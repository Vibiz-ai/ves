// MCP JSON-RPC transcript client (DESIGN-agnostic §4.8; moved into core from packs/mcp-conformance so MockAgent and the
// mcp connector share it). The protocol-level checks
// (handshake, tools/list paging, schemas, annotations, unknown tool, invalid args) grade a TRANSCRIPT of the
// exchanges the harness, acting as the MCP client in contract mode, had with the server under test.
//
// Evidence contract (for the connectors package's `mcp` connector in `mode: "contract"`, and for core's MockAgent):
//   * at session open: `initialize` then `notifications/initialized`;
//   * for each case `rpc` turn: send it; for `tools/list`, follow `nextCursor` up to MAX_PAGES pages;
//   * report EVERY exchange through HarnessIO.report as
//       { type: "effect", session_id, kind: "mcp.rpc", args: RpcExchange }
//     (it lands in Collected2.sideEffects; the graders read it from there).
// The client below implements exactly that over an injected `send` (fetch in production, an in-process
// `createMcpHandler()` in tests), so connectors can reuse it instead of re-deriving the convention.
// Plain TypeScript, no core imports at runtime.

export const RPC_EFFECT = 'mcp.rpc';
export const MAX_PAGES = 50;
export type McpHttpReply = { status: number; headers: Record<string, string | undefined>; body: string };
export type McpSend = (body: unknown, headers: Record<string, string>) => Promise<McpHttpReply>;
export type RpcExchange = {
  seq: number; method: string; params?: Record<string, unknown>; status: number;
  /** The JSON-RPC reply ({result} or {error}); null for notifications (no body) or an unparseable body. */
  response: { result?: any; error?: any } | null;
};

export class McpTranscriptClient {
  readonly send: McpSend; readonly protocolVersion: string;
  exchanges: RpcExchange[] = [];
  session?: string; negotiated?: string;
  private n = 0;
  constructor(send: McpSend, o: { protocolVersion?: string } = {}) { this.send = send; this.protocolVersion = o.protocolVersion ?? '2025-06-18'; }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.session ? { 'mcp-session-id': this.session } : {}), ...(this.negotiated ? { 'mcp-protocol-version': this.negotiated } : {}) };
  }
  private async one(method: string, params?: Record<string, unknown>, notification = false): Promise<RpcExchange> {
    const id = notification ? undefined : ++this.n;
    const r = await this.send({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) }, this.headers());
    let response: RpcExchange['response'] = null;
    if (r.body) { try { const j = JSON.parse(r.body); response = Array.isArray(j) ? j[0] ?? null : j; } catch { response = null; } }
    const sid = r.headers['mcp-session-id'];
    if (sid) this.session = sid;
    const ex: RpcExchange = { seq: this.exchanges.length + 1, method, ...(params ? { params } : {}), status: r.status, response };
    this.exchanges.push(ex);
    return ex;
  }

  /** `initialize` + `notifications/initialized`. */
  async initialize(): Promise<RpcExchange[]> {
    const init = await this.one('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'ves', version: '1' } });
    const v = init.response?.result?.protocolVersion;
    if (typeof v === 'string') this.negotiated = v;
    const note = await this.one('notifications/initialized', undefined, true);
    return [init, note];
  }

  /** One case `rpc` turn. `tools/list` follows nextCursor (at most MAX_PAGES pages). */
  async rpc(method: string, params?: Record<string, unknown>): Promise<RpcExchange[]> {
    if (method !== 'tools/list') return [await this.one(method, params)];
    const out: RpcExchange[] = [];
    let cursor: unknown = params?.cursor;
    for (let i = 0; i < MAX_PAGES; i++) {
      const ex = await this.one('tools/list', cursor === undefined ? params : { ...(params ?? {}), cursor });
      out.push(ex);
      cursor = ex.response?.result?.nextCursor;
      if (cursor === undefined || cursor === null || cursor === '') break;
    }
    return out;
  }
}

/** The transcript a trial collected (effects of kind mcp.rpc), in order. */
export function transcriptOf(sideEffects: { kind: string; args?: unknown }[]): RpcExchange[] {
  return sideEffects.filter((e) => e.kind === RPC_EFFECT && e.args && typeof e.args === 'object').map((e) => e.args as RpcExchange).sort((a, b) => a.seq - b.seq);
}

/** The first complete tools/list chain: pages, whether it terminated, and every listed tool. */
export function listedTools(tx: RpcExchange[]): { pages: RpcExchange[]; terminated: boolean; tools: any[] } {
  const all = tx.filter((e) => e.method === 'tools/list');
  const start = all.findIndex((e) => e.params?.cursor === undefined);
  if (start < 0) return { pages: [], terminated: false, tools: [] };
  const pages: RpcExchange[] = [all[start]];
  for (let i = start + 1; i < all.length; i++) {
    const prev = pages[pages.length - 1].response?.result?.nextCursor;
    if (prev === undefined || prev === null || prev === '' || all[i].params?.cursor !== prev) break;
    pages.push(all[i]);
  }
  const last = pages[pages.length - 1].response?.result;
  const terminated = !!last && (last.nextCursor === undefined || last.nextCursor === null || last.nextCursor === '');
  const tools = pages.flatMap((p) => (Array.isArray(p.response?.result?.tools) ? p.response!.result.tools : []));
  return { pages, terminated, tools };
}
