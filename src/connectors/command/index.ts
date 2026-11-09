// `command` connector (DESIGN-agnostic §1.3): spawn the team's agent (any language) and speak ves-agent/1 JSONL over
// stdin/stdout. One process holds many sessions, sequentially (`reuse_process: true`, the default).
//   { "type": "command", "command": ["python", "ves/bridge.py"], "cwd": ".", "env": {...}, "env_passthrough": [...],
//     "startup_timeout_s": 30, "open_timeout_s": 30, "turn_timeout_s": 0, "reuse_process": true, "stderr": "capture",
//     "routes": ["ves/**", "agent/**"] }
// Health = spawn + `ready` handshake within startup_timeout_s; a process that does not handshake, or exits during
// health(), makes the row INVALID harness_bug ("agent did not handshake"). A process that exits mid-trial FAILs the
// trial (agent-side). Non-JSON stdout lines (framework banners) are logged and ignored. stderr is kept in a 1 MB
// ring buffer and its tail is attached to process-failure messages.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeLine, decodeLine, lines } from '../_shared/jsonl.ts';
import { agentEnv } from '../_shared/env.ts';
import { routesHash } from '../_shared/routes.ts';
import { spawnWithFallback } from '../_shared/spawn.ts';
import { AsyncQueue, isTimeout } from '../_shared/queue.ts';
import { checkReady, clockMsg, decisionMsg, exchange, newPeerSession, route, turnMsg, wakeMsg, awaitOpened, type PeerSession } from '../_shared/protocol.ts';
import { withStdioBridge } from '../_shared/stdio-bridge.ts';
import type {
  AgentInfo, AgentToHarness, ChildLike, ConnectionConfig, ConnSession, Connector, ConnectorDeps, ConnectorFactory, HarnessIO, HarnessToAgent, Health,
  HitlDecision, SessionOpen, SpawnLike, TurnOutcome, UserTurn,
} from '../../core/types.ts';

export const COMMAND_VERSION = '1.0.0';
const STDERR_CAP = 1024 * 1024;

type Ready = Extract<AgentToHarness, { type: 'ready' }>;
type Proc = {
  child: ChildLike; alive: boolean; exit: { code: number | null; signal: string | null } | null; stderr: string;
  ready: AsyncQueue<Record<string, unknown>>; readyMsg: Ready | null; sessions: Map<string, PeerSession>;
};

export function commandOf(cfg: ConnectionConfig): string[] {
  const c = cfg.command;
  if (Array.isArray(c) && c.length && c.every((x) => typeof x === 'string')) return c as string[];
  if (typeof c === 'string' && c.trim()) return c.trim().split(/\s+/);
  throw new Error('command connector needs connection.command (an argv array, e.g. ["python", "ves/bridge.py"])');
}

export class CommandConnector implements Connector {
  readonly kind = 'command' as const;
  readonly version = COMMAND_VERSION;
  readonly cfg: ConnectionConfig; readonly deps: ConnectorDeps; readonly argv: string[]; readonly cwd: string; readonly spawn: SpawnLike;
  private proc: Proc | null = null;
  private readyMsg: Ready | null = null;
  constructor(cfg: ConnectionConfig, deps: ConnectorDeps) {
    this.cfg = cfg; this.deps = deps; this.argv = commandOf(cfg);
    this.cwd = resolve(deps.repoRoot, typeof cfg.cwd === 'string' ? cfg.cwd : '.');
    this.spawn = spawnWithFallback(deps.spawn, deps.log);
  }
  private num(k: string, d: number): number { const v = this.cfg[k]; return typeof v === 'number' && v >= 0 ? v : d; }
  private get reuse(): boolean { return this.cfg.reuse_process !== false; }
  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string) { try { this.deps.log(level, `[command] ${msg}`); } catch { /* logging never fails a trial */ } }

  /** Spawn and wire one agent process. */
  private start(): Proc {
    const env = agentEnv(this.deps.env, this.cfg.env_passthrough, this.cfg.env);
    const child = this.spawn(this.argv[0], this.argv.slice(1), { cwd: this.cwd, env });
    const p: Proc = { child, alive: true, exit: null, stderr: '', ready: new AsyncQueue(), readyMsg: null, sessions: new Map() };
    const onOther = (m: Record<string, unknown>) => {
      if (m.type === 'ready') { p.ready.push(m); return; }
      if (m.type === 'log') { this.log((m.level as 'info') ?? 'info', `agent: ${String(m.msg)}`); return; }
      if (m.type === 'error') { this.log('warn', `agent error: ${String(m.message)}`); if (!p.readyMsg) p.ready.push(m); return; }
      this.log('debug', `ignored ${String(m.type)} for unknown session ${String(m.session_id ?? '-')}`);
    };
    void (async () => {
      try {
        for await (const l of lines(child.stdout)) {
          const d = decodeLine(l);
          if (!d) continue;
          if (d.kind === 'text') { this.log('debug', `stdout (non-JSON, ignored): ${d.text.slice(0, 300)}`); continue; }
          route(d.msg, p.sessions, onOther);
        }
      } catch (e) { this.log('warn', `stdout read failed: ${(e as Error).message}`); }
    })();
    if (this.cfg.stderr !== 'inherit') void (async () => {
      try { for await (const c of child.stderr) { p.stderr = (p.stderr + String(c)).slice(-STDERR_CAP); } } catch { /* closed */ }
    })();
    void child.exited.then((x) => {
      p.alive = false; p.exit = x;
      const why = `agent process exited (code ${x.code ?? 'null'}${x.signal ? `, ${x.signal}` : ''})${this.stderrTail(p)}`;
      p.ready.close(why);
      for (const s of p.sessions.values()) s.q.close(why);
    });
    return p;
  }
  private stderrTail(p: Proc): string { const t = p.stderr.trim().split('\n').slice(-5).join(' | '); return t ? `; stderr: ${t.slice(-600)}` : ''; }

  /** Rule 1: `ready` within startup_timeout_s. */
  private async handshake(p: Proc): Promise<Ready> {
    const ms = this.num('startup_timeout_s', 30) * 1000;
    const m = await p.ready.next(ms);
    if (isTimeout(m)) throw new Error(`agent did not handshake: no ready message within ${ms / 1000} s${this.stderrTail(p)}`);
    if (m === null) throw new Error(`agent did not handshake: ${p.ready.closeReason}`);
    const bad = checkReady(m);
    if (bad) throw new Error(`agent did not handshake: ${bad}`);
    p.readyMsg = m as Ready;
    return p.readyMsg;
  }
  private async ensure(): Promise<Proc> {
    if (this.proc?.alive && this.proc.readyMsg) return this.proc;
    const p = this.start();
    this.proc = p;
    this.readyMsg = await this.handshake(p);
    return p;
  }

  async health(): Promise<Health> {
    try { await this.ensure(); return { ok: true }; } catch (e) {
      this.proc?.child.kill();
      return { ok: false, reason: 'harness_bug', detail: (e as Error).message };
    }
  }
  async info(): Promise<AgentInfo> {
    if (!this.readyMsg) await this.ensure();
    const r = this.readyMsg!;
    const diffs: string[] = [];
    if (this.cfg.stderr === 'inherit') diffs.push('agent stderr inherited, not captured');
    return {
      name: r.agent.name, ...(r.agent.version ? { version: r.agent.version } : {}), ...(r.agent.framework ? { framework: r.agent.framework } : {}),
      ...(r.agent.model ? { model: r.agent.model } : {}), protocol: r.protocol,
      ...(r.tools ? { declaredTools: r.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.input_schema ? { input_schema: t.input_schema } : {}) })) } : {}),
      capabilities: r.capabilities ?? [], diffsFromProd: diffs,
    };
  }
  capabilities(): ReadonlySet<string> { return new Set(this.readyMsg?.capabilities ?? []); }
  async routesHash(): Promise<string> {
    return routesHash({ identity: { kind: this.kind, command: this.argv, cwd: typeof this.cfg.cwd === 'string' ? this.cfg.cwd : '.' }, root: this.deps.repoRoot, routes: this.cfg.routes, command: this.argv.slice(1) });
  }

  private sender(p: Proc): (m: HarnessToAgent) => Promise<void> {
    return async (m) => {
      if (!p.alive) throw Object.assign(new Error(`agent process is not running${this.stderrTail(p)}`), { origin: 'agent' });
      p.child.stdin.write(encodeLine(m));
    };
  }

  async open(o: SessionOpen, io: HarnessIO): Promise<ConnSession> {
    if (!this.reuse && this.proc) { this.proc.child.kill(); this.proc = null; }
    const p = await this.ensure();
    const s = newPeerSession(o.session_id, io);
    s.proc = p;
    p.sessions.set(s.id, s);
    await this.sender(p)(withStdioBridge(o));
    await awaitOpened(s, { log: (l, m) => this.log(l, m), timeoutMs: this.num('open_timeout_s', 30) * 1000 });
    return s;
  }
  private run(sess: ConnSession, [msg, turnId]: [HarnessToAgent, string | null]): Promise<TurnOutcome> {
    const s = sess as PeerSession;
    const p = s.proc as Proc;
    const t = this.num('turn_timeout_s', 0);
    return exchange(s, msg, turnId, { send: this.sender(p), log: (l, m) => this.log(l, m), ...(t ? { turnTimeoutMs: t * 1000 } : {}) })
      .catch((e: Error) => ({ status: 'error' as const, error: { message: e.message, origin: 'agent' as const } }));
  }
  turn(s: ConnSession, t: UserTurn): Promise<TurnOutcome> { return this.run(s, turnMsg(s as PeerSession, t)); }
  decide(s: ConnSession, d: HitlDecision): Promise<TurnOutcome> { return this.run(s, decisionMsg(s as PeerSession, d)); }
  advanceClock(s: ConnSession, duration: string, now: string): Promise<TurnOutcome> { return this.run(s, clockMsg(s as PeerSession, duration, now)); }
  wake(s: ConnSession, scheduleId: string): Promise<TurnOutcome> { return this.run(s, wakeMsg(s as PeerSession, scheduleId)); }

  async close(sess: ConnSession): Promise<void> {
    const s = sess as PeerSession;
    const p = s.proc as Proc;
    s.closed = true;
    if (p?.alive) { try { p.child.stdin.write(encodeLine({ type: 'session.close', session_id: s.id })); } catch { /* exited */ } }
    s.q.close('session closed by the harness');
    p?.sessions.delete(s.id);
    if (!this.reuse && p) { await this.stop(p); if (this.proc === p) this.proc = null; }
  }
  private async stop(p: Proc): Promise<void> {
    if (!p.alive) return;
    try { p.child.stdin.write(encodeLine({ type: 'shutdown' })); p.child.stdin.end(); } catch { /* gone */ }
    const grace = new Promise((r) => { const t = setTimeout(r, 2000); t.unref?.(); });
    await Promise.race([p.child.exited, grace]);
    if (p.alive) p.child.kill('SIGKILL');
  }
  async dispose(): Promise<void> { if (this.proc) { await this.stop(this.proc); this.proc = null; } }
  /** Captured stderr of the current process (for the runner to write trajectories/<row>.stderr.log once it asks). */
  stderr(): string { return this.proc?.stderr ?? ''; }
}

const factory: ConnectorFactory = { kind: 'command', version: COMMAND_VERSION, create: (cfg, deps) => new CommandConnector(cfg, deps) };
export default factory;
export const COMMAND_SOURCE = fileURLToPath(import.meta.url);
