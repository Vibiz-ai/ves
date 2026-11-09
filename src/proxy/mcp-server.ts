// Minimal MCP Streamable-HTTP server for the per-trial tool proxy (DESIGN-agnostic §1.2, §7.1 item 5), as a PURE
// request handler: `handle(req) -> Promise<res>`. Implements initialize, notifications/initialized, ping,
// tools/list and tools/call with JSON responses (no SSE needed for a request/response tool server).
// `http-binding.ts` mounts it on node:http at 127.0.0.1 outside tests; tests call handle() in-process. The packs
// builder's mcp-conformance tests use it with deliberately broken tools (`opts.faults`).
import type { ToolSpec } from '../core/types.ts';

export type McpReq = { method: string; path?: string; headers: Record<string, string | undefined>; body?: string };
export type McpRes = { status: number; headers: Record<string, string>; body: string };
export type McpServerOptions = {
  tools: () => ToolSpec[];
  invoke: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string; details?: unknown }>;
  /** Unguessable per-trial path token; requests must hit /s/<token>/mcp when set. */
  token?: string;
  serverInfo?: { name: string; version: string };
  protocolVersions?: string[];
  pageSize?: number;
  /** Test hooks to build deliberately broken servers (mcp-conformance pack tests). */
  faults?: { badSchema?: string[]; readOnlyHintOn?: string[]; unknownToolSucceeds?: boolean; noSessionHeader?: boolean };
};

const json = (status: number, obj: unknown, extra: Record<string, string> = {}): McpRes =>
  ({ status, headers: { 'content-type': 'application/json', ...extra }, body: obj === undefined ? '' : JSON.stringify(obj) });
const rpcErr = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

export function createMcpHandler(o: McpServerOptions): (req: McpReq) => Promise<McpRes> {
  const versions = o.protocolVersions ?? ['2025-06-18', '2025-03-26', '2026-07-28'];
  const sessions = new Set<string>();
  let n = 0;
  const toMcp = (t: ToolSpec) => {
    const f = o.faults ?? {};
    const inputSchema = f.badSchema?.includes(t.name) ? { type: 'string' } : (t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object' });
    const readOnly = f.readOnlyHintOn?.includes(t.name) ? true : t.classes.includes('read');
    return {
      name: t.name, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description } : {}), inputSchema,
      ...(t.output_schema ? { outputSchema: t.output_schema } : {}),
      annotations: { readOnlyHint: readOnly, destructiveHint: t.classes.includes('destructive'), openWorldHint: t.classes.includes('outward') },
    };
  };
  const one = async (msg: any, sid: string | undefined): Promise<{ reply?: unknown; newSession?: string }> => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { reply: rpcErr(msg?.id, -32600, 'invalid request') };
    const isNote = msg.id === undefined || msg.id === null;
    if (msg.method === 'initialize') {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = versions.includes(asked) ? asked : versions[0];
      const s = `ves-${++n}-${Math.random().toString(16).slice(2, 10)}`;
      sessions.add(s);
      return { newSession: s, reply: { jsonrpc: '2.0', id: msg.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: o.serverInfo ?? { name: 'ves-proxy', version: '1.0.0' } } } };
    }
    if (msg.method.startsWith('notifications/')) return {};
    if (!o.faults?.noSessionHeader && (!sid || !sessions.has(sid))) return { reply: isNote ? undefined : rpcErr(msg.id, -32000, 'missing or unknown mcp-session-id (initialize first)') };
    if (msg.method === 'ping') return { reply: { jsonrpc: '2.0', id: msg.id, result: {} } };
    if (msg.method === 'tools/list') {
      const all = o.tools().map(toMcp);
      const size = o.pageSize ?? 100;
      const start = msg.params?.cursor ? Number(Buffer.from(String(msg.params.cursor), 'base64url').toString('utf8')) || 0 : 0;
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? Buffer.from(String(start + size), 'utf8').toString('base64url') : undefined;
      return { reply: { jsonrpc: '2.0', id: msg.id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } } };
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== 'string') return { reply: rpcErr(msg.id, -32602, 'tools/call needs params.name') };
      if (!o.tools().some((t) => t.name === name) && !o.faults?.unknownToolSucceeds) {
        await o.invoke(name, args); // recorded as unknown_tool by the proxy
        return { reply: rpcErr(msg.id, -32602, `unknown tool ${name}`) };
      }
      const r = await o.invoke(name, args);
      const payload = r.ok ? r.result : { error: r.error, ...(r.details !== undefined ? { details: r.details } : {}) };
      const structured = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { result: payload };
      return { reply: { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload ?? null) }], structuredContent: structured, isError: !r.ok } } };
    }
    return { reply: isNote ? undefined : rpcErr(msg.id, -32601, `method not found: ${msg.method}`) };
  };
  return async (req: McpReq): Promise<McpRes> => {
    if (o.token && req.path !== undefined && !req.path.startsWith(`/s/${o.token}/`)) return json(404, { error: 'not found' });
    if (req.method === 'GET') return json(405, { error: 'SSE stream not offered; POST JSON-RPC' }, { allow: 'POST' });
    if (req.method === 'DELETE') { if (req.headers['mcp-session-id']) sessions.delete(req.headers['mcp-session-id']!); return json(204, undefined); }
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    let body: any;
    try { body = JSON.parse(req.body ?? ''); } catch { return json(400, rpcErr(null, -32700, 'parse error')); }
    const sid = req.headers['mcp-session-id'];
    const msgs = Array.isArray(body) ? body : [body];
    const replies: unknown[] = [];
    let newSession: string | undefined;
    for (const m of msgs) { const r = await one(m, sid ?? newSession); if (r.newSession) newSession = r.newSession; if (r.reply !== undefined) replies.push(r.reply); }
    const hdr: Record<string, string> = newSession ? { 'mcp-session-id': newSession } : {};
    if (!replies.length) return { status: 202, headers: hdr, body: '' };
    return json(200, Array.isArray(body) ? replies : replies[0], hdr);
  };
}
