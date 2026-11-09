// The ves-agent/1 session state machine (DESIGN-agnostic §1.2 sequence rules), shared by the `command` (stdio) and
// `http` connectors. A transport only has to (a) send one HarnessToAgent message and (b) push every AgentToHarness
// message it receives into the session's queue; this file enforces everything else:
//   rule 2  session.open -> session.opened (within open_timeout_s)
//   rule 3  each turn / hitl.decision / clock.advance / wake -> 0..n messages, then exactly one turn.end whose
//           turn_id is the triggering one (hitl.decision: its request_id; clock.advance: clock-<n>)
//   rule 4  tool_call -> HarnessIO.callTool (the proxy) -> tool_result, replied in the order received
//   rule 5  hitl.request + turn.end{awaiting_hitl} parks the agent
//   rule 6  session.close needs no reply; nothing about grading is taken from the agent at close
//   rule 7  an optional connector-level turn timeout -> FAIL "agent timeout" (the runner also enforces limits.timeout_s)
//   rule 8  error{fatal} -> FAIL, unless it carries http_status 401/403/429/5xx from the agent's own model provider
//           (origin 'provider' -> the runner's infra classifier marks the row INVALID); same for turn.end{error}
//   rule 9  usage: turn.end.usage is the turn's total and supersedes that turn's `usage` messages (never both)
// Process exit or stream loss mid-turn -> FAIL (agent-side). Unknown types are logged and ignored.
import { AsyncQueue, isTimeout } from './queue.ts';
import type { AgentToHarness, HarnessIO, HarnessToAgent, HitlDecision, PrincipalRole, TurnOutcome, TurnUsage } from '../../core/types.ts';

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
export type PeerSession = { id: string; q: AsyncQueue<AgentToHarness>; io: HarnessIO; clockN: number; wakeN: number; closed: boolean; [k: string]: unknown };
export type ExchangeOpts = { send: (m: HarnessToAgent) => Promise<void>; log: Log; turnTimeoutMs?: number };

const KNOWN = new Set(['ready', 'session.opened', 'message', 'tool_call', 'hitl.request', 'tool_event', 'effect', 'usage', 'turn.end', 'log', 'error']);
/** VES-1 §5.7 via §1.2 rule 8: provider statuses that make a row INVALID rather than FAIL. */
export const isProviderInfraStatus = (s: unknown): boolean => typeof s === 'number' && (s === 401 || s === 403 || s === 429 || (s >= 500 && s <= 599));
export const fail = (message: string, http_status?: number): TurnOutcome =>
  ({ status: 'error', error: { message, origin: isProviderInfraStatus(http_status) ? 'provider' : 'agent', ...(http_status !== undefined ? { http_status } : {}) } });

export function newPeerSession(id: string, io: HarnessIO): PeerSession {
  return { id, q: new AsyncQueue<AgentToHarness>(), io, clockN: 0, wakeN: 0, closed: false };
}

/** Basic shape check of an inbound message; returns a reason string when it is malformed. */
export function malformed(m: Record<string, unknown>): string | null {
  const str = (k: string) => typeof m[k] === 'string' && (m[k] as string).length <= 128 * 1024;
  switch (m.type) {
    case 'tool_call': return str('call_id') && str('name') ? null : 'tool_call needs call_id and name';
    case 'hitl.request': return str('request_id') && str('tool') ? null : 'hitl.request needs request_id and tool';
    case 'turn.end': return str('turn_id') && ['done', 'awaiting_hitl', 'error'].includes(String(m.reason)) ? null : 'turn.end needs turn_id and reason done|awaiting_hitl|error';
    case 'message': return typeof m.text === 'string' ? null : 'message needs text';
    default: return null;
  }
}

/** Route one inbound message: session-bound ones go to their session's queue, the rest to `other`. */
export function route(m: Record<string, unknown>, sessions: Map<string, PeerSession>, other: (m: Record<string, unknown>) => void): void {
  const sid = typeof m.session_id === 'string' ? m.session_id : null;
  const s = sid ? sessions.get(sid) : undefined;
  if (s && m.type !== 'ready') s.q.push(m as AgentToHarness); else other(m);
}

/** Wait for session.opened after sending session.open (rule 2). */
export async function awaitOpened(s: PeerSession, o: { log: Log; timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    const m = await s.q.next(Math.max(1, deadline - Date.now()));
    if (isTimeout(m)) throw new Error(`agent did not answer session.open with session.opened within ${Math.round(o.timeoutMs / 1000)} s`);
    if (m === null) throw new Error(`agent stream closed before session.opened (${s.q.closeReason})`);
    if (m.type === 'session.opened') return;
    if (m.type === 'error' && m.fatal) throw Object.assign(new Error(`agent error on session.open: ${m.message}`), { http_status: m.http_status });
    o.log('debug', `ignored ${m.type} before session.opened`);
  }
}

/**
 * Send one turn-triggering message and run the turn to its turn.end (rules 3-5, 7, 8). Every observable thing the
 * agent emits goes to HarnessIO; tool calls go ONLY through io.callTool, so the proxy records them.
 */
export async function exchange(s: PeerSession, msg: HarnessToAgent, turnId: string | null, o: ExchangeOpts): Promise<TurnOutcome> {
  if (s.closed) return fail('session already closed');
  // Usage accounting (rule 9): `usage` messages of this turn are held until the turn ends. A `turn.end` that carries
  // `usage` is the turn's total and supersedes them (an agent may send both for back-compat: never counted twice);
  // otherwise they are reported as they came. A turn that ends any other way (error, timeout, stream loss) still
  // reports what it spent.
  const held: AgentToHarness[] = [];
  const flush = (): void => { for (const u of held.splice(0)) s.io.report(u); };
  const out = await exchangeInner(s, msg, turnId, o, held);
  if (out.usage) { held.length = 0; s.io.report({ type: 'usage', session_id: s.id, ...out.usage }); } else flush();
  return out.outcome;
}

async function exchangeInner(s: PeerSession, msg: HarnessToAgent, turnId: string | null, o: ExchangeOpts, held: AgentToHarness[]): Promise<{ outcome: TurnOutcome; usage?: TurnUsage }> {
  const r = (outcome: TurnOutcome, usage?: TurnUsage) => ({ outcome, ...(usage ? { usage } : {}) });
  await o.send(msg);
  const deadline = o.turnTimeoutMs ? Date.now() + o.turnTimeoutMs : undefined;
  for (;;) {
    const m = await s.q.next(deadline ? Math.max(1, deadline - Date.now()) : undefined);
    if (isTimeout(m)) return r(fail(`agent timeout: no turn.end within ${Math.round((o.turnTimeoutMs ?? 0) / 1000)} s`));
    if (m === null) return r(fail(`agent ended mid-turn (${s.q.closeReason})`));
    const bad = malformed(m as Record<string, unknown>);
    if (bad) return r(fail(`protocol violation: ${bad}`));
    switch (m.type) {
      case 'tool_call': {
        const r = await s.io.callTool({ call_id: m.call_id, name: m.name, args: m.args && typeof m.args === 'object' && !Array.isArray(m.args) ? m.args : {}, transport: 'pipe' });
        await o.send({ type: 'tool_result', session_id: s.id, call_id: m.call_id, ok: r.ok, ...(r.result !== undefined ? { result: r.result } : {}), ...(r.error !== undefined ? { error: r.error } : {}) });
        break;
      }
      case 'message': case 'hitl.request': s.io.report(m); break;
      case 'usage': held.push(m); break;
      case 'tool_event': case 'effect': s.io.report(m, 'reported'); break;
      case 'turn.end': {
        if (turnId !== null && m.turn_id !== turnId) return r(fail(`protocol violation: turn.end for ${m.turn_id} while ${turnId} was open`));
        const u = usageOf(m.usage);
        if (m.reason === 'awaiting_hitl') return r({ status: 'awaiting_hitl' }, u);
        if (m.reason === 'error') return r(fail(m.error ?? 'agent ended the turn with an error', m.http_status), u);
        return r({ status: 'done' }, u);
      }
      case 'error':
        if (m.fatal) return r(fail(`agent error: ${m.message}`, m.http_status));
        o.log('warn', `agent error (non-fatal): ${m.message}`);
        break;
      case 'log': o.log(m.level ?? 'info', `agent: ${m.msg}`); break;
      case 'session.opened': break;
      default:
        if (!KNOWN.has(String((m as { type: unknown }).type))) o.log('debug', `ignored unknown message type ${(m as { type: unknown }).type}`);
    }
  }
}

/** A `turn.end.usage` object, or undefined when absent or not an object. */
export function usageOf(u: unknown): TurnUsage | undefined {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return undefined;
  const x = u as Record<string, unknown>;
  const num = (k: string) => (typeof x[k] === 'number' && Number.isFinite(x[k]) ? { [k]: x[k] as number } : {});
  return { ...num('input_tokens'), ...num('output_tokens'), ...num('usd'), ...(typeof x.model === 'string' ? { model: x.model } : {}), ...(x.usd_estimated === true ? { usd_estimated: true } : {}) };
}

/** The harness -> agent message for a user turn, a HITL decision, a clock advance or a wake, plus its turn id. */
export const turnMsg = (s: PeerSession, t: { text: string; as: PrincipalRole; thread: string; turn_id: string }): [HarnessToAgent, string] =>
  [{ type: 'turn', session_id: s.id, turn_id: t.turn_id, text: t.text, as: t.as, thread: t.thread }, t.turn_id];
export const decisionMsg = (s: PeerSession, d: HitlDecision): [HarnessToAgent, string] => {
  const rid = d.request_id ?? 'chat';
  return [{ type: 'hitl.decision', session_id: s.id, request_id: rid, decision: d.decision, as: d.as, thread: d.thread, ...(d.text ? { text: d.text } : {}), ...(d.args_edited ? { args_edited: d.args_edited } : {}) }, rid];
};
export const clockMsg = (s: PeerSession, duration: string, now: string): [HarnessToAgent, string] =>
  [{ type: 'clock.advance', session_id: s.id, duration, now }, `clock-${++s.clockN}`];
/** §1.2 does not fix a wake turn id; any turn.end closes a wake. */
export const wakeMsg = (s: PeerSession, scheduleId: string): [HarnessToAgent, null] =>
  [{ type: 'wake', session_id: s.id, schedule_id: scheduleId }, null];

/** Validate a `ready` handshake message. */
export function checkReady(m: Record<string, unknown>): string | null {
  if (m.type !== 'ready') return `expected ready, got ${String(m.type)}`;
  if (m.protocol !== 'ves-agent/1') return `unsupported protocol ${String(m.protocol)} (this harness speaks ves-agent/1)`;
  const a = m.agent as Record<string, unknown> | undefined;
  if (!a || typeof a.name !== 'string') return 'ready.agent.name is required';
  return null;
}
