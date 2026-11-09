// MCP clients for the `mcp` connector (DESIGN-agnostic §1.7): Streamable HTTP (moved here from
// src/adapters/mcp.ts, which core keeps for the v1 tests) and stdio (newline-delimited JSON-RPC to a spawned server).
// Transports are injected: `fetch` for HTTP, `spawn` for stdio. Both expose the same small surface.
import { lines } from './jsonl.ts';
import { rpcReplies } from './stdio-bridge.ts';
import type { ChildLike, FetchLike, SpawnLike } from '../../core/types.ts';

export class McpRpcError extends Error {
  http_status?: number; code?: number;
  constructor(msg: string, http_status?: number, code?: number) { super(msg); this.http_status = http_status; this.code = code; }
}
/** One JSON-RPC exchange as the mcp-conformance transcript contract records it (src/proxy/mcp-transcript.ts). */
export type McpExchange = { method: string; params?: Record<string, unknown>; status: number; response: { result?: any; error?: any } | null };
export type McpTool = { name: string; title?: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: Record<string, unknown> };
export interface McpClient {
  readonly protocol: string; negotiatedProtocol?: string; serverInfo?: unknown; clientInfo: { name: string; version: string };
  /** Called with every exchange (contract mode reports them as `mcp.rpc` effects). */
  tap?: (ex: McpExchange) => void;
  rpc(method: string, params?: unknown, notify?: boolean): Promise<any>;
  initialize(): Promise<any>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

abstract class Base {
  protocol: string; clientInfo: { name: string; version: string }; negotiatedProtocol?: string; serverInfo?: unknown; nextId = 1;
  tap?: (ex: McpExchange) => void;
  protected record(method: string, params: unknown, status: number, response: McpExchange['response']): void {
    this.tap?.({ method, ...(params && typeof params === 'object' ? { params: params as Record<string, unknown> } : {}), status, response });
  }
  constructor(o: { clientName?: string; protocol?: string }) { this.clientInfo = { name: o.clientName ?? 'ves', version: '1.0.0' }; this.protocol = o.protocol ?? '2025-06-18'; }
  abstract rpc(method: string, params?: unknown, notify?: boolean): Promise<any>;
  async initialize(): Promise<any> {
    const r = await this.rpc('initialize', { protocolVersion: this.protocol, capabilities: {}, clientInfo: this.clientInfo });
    this.negotiatedProtocol = r?.protocolVersion ?? this.protocol;
    this.serverInfo = r?.serverInfo;
    await this.rpc('notifications/initialized', undefined, true);
    return r;
  }
  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {});
      out.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
  callTool(name: string, args: Record<string, unknown>): Promise<any> { return this.rpc('tools/call', { name, arguments: args }); }
}

/** JSON-RPC 2.0 over MCP Streamable HTTP (JSON or SSE replies), keeping mcp-session-id / mcp-protocol-version. */
export class McpHttpClient extends Base implements McpClient {
  url: string; fetch: FetchLike; headersExtra: Record<string, string>; sessionId?: string;
  constructor(o: { url: string; fetch: FetchLike; headers?: Record<string, string>; clientName?: string; protocol?: string }) {
    super(o); this.url = o.url; this.fetch = o.fetch; this.headersExtra = o.headers ?? {};
  }
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headersExtra };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.negotiatedProtocol) h['mcp-protocol-version'] = this.negotiatedProtocol;
    return h;
  }
  async rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const id = notify ? null : this.nextId++;
    const body = JSON.stringify(notify ? { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) } : { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    const res = await this.fetch(this.url, { method: 'POST', headers: this.headers(), body });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    const msg0 = notify ? null : (rpcReplies(text, res.headers.get('content-type')).find((m: any) => m?.id === id) as any) ?? null;
    this.record(method, params, res.status, msg0 ? (msg0.error ? { error: msg0.error } : { result: msg0.result }) : null);
    if (res.status >= 400) throw new McpRpcError(`HTTP ${res.status} on ${method}: ${text.slice(0, 200)}`, res.status);
    if (notify) return null;
    const msg = msg0;
    if (!msg) throw new McpRpcError(`no JSON-RPC response for ${method}`, res.status);
    if (msg.error) throw new McpRpcError(`JSON-RPC ${msg.error.code}: ${msg.error.message}`, res.status, msg.error.code);
    return msg.result;
  }
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try { await (await this.fetch(this.url, { method: 'DELETE', headers: this.headers() })).text(); } catch { /* best effort */ }
    this.sessionId = undefined;
  }
}

/** JSON-RPC 2.0 over a spawned stdio MCP server (one JSON message per line). */
export class McpStdioClient extends Base implements McpClient {
  child: ChildLike; private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>(); private dead: string | null = null; stderr = '';
  constructor(o: { command: string[]; spawn: SpawnLike; cwd: string; env: Record<string, string>; clientName?: string; protocol?: string }) {
    super(o);
    const child = o.spawn(o.command[0], o.command.slice(1), { cwd: o.cwd, env: o.env });
    this.child = child;
    void (async () => {
      for await (const l of lines(child.stdout)) {
        let m: any; try { m = JSON.parse(l); } catch { continue; }
        if (m && m.id !== undefined && m.id !== null && (m.result !== undefined || m.error !== undefined)) {
          const p = this.pending.get(m.id); if (!p) continue; this.pending.delete(m.id);
          if (m.error) p.rej(new McpRpcError(`JSON-RPC ${m.error.code}: ${m.error.message}`, undefined, m.error.code)); else p.res(m.result);
        } else if (m && typeof m.method === 'string' && m.id !== undefined) {
          // a server -> client request (roots/list, sampling/createMessage, elicitation): not offered by the harness
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `client does not support ${m.method}` } }) + '\n');
        }
      }
    })();
    void (async () => { try { for await (const c of child.stderr) this.stderr = (this.stderr + String(c)).slice(-65536); } catch { /* closed */ } })();
    void child.exited.then((x) => {
      this.dead = `MCP server process exited (code ${x.code ?? 'null'})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
      for (const p of this.pending.values()) p.rej(new McpRpcError(this.dead, 503));
      this.pending.clear();
    });
  }
  rpc(method: string, params?: unknown, notify = false): Promise<any> {
    if (this.dead) return Promise.reject(new McpRpcError(this.dead, 503));
    if (notify) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n'); this.record(method, params, 202, null); return Promise.resolve(null); }
    const id = this.nextId++;
    return new Promise((res, rej) => {
      // stdio has no HTTP status: 200 for a reply (result or JSON-RPC error), 503 when the process died
      this.pending.set(id, {
        res: (v) => { this.record(method, params, 200, { result: v }); res(v); },
        rej: (e) => { const er = e as McpRpcError; this.record(method, params, er.code !== undefined ? 200 : 503, er.code !== undefined ? { error: { code: er.code, message: er.message.replace(/^JSON-RPC -?\d+: /, '') } } : null); rej(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    });
  }
  async close(): Promise<void> { try { this.child.stdin.end(); } catch { /* gone */ } this.child.kill(); }
}

/** Reads a tool-level error from an MCP tools/call result (structuredContent, JSON text content, or isError). */
export function toolError(result: any): string | undefined {
  const sc = result?.structuredContent;
  if (sc && typeof sc === 'object' && sc.error) return String(sc.error);
  for (const c of result?.content ?? []) {
    if (c?.type !== 'text') continue;
    try { const j = JSON.parse(c.text); if (j?.error) return String(j.error); } catch { if (/approval_required/.test(c.text)) return 'approval_required'; }
  }
  return result?.isError ? 'tool_error' : undefined;
}

/** The useful payload of a tools/call result: structuredContent, else the parsed (or raw) text content. */
export function toolPayload(result: any): unknown {
  const texts = (result?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text);
  const sc = result?.structuredContent;
  // structuredContent must be an object, so servers wrap arrays/scalars as {result: X}; unwrap when the text agrees
  if (sc && typeof sc === 'object' && Object.keys(sc).length === 1 && 'result' in sc && texts.length === 1) {
    try { const t = JSON.parse(texts[0]); if (JSON.stringify(t) === JSON.stringify(sc.result)) return t; } catch { /* keep sc */ }
  }
  if (sc !== undefined) return sc;
  if (texts.length === 1) { try { return JSON.parse(texts[0]); } catch { return texts[0]; } }
  return texts.length ? texts.join('\n') : result ?? null;
}
