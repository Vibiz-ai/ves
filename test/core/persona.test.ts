// Persona cases end to end (src/runner/persona-loop.ts, src/cases/personas.ts): library ref resolution, the
// simulated conversation through a non-mock connector (stop, max turns, hitl approve/reject, simulator failure ->
// INVALID, k trials differ), the offline replay on MockAgent (what `ves validate` runs), and the advisory
// persona_outcome score. Injected models and connectors only; no network (test/setup.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolveConfig } from '../../src/config/load.ts';
import { checkRules2, prepare, runConfigOnce, type RunConfigOptions } from '../../src/runner/run-v2.ts';
import { loadPersonaLibrary, resolveCasePersonas, resolvePersona } from '../../src/cases/personas.ts';
import { scriptedUserSimulator, visibleTranscript } from '../../src/runner/persona-loop.ts';
import { detectLanguage, languageMatch } from '../../src/graders/language.ts';
import { schema } from '../../src/cases/load.ts';
import { validate } from '../../src/lib/jsonschema.ts';
import { mockFactory } from '../../src/core/mock-agent.ts';
import { NO_MODELS } from '../../src/registry/models.ts';
import { ModelHttpError } from '../../src/models/provider.ts';
import type { ConnectorRegistry } from '../../src/registry/connectors.ts';
import type { Connector, ConnectorFactory, ConnSession, HarnessIO, LoadedCase2, ModelsApi, PersonaOutcome, ResolvedConfig, SessionOpen, TurnOutcome, UserSimulator, VesConfig } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REPO = join(HERE, 'fixtures', 'persona-repo');
const TMP = join(ROOT, 'results', `.test-persona-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let tick = Date.parse('2026-11-08T12:00:00Z');
const now = () => new Date((tick += 1000));

function config(mut: (c: any) => void = () => {}): ResolvedConfig {
  const c = JSON.parse(readFileSync(join(REPO, 'ves.config.json'), 'utf8')) as VesConfig;
  mut(c);
  const r = resolveConfig(c, { dir: REPO, env: {} });
  assert.deepEqual(r.errors, []);
  return r.config;
}
const realCfg = () => config((c) => { c.agent.connection = { type: 'command', command: ['node', 'agent.mjs'] }; c.agent.model = 'gpt-x'; });
const opts = (cfg: ResolvedConfig, o: Partial<RunConfigOptions> = {}): RunConfigOptions => ({
  harnessRoot: ROOT, config: cfg, tier: 'smoke', trigger: 'manual', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, now, bootstrapN: 200, ...o,
});

// ---- a small agent: asks before refunding (structured hitl), searches tickets, otherwise asks what is needed
type S = ConnSession & { io: HarnessIO; pending?: Record<string, unknown> };
const agent: ConnectorFactory = {
  kind: 'command', version: 'test-persona',
  create: (): Connector => ({
    kind: 'command', version: 'test-persona', health: async () => ({ ok: true }),
    info: async () => ({ name: 'persona-agent', capabilities: ['multi_turn', 'hitl_structured'], diffsFromProd: [], declaredTools: [{ name: 'search_tickets' }, { name: 'issue_refund' }] }),
    capabilities: () => new Set(['multi_turn', 'hitl_structured']), routesHash: async () => 'x',
    open: async (o: SessionOpen, io: HarnessIO) => ({ id: o.session_id, io }) as S,
    turn: async (s: ConnSession, t): Promise<TurnOutcome> => {
      const f = s as S;
      const say = (text: string) => f.io.report({ type: 'message', session_id: f.id, text });
      if (/refund/i.test(t.text)) {
        f.pending = { order_id: 'O-7', amount_eur: 25 };
        f.io.report({ type: 'hitl.request', session_id: f.id, request_id: 'r1', tool: 'issue_refund', args: f.pending, prompt: 'Refund O-7 for 25 EUR?' });
        say('I can refund O-7 for 25 EUR. OK?');
        return { status: 'awaiting_hitl' };
      }
      if (/login/i.test(t.text)) { await f.io.callTool({ call_id: 'c1', name: 'search_tickets', args: { query: 'login' }, transport: 'pipe' }); say('Ticket T-100: Cannot log in.'); return { status: 'done' }; }
      say('What can I do for you?');
      return { status: 'done' };
    },
    decide: async (s: ConnSession, d): Promise<TurnOutcome> => {
      const f = s as S;
      if (d.decision === 'approve' && f.pending) { await f.io.callTool({ call_id: 'c2', name: 'issue_refund', args: f.pending, transport: 'pipe' }); f.io.report({ type: 'message', session_id: f.id, text: 'Refunded 25 EUR.' }); }
      else f.io.report({ type: 'message', session_id: f.id, text: 'Okay, not refunded.' });
      f.pending = undefined;
      return { status: 'done' };
    },
    close: async () => {},
  }),
};
const reg: ConnectorRegistry = { factories: new Map<string, ConnectorFactory>([['mock', mockFactory], ['command', agent]]), sources: {} };

type SimCall = Parameters<UserSimulator['next']>[0];
/** Injected models: the given simulator and a judge that records what it saw. */
function models(next: (i: SimCall) => ReturnType<UserSimulator['next']>, outcome: Partial<PersonaOutcome> = {}) {
  const calls: SimCall[] = [];
  const judged: unknown[] = [];
  const sim: UserSimulator = { identity: { model: 'sim-test', prompt_sha256: 'a'.repeat(64) }, next: async (i) => { calls.push(i); return next(i); } };
  const api = {
    ...NO_MODELS, userSimulator: () => sim,
    personaJudge: () => ({ identity: { model: 'judge-test', prompt_sha256: 'b'.repeat(64), admitted: false },
      score: async (i: unknown) => { judged.push(i); return { goal_met: 'yes', gave_up: false, frustration: 1, tone_fit: 2, why: 'refund done', judge: { model: 'judge-test', prompt_sha256: 'b'.repeat(64) }, ...outcome } as PersonaOutcome; } }),
    identities: () => ({ user_simulator: sim.identity }),
  } as unknown as ModelsApi;
  return { api, calls, judged };
}
const row0 = (r: Awaited<ReturnType<typeof runConfigOnce>>, id: string, trial = 0) => r.rows.find((x) => x.case_id === id && x.trial === trial)!;
const traj = (r: Awaited<ReturnType<typeof runConfigOnce>>, row: { trace: { atif_uri: string } }) => JSON.parse(readFileSync(join(r.runDir, row.trace.atif_uri), 'utf8'));

test('persona library: ref resolves with case overrides; style merges; the persona file SHA folds into the case SHA; errors', () => {
  const lib = loadPersonaLibrary(join(REPO, 'personas'), REPO);
  assert.deepEqual(lib.errors, []);
  const r = resolvePersona({ ref: 'refund-seeker', goal: 'g', max_user_turns: 3, style: { emoji: 'none' } }, lib);
  assert.ok(r.persona && r.sha256);
  assert.equal(r.persona.id, 'refund-seeker');
  assert.equal(r.persona.ref, 'refund-seeker');
  assert.deepEqual(r.persona.temperament, ['busy', 'sceptical']);
  assert.equal(r.persona.max_user_turns, 3, 'case wins');
  assert.deepEqual(r.persona.style, { length: 'short', typos: 'some', impatience: 2, emoji: 'none' });
  assert.match(r.persona.background ?? '', /O-7/);
  assert.match(resolvePersona({ ref: 'nobody', goal: 'x' }, lib).error ?? '', /persona ref nobody not found/);
  assert.match(resolvePersona({ ref: 'refund-seeker' }, lib).error ?? '', /no goal/);
  const inline = resolvePersona({ id: 'x', temperament: 'vague', goal: 'more customers' }, null);
  assert.deepEqual(inline.persona?.temperament, ['vague']);
  assert.equal(inline.persona?.max_user_turns, 8, 'default');
  const k = { id: 'c', input: { persona: { ref: 'refund-seeker', goal: 'g' } }, __sha256: 'f'.repeat(64) } as unknown as LoadedCase2;
  assert.deepEqual(resolveCasePersonas([k], lib), []);
  assert.notEqual(k.__sha256, 'f'.repeat(64), 'editing the person changes suite_version');
  assert.equal(k.__persona?.goal, 'g');
  const bad = { id: 'b', input: { persona: { ref: 'nope', goal: 'g' } }, __sha256: 'x' } as unknown as LoadedCase2;
  assert.match(resolveCasePersonas([bad], lib)[0], /^b: persona ref nope not found/);
});

test('schemas: persona cases (ref or inline, temperament list) validate; a persona without id/ref or a bad file does not', () => {
  const base = JSON.parse(readFileSync(join(REPO, 'cases', 'persona.refund.case.json'), 'utf8'));
  assert.deepEqual(validate(schema('case-2'), base), []);
  assert.deepEqual(validate(schema('case-2'), { ...base, input: { persona: { id: 'p', temperament: ['busy', 'goal_changing'], goal: 'x', languages: ['pt-PT', 'en'] } } }), []);
  assert.ok(validate(schema('case-2'), { ...base, input: { persona: { goal: 'x' } } }).length > 0);
  assert.ok(validate(schema('case-2'), { ...base, input: { persona: { ref: 'p', temperament: 'angry' } } }).length > 0);
  assert.deepEqual(validate(schema('persona-1'), JSON.parse(readFileSync(join(REPO, 'personas', 'refund-seeker.persona.json'), 'utf8'))), []);
  assert.ok(validate(schema('persona-1'), { schema_version: 'ves-persona/1', id: 'x', temperament: 'busy', style: { length: 'huge' } }).length > 0);
});

test('runner rules: persona_outcome cannot gate; persona graders need a persona; unknown refs fail prepare', async () => {
  const cfg = config();
  const p = await prepare({ harnessRoot: ROOT, config: cfg, tier: 'smoke' });
  assert.deepEqual([...p.errors, ...p.ruleErrors], []);
  const c = structuredClone(p.cases.find((x) => x.id === 'persona.refund')!);
  c.graders = [{ id: 'persona_outcome', role: 'gate' }];
  const s = structuredClone(p.cases.find((x) => x.id === 'persona.lookup')!);
  delete (s.input as any).persona; s.input.turns = [{ say: 'hi' }];
  const errs = checkRules2([c, s], p.catalog, { admitted: [] });
  assert.ok(errs.some((e) => /persona\.refund: persona_outcome .* advisory/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /persona\.lookup: grader persona_metrics needs input.persona/.test(e)), errs.join('\n'));
  const extra = { ...structuredClone(p.cases[0]), id: 'persona.extra', input: { persona: { ref: 'ghost', goal: 'x' } }, __persona: undefined } as LoadedCase2;
  const q = await prepare({ harnessRoot: ROOT, config: cfg, tier: 'smoke', extraCases: [extra] });
  assert.ok(q.errors.some((e) => /persona\.extra: persona ref ghost not found/.test(e)), q.errors.join('\n'));
  const f = await prepare({ harnessRoot: ROOT, config: cfg, tier: 'smoke', personaFilter: 'refund-*' });
  assert.deepEqual(f.cases.map((x) => x.id), ['persona.refund'], '--persona filters by id or ref');
});

test('offline replay (what `ves validate` runs): MockAgent + the scripted simulator, oracle passes, persona rows and tags recorded', async () => {
  const r = await runConfigOnce(opts(config(), { connection: 'mock', tier: 'release' }));
  const v = r.gate.rules.find((x) => x.rule === 'V §4.1 suite validity')!;
  assert.equal(v.status, 'clear', v.detail);
  for (const row of r.rows) assert.deepEqual(validate(schema('result-2'), row), [], row.row_id);
  const ref = row0(r, 'persona.refund');
  assert.equal(ref.status, 'pass', JSON.stringify(ref.scores));
  assert.equal(ref.persona?.simulator.model, 'ves-scripted-sim');
  assert.equal(ref.persona?.user_turns, 2, 'one message, one approval');
  assert.equal(ref.persona?.stop.kind, 'goal_met');
  const po = ref.scores.find((s) => s.grader_id === 'persona_outcome')!;
  assert.equal(po.role, 'advisory');
  assert.equal(po.label, 'unknown', 'no judge on MockAgent');
  const look = row0(r, 'persona.lookup');
  assert.equal(look.status, 'pass', JSON.stringify(look.scores));
  assert.equal(look.persona?.user_turns, 1, 'the fixed opening, then the simulator stops');
  const steps = traj(r, look).steps.filter((s: any) => s.source === 'user');
  assert.deepEqual(steps.map((s: any) => [s.message, s.vibiz?.persona?.source]), [['login tickets. now pls', 'opening']]);
  assert.ok(look.scores.some((s) => s.grader_id === 'persona_outcome' && s.implicit !== true), 'persona_outcome added to every persona case');
  assert.equal(r.manifest.user_simulator, null, 'no model simulator in a mock run');
});

test('loop: say -> structured approval -> stop(goal_met); simulator sees only visible text; judge read is advisory; rows schema-valid', async () => {
  const m = models((i) => (i.pending_hitl ? Promise.resolve({ hitl: 'approve' as const, text: 'yes do it' })
    : !i.transcript.some((x) => x.role === 'user') ? Promise.resolve({ say: 'refund O-7 pls, it came broken' }) : Promise.resolve({ stop: true as const, reason: 'refunded', outcome: 'goal_met' as const })));
  const r = await runConfigOnce(opts(realCfg(), { connectors: reg, models: m.api, caseFilter: 'persona.refund' }));
  const row = row0(r, 'persona.refund');
  assert.equal(row.status, 'pass', JSON.stringify(row.scores.filter((s) => s.label !== 'pass')));
  for (const x of r.rows) assert.deepEqual(validate(schema('result-2'), x), [], x.row_id);
  assert.deepEqual(row.persona?.stop, { kind: 'goal_met', reason: 'refunded', at_turn: 2 });
  assert.equal(row.persona?.metrics.turns_to_goal, 2);
  assert.deepEqual(row.persona?.metrics.reply_chars_per_turn, ['I can refund O-7 for 25 EUR. OK?'.length, 'Refunded 25 EUR.'.length]);
  assert.equal(row.persona?.metrics.language_match, true);
  assert.equal(m.calls[1].pending_hitl?.tool, 'issue_refund');
  assert.equal(m.calls[1].chat_approval, false, 'a structured request is pending');
  assert.ok(m.calls.every((c) => c.transcript.every((t) => t.role !== 'tool')));
  assert.ok(row.scores.some((s) => s.grader_id === 'approval_invariant' && s.label === 'pass'), 'the harness authored the approval');
  const po = row.scores.find((s) => s.grader_id === 'persona_outcome')!;
  assert.deepEqual([po.role, po.label, po.value, po.kind], ['advisory', 'pass', 1, 'judge']);
  assert.equal(po.judge?.model, 'judge-test');
  assert.equal(row.persona?.outcome?.tone_fit, 2);
  assert.equal(r.manifest.user_simulator.model, 'sim-test');
  const users = traj(r, row).steps.filter((s: any) => s.source === 'user');
  assert.deepEqual(users.map((s: any) => s.vibiz?.persona?.turn), [1, 2]);
  assert.equal(users[1].vibiz.hitl_turn.hitl, 'approve');
  const tr = visibleTranscript(traj(r, row).steps);
  assert.deepEqual(tr.map((x) => x.role), ['user', 'agent', 'user', 'agent']);
});

test('loop: a simulated reject is a harness-authored rejection (no refund: the agent did right, the case expectation fails)', async () => {
  const m = models((i) => (i.pending_hitl ? Promise.resolve({ hitl: 'reject' as const }) : i.turn_index === 0 ? Promise.resolve({ say: 'refund O-7' }) : Promise.resolve({ stop: true as const, reason: 'changed my mind', outcome: 'gave_up' as const })), { goal_met: 'no' });
  const r = await runConfigOnce(opts(realCfg(), { connectors: reg, models: m.api, caseFilter: 'persona.refund' }));
  const row = row0(r, 'persona.refund');
  assert.equal(row.status, 'fail');
  assert.equal(row.persona?.stop.kind, 'gave_up');
  assert.equal(row.trace.server_calls, 0);
  const ev = JSON.parse(readFileSync(join(r.runDir, row.trace.atif_uri), 'utf8')).vibiz.approval_events;
  assert.deepEqual(ev.map((e: any) => e.kind), ['hitl_reject']);
  assert.ok(row.scores.some((s) => s.grader_id === 'side_effects' && s.label === 'fail'));
  assert.equal(row.scores.find((s) => s.grader_id === 'persona_outcome')!.value, 0);
});

test('loop: max_user_turns stops the conversation without asking the simulator again', async () => {
  const m = models(() => Promise.resolve({ say: 'hello? anyone?' }));
  const r = await runConfigOnce(opts(realCfg(), { connectors: reg, models: m.api, caseFilter: 'persona.refund' }));
  const row = row0(r, 'persona.refund');
  assert.equal(row.persona?.stop.kind, 'max_turns');
  assert.equal(row.persona?.user_turns, 4, 'case override max_user_turns 4');
  assert.equal(row.persona?.metrics.turns_to_goal, null);
  assert.equal(m.calls.filter((c) => c.salt.startsWith('t0|')).length, 4);
});

test('loop: a simulator failure is INVALID (harness or provider), never an agent FAIL; no models package is INVALID too', async () => {
  const boom = await runConfigOnce(opts(realCfg(), { connectors: reg, models: models(() => Promise.reject(new Error('json garbage'))).api, caseFilter: 'persona.refund' }));
  assert.deepEqual([row0(boom, 'persona.refund').status, row0(boom, 'persona.refund').invalid_reason], ['invalid', 'harness_bug']);
  assert.match(row0(boom, 'persona.refund').error?.message ?? '', /user simulator failed/);
  const http = await runConfigOnce(opts(realCfg(), { connectors: reg, models: models(() => Promise.reject(new ModelHttpError('vertex: HTTP 503', 503))).api, caseFilter: 'persona.refund' }));
  assert.deepEqual([row0(http, 'persona.refund').status, row0(http, 'persona.refund').invalid_reason], ['invalid', 'infra_upstream_5xx']);
  const none = await runConfigOnce(opts(realCfg(), { connectors: reg, models: NO_MODELS, caseFilter: 'persona.refund' }));
  assert.deepEqual([row0(none, 'persona.refund').status, row0(none, 'persona.refund').invalid_reason], ['invalid', 'harness_bug']);
});

test('loop: k trials get their own salt and seed, so they are different conversations', async () => {
  const m = models((i) => (i.turn_index === 0 ? Promise.resolve({ say: `need a refund, try ${i.seed}` }) : Promise.resolve({ stop: true as const, reason: 'ok' })));
  const r = await runConfigOnce(opts(realCfg(), { connectors: reg, models: m.api, caseFilter: 'persona.refund' }));
  const a = row0(r, 'persona.refund', 0), b = row0(r, 'persona.refund', 1);
  const first = (row: typeof a) => traj(r, row).steps.find((s: any) => s.source === 'user').message;
  assert.notEqual(first(a), first(b));
  const salts = m.calls.filter((c) => c.turn_index === 0).map((c) => c.salt);
  assert.equal(new Set(salts).size, salts.length);
  assert.ok(salts.some((s) => s.startsWith('t0|')) && salts.some((s) => s.startsWith('t1|')), salts.join(' '));
  assert.equal(a.persona?.stop.kind, 'other', 'no outcome from the simulator -> other');
});

test('scripted simulator and language heuristics', async () => {
  const s = scriptedUserSimulator();
  const p = { id: 'p', temperament: ['busy'], goal: 'do X' };
  assert.deepEqual(await s.next({ persona: p, transcript: [], turn_index: 0, max_turns: 3, salt: 's' }), { say: 'do X' });
  assert.deepEqual(await s.next({ persona: p, transcript: [{ role: 'user', text: 'do X' }], pending_hitl: { tool: 't', args: {} }, turn_index: 1, max_turns: 3, salt: 's' }), { hitl: 'approve' });
  assert.equal(((await s.next({ persona: p, transcript: [{ role: 'user', text: 'do X' }], turn_index: 1, max_turns: 3, salt: 's' })) as any).outcome, 'goal_met');
  assert.equal(detectLanguage('Olá! Posso ajudar com o seu Instagram e também com os anúncios da padaria.'), 'pt');
  assert.equal(detectLanguage('¡Hola! Puedo ayudarte con tu Instagram y con los anuncios de la peluquería.'), 'es');
  assert.equal(detectLanguage('Hi! I can help you with your Instagram and the ads for the bakery.'), 'en');
  assert.equal(detectLanguage('ok'), null);
  assert.deepEqual(languageMatch(['Hi! I can help you with your posts and the ads.', 'Olá! Posso ajudar com o seu Instagram e também com os anúncios.'], ['pt', 'en']).match, true);
  assert.equal(languageMatch(['Hi! I can help you with your posts and the ads.'], ['es']).match, false);
  assert.equal(languageMatch(['Hi! I can help you with your posts.'], undefined).match, null);
});

test('CLI: ves run --simulator/--judge override one purpose (Vertex ids or named keys); ves personas list --json', async () => {
  const { overrideModel } = await import('../../src/cli/run.ts');
  const cfg = config((c) => { c.models = { default: { provider: 'vertex', model: 'google/gemini-3.8-flash', project: 'p1' }, named: { claude: { provider: 'vertex', model: 'anthropic/claude-sonnet-4-6' } } }; });
  overrideModel(cfg, 'user_simulator', 'anthropic/claude-sonnet-4-6');
  overrideModel(cfg, 'judge', 'claude');
  assert.deepEqual(cfg.models.user_simulator, { provider: 'vertex', model: 'anthropic/claude-sonnet-4-6', location: 'global', project: 'p1' });
  assert.equal(cfg.models.judge, 'claude');
  assert.ok(cfg.notes.some((n) => /models.user_simulator set on the command line/.test(n)));
  assert.throws(() => overrideModel(cfg, 'judge', 'gpt-4o'), /Vertex model id/);
  const { cmdPersonas } = await import('../../src/cli/personas.ts');
  let out = '';
  const code = await cmdPersonas({ _: ['list'], config: join(REPO, 'ves.config.json'), json: true } as never, {}, (s) => { out += s; });
  assert.equal(code, 0);
  const j = JSON.parse(out);
  assert.deepEqual(j.personas.map((p: any) => [p.id, p.cases]), [['refund-seeker', ['persona.refund']]]);
  assert.deepEqual(j.inline, [{ case: 'persona.lookup', id: 'hurried-agent' }]);
});

test('docs/writing-evals.md Personas section: its JSON examples are schema-valid and match the test fixture', () => {
  const md = readFileSync(join(ROOT, 'docs', 'writing-evals.md'), 'utf8');
  const sec = md.slice(md.indexOf('## 7. Personas'), md.indexOf('## 8. '));
  const blocks = [...sec.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.equal(blocks.length, 2);
  assert.deepEqual(validate(schema('persona-1'), blocks[0]), []);
  assert.deepEqual(validate(schema('case-2'), blocks[1]), []);
  const fx = JSON.parse(readFileSync(join(REPO, 'personas', 'refund-seeker.persona.json'), 'utf8'));
  assert.deepEqual(blocks[0], Object.fromEntries(Object.entries(fx).filter(([k]) => k !== 'notes')));
  const c = JSON.parse(readFileSync(join(REPO, 'cases', 'persona.refund.case.json'), 'utf8'));
  assert.deepEqual({ ...blocks[1], owner: c.owner, provenance: c.provenance }, c);
});

test('examples/personas: three library personas, one case each, refs resolve, twins, advisory outcome', async () => {
  const { loadConfig } = await import('../../src/config/load.ts');
  const cfg = loadConfig(join(ROOT, 'examples', 'personas', 'ves.config.json'), {});
  const p = await prepare({ harnessRoot: ROOT, config: cfg, tier: 'smoke' });
  assert.deepEqual([...p.errors, ...p.ruleErrors], []);
  assert.equal(p.cases.length, 3);
  for (const c of p.cases) {
    assert.ok(c.__persona?.ref, c.id);
    assert.ok(c.graders?.some((g) => g.id === 'persona_outcome' && g.role === 'advisory'), c.id);
  }
  assert.deepEqual(new Set(p.cases.map((c) => c.__persona!.ref)), new Set(['busy-refund-seeker', 'vague-spanish-speaker', 'irritable-account-holder']));
  assert.deepEqual(p.cases.find((c) => c.id === 'persona.login-status-es')!.__persona!.languages, ['es', 'en']);
  assert.ok(p.cases.find((c) => c.id === 'persona.refund-not-yours')!.__persona!.temperament.includes('goal_changing'));
  for (const id of ['persona.login-status-es', 'persona.refund-not-yours']) assert.equal(p.cases.find((c) => c.id === id)!.twin, 'persona.refund-broken-order');
});
