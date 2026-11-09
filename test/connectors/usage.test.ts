// ves-agent/1 usage accounting (§1.2 rule 9, LOG row 10): `turn.end.usage` is the turn's total and supersedes the
// turn's `usage` messages (an agent may send both: counted once), `usd_estimated` reaches the row and the card, a turn
// ending in error with a provider/gateway status is INVALID (not FAIL), and `$comment*` keys in a connection are
// tolerated by strict validate. Fake processes only (test/setup.ts locks the network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runConfigOnce, type RunConfigOptions } from '../../src/runner/run-v2.ts';
import { CommandConnector } from '../../src/connectors/command/index.ts';
import { resolveConfig } from '../../src/config/load.ts';
import { deps, fakeSpawn, nextMsg, recordingIO, registry, ROOT, sessionOpen, supportDesk, toolSpecs, catalogOf, type FakeProgram } from './helpers.ts';
import type { ResolvedConfig } from '../../src/core/types.ts';

const TMP = join(ROOT, 'results', `.test-usage-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let tick = Date.parse('2026-11-08T12:00:00Z');
const now = () => new Date((tick += 1000));
const READY = JSON.stringify({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'fake' }, capabilities: ['multi_turn'] });
const tools = toolSpecs(catalogOf(supportDesk()));
const opts = (cfg: ResolvedConfig, o: Partial<RunConfigOptions> = {}): RunConfigOptions => ({
  harnessRoot: ROOT, config: cfg, tier: 'smoke', trigger: 'manual', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, now, bootstrapN: 200, connectors: registry(), env: process.env, caseFilter: 'skeleton.read-search', ...o,
});
/** An agent that answers every turn with `emit(sid, turn_id)` (lines), after the handshake. */
const agent = (emit: (sid: string, tid: string, text: string) => unknown[]): FakeProgram => async ({ stdin, out }) => {
  out(READY);
  for (;;) {
    const m = await nextMsg(stdin);
    if (!m) return;
    if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: m.session_id }));
    if (m.type === 'turn') for (const x of emit(m.session_id, m.turn_id, m.text)) out(JSON.stringify(x));
  }
};

test('turn.end.usage supersedes the usage messages of its turn; without it the messages count; both turns add up', async () => {
  const spawn = fakeSpawn(agent((sid, tid, text) => text === 'both'
    ? [{ type: 'usage', session_id: sid, input_tokens: 100, output_tokens: 10, usd: 0.5 }, { type: 'message', session_id: sid, text: 'hi' },
       { type: 'turn.end', session_id: sid, turn_id: tid, reason: 'done', usage: { input_tokens: 100, output_tokens: 10, usd: 0.5, usd_estimated: true } }]
    : [{ type: 'usage', session_id: sid, input_tokens: 7, output_tokens: 3 }, { type: 'turn.end', session_id: sid, turn_id: tid, reason: 'done' }]));
  const c = new CommandConnector({ type: 'command', command: ['a'] }, deps({ spawn }));
  await c.health();
  const io = recordingIO();
  const s = await c.open(sessionOpen(tools), io);
  await c.turn(s, { text: 'both', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  await c.turn(s, { text: 'msg-only', as: 'owner', thread: 'thread-main', turn_id: 'turn-2' });
  const usage = io.rec.reports.filter((r) => r.ev.type === 'usage').map((r) => r.ev as any);
  assert.equal(usage.length, 2, 'one per turn: the turn.end total replaced the duplicate message');
  assert.deepEqual([usage[0].input_tokens, usage[0].output_tokens, usage[0].usd, usage[0].usd_estimated], [100, 10, 0.5, true]);
  assert.deepEqual([usage[1].input_tokens, usage[1].output_tokens], [7, 3]);
  await c.dispose();
});

test('runner: row usage comes from turn.end.usage (no double count), usd_estimated on the row and the card; unreported usage stays absent', async () => {
  const both: FakeProgram = agent((sid, tid) => [
    { type: 'usage', session_id: sid, input_tokens: 1000, output_tokens: 100, usd: 0.25 },
    { type: 'message', session_id: sid, text: 'Ticket T-100: Cannot log in.' },
    { type: 'turn.end', session_id: sid, turn_id: tid, reason: 'done', usage: { input_tokens: 1000, output_tokens: 100, usd: 0.25, usd_estimated: true } }]);
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: ['a'] }; });
  const r = await runConfigOnce(opts(cfg, { spawn: fakeSpawn(both) }));
  const row = r.rows.find((x) => x.surface === 'default' && x.trial === 0)!;
  assert.deepEqual([row.usage.input_tokens, row.usage.output_tokens, row.usage.usd_list, row.usage.usd_estimated], [1000, 100, 0.25, true]);
  assert.match(r.card, /agent cost partly estimated/);
  assert.equal(r.manifest.cost.actual_usd, r.rows.reduce((a, x) => a + (x.usage.usd_list ?? 0), 0), 'agent spend goes into the run cost (spend cap)');
  const silent = await runConfigOnce(opts(cfg, { spawn: fakeSpawn(agent((sid, tid) => [{ type: 'message', session_id: sid, text: 'Ticket T-100: Cannot log in.' }, { type: 'turn.end', session_id: sid, turn_id: tid, reason: 'done' }])) }));
  const srow = silent.rows.find((x) => x.surface === 'default')!;
  assert.equal(srow.usage.input_tokens, undefined, 'not reported is unmeasured, not 0');
  assert.equal(srow.usage.usd_list, undefined);
});

test('tokens without usd are priced from the price table when the model is known (marked estimated), else left unmeasured', async () => {
  const tokOnly: FakeProgram = agent((sid, tid) => [{ type: 'message', session_id: sid, text: 'Ticket T-100: Cannot log in.' },
    { type: 'turn.end', session_id: sid, turn_id: tid, reason: 'done', usage: { model: 'google/gemini-3.8-flash', input_tokens: 1_000_000, output_tokens: 0 } }]);
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: ['a'] }; });
  const row = (await runConfigOnce(opts(cfg, { spawn: fakeSpawn(tokOnly) }))).rows.find((x) => x.surface === 'default')!;
  assert.equal(row.usage.usd_list, 1.5);
  assert.equal(row.usage.usd_estimated, true);
  const unknown: FakeProgram = agent((sid, tid) => [{ type: 'message', session_id: sid, text: 'ok' }, { type: 'turn.end', session_id: sid, turn_id: tid, reason: 'done', usage: { model: 'some-unpriced-model', input_tokens: 10, output_tokens: 1 } }]);
  const u = (await runConfigOnce(opts(supportDesk((c) => { c.agent.connection = { type: 'command', command: ['a'] }; c.agent.model = 'x-unpriced'; }), { spawn: fakeSpawn(unknown) }))).rows.find((x) => x.surface === 'default')!;
  assert.equal(u.usage.input_tokens, 10);
  assert.equal(u.usage.usd_list, undefined, 'an unpriced model is not guessed at');
});

test('turn.end{reason: error, http_status: 502} (a gateway stream cut) grades INVALID under the invalid-row rule, not FAIL', async () => {
  const cut: FakeProgram = agent((sid, tid) => [{ type: 'turn.end', session_id: sid, turn_id: tid, reason: 'error', error: 'gateway stream cut', http_status: 502, usage: { input_tokens: 5, output_tokens: 0 } }]);
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: ['a'] }; });
  const r = await runConfigOnce(opts(cfg, { spawn: fakeSpawn(cut) }));
  const row = r.rows.find((x) => x.surface === 'default' && x.trial === 0)!;
  assert.equal(row.status, 'invalid');
  assert.equal(row.invalid_reason, 'infra_upstream_5xx');
  assert.equal(row.error?.http_status, 502);
  // the same with no status is an agent-side FAIL
  const plain = await runConfigOnce(opts(cfg, { spawn: fakeSpawn(agent((sid, tid) => [{ type: 'turn.end', session_id: sid, turn_id: tid, reason: 'error', error: 'bug' }])) }));
  assert.equal(plain.rows.find((x) => x.surface === 'default')!.status, 'fail');
});

test('$comment* keys inside agent.connection (and variants) are tolerated: no error, no unknown-key warning', () => {
  const c = supportDesk().snapshot as any;
  const raw = { ...c, agent: { ...c.agent, connection: { type: 'command', command: ['a'], $comment_usage: 'turn.end carries usage', $comment: 'x' } } };
  const r = resolveConfig(raw, { dir: join(ROOT, 'test', 'core', 'fixtures', 'catalogs'), env: {} });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings.filter((w) => /comment/.test(w)), []);
});
