// `trace` connector (DESIGN-agnostic §1.8): the four parsers on fixture files (OTel GenAI, AI SDK legacy, ATIF,
// OpenAI Agents SDK JSONL), every record reported at level `traced`, the VES proxy signature, and a recorded gated
// write with no harness approval blocking at G-3 through the runner (traced evidence can FAIL, never PASS).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseTrace, signTrace, verifySignature } from '../../src/connectors/trace/parsers.ts';
import { TraceConnectorImpl } from '../../src/connectors/trace/index.ts';
import { runConfigOnce } from '../../src/runner/run-v2.ts';
import { deps, HERE, recordingIO, registry, ROOT, sessionOpen, supportDesk } from './helpers.ts';

const FIX = join(HERE, 'fixtures');
const read = (f: string) => readFileSync(join(FIX, 'traces', f), 'utf8');
const TMP = join(ROOT, 'results', `.test-connectors-trace-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

test('otel-genai: execute_tool spans -> tool events (args/result parsed, error status -> ok false); invoke_agent text; per-call usage only (no double count)', () => {
  const p = parseTrace('otel-genai', read('otel-genai.json'));
  const tools = p.events.filter((e) => e.kind === 'tool') as any[];
  assert.deepEqual(tools.map((t) => [t.name, t.args, t.ok, t.call_id ?? null]), [['issue_refund', { order_id: 'O-7', amount_eur: 25 }, true, 'call_1'], ['search_tickets', { query: 'x' }, false, null]]);
  assert.deepEqual(tools[0].result, { refund_id: 'r_1' });
  const usage = p.events.filter((e) => e.kind === 'usage') as any[];
  assert.deepEqual(usage.map((u) => [u.input_tokens, u.output_tokens]), [[120, 14], [150, 10]], 'the invoke_agent totals are not added on top');
  assert.deepEqual(p.events.filter((e) => e.kind === 'message').map((e: any) => e.text), ['Refunded 25 EUR on O-7.']);
  assert.deepEqual(p.agent, { name: 'support', model: 'gpt-x' });
});
test('otel-genai: Vercel AI SDK legacy spans (ai.toolCall, ai.generateText, ai.usage.*)', () => {
  const p = parseTrace('otel-genai', read('ai-sdk-legacy.json'));
  assert.deepEqual(p.events.map((e) => e.kind), ['usage', 'tool', 'message']);
  const t = p.events.find((e) => e.kind === 'tool') as any;
  assert.deepEqual([t.name, t.args.to, t.result], ['send_email', 'jane@acme.example', { status: 'sent' }]);
  assert.equal((p.events.find((e) => e.kind === 'message') as any).text, 'Email sent to jane.');
});
test('atif: steps[].tool_calls + observation.results, agent messages, step usage (final_metrics only as a fallback)', () => {
  const p = parseTrace('atif', read('atif.json'));
  assert.deepEqual(p.events.map((e) => e.kind), ['tool', 'usage', 'message', 'usage']);
  assert.deepEqual((p.events[0] as any).result, { note_id: 'n1' });
  assert.deepEqual(p.agent, { name: 'lg-agent', model: 'gemini-x' });
});
test('openai-agents JSONL (ves_trace_processor.py): function spans -> tools, generation usage, the last generation text', () => {
  const p = parseTrace('openai-agents', read('openai-agents.jsonl'));
  assert.deepEqual(p.events.map((e) => e.kind), ['usage', 'tool', 'usage', 'message']);
  assert.deepEqual((p.events[1] as any).args, { order_id: 'O-7', amount_eur: 25 });
  assert.equal((p.events[3] as any).text, 'Refunded 25 EUR on O-7.');
  assert.deepEqual(p.agent, { name: 'Support agent' });
});
test('garbage and unknown formats are reported, not crashed on', () => {
  assert.deepEqual(parseTrace('otel-genai', '{}').warnings, ['no spans found (expected OTLP/JSON resourceSpans)']);
  assert.deepEqual(parseTrace('atif', '{"x":1}').warnings, ['no steps[] (expected ATIF v1.x)']);
  assert.equal(parseTrace('openai-agents', 'oops\n{"object":"ves.message","text":"hi"}\n').warnings.length, 1);
  assert.throws(() => parseTrace('langsmith', '{}'), /unknown trace format/);
});
test('VES proxy signature: valid only with the key and an untouched body', () => {
  const doc = JSON.parse(read('atif.json'));
  const signed = signTrace(doc, 'k3y');
  assert.equal(verifySignature(signed, 'k3y'), true);
  assert.equal(verifySignature(signed, 'other'), false);
  assert.equal(verifySignature(signed, undefined), false);
  assert.equal(verifySignature({ ...signed, session_id: 'tampered' }, 'k3y'), false);
  assert.equal(verifySignature(doc, 'k3y'), false);
});
test('ingest(): every record is reported at level traced (tool_event, message, usage)', async () => {
  const c = new TraceConnectorImpl({ type: 'trace', format: 'otel-genai', files: 'traces/*.json' }, deps({ configDir: FIX, repoRoot: FIX }));
  assert.deepEqual(await c.health(), { ok: true });
  assert.deepEqual(c.files(), ['traces/ai-sdk-legacy.json', 'traces/atif.json', 'traces/otel-genai.json']);
  const io = recordingIO();
  const s = await c.open(sessionOpen([]), io);
  assert.deepEqual(await c.ingest(s, { file: 'traces/otel-genai.json', format: 'otel-genai' }), { status: 'done' });
  assert.equal(io.rec.calls.length, 0, 'a trace never produces proxied calls');
  assert.ok(io.rec.reports.every((r) => r.level === 'traced'));
  assert.deepEqual(io.rec.reports.map((r) => r.ev.type), ['usage', 'tool_event', 'tool_event', 'usage', 'message']);
  await assert.rejects(c.ingest(s, { file: 'traces/missing.json', format: 'otel-genai' }), (e: any) => e.fixtureUnavailable === true);
  await assert.rejects(c.turn(), (e: any) => e.harness === true);
});
test('a recorded refund with no harness approval, graded on a trace variant: approval_invariant does not pass and G-3 blocks', async () => {
  const cfg = supportDesk((c) => { c.suites = ['../../../connectors/fixtures/trace-cases']; c.agent.connection = { type: 'trace', format: 'otel-genai' }; });
  const r = await runConfigOnce({ harnessRoot: ROOT, config: cfg, tier: 'smoke', trigger: 'manual', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, bootstrapN: 200, connectors: registry(), agentRoot: FIX });
  const row = r.rows.find((x) => x.case_id === 'trace.refund-recorded' && x.surface === 'default')!;
  assert.equal(row.trace.observation, 'traced');
  assert.equal(row.trace.host_reported_calls, 2);
  const g1 = row.scores.find((s) => s.grader_id === 'approval_invariant')!;
  assert.ok(g1 && g1.label !== 'pass', `G1 must not pass on traced evidence: ${g1?.label} ${g1?.explanation}`);
  const g3 = r.gate.rules.find((x) => x.rule === 'G-3 safety')!;
  assert.equal(g3.status, 'fired', g3.detail);
  assert.notEqual(r.gate.verdict, 'PASS');
  // (decided_by is "V §4.1 suite validity" today: core's MockAgent baselines cannot ingest a trace case; see report)
});
