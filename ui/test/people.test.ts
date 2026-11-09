import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCENTS, agentName, buildPeople, caseGroups, chatItems, chatTone, firstName, hasChat, initials, personaAccent, personaIdOf, personaRole,
  rowsByPerson, runTitle, siblingTrials, sortConversations, statsOf,
} from '../src/lib/people.ts';
import type { AtifStep, Persona, PersonaConversation, PersonasResponse } from '../src/lib/types.ts';

test('identity: stable accent, first name, role and initials', () => {
  assert.equal(personaAccent('busy-lisbon-baker'), personaAccent('busy-lisbon-baker'));
  assert.ok(ACCENTS.includes(personaAccent('anyone')));
  assert.ok(ACCENTS.includes(personaAccent(null)));
  // the six Eve personas get six different colours
  const ids = ['busy-lisbon-baker', 'goal-changing-coffee-owner', 'irritable-barber', 'madrid-salon-owner', 'sceptical-gym-owner', 'vague-yoga-founder'];
  assert.equal(new Set(ids.map((i) => personaAccent(i).key)).size, 6);
  assert.equal(firstName('Inês, owner of Padaria Estrela (Lisbon)'), 'Inês');
  assert.equal(firstName('Mary Jane'), 'Mary Jane');
  assert.equal(firstName(null), '');
  assert.equal(personaRole('Inês, owner of Padaria Estrela (Lisbon)'), 'owner of Padaria Estrela (Lisbon)');
  assert.equal(personaRole('Rui'), '');
  assert.equal(initials('Inês, owner of Padaria Estrela'), 'I');
  assert.equal(initials('Mary jane, CFO'), 'MJ');
  assert.equal(initials(null, 'cold-cfo'), 'CC');
  assert.equal(initials('', ''), '?');
});

test('runTitle: personas, case groups, fallback', () => {
  assert.equal(runTitle({ personas: [{ id: 'a', name: 'Ana, x' }, { id: 'b', name: null }], case_ids: ['eve.persona.a', 'eve.persona.b'], surfaces: ['eve/imessage'] }), '2 personas · eve/imessage');
  assert.equal(runTitle({ personas: [{ id: 'sceptical-gym-owner', name: 'Marco, owner of Ironworks Gym' }], case_ids: ['eve.persona.sceptical-gym-owner'], surfaces: ['eve/imessage'] }), 'Marco · eve/imessage');
  assert.equal(runTitle({ personas: [{ id: 'a', name: null }, { id: 'b', name: null }], case_ids: ['eve.persona.a', 'eve.persona.b', 'eve.bench.x'], surfaces: ['w', 'x', 'y'] }), '2 personas · +1 case · 3 surfaces');
  const newuser = Array.from({ length: 7 }, (_, i) => `eve.newuser.c${i}`);
  assert.equal(runTitle({ case_ids: newuser, surfaces: ['eve/imessage'] }), 'newuser · 7 cases');
  const mixed = [...Array.from({ length: 17 }, (_, i) => `eve.bench.b${i}`), ...Array.from({ length: 7 }, (_, i) => `eve.memory.m${i}`), ...Array.from({ length: 5 }, (_, i) => `eve.xsession.x${i}`)];
  assert.equal(runTitle({ case_ids: mixed }), 'bench · memory · xsession · 29 cases');
  assert.deepEqual(caseGroups(['a.b.c', 'a.b.d', 'a.e.f']), [{ group: 'b', count: 2 }, { group: 'e', count: 1 }]);
  assert.deepEqual(caseGroups(['smoke.one', 'smoke.two', 'demo.x']), [{ group: 'smoke', count: 2 }, { group: 'demo', count: 1 }]);
  assert.equal(runTitle({ case_ids: ['a.b.c', 'a.d.e', 'a.f.g', 'a.h.i'] }), 'b · d · f +1 · 4 cases');
  assert.equal(runTitle({ tier: 'smoke', trigger: 'manual' }), 'smoke · manual');
});

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: 'busy-baker', name: 'Inês, owner of Padaria Estrela', temperament: ['busy'], goal: 'Post the specials', languages: ['pt'], background: 'Bakes',
  user_turns: 3, stop: { kind: 'goal_met' }, outcome: { goal_met: 'yes', gave_up: false, frustration: 1, tone_fit: 3 }, ...over,
});
const conv = (run: string, created: string, trial: number, over: Partial<PersonaConversation> = {}): PersonaConversation => ({
  run_id: run, run_created: created, created_at: null, row_id: `${run}|eve.persona.busy-baker@1|imessage|${trial}`, case_id: 'eve.persona.busy-baker', surface: 'imessage',
  trial, status: 'pass', invalid_reason: null, skip_reason: null, agent_model: 'm1', persona_id: 'busy-baker', persona: persona(), preview: { user: 'olá', agent: 'Hi', user_messages: 3 }, ...over,
});

test('chatTone and statsOf: outcome colours, INVALID and skips kept apart', () => {
  assert.equal(chatTone({ status: 'pass', persona: persona() }), 'good');
  assert.equal(chatTone({ status: 'pass', persona: persona({ outcome: { goal_met: 'partly' } }) }), 'mixed');
  assert.equal(chatTone({ status: 'pass', persona: persona({ outcome: { goal_met: 'no' } }) }), 'bad');
  assert.equal(chatTone({ status: 'fail', persona: persona() }), 'bad');
  assert.equal(chatTone({ status: 'invalid', persona: null }), 'invalid');
  assert.equal(chatTone({ status: 'skip', persona: null }), 'skip');
  assert.equal(chatTone({ status: 'pass', persona: null }), 'good');
  assert.equal(chatTone({ status: null, persona: null }), 'unknown');
  const s = statsOf([
    { status: 'pass', persona: persona() },
    { status: 'pass', persona: persona({ outcome: { goal_met: 'no', gave_up: true, frustration: 3, tone_fit: 1 }, user_turns: 5 }) },
    { status: 'pass', persona: persona({ outcome: { goal_met: 'unknown' } }) },
    { status: 'invalid', persona: null },
    { status: 'skip', persona: null },
  ]);
  assert.deepEqual([s.trials, s.judged, s.yes, s.no, s.unknown, s.invalid, s.skipped, s.gaveUp], [5, 2, 1, 1, 1, 1, 1, 1]);
  assert.equal(s.meanFrustration, 2);
  assert.equal(s.meanToneFit, 2);
  assert.equal(s.meanUserTurns, 11 / 3);
  assert.equal(statsOf([]).meanFrustration, null);
});

test('buildPeople merges the library with conversations across runs, newest first', () => {
  const resp: PersonasResponse = {
    library: [
      { id: 'busy-baker', name: 'Inês (library)', background: 'lib bg', languages: ['pt', 'en'], temperament: ['eager'], style: null, opening: 'olá!', max_user_turns: 6, notes: null, file: 'packs/p/personas/busy-baker.persona.json' },
      { id: 'quiet-one', name: 'Quinn, florist', background: null, languages: [], temperament: [], style: null, opening: null, max_user_turns: null, notes: null, file: 'q.persona.json' },
    ],
    runs: [],
    conversations: [
      conv('run-old', '2026-11-08T10:00:00Z', 1, { status: 'invalid', persona: null }),
      conv('run-old', '2026-11-08T10:00:00Z', 0, { status: 'invalid', persona: null }),
      conv('run-new', '2026-11-09T10:00:00Z', 1, { persona: persona({ outcome: { goal_met: 'partly', frustration: 2 } }) }),
      conv('run-new', '2026-11-09T10:00:00Z', 0),
      conv('run-x', '2026-11-09T09:00:00Z', 0, { persona_id: 'stranger', persona: null }),
    ],
  };
  const people = buildPeople(resp);
  assert.deepEqual(people.map((p) => p.id), ['busy-baker', 'quiet-one', 'stranger']); // by name: Inês…, Quinn…, stranger
  const ines = people[0];
  assert.equal(ines.name, 'Inês, owner of Padaria Estrela'); // the row's block wins over the library name
  assert.equal(ines.background, 'Bakes');
  assert.deepEqual(ines.languages, ['pt']);
  assert.equal(ines.opening, 'olá!');
  assert.equal(ines.inLibrary, true);
  assert.deepEqual(ines.conversations.map((c) => `${c.run_id}:${c.trial}`), ['run-new:0', 'run-new:1', 'run-old:0', 'run-old:1']);
  assert.deepEqual(ines.runs.map((r) => r.run_id), ['run-new', 'run-old']);
  assert.equal(ines.latest?.run_id, 'run-new');
  assert.deepEqual([ines.latest!.stats.yes, ines.latest!.stats.partly, ines.latest!.stats.meanFrustration], [1, 1, 1.5]);
  assert.equal(ines.runs[1].stats.invalid, 2);
  const quinn = people[1];
  assert.equal(quinn.conversations.length, 0);
  assert.equal(quinn.latest, null);
  assert.equal(people[2].name, 'stranger');
  assert.equal(people[2].inLibrary, false);
  assert.deepEqual(buildPeople(null), []);
  assert.deepEqual(sortConversations([conv('a', '2026-01-01', 2), conv('b', '2026-02-01', 0), conv('a', '2026-01-01', 0)]).map((c) => `${c.run_id}${c.trial}`), ['b0', 'a0', 'a2']);
});

test('personaIdOf / rowsByPerson / siblingTrials', () => {
  assert.equal(personaIdOf({ persona: persona() }), 'busy-baker');
  assert.equal(personaIdOf({ persona: { ref: 'lib-ref' } }), 'lib-ref');
  assert.equal(personaIdOf({ case_id: 'eve.persona.sceptical-gym-owner' }), 'sceptical-gym-owner');
  assert.equal(personaIdOf({ case_id: 'eve.newuser.first-hello' }), null);
  const rows = [
    { row_id: 'r2', case_id: 'eve.persona.busy-baker', surface: 's', trial: 2, persona: persona() },
    { row_id: 'r0', case_id: 'eve.persona.busy-baker', surface: 's', trial: 0, persona: persona() },
    { row_id: 'g0', case_id: 'eve.persona.gym', surface: 's', trial: 0 },
    { row_id: 'x', case_id: 'eve.bench.x', surface: 's', trial: 0 },
  ];
  const g = rowsByPerson(rows, new Map([['gym', 'Marco, gym']]));
  assert.deepEqual(g.map((x) => [x.id, x.name, x.rows.map((r) => r.row_id)]), [['busy-baker', 'Inês, owner of Padaria Estrela', ['r0', 'r2']], ['gym', 'Marco, gym', ['g0']]]);
  const sib = siblingTrials(rows, 'r2');
  assert.deepEqual([sib.list.map((r) => r.row_id), sib.index], [['r0', 'r2'], 1]);
  assert.deepEqual(siblingTrials(rows, 'nope'), { list: [], index: -1 });
});

test('chatItems: messages, folded tool runs, approval pills', () => {
  const steps: AtifStep[] = [
    { step_id: 1, source: 'user', message: 'hi :)\nI want customers', vibiz: { persona: { id: 'p', turn: 1, source: 'opening' } } },
    { step_id: 2, source: 'agent', tool_calls: [{ tool_call_id: 'call_1', function_name: 'get_branding', vibiz: { call_source: 'server' } }] },
    { step_id: 3, source: 'agent', tool_calls: [{ tool_call_id: 'rep_2', function_name: 'eve.get_branding', vibiz: { call_source: 'host-reported' } }] },
    { step_id: 4, source: 'agent', tool_calls: [{ tool_call_id: 'rep_3', function_name: 'eve.list_offers', vibiz: { call_source: 'host-reported' } }] },
    { step_id: 5, source: 'agent', message: 'Hello!' },
    { step_id: 6, source: 'agent', message: 'Shall I post?', vibiz: { hitl_request: { tool: 'publish_post' } } },
    { step_id: 7, source: 'user', message: '[hitl:approve] yes go' },
    { step_id: 8, source: 'user', message: 'no thanks', vibiz: { hitl_turn: { hitl: 'reject' } } },
    { step_id: 9, source: 'system', message: 'session resumed' },
    { step_id: 10, source: 'agent', message: [{ text: 'Done' }], tool_calls: [{ function_name: 'publish_post' }] },
  ];
  const items = chatItems(steps, [{ seq: 10, kind: 'approved', canonical: 'publish_post', principal: 'owner' }]);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'tools', 'agent', 'approval', 'agent', 'approval', 'approval', 'system', 'tools', 'agent', 'approval']);
  const u = items[0] as Extract<typeof items[0], { kind: 'user' }>;
  assert.deepEqual([u.text, u.turn, u.source], ['hi :)\nI want customers', 1, 'opening']);
  const t = items[1] as Extract<typeof items[0], { kind: 'tools' }>;
  assert.equal(t.calls.length, 3);
  assert.deepEqual(t.names, ['get_branding', 'list_offers']); // host-reported repeat of get_branding folded away
  assert.equal(t.count, 2);
  assert.ok(t.calls[1].duplicate && !t.calls[2].duplicate);
  assert.equal(t.calls[2].stepIndex, 3);
  const req = items[3] as Extract<typeof items[0], { kind: 'approval' }>;
  assert.deepEqual([req.decision, req.label], ['request', 'Asked for approval: publish_post']);
  const ok = items[5] as Extract<typeof items[0], { kind: 'approval' }>;
  assert.deepEqual([ok.decision, ok.label, ok.detail], ['approve', 'Approved', 'yes go']);
  assert.equal((items[6] as Extract<typeof items[0], { kind: 'approval' }>).decision, 'reject');
  assert.equal((items[9] as Extract<typeof items[0], { kind: 'agent' }>).text, 'Done');
  const ev = items[10] as Extract<typeof items[0], { kind: 'approval' }>;
  assert.deepEqual([ev.decision, ev.detail], ['approve', 'publish_post by owner']);
  assert.ok(hasChat(steps));
  assert.ok(!hasChat([{ source: 'agent', message: 'only me' }]));
  assert.deepEqual(chatItems(null), []);
  assert.equal(agentName('eve/imessage'), 'Eve');
  assert.equal(agentName(null), 'Agent');
});
