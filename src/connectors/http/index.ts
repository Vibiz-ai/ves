// `http` connector (DESIGN-agnostic §1.4): ves-agent/1 over HTTP, for agents that are already servers (FastAPI,
// Express, Next.js routes, LangServe, Mastra servers).
//   GET    {base}/ves/v1/health                 -> 200 + the `ready` message
//   POST   {base}/ves/v1/sessions               -> body session.open, 200 + session.opened
//   POST   {base}/ves/v1/sessions/{id}/events   -> body one HarnessToAgent message; 200 NDJSON (or SSE `data:` lines)
//                                                  stream of AgentToHarness messages ending after turn.end. A tool_call
//                                                  is answered by a new POST .../events with tool_result; the turn
//                                                  continues in THAT response.
//   DELETE {base}/ves/v1/sessions/{id}          -> 204
//   { "type": "http", "base_url": "http://127.0.0.1:8000", "headers": {...}, "timeout_s": 180, "allow_hosts": [] }
// Non-local hosts are refused unless listed in allow_hosts. fetch is injected (deps.fetch); tests never touch sockets.
import { agentMessages } from '../_shared/jsonl.ts';
import { hostAllowed } from '../_shared/hosts.ts';
import { checkReady, clockMsg, decisionMsg, exchange, newPeerSession, turnMsg, wakeMsg, type PeerSession } from '../_shared/protocol.ts';
import { withStdioBridge } from '../_shared/stdio-bridge.ts';
import { routesHash } from '../_shared/routes.ts';
import { createHash } from 'node:crypto';
import type {
  AgentInfo, AgentToHarness, ConnectionConfig, ConnSession, Connector, ConnectorDeps, ConnectorFactory, FetchLike, HarnessIO, HarnessToAgent, Health,
  HitlDecision, InvalidReason, SessionOpen, TurnOutcome, UserTurn,
} from '../../core/types.ts';

export const HTTP_VERSION = '1.0.0';
type Ready = Extract<AgentToHarness, { type: 'ready' }>;
type Res = Awaited<ReturnType<FetchLike>>;

/** A fetch response body as text chunks (streamed when `body` is a ReadableStream, else one `text()` chunk). */
export async function* bodyChunks(res: Res): AsyncGenerator<string> {
  const b = res.body;
  if (b && typeof (b as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (b as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; yield dec.decode(value, { stream: true }); }
      const tail = dec.decode(); if (tail) yield tail;
    } finally { try { reader.releaseLock(); } catch { /* released */ } }
    return;
  }
  yield await res.text();
}

export const reasonForStatus = (s: number): InvalidReason =>
  s === 401 || s === 403 ? 'infra_auth' : s === 429 ? 'infra_rate_limit' : s >= 500 ? 'infra_upstream_5xx' : 'harness_bug';

export class HttpConnector implements Connector {
  readonly kind = 'http' as const;
  readonly version = HTTP_VERSION;
  readonly cfg: ConnectionConfig; readonly deps: ConnectorDeps; readonly base: string;
  private readyMsg: Ready | null = null;
  constructor(cfg: ConnectionConfig, deps: ConnectorDeps) {
    this.cfg = cfg; this.deps = deps;
    if (typeof cfg.base_url !== 'string' || !cfg.base_url) throw new Error('http connector needs connection.base_url');
    this.base = cfg.base_url.replace(/\/+$/, '');
  }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/x-ndjson, text/event-stream, application/json', ...extra };
    if (this.cfg.headers && typeof this.cfg.headers === 'object') for (const [k, v] of Object.entries(this.cfg.headers as Record<string, unknown>)) h[k.toLowerCase()] = String(v);
    return h;
  }
  private signal(): AbortSignal | undefined {
    const t = typeof this.cfg.timeout_s === 'number' ? this.cfg.timeout_s : 180;
    return t > 0 && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(t * 1000) : undefined;
  }
  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string) { try { this.deps.log(level, `[http] ${msg}`); } catch { /* never fails a trial */ } }
  private async req(method: string, path: string, body?: unknown): Promise<Res> {
    const sig = this.signal();
    return this.deps.fetch(`${this.base}${path}`, { method, headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(sig ? { signal: sig } : {}) });
  }

  async health(): Promise<Health> {
    const h = hostAllowed(this.base, this.cfg.allow_hosts);
    if (!h.ok) return { ok: false, reason: 'harness_bug', detail: h.reason };
    try {
      const res = await this.req('GET', '/ves/v1/health');
      const text = await res.text();
      if (res.status !== 200) return { ok: false, reason: reasonForStatus(res.status), detail: `agent did not handshake: GET /ves/v1/health -> HTTP ${res.status} ${text.slice(0, 200)}` };
      let m: Record<string, unknown>;
      try { m = JSON.parse(text); } catch { return { ok: false, reason: 'harness_bug', detail: 'agent did not handshake: /ves/v1/health did not return JSON' }; }
      const bad = checkReady(m);
      if (bad) return { ok: false, reason: 'harness_bug', detail: `agent did not handshake: ${bad}` };
      this.readyMsg = m as Ready;
      return { ok: true };
    } catch (e) { return { ok: false, reason: 'harness_bug', detail: `agent did not handshake: ${(e as Error).message}` }; }
  }
  async info(): Promise<AgentInfo> {
    if (!this.readyMsg) { const h = await this.health(); if (!h.ok) throw new Error(h.detail); }
    const r = this.readyMsg!;
    return {
      name: r.agent.name, ...(r.agent.version ? { version: r.agent.version } : {}), ...(r.agent.framework ? { framework: r.agent.framework } : {}),
      ...(r.agent.model ? { model: r.agent.model } : {}), protocol: r.protocol,
      ...(r.tools ? { declaredTools: r.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.input_schema ? { input_schema: t.input_schema } : {}) })) } : {}),
      capabilities: r.capabilities ?? [], diffsFromProd: [],
    };
  }
  capabilities(): ReadonlySet<string> { return new Set(this.readyMsg?.capabilities ?? []); }
  async routesHash(): Promise<string> {
    return Array.isArray(this.cfg.routes) && this.cfg.routes.length
      ? routesHash({ identity: { kind: this.kind, base: this.base }, root: this.deps.repoRoot, routes: this.cfg.routes })
      : createHash('sha256').update(JSON.stringify({ kind: this.kind, base: this.base, agent: this.readyMsg?.agent ?? null })).digest('hex');
  }

  /** POST one event and pump its streamed reply into the session queue (in the background). */
  private sender(s: PeerSession): (m: HarnessToAgent) => Promise<void> {
    return async (m) => {
      const res = await this.req('POST', `/ves/v1/sessions/${encodeURIComponent(s.id)}/events`, m);
      if (res.status < 200 || res.status >= 300) {
        const t = await res.text().catch(() => '');
        // The agent server itself failed this event: agent-side (FAIL), even for a 5xx. Only the agent's own model
        // provider statuses, carried inside an `error`/`turn.end` message, make a row INVALID (§1.2 rule 8).
        s.q.push({ type: 'error', session_id: s.id, message: `POST events -> HTTP ${res.status} ${t.slice(0, 200)}`, fatal: true });
        return;
      }
      const pump = (async () => {
        try {
          for await (const msg of agentMessages(bodyChunks(res), res.headers.get('content-type'), (t) => this.log('debug', `non-JSON line ignored: ${t.slice(0, 200)}`))) {
            if (msg.session_id !== undefined && msg.session_id !== s.id) { this.log('debug', `message for another session ignored`); continue; }
            s.q.push({ ...(msg as AgentToHarness), session_id: s.id } as AgentToHarness);
          }
        } catch (e) { if (!s.closed) s.q.push({ type: 'error', session_id: s.id, message: `event stream broke: ${(e as Error).message}`, fatal: true }); }
      })();
      s.pumps = [...((s.pumps as Promise<void>[]) ?? []), pump];
    };
  }

  async open(o: SessionOpen, io: HarnessIO): Promise<ConnSession> {
    const res = await this.req('POST', '/ves/v1/sessions', withStdioBridge(o));
    const text = await res.text();
    if (res.status !== 200) throw Object.assign(new Error(`POST /ves/v1/sessions -> HTTP ${res.status} ${text.slice(0, 200)}`), { origin: 'agent' });
    let m: Record<string, unknown> | null = null;
    try { m = JSON.parse(text); } catch { /* below */ }
    if (!m || m.type !== 'session.opened') throw Object.assign(new Error('agent did not answer session.open with session.opened'), { origin: 'agent' });
    return newPeerSession(o.session_id, io);
  }
  private run(sess: ConnSession, [msg, turnId]: [HarnessToAgent, string | null]): Promise<TurnOutcome> {
    const s = sess as PeerSession;
    const t = typeof this.cfg.turn_timeout_s === 'number' ? this.cfg.turn_timeout_s : 0;
    return exchange(s, msg, turnId, { send: this.sender(s), log: (l, m) => this.log(l, m), ...(t ? { turnTimeoutMs: t * 1000 } : {}) })
      .catch((e: Error) => ({ status: 'error' as const, error: { message: `agent unreachable: ${e.message}`, origin: 'agent' as const } }));
  }
  turn(s: ConnSession, t: UserTurn): Promise<TurnOutcome> { return this.run(s, turnMsg(s as PeerSession, t)); }
  decide(s: ConnSession, d: HitlDecision): Promise<TurnOutcome> { return this.run(s, decisionMsg(s as PeerSession, d)); }
  advanceClock(s: ConnSession, duration: string, now: string): Promise<TurnOutcome> { return this.run(s, clockMsg(s as PeerSession, duration, now)); }
  wake(s: ConnSession, scheduleId: string): Promise<TurnOutcome> { return this.run(s, wakeMsg(s as PeerSession, scheduleId)); }
  async close(sess: ConnSession): Promise<void> {
    const s = sess as PeerSession;
    s.closed = true;
    s.q.close('session closed by the harness');
    try { await (await this.req('DELETE', `/ves/v1/sessions/${encodeURIComponent(s.id)}`)).text(); } catch (e) { this.log('debug', `DELETE session failed: ${(e as Error).message}`); }
  }
}

const factory: ConnectorFactory = { kind: 'http', version: HTTP_VERSION, create: (cfg, deps) => new HttpConnector(cfg, deps) };
export default factory;
