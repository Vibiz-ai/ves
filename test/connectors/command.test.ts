// `command` connector: every ves-agent/1 sequence rule (DESIGN-agnostic §1.2) against fake processes, then the
// reference agent and the plain-Python example passing core's skeleton cases end to end through the runner, the
// proxy and the gate, and the gated-write bypass blocking at G-3. Fake processes, plus local child processes only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runConfigOnce, type RunConfigOptions } from '../../src/runner/run-v2.ts';
import { CommandConnector } from '../../src/connectors/command/index.ts';
import { realSpawn } from '../../src/connectors/_shared/spawn.ts';
import { createReferenceAgent } from '../../examples/reference-agent/agent.mjs';
import { deps, fakeSpawn, nextMsg, recordingIO, registry, ROOT, SCRIPT, sessionOpen, supportDesk, toolSpecs, catalogOf, type FakeProgram } from './helpers.ts';
import type { ResolvedConfig } from '../../src/core/types.ts';

const TMP = join(ROOT, 'results', `.test-connectors-cmd-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let tick = Date.parse('2026-11-07T12:00:00Z');
const now = () => new Date((tick += 1000));
const opts = (cfg: ResolvedConfig, o: Partial<RunConfigOptions> = {}): RunConfigOptions => ({
  harnessRoot: ROOT, config: cfg, tier: 'smoke', trigger: 'pr', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, now, bootstrapN: 300, connectors: registry(), env: process.env, ...o,
});
const READY = JSON.stringify({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'fake' }, capabilities: ['multi_turn'] });
const conn = (program: FakeProgram, cfg: Record<string, unknown> = {}) => {
  const spawn = fakeSpawn(program);
  return { c: new CommandConnector({ type: 'command', command: ['agent'], startup_timeout_s: 0.3, ...cfg }, deps({ spawn })), spawn };
};
const tools = toolSpecs(catalogOf(supportDesk()));

/** Reference agent as an in-memory process (prints a non-JSON banner first). */
export const referenceProgram = (o: { unsafe?: boolean; script?: unknown } = {}): FakeProgram => async ({ stdin, out }) => {
  const agent = createReferenceAgent({ ...o, emit: (m: unknown) => out(JSON.stringify(m)) });
  out('Framework v9 starting up... (banner, not JSON)');
  out(JSON.stringify(agent.ready));
  for (;;) { const m = await nextMsg(stdin); if (m === null) return; agent.onMessage(m); }
};

// --------------------------------------------------------------------------------------- rule 1 handshake
test('rule 1: no ready within startup_timeout_s -> health fails harness_bug "agent did not handshake"', async () => {
  const { c } = conn(async ({ out }) => { out('just a banner, never a ready'); });
  const h = await c.health();
  assert.equal(h.ok, false);
  assert.equal(h.reason, 'harness_bug');
  assert.match(h.detail!, /agent did not handshake: no ready message within 0.3 s/);
});
test('rule 1: a process that exits during health -> INVALID harness_bug with the stderr tail', async () => {
  const { c } = conn(({ err, exit }) => { err('Traceback: ModuleNotFoundError: openai\n'); setTimeout(() => exit(1), 5); });
  const h = await c.health();
  assert.equal(h.ok, false);
  assert.equal(h.reason, 'harness_bug');
  assert.match(h.detail!, /agent did not handshake: agent process exited \(code 1\).*ModuleNotFoundError/);
});
test('rule 1: a ready with the wrong protocol is refused', async () => {
  const { c } = conn(({ out }) => { out(JSON.stringify({ type: 'ready', protocol: 'ves-agent/9', agent: { name: 'x' } })); });
  const h = await c.health();
  assert.equal(h.ok, false);
  assert.match(h.detail!, /unsupported protocol ves-agent\/9/);
});
test('handshake: banners are ignored, info() carries the ready fields; env is filtered to PATH/HOME/VES_* + passthrough + env', async () => {
  const spawn = fakeSpawn(referenceProgram());
  const c = new CommandConnector({ type: 'command', command: ['node', 'agent.mjs'], env_passthrough: ['OPENAI_API_KEY'], env: { AGENT_MODE: 'eval' } },
    deps({ spawn, env: { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'k1', AWS_SECRET_ACCESS_KEY: 'nope', VES_RUN: '1' } }));
  assert.deepEqual(await c.health(), { ok: true });
  const i = await c.info();
  assert.equal(i.name, 'ves-reference-agent');
  assert.equal(i.protocol, 'ves-agent/1');
  assert.ok(c.capabilities().has('hitl_structured'));
  assert.deepEqual(Object.keys(spawn.seen.env!).sort(), ['AGENT_MODE', 'HOME', 'OPENAI_API_KEY', 'PATH', 'VES_RUN']);
  assert.equal(spawn.seen.cmd, 'node');
  await c.dispose();
});

// --------------------------------------------------------------------------------------- rules 2-8
test('rule 2: session.open -> session.opened; a missing session.opened fails open()', async () => {
  const { c } = conn(async ({ stdin, out }) => { out(READY); await nextMsg(stdin); /* never answers */ }, { open_timeout_s: 0.2 });
  await assert.rejects(c.open(sessionOpen(tools), recordingIO()), /did not answer session.open with session.opened/);
});
test('rules 3-4: tool_call goes through HarnessIO.callTool (transport pipe) and tool_result comes back in order; turn.end closes the turn', async () => {
  const { c, spawn } = conn(async ({ stdin, out }) => {
    out(READY);
    for (;;) {
      const m = await nextMsg(stdin);
      if (!m) return;
      if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: m.session_id }));
      if (m.type === 'turn') {
        // two parallel calls, then wait for both results
        out(JSON.stringify({ type: 'tool_call', session_id: m.session_id, call_id: 'a', name: 'search_tickets', args: { query: 'login' } }));
        out(JSON.stringify({ type: 'tool_call', session_id: m.session_id, call_id: 'b', name: 'get_customer', args: { customer_id: 'C-1' } }));
        const r1 = await nextMsg(stdin), r2 = await nextMsg(stdin);
        out(JSON.stringify({ type: 'log', level: 'info', msg: 'thinking' }));
        out(JSON.stringify({ type: 'some.future.type', session_id: m.session_id }));
        out(JSON.stringify({ type: 'usage', session_id: m.session_id, input_tokens: 10, output_tokens: 3 }));
        out(JSON.stringify({ type: 'message', session_id: m.session_id, text: `${r1.call_id}${r2.call_id} ${r1.result.tool}` }));
        out(JSON.stringify({ type: 'turn.end', session_id: m.session_id, turn_id: m.turn_id, reason: 'done' }));
      }
    }
  });
  assert.equal((await c.health()).ok, true);
  const io = recordingIO();
  const s = await c.open(sessionOpen(tools), io);
  const r = await c.turn(s, { text: 'hi', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  assert.deepEqual(r, { status: 'done' });
  assert.deepEqual(io.rec.calls.map((x) => [x.name, x.transport]), [['search_tickets', 'pipe'], ['get_customer', 'pipe']]);
  const results = spawn.seen.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === 'tool_result');
  assert.deepEqual(results.map((m) => m.call_id), ['a', 'b'], 'replied in the order received');
  // rule 9 (LOG row 10): a turn's usage is reported when the turn ends (turn.end.usage would supersede it)
  assert.deepEqual(io.rec.reports.map((x) => x.ev.type), ['message', 'usage']);
  assert.equal((io.rec.reports[0].ev as any).text, 'ab search_tickets');
  await c.close(s);
  assert.ok(spawn.seen.stdin.some((l) => JSON.parse(l).type === 'session.close'), 'rule 6: session.close sent, no reply needed');
  await c.dispose();
});
test('rule 3: a turn.end for the wrong turn_id is a protocol violation (agent FAIL)', async () => {
  const { c } = conn(async ({ stdin, out }) => {
    out(READY);
    for (;;) { const m = await nextMsg(stdin); if (!m) return;
      if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: m.session_id }));
      if (m.type === 'turn') out(JSON.stringify({ type: 'turn.end', session_id: m.session_id, turn_id: 'turn-99', reason: 'done' })); }
  });
  await c.health();
  const s = await c.open(sessionOpen(tools), recordingIO());
  const r = await c.turn(s, { text: 'x', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  assert.equal(r.status, 'error');
  assert.equal(r.error!.origin, 'agent');
  assert.match(r.error!.message, /protocol violation: turn.end for turn-99 while turn-1 was open/);
  await c.dispose();
});
test('rule 5: hitl.request + turn.end awaiting_hitl parks; the decision turn id is its request_id; clock.advance uses clock-<n>', async () => {
  const { c, spawn } = conn(async ({ stdin, out }) => {
    out(READY);
    for (;;) { const m = await nextMsg(stdin); if (!m) return;
      const sid = m.session_id;
      if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: sid }));
      if (m.type === 'turn') { out(JSON.stringify({ type: 'hitl.request', session_id: sid, request_id: 'R1', tool: 'issue_refund', args: { order_id: 'O-7', amount_eur: 25 } })); out(JSON.stringify({ type: 'turn.end', session_id: sid, turn_id: m.turn_id, reason: 'awaiting_hitl' })); }
      if (m.type === 'hitl.decision') out(JSON.stringify({ type: 'turn.end', session_id: sid, turn_id: m.request_id, reason: 'done' }));
      if (m.type === 'clock.advance') out(JSON.stringify({ type: 'turn.end', session_id: sid, turn_id: 'clock-1', reason: 'done' })); }
  });
  await c.health();
  const io = recordingIO();
  const s = await c.open(sessionOpen(tools), io);
  assert.deepEqual(await c.turn(s, { text: 'refund', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' }), { status: 'awaiting_hitl' });
  assert.equal(io.rec.reports[0].ev.type, 'hitl.request');
  assert.deepEqual(await c.decide(s, { request_id: 'R1', decision: 'approve', as: 'owner', thread: 'thread-main' }), { status: 'done' });
  assert.deepEqual(await c.advanceClock(s, 'PT1H', '2026-01-05T10:00:00Z'), { status: 'done' });
  const sent = spawn.seen.stdin.map((l) => JSON.parse(l));
  assert.deepEqual(sent.find((m) => m.type === 'hitl.decision'), { type: 'hitl.decision', session_id: 'S1', request_id: 'R1', decision: 'approve', as: 'owner', thread: 'thread-main' });
  await c.dispose();
});
test('rule 7: no turn.end within turn_timeout_s -> FAIL "agent timeout" (agent-side, never INVALID)', async () => {
  const { c } = conn(async ({ stdin, out }) => { out(READY); for (;;) { const m = await nextMsg(stdin); if (!m) return; if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: m.session_id })); } }, { turn_timeout_s: 0.2 });
  await c.health();
  const s = await c.open(sessionOpen(tools), recordingIO());
  const r = await c.turn(s, { text: 'x', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  assert.equal(r.status, 'error');
  assert.equal(r.error!.origin, 'agent');
  assert.match(r.error!.message, /agent timeout/);
  await c.dispose();
});
test('rule 8: error{fatal} FAILs; with the provider status 429 it is origin "provider" (INVALID); non-fatal errors are logged', async () => {
  const logs: string[] = [];
  const spawn = fakeSpawn(async ({ stdin, out }) => {
    out(READY);
    for (;;) { const m = await nextMsg(stdin); if (!m) return; const sid = m.session_id;
      if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: sid }));
      if (m.type === 'turn' && m.text === 'a') { out(JSON.stringify({ type: 'error', session_id: sid, message: 'retrying', fatal: false })); out(JSON.stringify({ type: 'error', session_id: sid, message: 'bug', fatal: true })); }
      if (m.type === 'turn' && m.text === 'b') out(JSON.stringify({ type: 'error', session_id: sid, message: 'openai 429', fatal: true, http_status: 429 }));
      if (m.type === 'turn' && m.text === 'c') out(JSON.stringify({ type: 'turn.end', session_id: sid, turn_id: m.turn_id, reason: 'error', error: 'vertex 503', http_status: 503 })); }
  });
  const c = new CommandConnector({ type: 'command', command: ['a'] }, deps({ spawn, log: (_l, m) => logs.push(m) }));
  await c.health();
  const s = await c.open(sessionOpen(tools), recordingIO());
  const t = (text: string, n: number) => c.turn(s, { text, as: 'owner', thread: 'thread-main', turn_id: `turn-${n}` });
  assert.deepEqual((await t('a', 1)).error, { message: 'agent error: bug', origin: 'agent' });
  assert.deepEqual((await t('b', 2)).error, { message: 'agent error: openai 429', origin: 'provider', http_status: 429 });
  assert.deepEqual((await t('c', 3)).error, { message: 'vertex 503', origin: 'provider', http_status: 503 });
  assert.ok(logs.some((l) => /agent error \(non-fatal\): retrying/.test(l)));
  await c.dispose();
});
test('process exit mid-turn FAILs the trial (agent-side), and the next session respawns the process', async () => {
  const spawn = fakeSpawn(async ({ stdin, out, exit }) => {
    out(READY);
    for (;;) { const m = await nextMsg(stdin); if (!m) return;
      if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: m.session_id }));
      if (m.type === 'turn') { exit(137); return; } }
  });
  const c = new CommandConnector({ type: 'command', command: ['a'] }, deps({ spawn }));
  await c.health();
  const s = await c.open(sessionOpen(tools), recordingIO());
  const r = await c.turn(s, { text: 'x', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  assert.equal(r.error!.origin, 'agent');
  assert.match(r.error!.message, /agent ended mid-turn \(agent process exited \(code 137/);
  await c.close(s);
  await c.open(sessionOpen(tools, { session_id: 'S2' }), recordingIO());
  assert.equal(spawn.seen.spawns, 2);
  await c.dispose();
});
test('reuse_process: one process serves many sequential sessions; reuse_process false spawns one per session', async () => {
  for (const reuse of [true, false]) {
    const spawn = fakeSpawn(referenceProgram({ script: SCRIPT }));
    const c = new CommandConnector({ type: 'command', command: ['a'], reuse_process: reuse }, deps({ spawn }));
    await c.health();
    for (const id of ['S1', 'S2', 'S3']) { const s = await c.open(sessionOpen(tools, { session_id: id }), recordingIO()); await c.close(s); }
    assert.equal(spawn.seen.spawns, reuse ? 1 : 4, `reuse_process ${reuse}`);
    await c.dispose();
  }
});
test('session.open carries an mcp_stdio bridge when core served an MCP URL', async () => {
  const spawn = fakeSpawn(referenceProgram());
  const c = new CommandConnector({ type: 'command', command: ['a'] }, deps({ spawn }));
  await c.health();
  await c.open(sessionOpen(tools, { tool_transport: { pipe: true, mcp: { url: 'http://127.0.0.1:5555/s/abc/mcp' } } }), recordingIO());
  const open = spawn.seen.stdin.map((l) => JSON.parse(l)).find((m) => m.type === 'session.open');
  assert.equal(open.tool_transport.mcp.url, 'http://127.0.0.1:5555/s/abc/mcp');
  assert.deepEqual(open.tool_transport.mcp_stdio.args.slice(1), ['--connect', 'http://127.0.0.1:5555/s/abc/mcp']);
  assert.match(open.tool_transport.mcp_stdio.args[0], /stdio-bridge\.ts$/);
  await c.dispose();
});
test('routesHash: changes when the bridge file named in the command changes identity; stable otherwise', async () => {
  const a = new CommandConnector({ type: 'command', command: ['node', 'examples/reference-agent/agent.mjs'] }, deps());
  const b = new CommandConnector({ type: 'command', command: ['node', 'examples/plain-python/agent.py'] }, deps());
  assert.equal(await a.routesHash(), await a.routesHash());
  assert.notEqual(await a.routesHash(), await b.routesHash());
  assert.match(await a.routesHash(), /^[a-f0-9]{64}$/);
});

// --------------------------------------------------------------------------------- end to end, runner + gate
const refCfg = (o: { unsafe?: boolean } = {}) => supportDesk((c) => {
  c.agent.connection = { type: 'command', command: ['node', 'examples/reference-agent/agent.mjs', ...(o.unsafe ? ['--unsafe'] : [])] };
  c.fixtures.context = { script: SCRIPT };
});
test('reference agent over `command` (fake process) passes the 6 skeleton cases on a PR trigger: PASS, proxied records', async () => {
  const r = await runConfigOnce(opts(refCfg(), { spawn: fakeSpawn(referenceProgram()) }));
  assert.equal(r.gate.verdict, 'PASS', JSON.stringify(r.gate.rules.filter((x) => x.status === 'fired')));
  assert.equal(r.manifest.connections.default.kind, 'command');
  assert.equal(r.manifest.observation.default, 'proxied');
  const rows = r.rows.filter((x) => x.surface === 'default');
  assert.ok(rows.every((x) => x.status === 'pass'), JSON.stringify(rows.filter((x) => x.status !== 'pass').map((x) => [x.case_id, x.status, x.scores])));
  const ap = rows.find((x) => x.case_id === 'skeleton.approve-refund')!;
  assert.equal(ap.trace.server_calls, 1);
  assert.ok(ap.scores.some((s) => s.grader_id === 'approval_invariant' && s.label === 'pass' && s.implicit));
});
test('the same reference agent with --unsafe (gated-write bypass) -> G-3 BLOCK, override refused, no retry', async () => {
  const r = await runConfigOnce(opts(refCfg({ unsafe: true }), { spawn: fakeSpawn(referenceProgram({ unsafe: true })), override: { by: 'founder', reason: 'ship it' } }));
  assert.equal(r.gate.decided_by, 'G-3 safety');
  assert.equal(r.gate.verdict, 'BLOCK');
  assert.equal(r.gate.override!.applied, false);
  const g1 = r.rows.filter((x) => x.scores.some((s) => s.grader_id === 'approval_invariant' && s.label === 'fail')).map((x) => x.case_id).sort();
  assert.deepEqual(g1, ['skeleton.approve-refund', 'skeleton.bypass-email', 'skeleton.reject-refund'], 'every trial that performed a gated write is checked, whatever the case lists');
});
test('connector-level turn timeout inside a real run: the row is FAIL (agent-side), not INVALID', async () => {
  const hang: FakeProgram = async ({ stdin, out }) => { out(READY); for (;;) { const m = await nextMsg(stdin); if (!m) return; if (m.type === 'session.open') out(JSON.stringify({ type: 'session.opened', session_id: m.session_id })); } };
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: ['a'], turn_timeout_s: 0.05 }; });
  const r = await runConfigOnce(opts(cfg, { spawn: fakeSpawn(hang), caseFilter: 'skeleton.read-search', trigger: 'manual' }));
  const row = r.rows.find((x) => x.surface === 'default' && x.trial === 0)!;
  assert.equal(row.status, 'fail');
  assert.match(String(row.error?.message), /agent timeout/);
});
test('an agent that never handshakes makes its rows INVALID harness_bug (not FAIL)', async () => {
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: ['a'], startup_timeout_s: 0.05 }; });
  const r = await runConfigOnce(opts(cfg, { spawn: fakeSpawn(async () => {}), caseFilter: 'skeleton.read-search', trigger: 'manual' }));
  const row = r.rows.find((x) => x.surface === 'default')!;
  assert.equal(row.status, 'invalid');
  assert.equal(row.invalid_reason, 'harness_bug');
  assert.match(String(row.error?.message), /agent did not handshake/);
});

// ------------------------------------------------------------------------- real local child processes
test('examples/reference-agent/agent.mjs as a real child process (--script, banner on stdout): PASS', async () => {
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: [process.execPath, join(ROOT, 'examples/reference-agent/agent.mjs'), '--script', join(ROOT, 'examples/reference-agent/support-desk.script.json')] }; });
  const r = await runConfigOnce(opts(cfg, { spawn: realSpawn }));
  assert.equal(r.gate.verdict, 'PASS', JSON.stringify(r.gate.rules.filter((x) => x.status === 'fired')));
});
const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('examples/plain-python/agent.py (fake LLM, no network) passes the skeleton cases over `command`; VES_DEMO_UNSAFE=1 blocks at G-3', { skip: hasPython ? false : 'python3 not installed' }, async () => {
  const cfg = (unsafe: boolean) => supportDesk((c) => { c.agent.connection = { type: 'command', command: ['python3', join(ROOT, 'examples/plain-python/agent.py')], env: unsafe ? { VES_DEMO_UNSAFE: '1' } : {} }; c.agent.framework = 'plain-python'; });
  const ok = await runConfigOnce(opts(cfg(false), { spawn: realSpawn }));
  assert.equal(ok.gate.verdict, 'PASS', JSON.stringify(ok.gate.rules.filter((x) => x.status === 'fired')));
  assert.equal(ok.manifest.connections.default.agent.name, 'plain-python-agent');
  const bad = await runConfigOnce(opts(cfg(true), { spawn: realSpawn }));
  assert.equal(bad.gate.decided_by, 'G-3 safety');
});
