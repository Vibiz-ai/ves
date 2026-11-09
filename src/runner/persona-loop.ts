// Persona conversation loop (VES-1 §2 persona input; scores from simulated users are advisory, §12). For a case with
// `input.persona`, after any scripted `input.turns`, a user simulator plays the person against the agent:
//   1. the persona's fixed `opening` goes first (only when the case has no scripted `say` turn);
//   2. each step the simulator sees ONLY the agent's visible text (and a pending structured approval request, if any)
//      and answers say | hitl | stop; `say` is sent like a scripted say turn, `hitl` is executed like a scripted
//      `{hitl}` turn (the HARNESS authors the approval event, so G1 trusts it; on a chat-approval variant with no
//      structured request it is delivered as chat text, exactly like a scripted hitl turn);
//   3. it ends on `stop` (goal met / gave up / other, as the simulator says) or at max_user_turns.
// Every simulated message is a user step tagged `vibiz.persona = {id, turn, source}` in the trajectory. Salt and seed
// are per trial (and per turn), so k trials are k different conversations and a re-run of the same trial salt hits
// the model cache. Any simulator failure is a HarnessError (INVALID harness_bug) or keeps its provider HTTP status
// (INVALID infra_*): it never becomes an agent FAIL. Agent errors from the turns themselves are unchanged.
// The MockAgent (validate, baselines, --connection mock) is always paired with scriptedUserSimulator: offline, $0.
import { HarnessError } from '../core/errors.ts';
import { languageMatch } from '../graders/language.ts';
import type { ConnectorAdapter, Trial } from '../core/connector-adapter.ts';
import type { AtifStep } from '../types.ts';
import type { PersonaRecord, PersonaStopKind, ResolvedPersona, SimPersona, SimStepOut, Transcript, UserSimulator } from '../core/types.ts';

export const SCRIPTED_SIM_MODEL = 'ves-scripted-sim';

/** Offline simulator for the MockAgent: says the opening (or the goal) once, approves what is asked, then stops. */
export function scriptedUserSimulator(): UserSimulator {
  return {
    identity: { model: SCRIPTED_SIM_MODEL, prompt_sha256: 'none' },
    async next(i) {
      if (i.turn_index >= i.max_turns) return { stop: true, reason: 'max_turns reached' };
      if (i.pending_hitl) return { hitl: 'approve' };
      if (!i.transcript.some((x) => x.role === 'user')) return { say: i.persona.goal };
      return { stop: true, reason: 'scripted simulator: one message, then done', outcome: 'goal_met' };
    },
  };
}

type PersonaTag = { id: string; turn: number; source: 'simulator' | 'opening' };
const tagOf = (s: AtifStep): PersonaTag | null => ((s.vibiz as { persona?: PersonaTag } | undefined)?.persona ?? null);

/** What the simulated person has seen: user messages and agent text, never tool calls or approval-request records. */
export function visibleTranscript(steps: AtifStep[]): Transcript {
  const out: Transcript = [];
  for (const s of steps) {
    const v = (s.vibiz ?? {}) as Record<string, unknown>;
    if (s.source === 'user') {
      const h = v.hitl_turn as { hitl?: string; text?: string } | undefined;
      if (h) out.push({ role: 'user', text: h.text ? h.text : `(you answered the approval request: ${h.hitl})` });
      else if (typeof s.message === 'string' && !v.wake) out.push({ role: 'user', text: s.message });
    } else if (s.source === 'agent' && typeof s.message === 'string' && !s.tool_calls?.length && !v.hitl_request) out.push({ role: 'agent', text: s.message });
  }
  return out;
}

/** Agent visible chars after each persona message, up to the next user step. */
export function replyCharsPerTurn(steps: AtifStep[]): { chars: number[]; replies: string[] } {
  const chars: number[] = [], replies: string[] = [];
  let cur = -1;
  for (const s of steps) {
    if (s.source === 'user') { if (tagOf(s)) { chars.push(0); replies.push(''); cur = chars.length - 1; } else cur = -1; continue; }
    if (cur >= 0 && s.source === 'agent' && typeof s.message === 'string' && !s.tool_calls?.length && !(s.vibiz as Record<string, unknown> | undefined)?.hitl_request) {
      chars[cur] += [...s.message].length;
      replies[cur] = replies[cur] ? `${replies[cur]}\n${s.message}` : s.message;
    }
  }
  return { chars, replies };
}

/** A simulator error is the harness's, never the agent's: keep an infra status, otherwise wrap as HarnessError. */
async function simStep(sim: UserSimulator, i: Parameters<UserSimulator['next']>[0]): Promise<SimStepOut> {
  try { return await sim.next(i); }
  catch (e) {
    const err = e as Error & { harness?: boolean; http_status?: number; origin?: string };
    if (err?.harness) throw err;
    if (err?.http_status) throw Object.assign(err, { origin: err.origin === 'host' ? 'host' : 'provider' });
    throw new HarnessError(`user simulator failed (${i.persona.id}, turn ${i.turn_index}): ${String(err?.message ?? e).slice(0, 300)}`);
  }
}

export const simPersonaOf = (p: ResolvedPersona): SimPersona => ({
  id: p.id, temperament: p.temperament, goal: p.goal, ...(p.name ? { name: p.name } : {}), ...(p.background ? { background: p.background } : {}),
  ...(p.languages ? { languages: p.languages } : {}), ...(p.style ? { style: p.style } : {}),
});

/** Drive one persona conversation on an open trial; returns the record (judge outcome added later by the runner). */
export async function runPersona(a: ConnectorAdapter, t: Trial, p: ResolvedPersona, o: { sim: UserSimulator; salt: string; seed: number; scriptedSay: boolean }): Promise<PersonaRecord> {
  const max = p.max_user_turns;
  const sp = simPersonaOf(p);
  let turn = 0;
  let stop: PersonaRecord['stop'] | null = null;
  let goalAt: number | null = null;
  if (p.opening && !o.scriptedSay) { turn = 1; await a.turn(t, { say: p.opening }, { persona: { id: p.id, turn, source: 'opening' } satisfies PersonaTag }); }
  while (!stop) {
    if (turn >= max) { stop = { kind: 'max_turns', reason: `max_user_turns ${max} reached`, at_turn: turn }; break; }
    const mode = t.hitl.cfg.mode;
    const pend = mode === 'chat' ? null : t.hitl.pending();
    const step = await simStep(o.sim, {
      persona: sp, transcript: visibleTranscript(t.proxy.steps), ...(pend ? { pending_hitl: { tool: pend.tool, args: pend.args, ...(pend.prompt ? { prompt: pend.prompt } : {}) } } : {}),
      chat_approval: !pend && mode !== 'structured', turn_index: turn, max_turns: max, salt: `${o.salt}|persona:${p.id}|u${turn}`, seed: (o.seed + turn) >>> 0,
    });
    if ('stop' in step) {
      const kind: PersonaStopKind = step.reason === 'max_turns reached' ? 'max_turns' : step.outcome ?? 'other';
      stop = { kind, reason: step.reason.slice(0, 500), at_turn: turn };
      if (kind === 'goal_met') goalAt = turn;
      break;
    }
    turn += 1;
    const tag = { persona: { id: p.id, turn, source: 'simulator' } satisfies PersonaTag };
    if ('say' in step) await a.turn(t, { say: step.say }, tag);
    else await a.turn(t, { hitl: step.hitl, ...(step.text ? { text: step.text } : {}) }, tag);
  }
  const { chars, replies } = replyCharsPerTurn(t.proxy.steps);
  const lang = languageMatch(replies, p.languages);
  return {
    id: p.id, ...(p.ref ? { ref: p.ref } : {}), ...(p.name ? { name: p.name } : {}), temperament: p.temperament, goal: p.goal,
    ...(p.background ? { background: p.background } : {}), ...(p.languages ? { languages: p.languages } : {}), max_user_turns: max,
    user_turns: turn, stop, simulator: { model: o.sim.identity.model, prompt_sha256: o.sim.identity.prompt_sha256 },
    metrics: {
      user_turns: turn, turns_to_goal: goalAt, reply_chars_per_turn: chars,
      mean_reply_chars: chars.length ? Math.round((chars.reduce((x, y) => x + y, 0) / chars.length) * 10) / 10 : null,
      language_match: lang.match, ...(p.languages ? { reply_languages: lang.detected } : {}),
    },
  };
}
