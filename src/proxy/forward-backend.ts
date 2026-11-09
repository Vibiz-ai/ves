// Forward tool backend (DESIGN-agnostic §1.6 step 4 `forward`): call the team's real sandbox implementation and record
// it. Transports are INJECTED (fetch, spawn, a bridge callback), so tests never touch the network. The proxy still
// records every call; it never enforces approval itself. A `guard_signal` marks guard_fired when the user's own
// server refuses (e.g. {"pointer": "/error", "equals": "approval_required"}).
import { McpHttpClient, toolError } from '../adapters/mcp.ts';
import { getPointer } from './sim-backend.ts';
import type { ExecResult } from './sim-backend.ts';
import type { ChildLike, FetchLike, ForwardBackendConfig, SpawnLike } from '../core/types.ts';

export type ForwardDeps = {
  fetch?: FetchLike; spawn?: SpawnLike; cwd?: string; env?: Record<string, string>;
  /** `{type: "bridge"}`: tool.invoke goes back over the agent's own pipe (supplied by the connector adapter). */
  bridge?: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
};
export interface ToolBackend { readonly kind: 'sim' | 'forward'; execute(name: string, args: Record<string, unknown>): Promise<ExecResult>; close?(): Promise<void> }

export function guardFired(result: unknown, sig?: { pointer: string; equals: unknown }): boolean {
  if (!sig) return false;
  const r = getPointer(result, sig.pointer);
  return r.found && JSON.stringify(r.value) === JSON.stringify(sig.equals);
}

export class ForwardBackend implements ToolBackend {
  readonly kind = 'forward' as const;
  cfg: ForwardBackendConfig; deps: ForwardDeps; guard?: { pointer: string; equals: unknown };
  private mcp?: McpHttpClient; private child?: ChildLike; private pending = new Map<string, (r: any) => void>(); private n = 0;
  constructor(cfg: ForwardBackendConfig, deps: ForwardDeps, guard?: { pointer: string; equals: unknown }) { this.cfg = cfg; this.deps = deps; this.guard = guard; }

  async execute(name: string, args: Record<string, unknown>): Promise<ExecResult> {
    const c = this.cfg;
    let out: { ok: boolean; result?: unknown; error?: string };
    if (c.type === 'http') {
      if (!this.deps.fetch) throw new Error('forward http backend needs an injected fetch');
      const res = await this.deps.fetch(`${c.url.replace(/\/$/, '')}/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(c.headers ?? {}) }, body: JSON.stringify(args) });
      const text = await res.text();
      let j: any; try { j = JSON.parse(text); } catch { j = { ok: res.status < 400, result: text }; }
      out = res.status >= 400 ? { ok: false, error: j?.error ?? `http_${res.status}`, result: j } : { ok: j?.ok !== false, result: j?.result ?? j, error: j?.error };
    } else if (c.type === 'mcp') {
      if (!c.url) throw new Error('forward mcp backend over stdio is provided by the connectors package; give a url here');
      if (!this.mcp) { this.mcp = new McpHttpClient({ url: c.url, fetch: this.deps.fetch }); await this.mcp.initialize(); }
      const r = await this.mcp.callTool(name, args);
      const err = toolError(r);
      out = { ok: !err, result: r?.structuredContent ?? r, ...(err ? { error: err } : {}) };
    } else if (c.type === 'command') {
      out = await this.viaCommand(c.command, name, args);
    } else {
      if (!this.deps.bridge) throw new Error('forward bridge backend needs the connector bridge callback');
      out = await this.deps.bridge(name, args);
    }
    return { ...out, guard: guardFired(out.result ?? out, this.guard) || (out.error !== undefined && this.guard !== undefined && JSON.stringify(out.error) === JSON.stringify(this.guard.equals)) };
  }

  /** JSONL `{"type":"tool.invoke",id,name,args}` -> `{"type":"tool.result",id,ok,result?,error?}` over a reused child. */
  private async viaCommand(cmd: string[], name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    if (!this.deps.spawn) throw new Error('forward command backend needs an injected spawn');
    if (!this.child) {
      this.child = this.deps.spawn(cmd[0], cmd.slice(1), { cwd: this.deps.cwd ?? process.cwd(), env: this.deps.env ?? {} });
      const child = this.child;
      void (async () => {
        let buf = '';
        for await (const chunk of child.stdout) {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { const m = JSON.parse(line); if (m?.type === 'tool.result' && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); } } catch { /* banner */ }
          }
        }
      })();
    }
    const id = `t${++this.n}`;
    const p = new Promise<any>((res) => this.pending.set(id, res));
    this.child.stdin.write(JSON.stringify({ type: 'tool.invoke', id, name, args }) + '\n');
    const m = await p;
    return { ok: !!m.ok, result: m.result, ...(m.error ? { error: String(m.error) } : {}) };
  }
  async close(): Promise<void> { if (this.child) { this.child.stdin.end(); this.child.kill(); } }
}
