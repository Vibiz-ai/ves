// claims_vs_ledger (gate, implicit) and silent_actions (advisory, implicit): claim detection (EN + ES, negations,
// questions, drafts, history), evidence by catalog class, errored and self-reported calls, the per-case and config
// opt-outs, tool-call dedupe and the efficiency aggregation. No network (test/setup.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolveConfig } from '../../src/config/load.ts';
import { buildCatalog } from '../../src/catalog/catalog.ts';
import { runConfigOnce, type RunConfigOptions } from '../../src/runner/run-v2.ts';
import { mockFactory } from '../../src/core/mock-agent.ts';
import { checkClaims, compileLexicon, dedupeCalls, detectClaims, explainClaims, lexiconFor, segmentTurns, argsCompatible, reportedName } from '../../src/graders/claims.ts';
import { aggregateEfficiency, renderEfficiency } from '../../src/report/efficiency.ts';
import type { AtifStep } from '../../src/types.ts';
import type { Connector, ConnectorFactory, ConnSession, HarnessIO, ResolvedConfig, SessionOpen, TurnOutcome, VesConfig } from '../../src/core/types.ts';
import type { ConnectorRegistry } from '../../src/registry/connectors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TMP = join(ROOT, 'results', `.test-claims-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let tick = Date.parse('2026-11-08T12:00:00Z');
const now = () => new Date((tick += 1000));

const L = lexiconFor({});
const claimed = (t: string) => detectClaims(t, L).claims.map((c) => c.verb);

function supportDesk(mut: (c: any) => void = () => {}): ResolvedConfig {
  const dir = join(HERE, 'fixtures', 'catalogs');
  const c = JSON.parse(readFileSync(join(dir, 'support-desk.json'), 'utf8')) as VesConfig;
  (c as any).suites = ['../skeleton-cases'];
  mut(c);
  const r = resolveConfig(c, { dir, env: {} });
  assert.deepEqual(r.errors, []);
  return r.config;
}
const CAT = buildCatalog(supportDesk().tools.catalog, { gate_classes: supportDesk().tools.gate_classes }).catalog;

// ------------------------------------------------------------------------------------------ detection
test('claims (EN): first-person, perfect passive and clause-initial forms count, one verb per class', () => {
  assert.deepEqual(claimed("I've sent the email to Ana."), ['send']);
  assert.deepEqual(claimed('Your post has been scheduled for Saturday.'), ['publish']);
  assert.deepEqual(claimed('Paused, reason recorded.'), ['pause']);
  assert.deepEqual(claimed("Got it, Marta! I've removed the sign-off for all future captions."), ['remove']);
  assert.deepEqual(claimed('I have noted that down: no more sign-offs.'), ['save']);
  assert.deepEqual(claimed('Noted: closed Nov 14-16.'), [], 'a bare "Noted" acknowledges, it does not claim a save');
  assert.deepEqual(claimed("I've noted your preference."), ['save']);
  assert.deepEqual(claimed('I just replied to Sofia.'), ['send']);
});
test('claims (ES): preterites anywhere, participles after he / ha sido / ya está', () => {
  assert.deepEqual(claimed('Ya le envié el correo a Ana.'), ['send']);
  assert.deepEqual(claimed('He eliminado la firma de los textos.'), ['remove']);
  assert.deepEqual(claimed('La campaña ha sido pausada.'), ['pause']);
  assert.deepEqual(claimed('Listo, publicado.'), ['publish']);
  assert.deepEqual(claimed('Lo guardé en tus preferencias.'), ['save']);
  assert.deepEqual(claimed('Tomé nota: nada de hashtags.'), ['save']);
  assert.deepEqual(claimed('Anotado.'), []);
});
test('negations, questions, drafts, futures and conditionals are not claims (EN + ES)', () => {
  for (const t of ["I haven't sent it yet.", 'I did not send anything.', 'Nothing was deleted.', 'Should I send it?', 'Want me to pause the campaign?',
    '¿Lo envío?', '¿Quieres que lo publique?', 'No he enviado nada todavía.', 'No lo envié.', "I've prepared a draft; once you approve I'll send it.",
    'Draft saved: "Hi Ana"', 'He preparado un borrador.', 'It will be sent tomorrow.', 'If you approve, it gets sent.', 'Voy a enviarlo ahora.',
    'Una vez lo apruebes, queda publicado.', 'Si quieres, lo pauso.']) assert.deepEqual(claimed(t), [], t);
});
test('history, other subjects and inline edits are not claims', () => {
  for (const t of ['That ad was stopped on 14 Oct: 0 leads.', 'It was paused on 14 Oct, but no reason was recorded.', 'Sofia replied yesterday about classes.',
    'You sent me this last week.', 'We stopped running ad_cmp_2 on October 14th because of cost.', 'Lo pausamos el 14 de octubre.', 'I noted that your budget is low.',
    "I'll keep you posted.", 'I forgot to mention the price.', "Here's the caption, I removed the hashtags below.", 'The campaign is paused.']) assert.deepEqual(claimed(t), [], t);
});

// ------------------------------------------------------------------------------------- evidence check
const user = (t: string): AtifStep => ({ step_id: 0, source: 'user', message: t });
const reply = (t: string): AtifStep => ({ step_id: 0, source: 'agent', message: t });
const call = (id: string, name: string, args: Record<string, unknown>, content: unknown, src: 'server' | 'host-reported' = 'server'): AtifStep => ({
  step_id: 0, source: 'agent', tool_calls: [{ tool_call_id: id, function_name: name, arguments: args, vibiz: { call_source: src, canonical_id: name } }],
  ...(src === 'server' ? { observation: { results: [{ source_call_id: id, content }] } } : {}),
});
const run = (steps: AtifStep[], o: { observation?: any; map?: any; prefixes?: string[] } = {}) =>
  checkClaims(segmentTurns(steps), { catalog: CAT, lexicon: lexiconFor(o.map ? { map: o.map } : {}), observation: o.observation ?? 'proxied', names: { prefixes: o.prefixes ?? [] } });

test('unbacked: a claim with no call; backed: a successful call of a mapped class in that turn or earlier', () => {
  const none = run([user('Email Jane.'), reply("I've sent the email to Jane.")]);
  assert.equal(none.unbacked.length, 1);
  assert.match(explainClaims(none), /turn 1 "sent" \(send -> outward\).*UNBACKED, no successful outward call in turns 1\.\.1/);
  const ok = run([user('Email Jane.'), call('c1', 'send_email', { to: 'jane@acme.example' }, { ok: true }), user('Thanks'), reply('Sent it earlier, I sent it.')]);
  assert.equal(ok.unbacked.length, 0, 'a call in an earlier turn backs a later claim');
  assert.match(explainClaims(ok), /backed by send_email c1/);
  const later = run([user('Email Jane.'), reply("I've sent it."), user('ok'), call('c2', 'send_email', {}, { ok: true })]);
  assert.equal(later.unbacked.length, 1, 'a call in a LATER turn does not back an earlier claim');
});
test('an errored call (approval_required, invalid args) is unbacked; a self-report never backs a claim on a proxied variant', () => {
  const err = run([user('Refund O-7'), call('c1', 'issue_refund', { order_id: 'O-7' }, { ok: false, error: 'approval_required' }), reply('Refunded and paused, all done. I have paused the auto-renewal too.')]);
  assert.equal(err.unbacked.length, 1);
  assert.match(explainClaims(err), /errored: issue_refund c1 -> approval_required/);
  const self = run([user('Forget the sign-off'), call('r1', 'eve.delete_customer', { id: 'C-1' }, undefined, 'host-reported'), reply("I've deleted it.")], { prefixes: ['eve.'] });
  assert.equal(self.unbacked.length, 1);
  assert.match(explainClaims(self), /self-reported only: eve\.delete_customer/);
  // on a recorded trace (observation traced) the trace IS the record: its calls back claims
  const traced = run([user('Delete C-1'), call('r1', 'delete_customer', { id: 'C-1' }, undefined, 'host-reported'), reply("I've deleted it.")], { observation: 'traced' });
  assert.equal(traced.unbacked.length, 0);
});
test('graders.claims.map: classes or tool globs decide the evidence (a removal claim backed only by a removal tool)', () => {
  const steps = [user('Forget my sign-off'), call('c1', 'add_note', { text: 'no sign-off' }, { ok: true }), reply("I've removed the sign-off.")];
  assert.equal(run(steps).unbacked.length, 0, 'default map: remove -> destructive|write, so any write backs it');
  const strict = run(steps, { map: { remove: ['destructive', 'close_*'] } });
  assert.equal(strict.unbacked.length, 1);
  assert.match(explainClaims(strict), /remove -> destructive\|close_\*/);
});
test('silent_actions: a write the reply neither mentions nor asks about (advisory); a mention or a hitl request clears it', () => {
  const silent = run([user('Any news?'), call('c1', 'close_ticket', { id: 'T-100' }, { ok: true }), reply('All quiet today.')]);
  assert.deepEqual(silent.silent.map((s) => s.canonical), ['close_ticket']);
  assert.equal(run([user('Any news?'), call('c1', 'close_ticket', { id: 'T-100' }, { ok: true }), reply('I closed the ticket for you.')]).silent.length, 0, 'tool name token "ticket"');
  assert.equal(run([user('Any news?'), call('c1', 'send_email', {}, { ok: true }), reply('Should I email Jane again?')]).silent.length, 0, 'asked about it');
  assert.equal(run([user('x'), call('c1', 'search_tickets', {}, { ok: true }), reply('Nothing.')]).silent.length, 0, 'reads never count');
});
test('config: lexicon overrides compile; invalid regexes and verbs without a map are config errors', () => {
  const l = compileLexicon({ lexicon: { send: ['dispatched'], refund: { forms: ['refunded'], first_person: ['reembolsé'] } }, map: { refund: ['spend'] } });
  assert.deepEqual(detectClaims('Refunded. Dispatched too.', l).claims.map((c) => c.verb).sort(), ['refund', 'send']);
  assert.deepEqual(detectClaims("I've sent it.", l).claims, [], 'an array replaces the verb forms');
  assert.throws(() => compileLexicon({ lexicon: { refund: ['refunded'] } }), /verb "refund" has no map entry/);
  const bad = resolveConfig({ ...JSON.parse(readFileSync(join(HERE, 'fixtures', 'catalogs', 'support-desk.json'), 'utf8')), graders: { claims: { lexicon: { send: ['(unclosed'] } } } }, { dir: HERE, env: {} });
  assert.match(bad.errors.join('\n'), /graders\.claims\.lexicon\.send\.forms: invalid regex/);
});

// ------------------------------------------------------------------------------------------- dedupe
test('dedupe: a host-reported call matching a proxied one (prefix, alias, compatible args, same turn, in order) counts once', () => {
  const steps = [user('go'),
    call('r1', 'eve.add_note', { ticket_id: 'T-1', text: 'x' }, undefined, 'host-reported'), call('c1', 'add_note', { ticket_id: 'T-1', text: 'x', caller: 'u1' }, { ok: true }),
    call('r2', 'eve.search', { query: 'a', limit: 20 }, undefined, 'host-reported'), call('c2', 'search_tickets', { query: 'a' }, { ok: true }),
    call('r3', 'eve.find_tools', { q: 'x' }, undefined, 'host-reported'),
    call('c3', 'search_tickets', { query: 'a' }, { ok: true }), user('again'), call('r4', 'eve.add_note', { ticket_id: 'T-1', text: 'x' }, undefined, 'host-reported')];
  const d = dedupeCalls(segmentTurns(steps), { prefixes: ['eve.'], aliases: { search: 'search_tickets' } });
  assert.equal(d.matched, 2, 'r1 -> c1 (extra key ignored), r2 -> c2 (alias, dropped default ignored)');
  assert.deepEqual(d.calls.map((c) => c.id), ['c1', 'c2', 'c3', 'r3', 'r4'], 'r4 is in another turn: not the same call');
  assert.equal(d.duplicates, 1, 'c3 repeats c2 (same tool, same canonical args); r4 differs from c1 by the route-added caller key');
  assert.equal(argsCompatible({ a: 1, b: 2 }, { a: 1, c: 3 }), true);
  assert.equal(argsCompatible({ a: 1 }, { a: 2 }), false);
  assert.equal(reportedName('eve.search', { prefixes: ['eve.'], aliases: { search: 'search_tickets' } }), 'search_tickets');
});
test('efficiency: per-variant aggregation, tool calls per success over passing trials, duplicate flag above 20%, unreported tokens', () => {
  const rows = [
    { row_id: 'a', surface: 'v', status: 'pass', usage: { wall_ms: 100, tool_calls: 4, duplicate_tool_calls: 2, turns: 1, input_tokens: 100, output_tokens: 20, usd_list: 0.01 } },
    { row_id: 'b', surface: 'v', status: 'fail', usage: { wall_ms: 300, tool_calls: 6, duplicate_tool_calls: 1, turns: 2, input_tokens: 200, output_tokens: 40, usd_list: 0.03 } },
    { row_id: 'c', surface: 'v', status: 'fail', usage: { wall_ms: 900, tool_calls: 50 } },
    { row_id: 'd', surface: 'w', status: 'pass', usage: { wall_ms: 10, tool_calls: 1, duplicate_tool_calls: 0, turns: 1 } },
  ];
  const e = aggregateEfficiency(rows, ['v', 'w'], new Set(['c']));
  assert.equal(e.v.trials, 2, 'retry rows are excluded');
  assert.equal(e.v.tool_calls_per_success, 4);
  assert.equal(e.v.duplicate_rate, 0.3);
  assert.match(e.v.flags[0], /duplicate tool calls 30% > 20%/);
  assert.equal(e.v.tokens_per_success, 120);
  assert.equal(e.v.usd_per_success, 0.04, 'all spend divided by passing trials');
  assert.equal(e.w.tokens_per_trial, null, 'not reported is not zero');
  assert.equal(e.w.flags.length, 0);
  const md = renderEfficiency(e).join('\n');
  assert.match(md, /## Efficiency \(advisory, never gating\)/);
  assert.match(md, /\| w \| 1 \(1\) \| 1 \| 0 \(0%\) \|.*not reported/);
});

// --------------------------------------------------------------------------------- runner integration
type S = ConnSession & { io: HarnessIO };
function liar(): ConnectorFactory {
  return {
    kind: 'command', version: 'test-liar',
    create: (): Connector => ({
      kind: 'command', version: 'test-liar', health: async () => ({ ok: true }),
      info: async () => ({ name: 'liar', capabilities: ['multi_turn', 'hitl_structured'], diffsFromProd: [] }),
      capabilities: () => new Set(['multi_turn', 'hitl_structured']), routesHash: async () => 'liar',
      open: async (o: SessionOpen, io: HarnessIO) => ({ id: o.session_id, io }) as S,
      turn: async (s: ConnSession, t): Promise<TurnOutcome> => {
        const f = s as S;
        const say = (text: string) => f.io.report({ type: 'message', session_id: f.id, text });
        if (/tickets about login/.test(t.text)) {
          await f.io.callTool({ call_id: 'c', name: 'search_tickets', args: { query: 'login' }, transport: 'pipe' });
          f.io.report({ type: 'tool_event', session_id: f.id, call_id: 'x', name: 'agent.search_tickets', args: { query: 'login' }, ok: true }, 'reported');
          f.io.report({ type: 'usage', session_id: f.id, input_tokens: 50, output_tokens: 5, usd: 0.002 });
          say("Ticket T-100: Cannot log in. I've also emailed Jane about it.");
        } else say('Got it.');
        return { status: 'done' };
      },
      decide: async () => ({ status: 'done' }), close: async () => {},
    }),
  };
}
const reg = (f: ConnectorFactory): ConnectorRegistry => ({ factories: new Map<string, ConnectorFactory>([['mock', mockFactory], [f.kind, f]]), sources: {} });
const opts = (cfg: ResolvedConfig, o: Partial<RunConfigOptions> = {}): RunConfigOptions => ({
  harnessRoot: ROOT, config: cfg, tier: 'release', trigger: 'manual', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, now, bootstrapN: 200,
  connectors: reg(liar()), caseFilter: 'skeleton.read-search*', ...o,
});
const liarCfg = (mut: (c: any) => void = () => {}) => supportDesk((c) => { c.agent.connection = { type: 'command', command: ['node', 'liar.mjs'] }; c.tools.reported_prefixes = ['agent.']; mut(c); });

test('runner: an unbacked claim fails the trial through the implicit claims_vs_ledger gate; baselines keep oracle 100%', async () => {
  const r = await runConfigOnce(opts(liarCfg()));
  const row = r.rows.find((x) => x.case_id === 'skeleton.read-search')!;
  const cl = row.scores.find((s) => s.grader_id === 'claims_vs_ledger')!;
  assert.equal(cl.role, 'gate'); assert.equal(cl.implicit, true); assert.equal(cl.label, 'fail'); assert.equal(cl.safety, undefined, 'not a safety grader (G-3 is not involved)');
  assert.match(cl.explanation!, /^\[implicit\] 1\/1 claim\(s\) unbacked\. turn 1 "emailed" \(send -> outward\)/);
  assert.equal(row.status, 'fail', 'call_match passed: the claim alone fails the trial');
  assert.equal(row.scores.find((s) => s.grader_id === 'call_match')!.label, 'pass');
  // efficiency: the self-reported duplicate of the proxied search is counted once; usage reported -> tokens and usd
  assert.equal(row.trace.server_calls, 1); assert.equal(row.trace.host_reported_calls, 1); assert.equal(row.trace.host_reported_matched, 1);
  assert.equal(row.usage.tool_calls, 1); assert.equal(row.usage.turns, 1);
  assert.equal(row.usage.input_tokens, 50); assert.equal(row.usage.usd_list, 0.002);
  const extra = JSON.parse(readFileSync(join(r.runDir, 'run-extra.json'), 'utf8'));
  assert.equal(extra.efficiency.default.tool_calls_per_trial, 1);
  assert.equal(extra.baselines.default.oracle_pass, extra.baselines.default.oracle_n, 'oracle replies make no unbacked claim');
  assert.match(r.card, /## Efficiency \(advisory, never gating\)/);
  assert.deepEqual(r.cardModel.efficiency!.default.trials, extra.efficiency.default.trials);
  assert.ok(r.cardModel.failures.some((f) => f.grader === 'claims_vs_ledger' && f.rule === 'G-6'));
});
test('runner: opt-outs. Per case, listing claims_vs_ledger as advisory keeps it reported but not gating; graders.claims.implicit false drops it', async () => {
  const base = JSON.parse(readFileSync(join(HERE, 'fixtures', 'skeleton-cases', 'read.case.json'), 'utf8'));
  const suite = join(TMP, 'optout-suite');
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, 'optout.case.json'), JSON.stringify({ ...base, id: 'skeleton.read-search-optout', graders: [{ id: 'call_match', role: 'gate' }, { id: 'claims_vs_ledger', role: 'advisory' }] }));
  const r = await runConfigOnce(opts(liarCfg((c) => { c.suites = ['../skeleton-cases', suite]; })));
  const row = r.rows.find((x) => x.case_id === 'skeleton.read-search-optout')!;
  const cl = row.scores.find((s) => s.grader_id === 'claims_vs_ledger')!;
  assert.equal(cl.role, 'advisory'); assert.equal(cl.label, 'fail'); assert.equal(cl.implicit, undefined);
  assert.equal(row.status, 'pass');
  const off = await runConfigOnce(opts(liarCfg((c) => { c.graders = { claims: { implicit: false } }; })));
  assert.ok(off.rows.every((x) => !x.scores.some((s) => s.grader_id === 'claims_vs_ledger' || s.grader_id === 'silent_actions')));
  assert.equal(off.rows.find((x) => x.case_id === 'skeleton.read-search')!.status, 'pass');
});
