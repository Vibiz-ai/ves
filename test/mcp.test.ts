// The MCP adapter is exercised against an in-memory fake `fetch`. No network call is made by this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpContractAdapter, McpHttpClient, toolError, type FetchLike } from '../src/adapters/mcp.ts';
import { loadCanonical } from '../src/lib/canonical.ts';
import { loadCases } from '../src/runner/load.ts';

// Hard rule: no network in tests. Any accidental real fetch throws.
(globalThis as any).fetch = () => { throw new Error('network call attempted in a test'); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIBIZ = join(ROOT, 'packs', 'vibiz'); // Vibiz assets moved here by the Core step (DESIGN-agnostic §7.1 item 10)
const canonical = loadCanonical(join(VIBIZ, 'catalog.v1.json'));

function fakeServer(log: any[]): FetchLike {
  return async (url, init) => {
    const msg = init.body ? JSON.parse(init.body) : null;
    log.push({ url, headers: init.headers, msg });
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
    if (msg?.method === 'initialize') return { status: 200, headers: h({ 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' }), text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake' }, capabilities: {} } })}\n\n` };
    if (msg?.method === 'notifications/initialized') return { status: 202, headers: h({}), text: async () => '' };
    if (msg?.method === 'tools/list') {
      const page = msg.params?.cursor ? { tools: [{ name: 'vibiz_ads_launch' }] } : { tools: [{ name: 'vibiz_billing' }], nextCursor: 'p2' };
      return { status: 200, headers: h({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: page }) };
    }
    if (msg?.method === 'tools/call') {
      const gated = msg.params.name === 'vibiz_ads_launch' && !msg.params.arguments.approval_token;
      const result = gated ? { content: [{ type: 'text', text: JSON.stringify({ error: 'approval_required' }) }], isError: true } : { content: [{ type: 'text', text: '{"ok":true}' }] };
      return { status: 200, headers: h({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) };
    }
    if (url.endsWith('/upstream-log')) return { status: 200, headers: h({ 'content-type': 'application/json' }), text: async () => '[]' };
    return { status: 404, headers: h({}), text: async () => 'nope' };
  };
}

test('JSON-RPC client: initialize over SSE, session header, paged tools/list', async () => {
  const log: any[] = [];
  const c = new McpHttpClient({ url: 'http://localhost:3999/mcp', fetch: fakeServer(log), token: 'dummy', clientName: 'principia' });
  await c.initialize();
  assert.equal(c.sessionId, 'sess-1');
  assert.equal(log[0].msg.params.clientInfo.name, 'principia');
  assert.equal(log[1].msg.method, 'notifications/initialized');
  assert.equal(log[1].headers['mcp-session-id'], 'sess-1');
  assert.equal(log[1].headers['mcp-protocol-version'], '2025-06-18');
  const tools = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['vibiz_billing', 'vibiz_ads_launch']);
  assert.equal(log.every((l) => l.url.startsWith('http://localhost')), true);
});

test('toolError reads approval_required from text or structured content', () => {
  assert.equal(toolError({ content: [{ type: 'text', text: '{"error":"approval_required"}' }] }), 'approval_required');
  assert.equal(toolError({ structuredContent: { error: 'approval_required' } }), 'approval_required');
  assert.equal(toolError({ content: [{ type: 'text', text: 'fine' }] }), undefined);
});

test('contract adapter: health refuses missing URL and production hosts without any request', async () => {
  const log: any[] = [];
  const none = new McpContractAdapter({ surface: 'gateway/contract', canonical, env: {}, fetch: fakeServer(log) });
  assert.equal((await none.health()).ok, false);
  const prod = new McpContractAdapter({ surface: 'gateway/contract', canonical, env: { VES_MCP_URL_GATEWAY: 'https://mcp.vibiz.ai/mcp?toolsets=all' }, fetch: fakeServer(log) });
  const h = await prod.health();
  assert.equal(h.ok, false); assert.match(h.detail!, /production/);
  assert.equal(log.length, 0);
});

test('contract adapter drives the oracle and records the guard as a server call', async () => {
  const log: any[] = [];
  const env = { VES_MCP_URL_GATEWAY: 'http://localhost:3999/mcp', VES_STUB_UPSTREAM_LOG_URL: 'http://localhost:3999/upstream-log' };
  const a = new McpContractAdapter({ surface: 'gateway/contract', canonical, env, fetch: fakeServer(log) });
  assert.equal((await a.health()).ok, true);
  const { cases } = loadCases(ROOT, [join(VIBIZ, 'cases', 'smoke')]);
  const k = cases.find((c) => c.id === 'smoke.gw-launch-guard')!;
  const s = await a.open(k.fixture, { runId: 'r', caseId: k.id, caseVersion: 1, surface: 'gateway/contract', trial: 0, seed: 1, salt: 's', case: k });
  await a.send(s, { say: 'Launch this ad on Instagram for $30 a day' });
  const col = await a.collect(s);
  assert.equal(col.serverCalls.length, 1);
  assert.equal(col.serverCalls[0].tool, 'vibiz_ads_launch');
  assert.equal(col.serverCalls[0].guard_fired, true);
  assert.equal(col.upstreamWrites.length, 0);
  assert.equal(a.upstreamObserved(), true);
});
