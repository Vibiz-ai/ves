// Models acceptance (§7.5): judge and simulator JSON parsing (invalid JSON -> unknown or error, never a crash),
// advisory-until-admitted, family rule, pointwise prompt hygiene, intent writer validation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from '../../src/core/errors.ts';
import type { CatalogTool } from '../../src/core/types.ts';
import { sha256 } from '../../src/lib/hash.ts';
import { effectiveJudgeRole, JUDGE_PROMPT_SHA256, isSafetyDimension } from '../../src/models/judge.ts';
import { USER_SIM_PROMPT_SHA256 } from '../../src/models/user-sim.ts';
import { ROOT, json, setup, tmpDir } from './helpers.ts';

const t = tmpDir('judge');
after(t.cleanup);
const RUBRIC = readFileSync(join(ROOT, 'judges', 'helpfulness@1.md'), 'utf8');
const input = (salt = 's') => ({ dimension: 'helpfulness@1', rubric_md: RUBRIC, reference: 'Offer the 3-month plan at $49.', salt,
  transcript: [{ role: 'user' as const, text: 'What should I offer?' }, { role: 'tool' as const, tool: 'list_offers', text: '[...]' }, { role: 'agent' as const, text: 'As Claude Sonnet 5.5 (acme-bot), I suggest the 3-month plan at $49.' }] });
const agent = { model: 'anthropic/claude-sonnet-5-5', name: 'acme-bot' };

test('judge: valid, fenced and invalid outputs; invalid never crashes and is unknown', async () => {
  const outs = [json({ label: 'pass', explanation: 'matches' }), '```json\n{"label":"fail","value":0.2,"explanation":"off"}\n```', 'I think it passes!', json({ label: 'great', explanation: 'x' }), '', json({ label: 'unknown', explanation: 'cannot tell', value: 1 })];
  let i = 0;
  const { api } = setup({ handler: () => ({ content: outs[i++] }), extra: { agent } });
  const j = api.judge('helpfulness@1');
  const r = [];
  for (let k = 0; k < outs.length; k++) r.push(await j.score(input(`s${k}`)));
  assert.deepEqual(r.map((x) => [x.label, x.value]), [['pass', 1], ['fail', 0.2], ['unknown', null], ['unknown', null], ['unknown', null], ['unknown', null]]);
  assert.match(r[2].explanation, /unusable/);
});

test('judge: pointwise prompt, one dimension, unknown offered, JSON schema, no system/model names, temperature 0', async () => {
  const { api, fetch } = setup({ handler: () => ({ content: json({ label: 'pass', explanation: 'ok' }) }), extra: { agent } });
  const j = api.judge('helpfulness@1');
  await j.score(input());
  const b = fetch.calls[0].body;
  const all = b.messages.map((m: any) => m.content).join('\n');
  assert.equal(b.messages.length, 2);
  assert.match(all, /"unknown"/);
  assert.match(all, /## Dimension\nhelpfulness@1/);
  assert.ok(all.includes('Offer the 3-month plan at $49.'));
  assert.ok(!/claude-sonnet-5-5|acme-bot/i.test(all), 'agent model and name redacted');
  assert.ok(!/gemini/i.test(all), 'judge model not shown');
  assert.match(all, /\[ASSISTANT\]: As Claude Sonnet 5.5 \(\[system\]\)/);
  assert.equal(b.response_format.json_schema.name, 'ves_judge');
  assert.deepEqual(b.response_format.json_schema.schema.properties.label.enum, ['pass', 'fail', 'unknown']);
  assert.equal(b.temperature, 0);
  await assert.rejects(j.score({ ...input(), dimension: 'tone@1' }), HarnessError, 'one dimension per judge');
  await assert.rejects(j.score({ ...input(), reference: ' ' }), HarnessError, 'reference required');
});

test('judge: advisory until admitted (empty registry at VES-1.0); gate role refused', async () => {
  const { api } = setup({ handler: () => ({ content: json({ label: 'pass', explanation: 'ok' }) }), extra: { agent, judgeRegistry: join(ROOT, 'judges', 'registry.json') } });
  const j = api.judge('helpfulness@1') as any;
  assert.equal(j.identity.admitted, false);
  assert.equal(j.identity.model, 'google/gemini-3.8-flash');
  assert.equal(j.identity.prompt_sha256, JUDGE_PROMPT_SHA256);
  assert.match(j.identity.not_admitted_because.join(' '), /not in the judge registry/);
  assert.equal(effectiveJudgeRole(j.identity, 'gate'), 'advisory');
  const s = await j.score(input());
  assert.equal(s.admitted, false);
});

test('judge: admitted only with an exact registry entry, a frozen rubric and a different family; rubric drift demotes', async () => {
  const dir = join(t.dir, 'reg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'helpfulness@1.md'), RUBRIC);
  const entry = { dimension: 'helpfulness@1', model: 'google/gemini-3.8-flash', prompt_sha256: JUDGE_PROMPT_SHA256, rubric_sha256: sha256(RUBRIC), kappa: 0.71 };
  writeFileSync(join(dir, 'registry.json'), json({ admitted: [entry] }));
  const ok = setup({ handler: () => ({ content: json({ label: 'pass', explanation: 'ok' }) }), extra: { agent, judgeRegistry: join(dir, 'registry.json') } });
  const j = ok.api.judge('helpfulness@1') as any;
  assert.equal(j.identity.admitted, true, j.identity.not_admitted_because.join('; '));
  assert.equal(effectiveJudgeRole(j.identity, 'gate'), 'gate');
  assert.equal(effectiveJudgeRole(j.identity), 'advisory');
  assert.equal((await j.score(input())).admitted, true);
  const drift = await j.score({ ...input('s2'), rubric_md: RUBRIC + '\nnew line' });
  assert.equal(drift.admitted, false);
  assert.equal(j.identity.admitted, false, 'sticky demotion');
  assert.ok(ok.api.warnings().some((w) => /rubric changed/.test(w)));

  // same family as the agent: G-1 warning, not admittable
  const same = setup({ extra: { agent: { model: 'google/gemini-3.5-flash' }, judgeRegistry: join(dir, 'registry.json') } });
  assert.equal(same.api.judge('helpfulness@1').identity.admitted, false);
  assert.ok(same.api.warnings().some((w) => /^G-1: judge google\/gemini-3.8-flash \(google\) shares a family/.test(w)));
  // a host family under test counts too
  const host = setup({ extra: { agent: { model: 'openai/gpt-5', host_families: ['google'] }, judgeRegistry: join(dir, 'registry.json') } });
  assert.equal(host.api.judge('helpfulness@1').identity.admitted, false);
  // undeclared agent model: the family rule cannot be checked -> advisory
  const anon = setup({ extra: { judgeRegistry: join(dir, 'registry.json') } });
  assert.equal(anon.api.judge('helpfulness@1').identity.admitted, false);
  // suspended entry, wrong prompt sha, tampered rubric file
  writeFileSync(join(dir, 'registry.json'), json({ admitted: [{ ...entry, suspended: true }] }));
  assert.equal(setup({ extra: { agent, judgeRegistry: join(dir, 'registry.json') } }).api.judge('helpfulness@1').identity.admitted, false);
  writeFileSync(join(dir, 'registry.json'), json({ admitted: [{ ...entry, prompt_sha256: 'f'.repeat(64) }] }));
  assert.equal(setup({ extra: { agent, judgeRegistry: join(dir, 'registry.json') } }).api.judge('helpfulness@1').identity.admitted, false);
  writeFileSync(join(dir, 'registry.json'), json({ admitted: [entry] }));
  writeFileSync(join(dir, 'helpfulness@1.md'), RUBRIC + 'edited');
  assert.equal(setup({ extra: { agent, judgeRegistry: join(dir, 'registry.json') } }).api.judge('helpfulness@1').identity.admitted, false);
});

test('judge: never on a safety dimension; infra errors propagate (row becomes INVALID, not a score)', async () => {
  const { api } = setup({ handler: () => ({ status: 503, json: {} }), extra: { maxAttempts: 1 } });
  for (const d of ['safety', 'approval_invariant', 'g1_approval', 'prompt-injection@1', 'tenant_isolation', 'leak']) {
    assert.ok(isSafetyDimension(d), d);
    assert.throws(() => api.judge(d), HarnessError);
  }
  assert.equal(isSafetyDimension('helpfulness@1'), false);
  await assert.rejects(api.judge('helpfulness@1').score(input()), (e: any) => e.http_status === 503);
});

const persona = { id: 'busy-founder', temperament: 'terse, impatient', goal: 'get a refund for order A-1' };

test('user simulator: say / hitl / stop; tool turns hidden; pinned prompt sha', async () => {
  const outs = [json({ action: 'say', text: 'refund A-1 pls' }), json({ action: 'hitl', decision: 'approve', text: 'yes' }), json({ action: 'stop', reason: 'done' }), json({ action: 'hitl', decision: 'reject' })];
  let i = 0;
  const { api, fetch } = setup({ handler: () => ({ content: outs[i++] }) });
  const sim = api.userSimulator();
  assert.equal(sim.identity.prompt_sha256, USER_SIM_PROMPT_SHA256);
  assert.equal(sim.identity.model, 'google/gemini-3.8-flash');
  const tr = [{ role: 'agent' as const, text: 'Hi! How can I help?' }, { role: 'tool' as const, tool: 'secret_lookup', text: 'INTERNAL-ROW-77' }];
  assert.deepEqual(await sim.next({ persona, transcript: [], turn_index: 0, max_turns: 4, salt: 'a' }), { say: 'refund A-1 pls' });
  const pending = { tool: 'issue_refund', args: { order_id: 'A-1' }, prompt: 'Refund A-1?' };
  assert.deepEqual(await sim.next({ persona, transcript: tr, pending_hitl: pending, turn_index: 1, max_turns: 4, salt: 'b' }), { hitl: 'approve', text: 'yes' });
  assert.deepEqual(await sim.next({ persona, transcript: tr, turn_index: 2, max_turns: 4, salt: 'c' }), { stop: true, reason: 'done' });
  assert.deepEqual(await sim.next({ persona, transcript: tr, pending_hitl: pending, turn_index: 3, max_turns: 4, salt: 'd' }), { hitl: 'reject' });
  const u = fetch.calls[1].body.messages[1].content;
  assert.ok(!u.includes('INTERNAL-ROW-77') && !u.includes('secret_lookup'), 'the simulated user never sees tool turns');
  assert.match(u, /issue_refund/);
  assert.match(u, /terse, impatient/);
  assert.equal(fetch.calls[0].body.response_format.json_schema.name, 'ves_user_sim');
});

test('user simulator: max_turns stops without a model call; invalid JSON retried once then HarnessError', async () => {
  let n = 0;
  const { api, fetch } = setup({ handler: () => { n++; return { content: n === 1 ? 'sure thing!' : n === 2 ? json({ action: 'say', text: 'ok then' }) : 'garbage' }; } });
  const sim = api.userSimulator();
  assert.deepEqual(await sim.next({ persona, transcript: [], turn_index: 4, max_turns: 4, salt: 'x' }), { stop: true, reason: 'max_turns reached' });
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(await sim.next({ persona, transcript: [], turn_index: 0, max_turns: 4, salt: 'y' }), { say: 'ok then' });
  assert.equal(fetch.calls.length, 2);
  await assert.rejects(sim.next({ persona, transcript: [], turn_index: 1, max_turns: 4, salt: 'z' }), HarnessError);
  // a hitl answer with nothing pending: words only, or unusable
  let m = 0;
  const b = setup({ handler: () => ({ content: m++ === 0 ? json({ action: 'hitl', decision: 'approve', text: 'yes do it' }) : json({ action: 'hitl', decision: 'approve' }) }) });
  assert.deepEqual(await b.api.userSimulator().next({ persona, transcript: [], turn_index: 0, max_turns: 2, salt: 'q' }), { say: 'yes do it' });
  await assert.rejects(b.api.userSimulator().next({ persona, transcript: [], turn_index: 0, max_turns: 2, salt: 'r' }), HarnessError);
});

test('intent writer: args validated against input_schema, invalid and duplicate intents dropped', async () => {
  const tool = { name: 'issue_refund', classes: ['write', 'spend'], gated: true, gated_reason: 'class', risk: 3, schema_sha256: 'abc',
    input_schema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number', minimum: 0 } }, required: ['order_id'], additionalProperties: false } } as unknown as CatalogTool;
  const out = { intents: [
    { say: 'Refund order A-1 please', args: { order_id: 'A-1' } },
    { say: 'refund order a-1 please', args: { order_id: 'A-1' } },        // duplicate
    { say: 'Give back $20 on B-2', args: { order_id: 'B-2', amount: -20 } }, // invalid (minimum)
    { say: 'Refund C-3', args: { order: 'C-3' } },                          // invalid (additionalProperties, required)
    { say: 'Refund D-4 for $5', args: { order_id: 'D-4', amount: 5 } },
    { say: '', args: { order_id: 'E' } },
  ] };
  const { api, fetch } = setup({ handler: () => ({ content: json(out) }) });
  const w = api.intentWriter();
  const got = await w.write(tool, 5, 7);
  assert.deepEqual(got.map((g) => g.args), [{ order_id: 'A-1' }, { order_id: 'D-4', amount: 5 }]);
  assert.ok(api.warnings().some((x) => /dropped 4/.test(x)));
  assert.equal(fetch.calls[0].body.response_format.type, 'json_object');
  assert.deepEqual(await w.write(tool, 1, 7), [{ say: 'Refund order A-1 please', args: { order_id: 'A-1' } }]);
  const bad = setup({ handler: () => ({ content: 'nope' }) });
  assert.deepEqual(await bad.api.intentWriter().write(tool, 3, 1), []);
});
