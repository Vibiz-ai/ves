// `mcp` connector (DESIGN-agnostic §1.7) against an in-process MCP server (core's createMcpHandler, reached through an
// injected fetch, or a fake stdio child): health/catalog import, contract mode with a server-side approval guard and
// the `approval` tool, rpc turns, the upstream ledger, host-sim through a scripted ChatModel, and the stdio bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler } from '../../src/proxy/mcp-server.ts';
import { McpConnector, renderVars } from '../../src/connectors/mcp/index.ts';
import { runStdioBridge, withStdioBridge } from '../../src/connectors/_shared/stdio-bridge.ts';
import { AsyncQueue } from '../../src/connectors/_shared/queue.ts';
import { NO_MODELS } from '../../src/registry/models.ts';
import { catalogOf, deps, fakeSpawn, fetchFrom, nextMsg, recordingIO, sessionOpen, supportDesk, toolSpecs } from './helpers.ts';
import type { ChatModel, ChatRequest, ChatResponse, HarnessIO, ModelsApi, ToolSpec } from '../../src/core/types.ts';

const URL_ = 'http://127.0.0.1:3100/mcp';
const LEDGER = 'http://127.0.0.1:3101/log';
const catalogTools = toolSpecs(catalogOf(supportDesk()));

/** A small MCP server with its own approval guard on gated tools, an approve_action tool and an upstream ledger. */
function server() {
  const state = { approved: new Set<string>(), ledger: [] as { tool: string; args: Record<string, unknown> }[], n: 0, log: [] as string[] };
  const tools: ToolSpec[] = [...catalogTools, { name: 'approve_action', input_schema: { type: 'object', properties: { pending_id: { type: 'string' } }, required: ['pending_id'] }, classes: ['write'], gated: false }];
  const handle = createMcpHandler({
    tools: () => tools, serverInfo: { name: 'acme-mcp', version: '2.1.0' },
    invoke: async (name, args) => {
      state.log.push(name);
      if (name === 'approve_action') { state.approved.add(String(args.pending_id)); return { ok: true, result: { approved: args.pending_id } }; }
      const t = tools.find((x) => x.name === name)!;
      if (t.gated && !state.approved.has(`P-${name}`)) return { ok: false, error: 'approval_required', details: { review: { pending_id: `P-${name}` } } };
      if (!t.classes.includes('read')) state.ledger.push({ tool: name, args });
      return { ok: true, result: t.classes.includes('read') ? [{ id: 'T-100', subject: 'Cannot log in' }] : { id: `w${++state.n}` } };
    },
  });
  const fetch = fetchFrom({
    [URL_]: async (method, path, body, headers) => handle({ method, path, headers, body }),
    [LEDGER]: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(state.ledger) }),
  });
  return { state, fetch, handle };
}
/** What core does for an mcp connection: HarnessIO.callTool -> Proxy -> connector.toolBackend(). */
function coreLikeIO(c: McpConnector): HarnessIO & { rec: ReturnType<typeof recordingIO>['rec'] } {
  const b = c.toolBackend();
  return recordingIO(async (name, args) => { const r = await b.execute(name, args); return { ok: r.ok, ...(r.ok ? { result: r.result } : { error: r.error, details: r.details }) }; });
}

test('health + info: initialize and tools/list; declaredTools (with annotations) feed `schemas_from: "mcp"`; non-local hosts refused', async () => {
  const { fetch } = server();
  const c = new McpConnector({ type: 'mcp', url: URL_ }, deps({ fetch }));
  assert.deepEqual(await c.health(), { ok: true });
  const i = await c.info();
  assert.equal(i.name, 'acme-mcp');
  assert.equal(i.protocol, 'mcp/2025-06-18');
  assert.equal(i.declaredTools!.length, catalogTools.length + 1);
  assert.equal((i.declaredTools!.find((t) => t.name === 'delete_customer') as any).annotations.destructiveHint, true);
  assert.ok(c.capabilities().has('rpc'));
  assert.match(i.diffsFromProd.join(' '), /no upstream ledger/);
  const prod = await new McpConnector({ type: 'mcp', url: 'https://mcp.acme.com/mcp' }, deps({ fetch })).health();
  assert.equal(prod.ok, false);
  const down = await new McpConnector({ type: 'mcp', url: URL_ }, deps({ fetch: fetchFrom({ [URL_]: async () => ({ status: 503, headers: {}, body: 'down' }) }) })).health();
  assert.equal(down.reason, 'infra_upstream_5xx');
});
test('contract mode: replays the oracle through the proxy; the server guard parks it; approve -> the approval tool is called directly (the harness is the human), then the guarded call is retried through the proxy', async () => {
  const { fetch, state } = server();
  const c = new McpConnector({ type: 'mcp', url: URL_, mode: 'contract', approval: { tool: 'approve_action', args: { pending_id: '{{guard.body.details.review.pending_id}}' } } }, deps({ fetch }));
  await c.health();
  const io = coreLikeIO(c);
  const steps = [{ call: 'search_tickets', args: { query: 'login' } }, { call: 'issue_refund', args: { order_id: 'O-7', amount_eur: 25 } }, { reply: 'Refunded.' }];
  const s = await c.open(sessionOpen(catalogTools, { context: { 'ves.oracle': { steps, say_turns: 1 } } }), io);
  assert.deepEqual(await c.turn(s, { text: 'Refund O-7', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' }), { status: 'awaiting_hitl' });
  const req = io.rec.reports.find((r) => r.ev.type === 'hitl.request')!.ev as any;
  assert.equal(req.tool, 'issue_refund');
  assert.deepEqual(state.ledger, [], 'nothing written before approval');
  assert.deepEqual(await c.decide(s, { request_id: req.request_id, decision: 'approve', as: 'owner', thread: 'thread-main' }), { status: 'done' });
  assert.deepEqual(io.rec.calls.map((x) => [x.name, x.transport]), [['search_tickets', 'mcp'], ['issue_refund', 'mcp'], ['issue_refund', 'mcp']]);
  assert.deepEqual(state.log, ['search_tickets', 'issue_refund', 'approve_action', 'issue_refund'], 'approve_action reached the server but is not an agent call');
  assert.deepEqual(state.ledger, [{ tool: 'issue_refund', args: { order_id: 'O-7', amount_eur: 25 } }]);
  assert.equal((io.rec.reports.at(-1)!.ev as any).text, 'Refunded.');
});
test('contract mode: a reject skips the guarded call; no oracle in session.open is a harness error, not an agent FAIL', async () => {
  const { fetch, state } = server();
  const c = new McpConnector({ type: 'mcp', url: URL_ }, deps({ fetch }));
  const io = coreLikeIO(c);
  const s = await c.open(sessionOpen(catalogTools, { context: { 'ves.oracle': [{ ask: { tool: 'send_email', args: { to: 'a@b.test', subject: 's', body: 'b' } } }, { call: 'send_email', args: { to: 'a@b.test', subject: 's', body: 'b' } }, { reply: 'Sent.' }] } }), io);
  assert.equal((await c.turn(s, { text: 'email', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' })).status, 'awaiting_hitl');
  await c.decide(s, { request_id: 'req-1', decision: 'reject', as: 'owner', thread: 'thread-main' });
  assert.deepEqual(io.rec.calls, []);
  assert.deepEqual(state.ledger, []);
  const bare = await c.open(sessionOpen(catalogTools), coreLikeIO(c));
  await assert.rejects(c.turn(bare, { text: 'x', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' }), (e: any) => e.harness === true && /ves\.oracle/.test(e.message));
});
test('rpc turns go raw to the server (its own protocol behaviour), and contract mode reports every exchange as an mcp.rpc effect', async () => {
  // Replaced by the integrator: rpc tools/call used to go through the proxy, which refuses unknown tools and invalid
  // args before the server sees them; mcp-conformance grades the server's own answer, so rpc is raw (transcript.ts).
  const { fetch } = server();
  const c = new McpConnector({ type: 'mcp', url: URL_ }, deps({ fetch }));
  const io = coreLikeIO(c);
  const s = await c.open(sessionOpen(catalogTools), io);
  await c.rpc(s, { method: 'tools/call', params: { name: 'search_tickets', arguments: { query: 'x' } } });
  await c.rpc(s, { method: 'tools/list' });
  await c.rpc(s, { method: 'no/such' });
  assert.deepEqual(io.rec.calls.map((x) => x.name), [], 'rpc turns are not proxied agent calls');
  const texts = io.rec.reports.filter((r) => (r.ev as any).type === 'message').map((r) => JSON.parse((r.ev as any).text));
  assert.equal(texts[0].ok, true);
  assert.equal(texts[1].result.tools.length, catalogTools.length + 1);
  assert.equal(texts[2].ok, false);
  assert.equal(texts[2].code, -32601);
  const tx = io.rec.reports.filter((r) => (r.ev as any).type === 'effect' && (r.ev as any).kind === 'mcp.rpc').map((r) => (r.ev as any).args);
  assert.deepEqual(tx.map((x: any) => x.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/list', 'no/such']);
  assert.deepEqual(tx.map((x: any) => x.seq), [1, 2, 3, 4, 5]);
  assert.equal(tx[4].response.error.code, -32601);
});
test('upstream ledger: the connector is a LedgerSource only when configured, and returns only this session\'s rows', async () => {
  const { fetch, state } = server();
  assert.equal(typeof new McpConnector({ type: 'mcp', url: URL_ }, deps({ fetch })).readLedger, 'undefined', 'no ledger -> no false "ledger" observation');
  state.ledger.push({ tool: 'add_note', args: { ticket_id: 'old', text: 'earlier trial' } });
  const c = new McpConnector({ type: 'mcp', url: URL_, ledger: { url: LEDGER } }, deps({ fetch }));
  const io = coreLikeIO(c);
  const s = await c.open(sessionOpen(catalogTools), io);
  await io.callTool({ call_id: 'x', name: 'add_note', args: { ticket_id: 'T-100', text: 'hi' }, transport: 'mcp' });
  assert.deepEqual(await c.readLedger!(s), [{ tool: 'add_note', args: { ticket_id: 'T-100', text: 'hi' } }]);
});
test('stdio transport: JSON-RPC lines to a spawned server (fake child), env filtered', async () => {
  const { handle } = server();
  const spawn = fakeSpawn(async ({ stdin, out }) => {
    let sid: string | undefined;
    for (;;) {
      const m = await nextMsg(stdin); if (!m) return;
      const r = await handle({ method: 'POST', headers: sid ? { 'mcp-session-id': sid } : {}, body: JSON.stringify(m) });
      sid = r.headers['mcp-session-id'] ?? sid;
      if (r.body) out(r.body);
    }
  });
  const c = new McpConnector({ type: 'mcp', transport: 'stdio', command: ['python', 'server.py'] }, deps({ spawn, env: { PATH: '/bin', SECRET: 'x' } }));
  assert.deepEqual(await c.health(), { ok: true });
  assert.equal((await c.info()).declaredTools!.length, catalogTools.length + 1);
  assert.deepEqual(Object.keys(spawn.seen.env!), ['PATH']);
  const r = await c.toolBackend().execute('search_tickets', { query: 'login' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, [{ id: 'T-100', subject: 'Cannot log in' }]);
  await c.dispose();
});

// ------------------------------------------------------------------------------------------ host-sim
function scriptedModels(script: (req: ChatRequest, n: number) => ChatResponse['message'], seen: { purpose: string; salt: string }[] = []): ModelsApi {
  let n = 0;
  const m: ChatModel = {
    ref: { provider: 'vertex', model: 'google/gemini-test' }, family: 'google',
    chat: async (req, o) => { seen.push({ purpose: o.purpose, salt: o.salt }); return { message: script(req, n++), finish_reason: 'stop', model: 'google/gemini-test', usage: { input_tokens: 1, output_tokens: 1 }, usd_list: 0, cached: false, request_sha256: 'x' }; },
  };
  return { ...NO_MODELS, chat: () => m };
}
const tc = (name: string, args: unknown, id: string) => ({ role: 'assistant' as const, content: null, tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] });
test('host-sim: the model drives the tools through the proxy; a gated call becomes a host-authored hitl.request and runs only after approve, with the proposed args', async () => {
  const { fetch, state } = server();
  const seen: { purpose: string; salt: string }[] = [];
  const models = scriptedModels((req, n) => {
    if (n === 0) return tc('search_tickets', { query: 'login' }, 'a');
    if (n === 1) return tc('issue_refund', { order_id: 'O-7', amount_eur: 25 }, 'b');
    const last = req.messages.at(-1)!;
    return { role: 'assistant', content: /user_denied/.test(last.content ?? '') ? 'Not refunded.' : 'Refunded.' };
  }, seen);
  const c = new McpConnector({ type: 'mcp', url: URL_, mode: 'host-sim', model: 'host_sim', guard_signal: { pointer: '/error', equals: 'approval_required' } }, deps({ fetch, models }));
  state.approved.add('P-issue_refund'); // the server itself does not guard here: the host's allow prompt is under test
  const io = coreLikeIO(c);
  const s = await c.open(sessionOpen(catalogTools), io);
  assert.deepEqual(await c.turn(s, { text: 'Refund order O-7', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' }), { status: 'awaiting_hitl' });
  assert.deepEqual(io.rec.calls.map((x) => x.name), ['search_tickets']);
  const req = io.rec.reports.find((r) => r.ev.type === 'hitl.request')!.ev as any;
  assert.deepEqual([req.tool, req.args, req.prompt], ['issue_refund', { order_id: 'O-7', amount_eur: 25 }, 'Allow issue_refund?']);
  assert.deepEqual(await c.decide(s, { request_id: req.request_id, decision: 'approve', as: 'owner', thread: 'thread-main' }), { status: 'done' });
  assert.deepEqual(io.rec.calls.map((x) => [x.name, x.args]), [['search_tickets', { query: 'login' }], ['issue_refund', { order_id: 'O-7', amount_eur: 25 }]]);
  assert.equal((io.rec.reports.filter((r) => r.ev.type === 'message').at(-1)!.ev as any).text, 'Refunded.');
  assert.ok(seen.every((x) => x.purpose === 'host_sim'));
  assert.equal(new Set(seen.map((x) => x.salt)).size, seen.length, 'distinct salts per step');
  // reject: the call never runs and the model is told
  const io2 = coreLikeIO(c);
  const models2 = scriptedModels((req, n) => (n === 0 ? tc('issue_refund', { order_id: 'O-7', amount_eur: 25 }, 'b') : { role: 'assistant', content: /user_denied/.test(req.messages.at(-1)!.content ?? '') ? 'Not refunded.' : '?' }));
  const c2 = new McpConnector({ type: 'mcp', url: URL_, mode: 'host-sim' }, deps({ fetch, models: models2 }));
  const s2 = await c2.open(sessionOpen(catalogTools), io2);
  await c2.turn(s2, { text: 'Refund order O-7', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  await c2.decide(s2, { request_id: 'x', decision: 'reject', as: 'owner', thread: 'thread-main' });
  assert.deepEqual(io2.rec.calls, []);
  assert.equal((io2.rec.reports.at(-1)!.ev as any).text, 'Not refunded.');
});
test('host-sim without the models package fails clearly (harness error), never silently', async () => {
  const { fetch } = server();
  const c = new McpConnector({ type: 'mcp', url: URL_, mode: 'host-sim' }, deps({ fetch }));
  await assert.rejects(c.open(sessionOpen(catalogTools), recordingIO()), /models package not installed/);
});
test('guard_signal (dogfood fix): a server that answers "confirmation_required" is recognised as a guard, so the approval flow runs', async () => {
  const handle = createMcpHandler({
    tools: () => [{ name: 'delete_note', input_schema: { type: 'object', properties: { id: { type: 'string' } } }, classes: ['write', 'destructive'], gated: true }],
    serverInfo: { name: 'notes', version: '1' },
    invoke: async () => ({ ok: false, error: 'confirmation_required', details: { confirm: { token: 'T1' } } }),
  });
  const fetch = fetchFrom({ [URL_]: async (method, path, body, headers) => handle({ method, path, headers, body }) });
  const plain = new McpConnector({ type: 'mcp', url: URL_, mode: 'contract' }, deps({ fetch }));
  const before = await plain.toolBackend().execute('delete_note', { id: 'n1' });
  assert.equal(before.error, 'confirmation_required', 'without guard_signal the server error is passed through');
  const c = new McpConnector({ type: 'mcp', url: URL_, mode: 'contract', guard_signal: { pointer: '/error', equals: 'confirmation_required' } }, deps({ fetch }));
  const r = await c.toolBackend().execute('delete_note', { id: 'n1' });
  assert.equal(r.ok, false);
  assert.equal(r.guard, true);
  assert.equal(r.error, 'approval_required', 'normalised, so contract mode parks it and runs connection.approval');
  assert.deepEqual(renderVars({ token: '{{guard.body.details.confirm.token}}' }, { guard: { body: r.details } }), { token: 'T1' });
  await plain.dispose(); await c.dispose();
});

test('renderVars: whole-placeholder templates keep types; embedded ones stringify', () => {
  assert.deepEqual(renderVars({ a: '{{guard.body.n}}', b: 'id={{guard.body.id}}', c: ['{{args.x}}'] }, { guard: { body: { n: 3, id: 'P1' } }, args: { x: true } }), { a: 3, b: 'id=P1', c: [true] });
});

// ------------------------------------------------------------------------------------------ stdio bridge
test('stdio bridge (`ves proxy --connect <url>`): forwards JSON-RPC lines to the per-trial HTTP MCP endpoint, keeps the session, maps failures to JSON-RPC errors', async () => {
  const { fetch, state } = server();
  const input = new AsyncQueue<string>();
  const out: any[] = [];
  const done = runStdioBridge({ url: URL_, fetch, input: { async *[Symbol.asyncIterator]() { for (;;) { const v = await input.next(); if (v === null) return; yield v; } } }, write: (l) => out.push(JSON.parse(l)) });
  input.push(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'crewai', version: '1' } } }) + '\n');
  input.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_note', arguments: { ticket_id: 'T-1', text: 'x' } } }) + '\n');
  input.push('not json\n');
  input.close();
  await done;
  assert.deepEqual(out.map((m) => m.id), [1, 2, null]);
  assert.equal(out[1].result.isError, false);
  assert.deepEqual(state.ledger, [{ tool: 'add_note', args: { ticket_id: 'T-1', text: 'x' } }]);
  assert.equal(fetch.log[2].headers['mcp-session-id'], fetch.log[1].headers['mcp-session-id']);
  assert.ok(fetch.log[2].headers['mcp-session-id']);
  assert.equal(out[2].error.code, -32700);
  // transport failure -> JSON-RPC error for that id
  const out2: any[] = [];
  await runStdioBridge({ url: URL_, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as never, input: (async function* () { yield JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n'; })(), write: (l) => out2.push(JSON.parse(l)) });
  assert.equal(out2[0].id, 7);
  assert.match(out2[0].error.message, /ECONNREFUSED/);
  assert.equal(withStdioBridge(sessionOpen(catalogTools)).tool_transport.mcp_stdio, undefined, 'no MCP URL -> no bridge');
});
