// Models acceptance (§7.5): content-hash cache (hit on identical request + salt, miss on a changed salt, persisted
// on disk) and the spend ledger (worst-case reservation, SpendStopError at the cap, cache-only after a stop).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SpendStopError } from '../../src/core/errors.ts';
import { classifyFailure } from '../../src/lib/classify.ts';
import { SpendLedger } from '../../src/models/ledger.ts';
import { lookupPrice, PRICES, usdOf } from '../../src/models/prices.ts';
import { setup, tmpDir } from './helpers.ts';

const t = tmpDir('cache');
after(t.cleanup);
const req = { messages: [{ role: 'user' as const, content: 'grade this' }] };

test('cache: identical request + salt is a hit ($0, cached: true); a changed salt is a miss', async () => {
  const dir = join(t.dir, 'a');
  const { api, fetch } = setup({ cacheDir: dir });
  const m = api.chat('judge');
  const r1 = await m.chat(req, { purpose: 'judge', salt: 'rep-1' });
  const r2 = await m.chat(req, { purpose: 'judge', salt: 'rep-1' });
  const r3 = await m.chat(req, { purpose: 'judge', salt: 'rep-2' });
  assert.equal(fetch.calls.length, 2);
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, true);
  assert.equal(r2.usd_list, 0);
  assert.equal(r2.request_sha256, r1.request_sha256);
  assert.equal(r3.cached, false);
  assert.notEqual(r3.request_sha256, r1.request_sha256);
  const l = api.ledger();
  assert.equal(l.calls, 3);
  assert.equal(l.cache_hit_ratio, 1 / 3);
  assert.deepEqual(api.rows().map((r) => r.cached), [false, true, false]);
  // the cache file holds no credential
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  for (const f of files) assert.ok(!readFileSync(join(dir, f), 'utf8').includes('ya29'));
});

test('cache: persists across harness processes (new createModels, same dir)', async () => {
  const dir = join(t.dir, 'b');
  await setup({ cacheDir: dir }).api.chat('judge').chat(req, { purpose: 'judge', salt: 'x' });
  const again = setup({ cacheDir: dir });
  const r = await again.api.chat('judge').chat(req, { purpose: 'judge', salt: 'x' });
  assert.equal(r.cached, true);
  assert.equal(again.fetch.calls.length, 0);
  assert.equal(again.exec.calls.length, 0, 'a cache hit needs no credential');
});

test('cache: a different model or request body is a different key; no cacheDir disables caching', async () => {
  const dir = join(t.dir, 'c');
  const { api, fetch } = setup({ cacheDir: dir, cfg: { named: { b: { provider: 'vertex', model: 'google/gemini-3.5-flash' } } } });
  await api.chat('default').chat(req, { purpose: 'judge', salt: 's' });
  await api.chat('b').chat(req, { purpose: 'judge', salt: 's' });
  await api.chat('default').chat({ ...req, temperature: 0.5 }, { purpose: 'judge', salt: 's' });
  assert.equal(fetch.calls.length, 3);
  const off = setup();
  await off.api.chat('default').chat(req, { purpose: 'judge', salt: 's' });
  await off.api.chat('default').chat(req, { purpose: 'judge', salt: 's' });
  assert.equal(off.fetch.calls.length, 2);
  assert.equal(existsSync(join(t.dir, 'none')), false);
});

test('ledger: spend stop at the cap -> SpendStopError (402 -> infra_rate_limit); then cache hits only', async () => {
  const dir = join(t.dir, 'd');
  // $1 / $1 per 1M tokens; max_tokens 100k -> worst case about $0.1 per call; cap $0.25 allows two reservations.
  const { api, fetch } = setup({ cacheDir: dir, cap: 0.25, extra: { prices: { 'google/gemini-3.8-flash': { in_per_mtok: 1, out_per_mtok: 1 } } },
                                 handler: () => ({ content: 'x', usage: { prompt_tokens: 10, completion_tokens: 90_000 } }) });
  const m = api.chat('default');
  const big = { ...req, max_tokens: 100_000 };
  await m.chat(big, { purpose: 'host_sim', salt: '1' });
  await m.chat(big, { purpose: 'host_sim', salt: '2' });
  await assert.rejects(m.chat(big, { purpose: 'host_sim', salt: '3' }), (e: any) => e instanceof SpendStopError && e.http_status === 402);
  assert.equal(classifyFailure({ origin: 'provider', http_status: 402 }), 'infra_rate_limit');
  assert.equal(fetch.calls.length, 2, 'the refused call never reached the provider');
  assert.equal(api.ledger().spend_stopped, true);
  // stopped: even a small call is refused ...
  await assert.rejects(m.chat(req, { purpose: 'judge', salt: 'small' }), SpendStopError);
  // ... but a cached answer is still served
  const hit = await m.chat(big, { purpose: 'host_sim', salt: '1' });
  assert.equal(hit.cached, true);
  const l = api.ledger();
  assert.ok(l.usd_list <= 0.25, `spent ${l.usd_list} within the cap`);
  assert.equal(l.by_purpose.host_sim.calls, 3);
  assert.equal(l.by_purpose.judge.calls, 0, 'refused calls are not counted as calls');
  assert.equal(api.rows().filter((r) => r.status === 'refused').length, 2);
});

test('ledger: actual cost from usage at list price; agent-reported spend shares the pool', async () => {
  const { api } = setup({ cap: 2, handler: () => ({ content: 'x', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }) });
  const r = await api.chat('default').chat(req, { purpose: 'judge', salt: 's' });
  assert.equal(r.usd_list, PRICES['google/gemini-3.8-flash'].in); // 1M input tokens of list price
  api.chargeExternal(0.5, 'agent');
  await assert.rejects(api.chat('default').chat(req, { purpose: 'judge', salt: 's2' }), SpendStopError);
});

test('ledger/prices: every shipped price is unverified list price; unknown remote model uses the conservative fallback with a warning', async () => {
  assert.ok(Object.values(PRICES).every((p) => p.verified === false));
  assert.equal(lookupPrice('google/gemini-9-ultra', { local: false }).fallback, true);
  assert.equal(lookupPrice('gemini-3.8-flash', { local: false }).row, PRICES['google/gemini-3.8-flash']);
  assert.equal(lookupPrice('x', { local: false, overrides: { x: { in_per_mtok: 0, out_per_mtok: 0 } } }).row.verified, true);
  assert.equal(usdOf(PRICES['google/gemini-2.5-pro'], 300_000, 0), 300_000 * 2.5 / 1e6, 'long-context rate above longAt');
  const { api } = setup({ cfg: { named: { u: { provider: 'openai-compatible', base_url: 'https://x.example.test/v1', model: 'mystery-1' } } } });
  await api.chat('u').chat(req, { purpose: 'judge', salt: 's' });
  assert.ok(api.warnings().some((w) => /no list price for mystery-1/.test(w)));
  const l = new SpendLedger(1, 'release', () => new Date(0));
  const id = l.reserve(0.6, 'x');
  assert.throws(() => l.reserve(0.6, 'y'), SpendStopError);
  l.settle(id, 0.1, { purpose: 'judge', provider: 'p', model: 'm', cached: false, status: 'ok', input_tokens: 1, output_tokens: 1, usage_estimated: false, price_verified: false, request_sha256: 'k' });
  assert.equal(l.summary().usd_list, 0.1);
  assert.equal(l.reserved, 0);
});
