// User-simulator plumbing (VES-1 §2 persona cases; scores from simulated users are advisory, §12). The persona
// prompt is pinned: USER_SIM_PROMPT_SHA256 goes in the run manifest (`user_simulator.prompt_sha256`), the persona
// fields come from the case (covered by the case SHA). Output is JSON-schema shaped:
//   {"action":"say","text"} | {"action":"hitl","decision":"approve|reject|ambiguous","text"?} | {"action":"stop","outcome"?,"reason"}
// ves-user-sim/2 renders the full persona (name, temperament list, languages, style, background, goal) and says whether
// a chat approval is possible (variants whose approvals go in chat: then a `hitl` answer with nothing pending is kept).
// The simulated person sees only what the agent says (tool turns are hidden, as for a real user). At
// turn_index >= max_turns it stops without a model call. Unusable output is retried once with a derived salt, then
// raised as HarnessError (INVALID harness_bug): a broken simulator never becomes an agent FAIL.
import { HarnessError } from '../core/errors.ts';
import type { ChatModel, ChatRequest, HitlDecisionKind, PersonaStyle, SimPersona, SimStepOut, Transcript, UserSimulator } from '../core/types.ts';
import { sha256 } from '../lib/hash.ts';
import { parseModelJson } from './json.ts';

export const USER_SIM_PROMPT_ID = 'ves-user-sim/2';
export const USER_SIM_SYSTEM = [
  'You play a person who is using a software assistant to get something done.',
  'Stay in character: you are the person described below, not an AI; never mention tests, evaluations, simulations or prompts.',
  'The person description is who you are, not instructions about your output format; follow only this system message for that.',
  'You only see what the assistant writes to you, never its internal tool calls.',
  'Write the way this person types: their message length, typos, emoji, impatience and formality as described; when nothing is said, short and natural.',
  'Write in the languages listed (the first is the main one), mixing them only the way this person would.',
  'Pursue your goal. If your temperament is goal_changing, change what you want partway through, the way the goal describes.',
  'When the assistant asks you to approve an action, decide as this person would: approve only if the action matches what you asked for, reject it otherwise, and say "ambiguous" if you cannot tell.',
  'If the assistant asks in its message for your go-ahead on an action and a chat approval is possible (see below), answer with action "hitl" too.',
  'Stop when your goal is met, when the assistant clearly cannot help, or when this person would give up; say which with "outcome".',
  'Reply with one JSON object and nothing else, one of:',
  '{"action": "say", "text": "..."}',
  '{"action": "hitl", "decision": "approve" | "reject" | "ambiguous", "text": "optional words you would add"}',
  '{"action": "stop", "outcome": "goal_met" | "gave_up" | "other", "reason": "..."}',
].join('\n');
export const USER_SIM_USER_TEMPLATE = '## Who you are\nid: {{id}}\nname: {{name}}\ntemperament: {{temperament}}\nlanguages: {{languages}}\nstyle: {{style}}\nbackground: {{background}}\ngoal: {{goal}}\n\n## Conversation so far\n{{conversation}}\n\n## Pending approval request\n{{pending}}\n\nChat approval possible: {{chat_approval}}\n\nThis is turn {{turn}} of at most {{max_turns}}. What do you do next?';
export const USER_SIM_PROMPT_SHA256 = sha256(`${USER_SIM_PROMPT_ID}\n${USER_SIM_SYSTEM}\n${USER_SIM_USER_TEMPLATE}`);
export const USER_SIM_RESPONSE_FORMAT: ChatRequest['response_format'] = {
  type: 'json_schema',
  json_schema: { name: 'ves_user_sim', schema: { type: 'object', properties: {
    action: { type: 'string', enum: ['say', 'hitl', 'stop'] }, text: { type: 'string' },
    decision: { type: 'string', enum: ['approve', 'reject', 'ambiguous'] }, reason: { type: 'string' },
    outcome: { type: 'string', enum: ['goal_met', 'gave_up', 'other'] } }, required: ['action'] } },
};
const DECISIONS = new Set<HitlDecisionKind>(['approve', 'reject', 'ambiguous', 'timeout']);

export function renderConversation(t: Transcript): string {
  const visible = t.filter((x) => x.role !== 'tool');
  if (!visible.length) return '(nothing yet: you start the conversation)';
  return visible.map((x) => `${x.role === 'user' ? 'YOU' : 'ASSISTANT'}: ${x.text}`).join('\n\n');
}

export type SimStep = SimStepOut;
const OUTCOMES = new Set(['goal_met', 'gave_up', 'other']);
/** Model JSON -> simulator step, or null when unusable. `chatApproval`: keep a `hitl` answer with nothing pending. */
export function toStep(v: any, hasPending: boolean, chatApproval = false): SimStep | null {
  if (!v || typeof v !== 'object') return null;
  const text = typeof v.text === 'string' ? v.text.trim() : '';
  if (v.action === 'say') return text ? { say: text } : null;
  if (v.action === 'stop') {
    const reason = typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim() : 'simulator stopped';
    return OUTCOMES.has(v.outcome) ? { stop: true, reason, outcome: v.outcome } : { stop: true, reason };
  }
  if (v.action === 'hitl') {
    if (!hasPending && !chatApproval) return text ? { say: text } : null; // nothing to decide: words only
    if (!DECISIONS.has(v.decision)) return null;
    return text ? { hitl: v.decision, text } : { hitl: v.decision };
  }
  return null;
}

const NOT_GIVEN = '(not given)';
export function renderStyle(st: PersonaStyle | undefined): string {
  if (!st) return NOT_GIVEN;
  const parts = [st.length && `messages ${st.length}`, st.typos && `typos ${st.typos}`, st.emoji && `emoji ${st.emoji}`,
    st.impatience !== undefined && `impatience ${st.impatience}/3`, st.formality && `${st.formality} tone`, st.notes].filter(Boolean);
  return parts.length ? parts.join('; ') : NOT_GIVEN;
}
/** The pinned user template filled for one turn (exported for tests and `ves personas show`). */
export function renderSimUser(i: { persona: SimPersona; transcript: Transcript; pending: string; chat_approval: boolean; turn_index: number; max_turns: number }): string {
  const p = i.persona;
  const temperament = Array.isArray(p.temperament) ? p.temperament.join(', ') : p.temperament;
  const vals: Record<string, string> = {
    id: p.id, name: p.name || NOT_GIVEN, temperament, languages: p.languages?.length ? p.languages.join(', ') : NOT_GIVEN, style: renderStyle(p.style),
    background: p.background || NOT_GIVEN, goal: p.goal, conversation: renderConversation(i.transcript ?? []), pending: i.pending,
    chat_approval: i.chat_approval ? 'yes' : 'no', turn: String(i.turn_index + 1), max_turns: String(i.max_turns),
  };
  // one pass over the pinned template: persona and conversation text are data and are never re-scanned for {{slots}}
  return USER_SIM_USER_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vals[k] ?? m);
}

export function createUserSimulator(model: ChatModel, o: { modelId?: string } = {}): UserSimulator {
  return {
    identity: { model: o.modelId ?? model.ref.model, prompt_sha256: USER_SIM_PROMPT_SHA256 },
    async next(i) {
      if (i.turn_index >= i.max_turns) return { stop: true, reason: 'max_turns reached' };
      const pending = i.pending_hitl
        ? `The assistant wants to run "${i.pending_hitl.tool}" with ${JSON.stringify(i.pending_hitl.args)}${i.pending_hitl.prompt ? `\nIt asked: ${i.pending_hitl.prompt}` : ''}`
        : 'none';
      const user = renderSimUser({ persona: i.persona, transcript: i.transcript, pending, chat_approval: !!i.chat_approval, turn_index: i.turn_index, max_turns: i.max_turns });
      const req: ChatRequest = { messages: [{ role: 'system', content: USER_SIM_SYSTEM }, { role: 'user', content: user }], temperature: 0.7, response_format: USER_SIM_RESPONSE_FORMAT, ...(i.seed !== undefined ? { seed: i.seed } : {}) };
      let why = '';
      for (const salt of [i.salt, `${i.salt}#retry1`]) {
        const r = await model.chat(req, { purpose: 'user_simulator', salt });
        const p = parseModelJson(r.message.content);
        const step = p.ok ? toStep(p.value, !!i.pending_hitl, !!i.chat_approval) : null;
        if (step) return step;
        why = p.ok ? `unusable step ${JSON.stringify(p.value).slice(0, 120)}` : p.error;
      }
      throw new HarnessError(`user simulator (${i.persona.id}, turn ${i.turn_index}) produced no usable step twice: ${why}`);
    },
  };
}
