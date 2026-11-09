// Models side of persona cases: Claude on Vertex (rawPredict request/response mapping, ADC, prices, cache key), the
// ves-user-sim/2 prompt (persona fields rendered once, chat approvals, outcome), and the persona_outcome judge
// (parsing, advisory identity). Injected fetch/exec only (test/setup.ts blocks the network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, setup } from './helpers.ts';
import { anthropicVertexModel, anthropicVertexUrl, acceptsTemperature, mapAnthropicResponse, shapeAnthropicBody } from '../../src/models/vertex-anthropic.ts';
import { PERSONA_JUDGE_PROMPT_SHA256, parsePersonaOutcome } from '../../src/models/persona-judge.ts';
import { renderSimUser, toStep, USER_SIM_PROMPT_ID, USER_SIM_PROMPT_SHA256 } from '../../src/models/user-sim.ts';
import { lookupPrice } from '../../src/models/prices.ts';
import type { PersonaRecord } from '../../src/core/types.ts';

const anthropicJson = (text: string, usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 10 }) =>
  ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage });

test('Claude on Vertex: model id mapping, URL, temperature rule', () => {
  assert.deepEqual(anthropicVertexModel('anthropic/claude-sonnet-4-6'), { ref: 'anthropic/claude-sonnet-4-6', vertexId: 'claude-sonnet-4-6' });
  assert.deepEqual(anthropicVertexModel('claude-haiku-4-5'), { ref: 'anthropic/claude-haiku-4-5', vertexId: 'claude-haiku-4-5@20251001' });
  assert.deepEqual(anthropicVertexModel('anthropic/claude-opus-4-1@20250805'), { ref: 'anthropic/claude-opus-4-1', vertexId: 'claude-opus-4-1@20250805' });
  assert.equal(anthropicVertexModel('google/gemini-3.8-flash'), null);
  assert.equal(anthropicVertexUrl('p1', 'global', 'claude-sonnet-4-6'), 'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/anthropic/models/claude-sonnet-4-6:rawPredict');
  assert.equal(anthropicVertexUrl('p1', 'us-east5', 'claude-haiku-4-5@20251001'), 'https://us-east5-aiplatform.googleapis.com/v1/projects/p1/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5%4020251001:rawPredict');
  assert.equal(acceptsTemperature('claude-sonnet-4-6'), true);
  assert.equal(acceptsTemperature('claude-sonnet-5-5'), false);
  assert.equal(acceptsTemperature('claude-sonnet-5'), false);
  assert.equal(lookupPrice('anthropic/claude-sonnet-4-6', { local: false }).row.in, 3);
  assert.equal(lookupPrice('anthropic/claude-haiku-4-5', { local: false }).fallback, false);
});

test('Claude on Vertex: Messages body (system lifted, roles merged, JSON schema as an instruction) and response -> ChatModel shape', () => {
  const b = shapeAnthropicBody('claude-sonnet-4-6', {
    messages: [{ role: 'system', content: 'S1' }, { role: 'user', content: 'u1' }, { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a1' }],
    temperature: 0.7, max_tokens: 512, seed: 9, response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
  }, { provider: 'vertex', model: 'anthropic/claude-sonnet-4-6' });
  assert.equal(b.anthropic_version, 'vertex-2023-10-16');
  assert.equal(b.model, undefined, 'the model is in the URL');
  assert.equal(b.seed, undefined);
  assert.equal(b.temperature, 0.7);
  assert.deepEqual(b.messages, [{ role: 'user', content: 'u1\n\nu2' }, { role: 'assistant', content: 'a1' }]);
  assert.match(String(b.system), /^S1\n\nAnswer with one JSON object matching this JSON Schema/);
  assert.equal(shapeAnthropicBody('claude-sonnet-5-5', { messages: [{ role: 'user', content: 'x' }], temperature: 0.7 }, { provider: 'vertex', model: 'm' }).temperature, undefined);
  const m = mapAnthropicResponse(anthropicJson('{"a":1}'), 'anthropic/claude-sonnet-4-6') as any;
  assert.equal(m.choices[0].message.content, '{"a":1}');
  assert.equal(m.choices[0].finish_reason, 'stop');
  assert.deepEqual(m.usage, { prompt_tokens: 130, completion_tokens: 30, total_tokens: 160 });
  assert.equal((mapAnthropicResponse({ ...anthropicJson('x'), stop_reason: 'max_tokens' }, 'r') as any).choices[0].finish_reason, 'length');
});

test('Claude on Vertex end to end: ADC bearer + rawPredict URL, usage into the spend ledger, family anthropic', async () => {
  const cfg = { user_simulator: { provider: 'vertex' as const, model: 'anthropic/claude-sonnet-4-6', project: 'proj-x', location: 'global' } };
  const { api, fetch, exec } = setup({ cfg, handler: () => ({ status: 200, json: anthropicJson(json({ action: 'say', text: 'olá, preciso de clientes' })) }) });
  const sim = api.userSimulator();
  assert.equal(sim.identity.model, 'anthropic/claude-sonnet-4-6');
  const persona = { id: 'baker', temperament: ['busy'], goal: 'more customers', languages: ['pt', 'en'] };
  assert.deepEqual(await sim.next({ persona, transcript: [], turn_index: 0, max_turns: 4, salt: 't0|u0', seed: 7 }), { say: 'olá, preciso de clientes' });
  assert.equal(fetch.calls.length, 1);
  const c = fetch.calls[0];
  assert.equal(c.url, 'https://aiplatform.googleapis.com/v1/projects/proj-x/locations/global/publishers/anthropic/models/claude-sonnet-4-6:rawPredict');
  assert.equal(c.headers.authorization, 'Bearer ya29.token-one');
  assert.equal(c.headers['x-goog-user-project'], 'proj-x');
  assert.equal(c.body.anthropic_version, 'vertex-2023-10-16');
  assert.equal(c.body.__vertex_model, undefined, 'cache-key field never sent');
  assert.equal(c.body.max_tokens, 4096);
  assert.equal(exec.calls[0].cmd, 'gcloud');
  const led = api.ledger();
  assert.equal(led.by_purpose.user_simulator.calls, 1);
  assert.ok(Math.abs(led.usd_list - (130 * 3 + 30 * 15) / 1e6) < 1e-9, String(led.usd_list));
  assert.equal(api.chat('user_simulator').family, 'anthropic');
  assert.throws(() => setup({ cfg: { judge: { provider: 'vertex', model: 'anthropic/gpt-4o' } } }).api.personaJudge(), /not a Vertex Gemini id/);
});

test('ves-user-sim/2: persona fields rendered once (slot-looking text stays data), chat approvals kept, stop outcome', () => {
  assert.equal(USER_SIM_PROMPT_ID, 'ves-user-sim/2');
  assert.match(USER_SIM_PROMPT_SHA256, /^[a-f0-9]{64}$/);
  const u = renderSimUser({ persona: { id: 'p', name: 'Inês {{conversation}}', temperament: ['busy', 'vague'], goal: 'g', languages: ['pt', 'en'], style: { length: 'terse', emoji: 'some', impatience: 3 }, background: 'bakery in Lisbon' },
    transcript: [{ role: 'agent', text: 'Olá!' }], pending: 'none', chat_approval: true, turn_index: 1, max_turns: 5 });
  assert.match(u, /name: Inês \{\{conversation\}\}\n/);
  assert.match(u, /temperament: busy, vague\nlanguages: pt, en\nstyle: messages terse; emoji some; impatience 3\/3\nbackground: bakery in Lisbon/);
  assert.match(u, /ASSISTANT: Olá!/);
  assert.match(u, /Chat approval possible: yes\n\nThis is turn 2 of at most 5/);
  assert.deepEqual(toStep({ action: 'hitl', decision: 'approve', text: 'sim, pode' }, false, true), { hitl: 'approve', text: 'sim, pode' });
  assert.deepEqual(toStep({ action: 'hitl', decision: 'approve', text: 'sim, pode' }, false, false), { say: 'sim, pode' });
  assert.deepEqual(toStep({ action: 'stop', reason: 'done', outcome: 'gave_up' }, false), { stop: true, reason: 'done', outcome: 'gave_up' });
  assert.deepEqual(toStep({ action: 'stop', reason: 'done', outcome: 'whatever' }, false), { stop: true, reason: 'done' });
});

const rec: PersonaRecord = {
  id: 'barber', name: 'Rui', temperament: ['irritable'], goal: 'book more Tuesday clients', languages: ['en'], max_user_turns: 6, user_turns: 3,
  stop: { kind: 'gave_up', reason: 'too long', at_turn: 3 }, simulator: { model: 's', prompt_sha256: 'x' },
  metrics: { user_turns: 3, turns_to_goal: null, reply_chars_per_turn: [900, 800, 700], mean_reply_chars: 800, language_match: true },
};

test('persona_outcome parsing: valid, out-of-range and garbage outputs never throw', () => {
  assert.deepEqual(parsePersonaOutcome(json({ goal_met: 'partly', gave_up: true, frustration: 3, tone_fit: 0, why: 'walls of text' })), { goal_met: 'partly', gave_up: true, frustration: 3, tone_fit: 0, why: 'walls of text' });
  const odd = parsePersonaOutcome('```json\n{"goal_met":"maybe","gave_up":"no","frustration":7,"tone_fit":2.5,"why":""}\n```');
  assert.deepEqual([odd.goal_met, odd.gave_up, odd.frustration, odd.tone_fit, odd.why], ['unknown', null, null, null, '(no reason given)']);
  assert.match(odd.parse_error ?? '', /goal_met, gave_up, frustration, tone_fit/);
  const g = parsePersonaOutcome('I think it went fine');
  assert.equal(g.goal_met, 'unknown');
  assert.ok(g.parse_error);
});

test('persona_outcome judge: one judge call on the judge model, agent names redacted, identity advisory; infra errors propagate', async () => {
  const { api, fetch } = setup({ handler: () => ({ content: json({ goal_met: 'no', gave_up: true, frustration: 3, tone_fit: 0, why: 'Eve wrote essays' }) }), extra: { agent: { model: 'gpt-x', name: 'Eve' } } });
  const j = api.personaJudge();
  assert.deepEqual(j.identity, { model: 'google/gemini-3.8-flash', prompt_sha256: PERSONA_JUDGE_PROMPT_SHA256, admitted: false });
  const out = await j.score({ persona: rec, transcript: [{ role: 'user', text: 'yo' }, { role: 'agent', text: 'Hi, I am Eve, here is a long plan' }, { role: 'tool', tool: 'x', text: 'SECRET' }], salt: 't0|outcome' });
  assert.equal(out.goal_met, 'no');
  assert.equal(out.judge?.prompt_sha256, PERSONA_JUDGE_PROMPT_SHA256);
  const body = fetch.calls[0].body;
  assert.equal(body.response_format.json_schema.name, 'ves_persona_outcome');
  const u = body.messages[1].content as string;
  assert.match(u, /gave_up after 3 user message\(s\) \(max 6\): too long/);
  assert.ok(u.includes('[system]') && !u.includes('Eve') && !u.includes('SECRET'));
  assert.ok((api.identities() as any)['judge:persona_outcome']);
  const down = setup({ handler: () => ({ status: 503, json: {} }), extra: { maxAttempts: 1 } });
  await assert.rejects(down.api.personaJudge().score({ persona: rec, transcript: [], salt: 's' }), (e: any) => e.http_status === 503);
});
