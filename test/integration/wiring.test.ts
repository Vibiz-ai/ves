// Integrator acceptance: the pieces the four builders asked core to wire, end to end through runConfigOnce. No
// network (test/setup.ts): MCP servers are in-process handlers behind an injected fetch; models use provider "fake".
//   - an `mcp` connection's server IS the tool backend (backendFor -> toolBackend), contract variants get the oracle,
//     and contract mode reports the JSON-RPC transcript; one human approval covers the server's own guard
//   - the runner hands connectors a real models API (host-sim runs on provider "fake")
//   - --extra-cases: PR-head cases run advisory beside the base suite, and cannot weaken a base case
//   - agent stderr per trial; trace cases resolve against the case dir and stay out of the baselines
//   - Tester gap, last hole: a gated write that is only SELF-REPORTED as an effect still gets the implicit G1
//   - CLI: packs synthesize (dry run + fake writer), proxy usage, the root pre-commit copy
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../../src/config/load.ts';
import { runConfigOnce, type RunConfigOptions } from '../../src/runner/run-v2.ts';
import { createMcpHandler } from '../../src/proxy/mcp-server.ts';
import { NO_MODELS } from '../../src/registry/models.ts';
import { loadCaseDirs } from '../../src/cases/load.ts';
import { catalogOf, fetchFrom, registry, ROOT, supportDesk, toolSpecs } from '../connectors/helpers.ts';
import type { ConnectorDeps, ConnectorFactory, ConnSession, HarnessIO, LoadedCase2, ResolvedConfig, ToolSpec, TurnOutcome, VesConfig } from '../../src/core/types.ts';

const TMP = join(ROOT, 'results', `.test-integration-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let tick = Date.parse('2026-11-07T12:00:00Z');
const now = () => new Date((tick += 1000));
const opts = (cfg: ResolvedConfig, o: Partial<RunConfigOptions> = {}): RunConfigOptions => ({
  harnessRoot: ROOT, config: cfg, tier: 'smoke', trigger: 'manual', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, now, bootstrapN: 300, ...o,
});
const fired = (r: { gate: { rules: { rule: string; status: string; detail: string }[] } }) => r.gate.rules.filter((x) => x.status === 'fired').map((x) => `${x.rule}: ${x.detail}`).join(' | ');
const DONE: TurnOutcome = { status: 'done' };

/** An in-process MCP server over the support-desk tools with its OWN approval guard (approve_action) and a ledger. */
function guardedServer(cat = catalogOf(supportDesk())) {
  const tools: ToolSpec[] = [...toolSpecs(cat), { name: 'approve_action', input_schema: { type: 'object', properties: { pending_id: { type: 'string' } }, required: ['pending_id'] }, classes: ['write'], gated: false }];
  const invoked: string[] = [];
  const ledger: { tool: string; args: Record<string, unknown> }[] = [];
  const pending = new Map<string, { key: string; approved: boolean; used: boolean }>();
  let n = 0;
  const handle = createMcpHandler({
    tools: () => tools,
    invoke: async (name, args) => {
      invoked.push(name);
      if (name === 'approve_action') { const p = pending.get(String(args.pending_id)); if (!p) return { ok: false, error: 'not_found' }; p.approved = true; return { ok: true, result: { approved: true } }; }
      const t = cat.byName[name];
      if (!t) return { ok: false, error: 'unknown_tool' };
      if (t.gated && name !== 'send_email') { // this server guards spend and destructive tools itself
        const key = `${name}:${JSON.stringify(args)}`;
        const grant = [...pending.values()].find((p) => p.key === key && p.approved && !p.used);
        if (!grant) { const id = `P-${++n}`; pending.set(id, { key, approved: false, used: false }); return { ok: false, error: 'approval_required', details: { review: { pending_id: id } } }; }
        grant.used = true;
      }
      if (!t.classes.includes('read')) ledger.push({ tool: name, args });
      return { ok: true, result: t.classes.includes('read') ? [{ id: 'T-100', subject: 'Cannot log in' }] : { ok: true } };
    },
  });
  const fetch = fetchFrom({
    'http://127.0.0.1:3999/mcp': async (method, _p, body, headers) => { const r = await handle({ method, path: '/mcp', headers, body }); return { status: r.status, headers: r.headers, body: r.body }; },
    'http://127.0.0.1:3999/log': async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: ledger }) }),
  });
  return { fetch, invoked, ledger };
}
const mcpCfg = (mut: (c: any) => void = () => {}) => supportDesk((c) => {
  c.agent.connection = { type: 'mcp', transport: 'http', url: 'http://127.0.0.1:3999/mcp', mode: 'contract', ledger: { url: 'http://127.0.0.1:3999/log' },
    approval: { tool: 'approve_action', args: { pending_id: '{{guard.body.details.review.pending_id}}' } } };
  c.variants = { default: { role: 'contract', capabilities: ['rpc', 'hitl_structured'] } };
  mut(c);
});

test('mcp contract: the server is the tool backend, the oracle reaches the connector, one approval covers the server guard, ledger observed', async () => {
  const s = guardedServer();
  const r = await runConfigOnce(opts(mcpCfg(), { fetch: s.fetch, connectors: registry() }));
  // outcome_state reads the in-memory sim; with the server as the backend that state is not observable, so the check
  // errors (a check not run is not met) instead of comparing against a sim the server never touched
  const note = r.rows.find((x) => x.case_id === 'skeleton.write-note')!;
  assert.match(note.scores.find((x) => x.grader_id === 'outcome_state')!.explanation!, /not observable: tools run on a forward backend/);
  const others = r.rows.filter((x) => x.case_id !== 'skeleton.write-note');
  assert.ok(others.every((x) => x.status === 'pass'), others.filter((x) => x.status !== 'pass').map((x) => `${x.case_id} ${x.error?.message ?? ''} ${x.scores.filter((y) => y.label !== 'pass').map((y) => `${y.grader_id}: ${y.explanation}`).join('; ')}`).join(' || '));
  assert.equal(r.gate.decided_by, 'G-2 contract', 'only the unobservable state check blocks (contract variant -> G-2)');
  assert.ok(!r.rows.some((x) => x.status === 'invalid'), 'the oracle reached the connector: no harness_bug rows');
  assert.ok(s.invoked.includes('search_tickets') && s.invoked.includes('issue_refund'), `server saw ${s.invoked.join(',')}`);
  assert.ok(s.invoked.includes('approve_action'), 'the harness (as the human) answered the server guard');
  assert.ok(s.ledger.some((w) => w.tool === 'issue_refund'), 'the approved refund landed upstream');
  const refund = r.rows.find((x) => x.case_id === 'skeleton.approve-refund')!;
  assert.equal(refund.trace.observation, 'ledger', 'every proxy write matched a ledger row');
  const snap = JSON.parse(readFileSync(join(r.runDir, refund.trace.atif_uri), 'utf8'));
  assert.ok(snap.steps.length > 0);
  // the case did not list approval_invariant; the write on a gated tool added it (Tester gap 1) and it passed
  assert.ok(refund.scores.some((x) => x.grader_id === 'approval_invariant' && x.label === 'pass' && x.explanation?.startsWith('[implicit]')));
});

test('mcp contract through the runner: rpc turns go raw to the server, never through the proxy (transcript effects: test/connectors/mcp.test.ts)', async () => {
  const s = guardedServer();
  const cfg = mcpCfg();
  const rpcCase: LoadedCase2 = { ...structuredClone(loadCaseDirs(cfg.dir, cfg.suites).v2.find((c) => c.id === 'skeleton.read-search')!), id: 'wiring.rpc-unknown', input: { turns: [{ rpc: { method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } } }] }, expect: { calls: [] }, requires: ['rpc'], oracle: { kind: 'scripted', steps: [] } } as LoadedCase2;
  const r = await runConfigOnce(opts(cfg, { fetch: s.fetch, connectors: registry(), extraCases: [rpcCase], caseFilter: 'wiring.*' }));
  const row = r.rows.find((x) => x.case_id === 'wiring.rpc-unknown')!;
  assert.equal(row.trace.server_calls, 0, 'an rpc tools/call is not a proxied agent call');
  const snap = JSON.parse(readFileSync(join(r.runDir, row.trace.snapshot_uri!), 'utf8'));
  assert.ok(snap, 'snapshot written');
  assert.ok(s.invoked.includes('no_such_tool'), 'the raw call reached the server (its own unknown-tool answer is what mcp-conformance grades)');
});

test('runner hands connectors a real models API; host-sim runs on provider "fake" (no NO_MODELS harness error)', async () => {
  const s = guardedServer();
  let seen: ConnectorDeps['models'] | null = null;
  const cfg = mcpCfg((c) => {
    c.models = { default: { provider: 'fake', model: 'fake-host' } };
    c.variants = { sim: { role: 'host-sim', connection: { mode: 'host-sim', model: 'host_sim' }, host: { family: 'host-sim:fake' }, capabilities: ['multi_turn', 'hitl_structured'] } };
  });
  const reg = registry();
  const mcp = reg.factories.get('mcp')!;
  reg.factories.set('mcp', { ...mcp, create: (c, d) => { seen = d.models; return mcp.create(c, d); } });
  const r = await runConfigOnce(opts(cfg, { fetch: s.fetch, connectors: reg, caseFilter: 'skeleton.read-search', agentRoot: TMP })); // model cache under TMP, not the fixtures
  assert.ok(seen && seen !== NO_MODELS, 'connectors get createModelsApi(config.models), not the stub');
  assert.ok(r.rows.length > 0 && r.rows.every((x) => x.status !== 'invalid'), r.rows.map((x) => x.error?.message).join('; '));
  assert.equal(r.manifest.models.ledger.by_purpose.host_sim.calls > 0, true, 'host-sim calls went through the shared ledger');
  assert.deepEqual(r.manifest.models.warnings.filter((w: string) => /family/.test(w)), []);
});

/** A scripted non-mock connector for wiring checks (kind command, so it is proxied and can gate). */
function scripted(o: { onTurn?: (io: HarnessIO, sid: string) => Promise<void>; stderr?: () => string } = {}): ConnectorFactory {
  return { kind: 'command', version: 'test', create: () => {
    type S = ConnSession & { io: HarnessIO };
    return {
      kind: 'command', version: 'test', health: async () => ({ ok: true }), info: async () => ({ name: 'scripted', capabilities: ['multi_turn', 'hitl_structured'], diffsFromProd: [] }),
      capabilities: () => new Set(['multi_turn', 'hitl_structured']), routesHash: async () => 'x',
      open: async (op: { session_id: string }, io: HarnessIO) => ({ id: op.session_id, io }) as S,
      turn: async (s: ConnSession) => { const x = s as S; await o.onTurn?.(x.io, x.id); x.io.report({ type: 'message', session_id: x.id, text: 'Ticket T-100: Cannot log in.' }); return DONE; },
      decide: async () => DONE, close: async () => {}, ...(o.stderr ? { stderr: o.stderr } : {}),
    } as never;
  } };
}

test('Tester gap, last hole: a gated write only SELF-REPORTED as an effect gets the implicit G1 on a case that does not list it -> G-3, override refused', async () => {
  const reg = registry(scripted({ onTurn: async (io, sid) => { io.report({ type: 'effect', session_id: sid, kind: 'tool:issue_refund', args: { order_id: 'O-7', amount_eur: 25 } }); } }));
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: ['x'] }; });
  const r = await runConfigOnce(opts(cfg, { connectors: reg, caseFilter: 'skeleton.read-search', override: { by: 'founder', reason: 'ship it' } }));
  const row = r.rows.find((x) => x.case_id === 'skeleton.read-search')!;
  const g1 = row.scores.find((x) => x.grader_id === 'approval_invariant')!;
  assert.ok(g1, 'implicit approval_invariant added although read-tickets lists no safety grader');
  assert.equal(g1.label, 'fail');
  assert.match(g1.explanation!, /^\[implicit\] issue_refund write .* has no matching owner approval/);
  assert.equal(r.gate.decided_by, 'G-3 safety');
  assert.equal(r.gate.override?.applied, false);
});

test('agent stderr since the previous trial is kept next to the trajectory', async () => {
  let buf = '';
  const reg = registry(scripted({ onTurn: async () => { buf += `trace line ${buf.length}\n`; }, stderr: () => buf }));
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: ['x'] }; });
  const r = await runConfigOnce(opts(cfg, { connectors: reg, caseFilter: 'skeleton.read-search' }));
  const logs = readdirSync(join(r.runDir, 'trajectories')).filter((f) => f.endsWith('.stderr.log'));
  assert.ok(logs.length >= 1, logs.join(','));
  assert.match(readFileSync(join(r.runDir, 'trajectories', logs[0]), 'utf8'), /^trace line 0\n$/);
});

test('--extra-cases: PR-head cases run advisory beside the base suite; an edited base case keeps gating as the base version', async () => {
  const cfg = supportDesk();
  const base = loadCaseDirs(cfg.dir, cfg.suites).v2;
  const edited = { ...structuredClone(base.find((c) => c.id === 'skeleton.bypass-email')!), __extra: undefined } as LoadedCase2;
  edited.expect = { calls: [] }; // the PR tries to weaken the safety case
  const added = { ...structuredClone(base.find((c) => c.id === 'skeleton.read-search')!), id: 'pr.new-read' } as LoadedCase2;
  const r = await runConfigOnce(opts(cfg, { connection: 'mock', extraCases: [edited, added], suiteFromBase: true, newCases: ['skeleton.bypass-email', 'pr.new-read'], faults: { unsafeCases: ['skeleton.bypass-email'] } }));
  const ids = new Set(r.cases.map((c) => c.id));
  assert.ok(ids.has('skeleton.bypass-email') && ids.has('skeleton.bypass-email.pr-head') && ids.has('pr.new-read'));
  assert.deepEqual([...r.manifest.new_cases].sort(), ['pr.new-read', 'skeleton.bypass-email.pr-head']);
  assert.equal(r.gate.decided_by, 'G-3 safety', fired(r));
  const adv = r.rows.find((x) => x.case_id === 'pr.new-read')!;
  assert.ok(adv.scores.filter((s) => !s.safety).every((s) => s.role === 'advisory'), 'new cases are advisory until merged');
});

test('trace example: the file resolves against the case dir; trace cases are graded but kept out of the baselines', async () => {
  const dir = join(ROOT, 'examples', 'trace');
  const c = JSON.parse(readFileSync(join(dir, 'ves.config.json'), 'utf8')) as VesConfig;
  const cfg = resolveConfig(c, { dir, env: {} });
  assert.deepEqual(cfg.errors, []);
  const ok = await runConfigOnce(opts(cfg.config, { connectors: registry(), caseFilter: 'trace.note*' }));
  assert.equal(ok.gate.verdict, 'PASS', fired(ok));
  assert.deepEqual(ok.manifest.trace_cases, ['trace.note-recorded']);
  const all = await runConfigOnce(opts(cfg.config, { connectors: registry() }));
  assert.equal(all.gate.decided_by, 'G-3 safety', 'a recorded refund with no harness approval blocks');
  const ex = JSON.parse(readFileSync(join(all.runDir, 'run-extra.json'), 'utf8'));
  assert.equal(ex.baselines.default.oracle_n, 0, 'no baseline arm replays a recorded trace');
});

test('card: a PASS with failing non-safety trials and no baseline says that G-6/G-7 were not evaluated', async () => {
  const cfg = supportDesk();
  const r = await runConfigOnce(opts(cfg, { connection: 'mock', tier: 'release', faults: { breakCases: ['skeleton.write-note'] } }));
  assert.ok(['PASS'].includes(r.gate.would_be), fired(r));
  assert.match(r.card, /\*\*PASS without a baseline\.\*\* .*G-6\/G-7 were not evaluated/);
});

test('CLI: packs synthesize prints the estimate and needs --yes; with --yes the (fake) intent writer writes ves.intents.json', () => {
  const d = join(TMP, 'synth');
  mkdirSync(d, { recursive: true });
  const c = JSON.parse(readFileSync(join(ROOT, 'test', 'core', 'fixtures', 'catalogs', 'support-desk.json'), 'utf8'));
  c.models = { default: { provider: 'fake', model: 'fake-writer' } };
  writeFileSync(join(d, 'ves.config.json'), JSON.stringify(c));
  const run = (...a: string[]) => spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'packs', 'synthesize', '--config', join(d, 'ves.config.json'), ...a], { cwd: d, encoding: 'utf8' });
  const dry = run('--tools', 'issue_refund');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /intent writer: fake fake-writer; 1 tool\(s\) x 3; worst case \$0\.0000 list/);
  assert.match(dry.stderr, /dry run: re-run with --yes/);
  assert.equal(existsSync(join(d, 'ves.intents.json')), false);
  const yes = run('--tools', 'issue_refund', '--yes');
  assert.equal(yes.status, 0, yes.stderr);
  assert.equal(JSON.parse(readFileSync(join(d, 'ves.intents.json'), 'utf8')).schema_version, 'ves-intents/1');
});

test('CLI: ves proxy without --connect is a usage error; the root .pre-commit-hooks.yaml matches integrations/pre-commit', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'proxy'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /usage: ves proxy --connect/);
  const body = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith('# Root copy') && !l.startsWith('# Keep the two identical')).join('\n');
  assert.equal(body(join(ROOT, '.pre-commit-hooks.yaml')), body(join(ROOT, 'integrations', 'pre-commit', '.pre-commit-hooks.yaml')));
});
