// mcp-conformance (DESIGN-agnostic §4.8, §7.3): the graders against an in-process fake MCP server (core's
// createMcpHandler() with deliberately broken tools), driven by a contract-mode connector that follows the
// transcript contract of packs/mcp-conformance/transcript.ts. No network: every request goes to handle() in-process.
//
// The oracle baseline needs MockAgent to answer `rpc` turns from a reference MCP server over the proxy; core does that
// (src/core/mock-agent.ts, integrator step). Transcript checks are still skipped when the variant lacks `rpc`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, type McpServerOptions } from '../../src/proxy/mcp-server.ts';
import { validate } from '../../src/lib/jsonschema.ts';
import { mockFactory } from '../../src/core/mock-agent.ts';
import { prepare } from '../../src/runner/run-v2.ts';
import { McpTranscriptClient, RPC_EFFECT, listedTools, type McpSend, type RpcExchange } from '../../packs/mcp-conformance/transcript.ts';
import { GRADERS, shapeOf } from '../../packs/mcp-conformance/pack.ts';
import { ROOT, config, expand, extraOf, firedRules, runPacks, tmpDir } from './helpers.ts';
import type { ConnectorFactory, ConnSession, HarnessIO, LoadedCase2, ResolvedConfig, ToolSpec, TurnOutcome } from '../../src/core/types.ts';

const tmp = tmpDir('mcp');
after(tmp.cleanup);
const DONE: TurnOutcome = { status: 'done' };
const contractCfg = (caps = ['rpc']) => config('travel-desk', (c) => {
  c.variants = { mcp: { role: 'contract', connection: { type: 'mcp', transport: 'http', url: 'http://127.0.0.1:9/mcp', mode: 'contract' }, capabilities: caps } };
});
const sendTo = (handle: ReturnType<typeof createMcpHandler>): McpSend => (body, headers) => handle({ method: 'POST', path: '/mcp', headers, body: JSON.stringify(body) });
const reportAll = (io: HarnessIO, sid: string, xs: RpcExchange[]) => { for (const ex of xs) io.report({ type: 'effect', session_id: sid, kind: RPC_EFFECT, args: ex as unknown as Record<string, unknown> }); };

/** A server's tools/call implementation: correct (validates args, unknown names fail) or lenient (accepts anything). */
const impl = (tools: () => ToolSpec[], lenient: boolean) => async (name: string, args: Record<string, unknown>) => {
  if (lenient) return { ok: true, result: { ok: true } };
  const t = tools().find((x) => x.name === name);
  if (!t) return { ok: false, error: 'unknown_tool' };
  const errs = validate(t.input_schema as Record<string, unknown>, args);
  return errs.length ? { ok: false, error: 'invalid_args', details: errs } : { ok: true, result: { ok: true } };
};

/** Core's MockAgent now answers rpc turns from a reference MCP server (src/core/mock-agent.ts); this wrapper is kept
 * so the tests read as before, and asserts nothing is patched. */
async function withReferenceRpc<T>(fn: () => Promise<T>): Promise<T> { return fn(); }

/** A contract-mode connector (what the connectors package's `mcp` connector does in mode "contract"), over a fake server. */
function fakeContract(cases: Map<string, LoadedCase2>, server: { faults?: McpServerOptions['faults']; lenient?: boolean; pageSize?: number } = {}): ConnectorFactory {
  type S = ConnSession & { io: HarnessIO; client: McpTranscriptClient; steps: NonNullable<LoadedCase2['oracle']['steps']> };
  return {
    kind: 'mcp', version: 'test-contract',
    create: () => ({
      kind: 'mcp', version: 'test-contract',
      health: async () => ({ ok: true }),
      info: async () => ({ name: 'fake-mcp-server', framework: 'mcp', capabilities: ['rpc'], diffsFromProd: [] }),
      capabilities: () => new Set(['rpc']), routesHash: async () => 'fake',
      open: async (o, io) => {
        const tools = () => o.tools;
        const handle = createMcpHandler({ tools, invoke: impl(tools, !!server.lenient), faults: server.faults, pageSize: server.pageSize });
        const client = new McpTranscriptClient(sendTo(handle));
        reportAll(io, o.session_id, await client.initialize());
        return { id: o.session_id, io, client, steps: cases.get(o.case_id)?.oracle.steps ?? [] } as S;
      },
      // contract mode replays the case oracle's tool calls through the proxy (the harness is the client)
      turn: async (s) => { const x = s as S; let n = 0; for (const st of x.steps) if ('call' in st) await x.io.callTool({ call_id: `c${++n}`, name: st.call, args: st.args, transport: 'mcp' }); return DONE; },
      decide: async () => DONE,
      rpc: async (s, r) => { const x = s as S; reportAll(x.io, x.id, await x.client.rpc(r.method, r.params)); return DONE; },
      close: async () => {},
    }),
  };
}
async function casesFor(cfg: ResolvedConfig): Promise<Map<string, LoadedCase2>> {
  const p = await prepare({ harnessRoot: ROOT, config: cfg, tier: 'release', packs: ['mcp-conformance'], variants: Object.values(cfg.variants) });
  assert.deepEqual(p.errors, []);
  return new Map(p.cases.map((c) => [c.id, c]));
}
const run = async (cfg: ResolvedConfig, server: Parameters<typeof fakeContract>[1]) => {
  const factory = fakeContract(await casesFor(cfg), server);
  return runPacks(cfg, ['mcp-conformance'], tmp.dir, { connection: undefined, variants: ['mcp'], connectors: { factories: new Map([['mock', mockFactory], ['mcp', factory]]), sources: {} } });
};
const failing = (r: Awaited<ReturnType<typeof run>>) => [...new Set(r.rows.filter((x) => x.status === 'fail').flatMap((x) => x.scores.filter((s) => s.role === 'gate' && s.label !== 'pass').map((s) => `${x.case_id.replace(/-[a-f0-9]{6}$/, '')}:${s.grader_id}`)))].sort();

test('expansion: one case per protocol check plus per-tool cases, only on contract variants; transcript checks require rpc', async () => {
  const r = await expand('mcp-conformance', contractCfg());
  assert.deepEqual(r.errors, []);
  const tpl = (t: string) => r.cases.filter((c) => c.provenance.pack!.template === t);
  assert.equal(tpl('handshake').length, 1);
  assert.equal(tpl('tools-list-paging').length, 1);
  assert.equal(tpl('unknown-tool').length, 1);
  assert.equal(tpl('tool-schema-valid').length, 7, 'every catalog tool');
  assert.equal(tpl('annotations-consistent').length, 7);
  assert.equal(tpl('invalid-args').length, 7, 'every tool with required args');
  assert.deepEqual(tpl('read-idempotent').map((c) => c.provenance.pack!.bindings!.tool).sort(), ['find_hotels', 'get_booking']);
  assert.deepEqual(tpl('gated-without-approval').map((c) => c.provenance.pack!.bindings!.tool).sort(), ['book_flight', 'cancel_trip', 'email_itinerary']);
  assert.deepEqual(tpl('structured-output').map((c) => c.provenance.pack!.bindings!.tool), ['find_hotels']);
  assert.ok(r.cases.every((c) => JSON.stringify(c.variants) === '["mcp"]' && c.suite === 'smoke'));
  for (const c of r.cases) assert.equal(c.requires?.includes('rpc') ?? false, !!c.input.turns?.some((t) => 'rpc' in t), c.id);
});

test('a conformant server passes every check; MockAgent (core reference rpc) passes 100% and the trivial agent none', async () => {
  const r = await withReferenceRpc(() => run(contractCfg(), { pageSize: 3 }));
  assert.equal(r.gate.verdict, 'PASS', firedRules(r) + ' ' + failing(r).join(', '));
  assert.ok(r.rows.length > 20 && r.rows.every((x) => x.status === 'pass'));
  const b = extraOf(r).baselines.mcp;
  assert.equal(b.oracle_pass, b.oracle_n);
  assert.equal(b.trivial_unit_pass, 0);
  const paging = r.rows.find((x) => x.case_id === 'mcp-conformance.tools-list-paging')!.scores.find((s) => s.grader_id === 'mcp-conformance/tools_list_paging')!;
  assert.match(paging.explanation ?? "", /^7 tools in 3 page\(s\), names unique$/);
  assert.equal(r.manifest.connections.mcp.kind, 'mcp');
});

test('a broken server fails exactly the checks it breaks (G-2 contract block)', async () => {
  const r = await withReferenceRpc(() => run(contractCfg(), { faults: { badSchema: ['hold_room'], readOnlyHintOn: ['email_itinerary'], unknownToolSucceeds: true }, lenient: true }));
  assert.equal(r.gate.verdict, 'BLOCK');
  assert.match(r.gate.decided_by ?? '', /^G-2/);
  assert.deepEqual(failing(r), [
    'mcp-conformance.annotations-consistent.email_itinerary:mcp-conformance/annotations_consistent',
    'mcp-conformance.invalid-args.book_flight:mcp-conformance/invalid_args',
    'mcp-conformance.invalid-args.cancel_trip:mcp-conformance/invalid_args',
    'mcp-conformance.invalid-args.email_itinerary:mcp-conformance/invalid_args',
    'mcp-conformance.invalid-args.find_hotels:mcp-conformance/invalid_args',
    'mcp-conformance.invalid-args.get_booking:mcp-conformance/invalid_args',
    'mcp-conformance.invalid-args.hold_room:mcp-conformance/invalid_args',
    'mcp-conformance.invalid-args.save_traveller_note:mcp-conformance/invalid_args',
    'mcp-conformance.tool-schema-valid.hold_room:mcp-conformance/tool_schema_valid',
    'mcp-conformance.unknown-tool:mcp-conformance/unknown_tool',
  ]);
  const ann = r.rows.find((x) => x.case_id.startsWith('mcp-conformance.annotations-consistent.email_itinerary'))!.scores.find((s) => s.grader_id === 'mcp-conformance/annotations_consistent')!;
  assert.match(ann.explanation ?? "", /readOnlyHint true, but the catalog classes it as write\+outward/);
});

test('without the rpc capability transcript checks are skipped with a reason, call checks still run and pass', async () => {
  const r = await runPacks(contractCfg([]), ['mcp-conformance'], tmp.dir, { variants: ['mcp'] });
  assert.equal(r.gate.verdict, 'PASS', firedRules(r));
  const skipped = r.rows.filter((x) => x.status === 'skip');
  assert.ok(skipped.length > 0 && skipped.every((x) => x.skip_reason === 'variant lacks rpc'));
  const ran = new Set(r.rows.filter((x) => x.status === 'pass').map((x) => x.case_id.split('.')[1]));
  assert.deepEqual([...ran].sort(), ['gated-without-approval', 'read-idempotent', 'structured-output']);
});

// ---- grader units on hand-built transcripts (paging that never ends, handshake failures, idempotence shapes)
const grade = (id: string, sideEffects: { kind: string; args: unknown }[], params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  GRADERS.find((g) => g.id === `mcp-conformance/${id}`)!.grade({ c: { sideEffects: sideEffects.map((e, i) => ({ id: `fx${i}`, ...e })), serverCalls: [], upstreamWrites: [] }, variant: 'mcp', catalog: { byName: {} }, ...extra } as any, params);
const page = (seq: number, cursor: string | undefined, next: string | undefined, tools: string[]): { kind: string; args: RpcExchange } =>
  ({ kind: RPC_EFFECT, args: { seq, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}), status: 200, response: { result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })), ...(next ? { nextCursor: next } : {}) } } } });

test('grader units: paging that never terminates, duplicate names, a failed handshake, no transcript at all', () => {
  const loop = Array.from({ length: 50 }, (_, i) => page(i + 1, i ? 'again' : undefined, 'again', [`t${i}`]));
  assert.match(grade('tools_list_paging', loop).explanation, /did not terminate within 50 pages/);
  assert.match(grade('tools_list_paging', [page(1, undefined, 'c2', ['a', 'b']), page(2, 'c2', undefined, ['b'])]).explanation, /duplicate tool names: b/);
  assert.equal(grade('tools_list_paging', [page(1, undefined, 'c2', ['a']), page(2, 'c2', undefined, ['b'])]).pass, true);
  assert.equal(listedTools([page(1, undefined, 'c2', ['a']).args, page(2, 'c2', undefined, ['b']).args]).tools.length, 2);
  const badInit = { kind: RPC_EFFECT, args: { seq: 1, method: 'initialize', status: 200, response: { error: { code: -32602, message: 'unsupported protocol' } } } };
  const h = grade('handshake', [badInit]);
  assert.equal(h.pass, false);
  assert.match(h.explanation, /initialize failed \(unsupported protocol\); notifications\/initialized was not sent/);
  for (const id of ['handshake', 'tools_list_paging', 'unknown_tool', 'tool_schema_valid']) {
    const o = grade(id, [], { tool: 'x', name: 'x' });
    assert.equal(o.pass, false, `${id} without a transcript is not met`);
    assert.match(o.explanation, /no MCP transcript recorded/);
  }
  assert.deepEqual(shapeOf({ b: [1, 2], a: 'x' }), shapeOf({ a: 'y', b: [3] }), 'values do not matter, keys and types do');
  assert.notDeepEqual(shapeOf({ a: 'x' }), shapeOf({ a: 1 }));
});
