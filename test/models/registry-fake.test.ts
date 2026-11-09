// Models package wiring: core's registry finds createModels; ref resolution (default, purposes, named); the
// deterministic fake provider; zero real network (test/setup.ts) and no network without an injected fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../../src/core/errors.ts';
import { createModelsApi } from '../../src/registry/models.ts';
import { createModelsExt, resolveModelRef, DEFAULT_MODEL_REF } from '../../src/models/index.ts';
import { fakeExec, fakeOpenAIFetch } from '../../src/models/fake.ts';
import { setup } from './helpers.ts';

test('registry: src/registry/models.ts loads createModels from src/models/index.ts', async () => {
  const fetch = fakeOpenAIFetch(() => ({ content: 'hi' }));
  const { api, installed } = await createModelsApi({}, { fetch, exec: fakeExec(['t']), env: { GOOGLE_CLOUD_PROJECT: 'p' }, now: () => new Date(0), cacheDir: '', budget: { pool: 'smoke', usd_cap: 2 } });
  assert.equal(installed, true);
  assert.equal(api.chat('judge').ref.provider, 'vertex');
  assert.equal(api.ledger().calls, 0);
});

test('refs: Vertex Gemini is the default for every purpose; strings point at default, purposes or named models', () => {
  assert.deepEqual(resolveModelRef({}, 'judge'), DEFAULT_MODEL_REF);
  assert.equal(DEFAULT_MODEL_REF.provider, 'vertex');
  const cfg = { default: { provider: 'vertex' as const, model: 'google/gemini-3.5-flash' }, judge: 'local', user_simulator: 'judge', host_sim: { provider: 'openai-compatible' as const, model: 'm', base_url: 'http://localhost:1/v1' },
                named: { local: { provider: 'openai-compatible' as const, model: 'qwen3', base_url: 'http://127.0.0.1:11434/v1' } } };
  assert.equal(resolveModelRef(cfg, 'user_simulator').model, 'qwen3');
  assert.equal(resolveModelRef(cfg, 'named.local').model, 'qwen3');
  assert.equal(resolveModelRef(cfg, 'intent_writer').model, 'google/gemini-3.5-flash');
  assert.equal(resolveModelRef(cfg, 'host_sim').model, 'm');
  assert.throws(() => resolveModelRef(cfg, 'nope'), UsageError);
  assert.throws(() => resolveModelRef({ judge: 'user_simulator', user_simulator: 'judge' }, 'judge'), /cycle/);
});

test('fake provider: deterministic, $0, no fetch, drives judge and simulator offline', async () => {
  const fetch = fakeOpenAIFetch(() => { throw new Error('must not be called'); });
  const mk = () => createModelsExt({ default: { provider: 'fake' as any, model: 'fake-1' } }, { fetch, exec: fakeExec(['t']), env: {}, now: () => new Date(0), cacheDir: '', budget: { pool: 'smoke', usd_cap: 0 } });
  const a = mk();
  const b = mk();
  const req = { messages: [{ role: 'user' as const, content: 'ping' }] };
  const r1 = await a.chat('default').chat(req, { purpose: 'host_sim', salt: 's' });
  const r2 = await b.chat('default').chat(req, { purpose: 'host_sim', salt: 's' });
  assert.equal(r1.message.content, r2.message.content);
  assert.match(String(r1.message.content), /^fake:[0-9a-f]{12}$/);
  assert.equal(r1.usd_list, 0);
  assert.equal(a.chat('default').family, 'fake');
  const s = await a.judge('helpfulness@1').score({ dimension: 'helpfulness@1', rubric_md: 'r', reference: 'ref', transcript: [], salt: 's' });
  assert.equal(s.label, 'unknown');
  const sim = a.userSimulator();
  assert.deepEqual(await sim.next({ persona: { id: 'p', temperament: 't', goal: 'g' }, transcript: [], pending_hitl: { tool: 'x', args: {} }, turn_index: 0, max_turns: 3, salt: 's' }), { hitl: 'approve', text: 'yes, go ahead' });
  assert.equal((await sim.next({ persona: { id: 'p', temperament: 't', goal: 'g' }, transcript: [], turn_index: 1, max_turns: 3, salt: 's' }) as any).stop, true);
  assert.equal(fetch.calls.length, 0);
  assert.ok((a.identities() as any)['judge:helpfulness@1'].prompt_sha256);
});

test('zero network: the global fetch is blocked in tests, and the package refuses to run without an injected fetch', async () => {
  await assert.rejects(async () => (globalThis.fetch as any)('https://aiplatform.googleapis.com/'), /network call attempted in a test/);
  assert.throws(() => createModelsExt({}, { env: {}, now: () => new Date(0), cacheDir: '', budget: { pool: 'smoke', usd_cap: 1 } } as any), /must be injected/);
  const { api, fetch } = setup();
  await api.chat('default').chat({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'judge', salt: 's' });
  assert.equal(fetch.calls.length, 1, 'all traffic went through the injected fetch');
});

test('estimate: list-price upper bound before any call (for `ves packs synthesize` cost printing)', () => {
  const { api, fetch } = setup();
  const usd = api.estimate('intent_writer', { messages: [{ role: 'user', content: 'x'.repeat(2000) }] }, 'intent_writer');
  assert.ok(usd > 0 && usd < 0.1, String(usd));
  assert.equal(fetch.calls.length, 0);
});
