#!/usr/bin/env node
// A small MCP server (Streamable HTTP, JSON responses, no dependencies) standing in for YOUR MCP server, so the `mcp`
// connector example runs end to end: `node examples/mcp-server-node/server.mjs --port 3100`.
//   POST /mcp   JSON-RPC: initialize, notifications/initialized, ping, tools/list (paged, 5 per page), tools/call
//   GET  /log   the upstream ledger: every write this server performed ({tool, args}); VES matches it against the
//               proxy's records (observation "ledger"), so a write the harness did not see is a bypass
// The server has its OWN approval guard, like many real ones: a tool marked requires_approval in
// examples/fixtures/support-desk.mcp-tools.json refuses with {"error":"approval_required","review":{"pending_id"}} until
// `approve_action({pending_id})` is called (VES plays the human and calls it; connection.approval in ves.config.json).
// VES_DEMO_UNSAFE=1 turns the guard off, to watch mcp-conformance's gated-without-approval check fail.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const DEFS = JSON.parse(readFileSync(new URL('../fixtures/support-desk.mcp-tools.json', import.meta.url), 'utf8')).tools;
const STATE0 = JSON.parse(readFileSync(new URL('../fixtures/support-desk.state.json', import.meta.url), 'utf8'));
const UNSAFE = process.env.VES_DEMO_UNSAFE === '1';
const TOKEN = process.env.MCP_TEST_TOKEN; // when set, requests must carry "authorization: Bearer <token>"
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || process.env.PORT || 3100);
const PAGE = 5;
const APPROVE = { name: 'approve_action', description: 'Approve a pending action (called by the human reviewer, not by the agent).',
  inputSchema: { type: 'object', additionalProperties: false, properties: { pending_id: { type: 'string', minLength: 1 } }, required: ['pending_id'] },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
const TOOLS = [...DEFS, APPROVE];

const state = structuredClone(STATE0);
const ledger = [];
const pending = new Map(); // pending_id -> { tool, key, approved, used }
const sessions = new Set();
let seq = 0;

/** The subset of JSON Schema these tools use: object, required, additionalProperties false, string/number bounds, email. */
function invalid(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const k of schema.required ?? []) if (!(k in args)) return `missing required ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) { if (schema.additionalProperties === false) return `unknown argument ${k}`; continue; }
    if (p.type === 'string' && (typeof v !== 'string' || v.length < (p.minLength ?? 0) || (p.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)))) return `${k} is not a valid string`;
    if (p.type === 'number' && (typeof v !== 'number' || v < (p.minimum ?? -Infinity) || v > (p.maximum ?? Infinity))) return `${k} is out of range`;
  }
  return null;
}
const key = (tool, args) => `${tool}:${JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]))}`;
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { result: value } : value });
const toolErr = (value) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

function run(name, args) {
  const write = (row) => { ledger.push({ tool: name, args }); return ok(row); };
  switch (name) {
    case 'search_tickets': return ok(state.tickets.filter((t) => t.subject.toLowerCase().includes(String(args.query).toLowerCase().split(/\s+/)[0])));
    case 'get_customer': return state.customers[args.customer_id] ? ok(state.customers[args.customer_id]) : toolErr({ error: 'not_found' });
    case 'list_orders': return ok(state.orders.filter((o) => o.customer_id === args.customer_id));
    case 'add_note': state.notes.push(args); return write({ note_id: `N-${++seq}` });
    case 'close_ticket': state.ticket_status[args.ticket_id] = 'closed'; return write({ ok: true });
    case 'send_email': state.sent_emails.push(args); return write({ status: 'sent', id: `E-${++seq}` });
    case 'issue_refund': state.refunds.push(args); return write({ refund_id: `R-${++seq}` });
    case 'delete_customer': delete state.customers[args.customer_id]; return write({ deleted: args.customer_id });
    default: return toolErr({ error: 'unknown_tool' });
  }
}

function callTool(name, args) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { rpcError: { code: -32602, message: `unknown tool ${name}` } };
  const bad = invalid(def.inputSchema, args ?? {});
  if (bad) return { result: toolErr({ error: 'invalid_args', detail: bad }) };
  if (name === 'approve_action') {
    const p = pending.get(args.pending_id);
    if (!p || p.used) return { result: toolErr({ error: 'not_found' }) };
    p.approved = true;
    return { result: ok({ approved: args.pending_id }) };
  }
  if (def.requires_approval && !UNSAFE) {
    const k = key(name, args);
    const grant = [...pending.values()].find((p) => p.key === k && p.approved && !p.used);
    if (!grant) {
      const id = `P-${randomUUID().slice(0, 8)}`;
      pending.set(id, { tool: name, key: k, approved: false, used: false });
      return { result: toolErr({ error: 'approval_required', review: { pending_id: id, tool: name } }) };
    }
    grant.used = true; // single use, bound to the exact arguments
  }
  return { result: run(name, args) };
}

function handle(msg, sid) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params?.protocolVersion;
      return { body: reply({ protocolVersion: ['2025-06-18', '2025-03-26'].includes(want) ? want : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'support-desk-mcp', version: '1.0.0' } }), newSession: randomUUID() };
    }
    case 'notifications/initialized': return { body: undefined };
    case 'ping': return { body: reply({}) };
    case 'tools/list': {
      const start = Number(msg.params?.cursor ?? 0) || 0;
      const page = TOOLS.slice(start, start + PAGE).map(({ requires_approval, ...t }) => t);
      return { body: reply({ tools: page, ...(start + PAGE < TOOLS.length ? { nextCursor: String(start + PAGE) } : {}) }) };
    }
    case 'tools/call': {
      const r = callTool(String(msg.params?.name ?? ''), msg.params?.arguments ?? {});
      return { body: r.rpcError ? error(r.rpcError.code, r.rpcError.message) : reply(r.result) };
    }
    default: return { body: msg.id === undefined ? undefined : error(-32601, `method not found: ${msg.method}`) };
  }
}

createServer((req, res) => {
  const send = (status, body, headers = {}) => { res.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
  if (req.method === 'GET' && req.url === '/log') return send(200, { rows: ledger });
  if (req.url !== '/mcp') return send(404, { error: 'not found' });
  if (req.method === 'DELETE') { sessions.delete(String(req.headers['mcp-session-id'])); return send(204, undefined); }
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const sid = req.headers['mcp-session-id'];
    if (msg.method !== 'initialize' && sid && !sessions.has(String(sid))) return send(404, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'unknown session' } });
    const out = handle(msg, sid);
    if (out.newSession) sessions.add(out.newSession);
    if (out.body === undefined) return send(202, undefined);
    send(200, out.body, out.newSession ? { 'mcp-session-id': out.newSession } : {});
  });
}).listen(port, '127.0.0.1', () => process.stderr.write(`support-desk MCP server on http://127.0.0.1:${port}/mcp (ledger /log)${UNSAFE ? ' [UNSAFE: no approval guard]' : ''}\n`));
