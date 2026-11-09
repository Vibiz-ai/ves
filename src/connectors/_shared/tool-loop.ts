// The tool loop shared by `openai-chat` (the endpoint under test returns tool_calls, the harness executes them) and
// the MCP connector's `host-sim` mode (a harness model plays the MCP host). DESIGN-agnostic §1.5, §1.7.
//   send messages + tools -> assistant message; no tool_calls -> its text is the delivered message (done);
//   each tool_call in order -> handler -> a `role: tool` message; repeat up to max_steps (exceeding it FAILs).
// A handler may PARK the loop (an approval is needed): the loop returns `awaiting_hitl` and keeps the parked call and
// the not-yet-run calls of the same assistant message, so `resume()` can answer them in order (OpenAI requires a
// tool message for every tool_call id before the next request).
import type { ChatMessage, ToolSpec, TurnOutcome } from '../../core/types.ts';

export type OpenAITool = { type: 'function'; function: { name: string; description?: string; parameters: unknown } };
export type ToolCallMsg = NonNullable<ChatMessage['tool_calls']>[number];
export type ChatFn = (messages: ChatMessage[], tools: OpenAITool[]) => Promise<{ message: ChatMessage; usage?: { input_tokens: number; output_tokens: number } }>;
export type HandlerOut = { kind: 'result'; content: string } | { kind: 'park' };
export type LoopState = {
  messages: ChatMessage[]; steps: number;
  parked: { call: ToolCallMsg; rest: ToolCallMsg[] } | null;
};
export type LoopOpts = {
  chat: ChatFn; tools: OpenAITool[]; maxSteps: number;
  /** Execute (or park) one tool call. `name` is already mapped back to the catalog name. */
  onToolCall: (c: { id: string; name: string; args: Record<string, unknown>; argsError?: string }) => Promise<HandlerOut>;
  onText: (text: string) => void;
  onUsage?: (u: { input_tokens: number; output_tokens: number }) => void;
  /** Wire name -> catalog name. */
  unmap: (wire: string) => string;
};

const OPENAI_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Catalog tools in OpenAI `function` form, with names made wire-safe (catalog names may contain . : /). */
export function toOpenAITools(specs: ToolSpec[], extra: OpenAITool[] = []): { tools: OpenAITool[]; map: (n: string) => string; unmap: (w: string) => string } {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const t of extra) fromWire.set(t.function.name, t.function.name);
  const tools: OpenAITool[] = [];
  for (const s of specs) {
    let w = OPENAI_NAME.test(s.name) ? s.name : s.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    for (let i = 2; fromWire.has(w); i++) w = `${w.slice(0, 60)}_${i}`;
    toWire.set(s.name, w); fromWire.set(w, s.name);
    const desc = [s.title, s.description].filter(Boolean).join(': ');
    tools.push({ type: 'function', function: { name: w, ...(desc ? { description: desc } : {}), parameters: s.input_schema && typeof s.input_schema === 'object' ? s.input_schema : { type: 'object', properties: {} } } });
  }
  return { tools: [...tools, ...extra], map: (n) => toWire.get(n) ?? n, unmap: (w) => fromWire.get(w) ?? w };
}

export function parseArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (typeof raw !== 'string' || !raw.trim()) return { args: {} };
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' && !Array.isArray(j) ? { args: j } : { args: {}, error: 'tool arguments are not a JSON object' };
  } catch { return { args: {}, error: 'tool arguments are not valid JSON' }; }
}

export const newLoopState = (system?: string): LoopState => ({ messages: system ? [{ role: 'system', content: system }] : [], steps: 0, parked: null });

async function runCalls(st: LoopState, calls: ToolCallMsg[], o: LoopOpts): Promise<'parked' | 'ok'> {
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const p = parseArgs(c.function?.arguments);
    const out = await o.onToolCall({ id: c.id, name: o.unmap(c.function?.name ?? ''), args: p.args, ...(p.error ? { argsError: p.error } : {}) });
    if (out.kind === 'park') { st.parked = { call: c, rest: calls.slice(i + 1) }; return 'parked'; }
    st.messages.push({ role: 'tool', tool_call_id: c.id, content: out.content });
  }
  return 'ok';
}

/** Run model steps until a reply without tool calls, a park, or max_steps. */
export async function loop(st: LoopState, o: LoopOpts): Promise<TurnOutcome> {
  for (;;) {
    if (st.steps >= o.maxSteps) return { status: 'error', error: { message: `max_steps ${o.maxSteps} exceeded`, origin: 'agent' } };
    st.steps++;
    const r = await o.chat(st.messages, o.tools);
    if (r.usage) o.onUsage?.(r.usage);
    const m = r.message;
    const calls = m.tool_calls ?? [];
    st.messages.push({ role: 'assistant', content: m.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) { if (m.content) o.onText(m.content); return { status: 'done' }; }
    if (m.content) o.onText(m.content);
    if ((await runCalls(st, calls, o)) === 'parked') return { status: 'awaiting_hitl' };
  }
}

/** Answer the parked call with `content`, run the remaining calls of that message, then continue the loop. */
export async function resume(st: LoopState, content: string, o: LoopOpts): Promise<TurnOutcome> {
  const p = st.parked;
  if (!p) return { status: 'done' };
  st.parked = null;
  st.messages.push({ role: 'tool', tool_call_id: p.call.id, content });
  if ((await runCalls(st, p.rest, o)) === 'parked') return { status: 'awaiting_hitl' };
  return loop(st, o);
}

export const resultContent = (r: { ok: boolean; result?: unknown; error?: string }): string =>
  JSON.stringify(r.ok ? (r.result ?? null) : { error: r.error ?? 'tool_error' });

/** A new user turn arrived while a call was parked (no decision came): answer the open call ids so the chat stays valid. */
export function abandonParked(st: LoopState, why = 'no approval decision was given'): void {
  const p = st.parked;
  if (!p) return;
  st.parked = null;
  for (const c of [p.call, ...p.rest]) st.messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: 'not_executed', reason: why }) });
}
