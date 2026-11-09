import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalMet, hasPersona, isPersonaOutcomeScore, personaLabel, personaOf, personaOutcomeScore, personaTable, simulatedTag, stepPersona, userTurns } from '../src/lib/persona.ts';
import { buildPath } from '../src/lib/path/model.ts';
import { caseGraph, alignPaths, type CaseTrial } from '../src/lib/path/align.ts';
import { trialLayout, caseLayout } from '../src/lib/path/layout.ts';
import type { Atif, Persona, ResultRow } from '../src/lib/types.ts';

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: 'busy-baker', name: 'Inês, owner of Padaria Estrela', temperament: ['busy', 'impatient'], goal: 'Post today’s specials', languages: ['pt', 'en'],
  max_user_turns: 6, user_turns: 3, stop: { kind: 'goal_met', reason: 'specials posted', at_turn: 3 }, simulator: { model: 'sim-1', prompt_sha256: 'abc' },
  metrics: { user_turns: 3, turns_to_goal: 3, reply_chars_per_turn: [120, 80, 40], mean_reply_chars: 80, language_match: true },
  outcome: { goal_met: 'yes', gave_up: false, frustration: 1, tone_fit: 2, why: 'short and in Portuguese' },
  ...over,
});
const outcomeScore = (value: number | null) => ({ grader_id: 'persona_outcome', name: 'ves.persona_outcome', role: 'advisory', kind: 'judge', value, label: value === null ? 'unknown' : value > 0 ? 'pass' : 'fail' });
const row = (surface: string, trial: number, p: Persona | undefined, extra: Partial<ResultRow> = {}): ResultRow => ({ row_id: `run1|c@1|${surface}|${trial}`, run_id: 'run1', case_id: 'c', surface, trial, status: 'pass', persona: p, ...extra });

test('personaOf / labels / score lookup are defensive', () => {
  assert.equal(personaOf(row('web', 0, undefined)), null);
  assert.equal(personaOf({ row_id: 'x', persona: 'nope' as unknown as Persona }), null);
  assert.equal(personaLabel(persona()), 'Inês, owner of Padaria Estrela');
  assert.equal(personaLabel({ id: 'cold-cfo' }), 'cold-cfo');
  assert.equal(personaLabel(null), '(persona)');
  assert.equal(userTurns({ metrics: { user_turns: 4 } }), 4);
  assert.equal(userTurns({}), null);
  const r = row('web', 0, persona(), { scores: [{ grader_id: 'call_match', label: 'pass' }, outcomeScore(1)] });
  assert.equal(personaOutcomeScore(r)?.grader_id, 'persona_outcome');
  assert.ok(isPersonaOutcomeScore({ name: 'ves.persona_outcome' }));
  assert.ok(!isPersonaOutcomeScore({ grader_id: 'call_match' }));
  assert.ok(hasPersona([row('web', 0, undefined), r]));
  assert.ok(!hasPersona([row('web', 0, undefined)]));
  assert.ok(!hasPersona(null));
});

test('goalMet reads the outcome block, else the score value', () => {
  assert.equal(goalMet(row('w', 0, persona())), 'yes');
  assert.equal(goalMet(row('w', 0, persona({ outcome: undefined }), { scores: [outcomeScore(0.5)] })), 'partly');
  assert.equal(goalMet(row('w', 0, persona({ outcome: undefined }), { scores: [outcomeScore(0)] })), 'no');
  assert.equal(goalMet(row('w', 0, persona({ outcome: undefined }))), 'unknown');
  assert.equal(goalMet(row('w', 0, persona({ outcome: { goal_met: 'bogus' } }), { scores: [outcomeScore(null)] })), 'unknown');
});

test('stepPersona and simulatedTag label simulated user steps', () => {
  assert.deepEqual(stepPersona({ source: 'user', vibiz: { persona: { id: 'busy-baker', turn: 2, source: 'simulator' } } }), { id: 'busy-baker', turn: 2, source: 'simulator' });
  assert.equal(stepPersona({ source: 'user', message: 'hi' }), null);
  assert.equal(stepPersona(null), null);
  assert.equal(simulatedTag({ id: 'busy-baker', source: 'opening' }, persona()), 'opening · Inês, owner of Padaria Estrela');
  assert.equal(simulatedTag({ id: 'other', source: 'simulator' }, persona()), 'simulated · other');
  assert.equal(simulatedTag({ id: 'busy-baker' }, null), 'simulated · busy-baker');
});

test('personaTable: persona × column with goal counts and means, skips and non-persona rows left out', () => {
  const rows = [
    row('web', 0, persona(), { scores: [outcomeScore(1)] }),
    row('web', 1, persona({ user_turns: 5, outcome: { goal_met: 'no', frustration: 3, tone_fit: 0 } })),
    row('web', 2, persona({ user_turns: 4, outcome: { goal_met: 'unknown', frustration: null, tone_fit: null } })),
    row('slack', 0, persona({ user_turns: 2, outcome: { goal_met: 'partly', frustration: 2, tone_fit: 1 } })),
    row('slack', 1, persona(), { status: 'skip' }),
    row('web', 3, persona({ id: 'cold-cfo', name: undefined, outcome: undefined }), { scores: [outcomeScore(0.5)] }),
    row('web', 4, undefined),
  ];
  const t = personaTable(rows, (r) => r.surface!, ['slack', 'web', 'unused']);
  assert.deepEqual(t.columns, ['slack', 'web']);
  assert.deepEqual(t.rows.map((r) => [r.key, r.label]), [['busy-baker', 'Inês, owner of Padaria Estrela'], ['cold-cfo', 'cold-cfo']]);
  const web = t.rows[0].cells.web;
  assert.equal(web.trials, 3);
  assert.deepEqual([web.yes, web.partly, web.no, web.unknown], [1, 0, 1, 1]);
  assert.equal(web.goalShare, 0.5);
  assert.equal(web.meanUserTurns, 4);
  assert.equal(web.meanFrustration, 2);
  assert.equal(web.meanToneFit, 1);
  assert.equal(t.rows[0].cells.slack.trials, 1); // the skipped trial is not counted
  const cfo = t.rows[1].cells.web;
  assert.deepEqual([cfo.partly, cfo.goalShare, cfo.meanFrustration], [1, 0, null]);
  assert.equal(t.rows[1].cells.slack, undefined);
  assert.deepEqual(personaTable([row('web', 0, undefined)], (r) => r.surface!), { columns: [], rows: [] });
});

// ------------------------------------------------------------------------------------- path canvas on persona trials
const sim = (turn: number, text: string, source: 'simulator' | 'opening' = 'simulator') => ({ source: 'user', message: text, vibiz: { persona: { id: 'busy-baker', turn, source } } });
const reply = (text: string) => ({ source: 'agent', message: text });
const atif = (steps: unknown[]): Atif => ({ schema_version: 'ATIF-v1.8', steps: steps.map((s, i) => ({ step_id: i + 1, ...(s as object) })), vibiz: { persona: { id: 'busy-baker', stop: { kind: 'goal_met', reason: 'done', at_turn: steps.length } } } } as Atif);
const personaCtx = { catalog: null, config: null, case: { id: 'c', version: 1, input: { turns: [{ persona: { ref: 'busy-baker' } }] } } } as const;

test('path model: persona trials with different user-turn counts build, align and aggregate', () => {
  const short = atif([sim(1, 'Olá, preciso dos especiais de hoje', 'opening'), reply('Claro! Quais são?'), sim(2, 'Pastel de nata e broa'), reply('Publicado.')]);
  const long = atif([
    sim(1, 'Olá, preciso dos especiais de hoje', 'opening'), reply('Pode dizer-me mais?'),
    sim(2, 'Pastel de nata'), reply('E mais?'),
    sim(3, 'Sim, publique'), reply('Posso publicar?'), { source: 'user', message: '[hitl:approve]', vibiz: { hitl_turn: { hitl: 'approve' }, persona: { id: 'busy-baker', turn: 4, source: 'simulator' } } },
    reply('Feito.'),
  ]);
  const scored = (trial: number, status: string): ResultRow => ({ ...row('eve/web', trial, persona()), status, scores: [{ ...outcomeScore(0), explanation: 'goal not met' }] });
  const gs = buildPath({ atif: short, row: scored(0, 'pass'), context: personaCtx as never });
  const gl = buildPath({ atif: long, row: scored(1, 'fail'), context: personaCtx as never });
  // no boundary invented from the case's persona block; simulated user nodes carry the tag
  assert.ok(!gs.nodes.some((n) => n.kind === 'boundary'));
  assert.deepEqual(gs.turns.map((t) => t.index), [1, 2]);
  assert.deepEqual(gl.turns.map((t) => t.index), [1, 2, 3, 4]);
  const users = gs.nodes.filter((n) => n.kind === 'user');
  assert.equal(users[0].persona?.source, 'opening');
  assert.ok(users.every((n) => n.flags.includes('simulated')));
  const dec = gl.nodes.find((n) => n.kind === 'approval_decision')!;
  assert.equal(dec.decision, 'approve');
  assert.equal(dec.persona?.id, 'busy-baker');
  // the advisory persona_outcome is drawn but never marks a step failing
  assert.ok(gs.nodes.some((n) => n.kind === 'verdict' && n.verdict?.name === 'persona_outcome'));
  assert.equal(gs.stats.failingChecks, 0);
  assert.ok(!gs.nodes.some((n) => n.failing));
  // alignment, case aggregate and layouts cope with unequal turn counts
  const pairs = alignPaths(gs, gl);
  assert.ok(pairs.some((p) => p.match === 'b'));
  const trials: CaseTrial[] = [gs, gl].map((g, i) => ({ key: `k${i}`, runId: 'run1', rowId: g.rowId!, trial: i, status: g.status, caseVersion: 1, created: null, graph: g }));
  const cg = caseGraph(trials);
  assert.ok(cg.nodes.some((n) => n.id === 'user:2'));
  assert.ok(cg.nodes.some((n) => n.id === 'user:3' && n.trials.length === 1));
  const L = trialLayout(gl);
  assert.ok(gl.nodes.filter((n) => n.sequential).every((n) => L.pos.has(n.id)));
  assert.ok(Number.isFinite(caseLayout(cg).width));
});
