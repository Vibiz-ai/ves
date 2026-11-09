// Generic HITL (DESIGN-agnostic §3.4). Executing a case `hitl` turn makes the HARNESS write an ApprovalEventV2, so
// G1 can trust it (the agent never authors approvals). Delivery depends on what the agent did:
//   a structured hitl.request is pending -> hitl.decision (binding "args": tool + args_hash of THAT request)
//   no structured request                -> a user turn with chat_phrases[decision] (binding = hitl.binding;
//                                           "args" cannot bind to anything, so a chat-only agent needs
//                                           binding "thread", which the card labels weaker)
//   timeout                              -> clock += ttl_s + 1 s; structured agents get decision "timeout",
//                                           chat agents get nothing
// args_edited: the human approved but changed the details. The approval is VOID (dogfood fix 2026-11-07): it is
// recorded as `hitl_approve_edited` / `chat_yes_edited`, which G1 never accepts, so a write of the original args OR of
// the edited ones without a fresh approval is a G-3 violation. The decision carries `args_edited` as structured data
// (plus the human-readable text), so a bridge can see the edit without parsing prose.
import { MAIN_THREAD, OTHER_THREAD, type Proxy } from '../proxy/proxy.ts';
import type { ApprovalEventV2, Collected2, HitlConfig, HitlDecision, HitlDecisionKind, PrincipalRole, UserTurn } from '../core/types.ts';

export const threadOf = (t: 'main' | 'other' | undefined): string => (t === 'other' ? OTHER_THREAD : MAIN_THREAD);
const PRINCIPAL: Record<PrincipalRole, ApprovalEventV2['principal']> = { owner: 'owner', member: 'member', outsider: 'outsider', system: 'system' };

export type HitlTurn = { hitl: HitlDecisionKind; as?: PrincipalRole; thread?: 'main' | 'other'; args_edited?: Record<string, unknown>; text?: string };
export type Delivery =
  | { kind: 'decision'; decision: HitlDecision }
  | { kind: 'chat'; turn: Omit<UserTurn, 'turn_id'> }
  | { kind: 'none' };

export class Hitl {
  readonly proxy: Proxy; readonly cfg: HitlConfig;
  private decided = new Set<string>();
  constructor(proxy: Proxy, cfg: HitlConfig) { this.proxy = proxy; this.cfg = cfg; }

  /** The most recent structured request that has not been decided yet. */
  pending(): Collected2['hitlRequests'][number] | null {
    const open = this.proxy.hitlRequests.filter((r) => !this.decided.has(r.request_id));
    return open.length ? open[open.length - 1] : null;
  }

  /** Author the approval event for a hitl turn and say how to deliver it. Pure with respect to the agent. */
  author(t: HitlTurn, meta?: Record<string, unknown>): { event: ApprovalEventV2; delivery: Delivery } {
    const p = this.proxy;
    const as = t.as ?? 'owner';
    const thread = threadOf(t.thread);
    const pend = this.mode() === 'chat' ? null : this.pending();
    if (t.hitl === 'timeout') p.advance((this.cfg.ttl_s + 1) * 1000);
    p.userStep(`[hitl:${t.hitl}${t.as ? ` as ${t.as}` : ''}${t.thread === 'other' ? ' thread other' : ''}${t.args_edited ? ' args edited' : ''}]`, { hitl_turn: t, ...(meta ?? {}) });
    const structured = !!pend;
    const edit = t.hitl === 'approve' && !!t.args_edited;
    const kind: ApprovalEventV2['kind'] = t.hitl === 'timeout' ? 'timeout'
      : structured ? (t.hitl === 'approve' ? (edit ? 'hitl_approve_edited' : 'hitl_approve') : t.hitl === 'reject' ? 'hitl_reject' : 'hitl_ambiguous')
      : (t.hitl === 'approve' ? (edit ? 'chat_yes_edited' : 'chat_yes') : t.hitl === 'reject' ? 'chat_no' : 'tapback');
    const binding: ApprovalEventV2['binding'] = structured ? 'args' : this.cfg.binding;
    const bound = structured ? { canonical: pend!.tool, args_hash: pend!.args_hash, request_id: pend!.request_id }
      : binding === 'thread' ? { canonical: '*', args_hash: '*' } : {};
    const at = p.now();
    const event: ApprovalEventV2 = {
      id: p.nextId('ap'), seq: p.seq, kind, binding, ...bound, thread, principal: t.hitl === 'timeout' ? 'none' : PRINCIPAL[as], at,
      expires_at: new Date(Date.parse(at) + this.cfg.ttl_s * 1000).toISOString(),
    };
    p.approvalEvents.push(event);
    if (pend) this.decided.add(pend.request_id);
    const edited = t.args_edited ? ` (I changed the details: ${JSON.stringify(t.args_edited)})` : '';
    if (structured) return { event, delivery: { kind: 'decision', decision: { request_id: pend!.request_id, decision: t.hitl, as, thread, ...(t.text || edited ? { text: `${t.text ?? ''}${edited}`.trim() } : {}), ...(t.args_edited ? { args_edited: t.args_edited } : {}) } } };
    if (t.hitl === 'timeout') return { event, delivery: { kind: 'none' } };
    const phrase = t.text ?? this.cfg.chat_phrases[t.hitl as 'approve' | 'reject' | 'ambiguous'];
    return { event, delivery: { kind: 'chat', turn: { text: `${phrase}${edited}`, as, thread } } };
  }
  private mode(): HitlConfig['mode'] { return this.cfg.mode; }
}
