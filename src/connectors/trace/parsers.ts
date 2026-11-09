// Trace import (DESIGN-agnostic §1.8): normalise recorded agent traces into one event list.
//   otel-genai     OTLP/JSON resourceSpans (GenAI semantic conventions): execute_tool spans (gen_ai.tool.name,
//                  gen_ai.tool.call.id, gen_ai.tool.call.arguments, gen_ai.tool.call.result), chat / invoke_agent
//                  output messages (gen_ai.output.messages), usage (gen_ai.usage.*). Also the Vercel AI SDK legacy
//                  spans: ai.toolCall (ai.toolCall.name/.args/.result), ai.generateText (ai.response.text), ai.usage.*.
//   atif           ATIF v1.8 steps[].tool_calls + observation.results, agent step messages, step/final metrics.
//   openai-agents  JSONL written by examples/openai-agents-python/ves_trace_processor.py: one exported span per line
//                  (span_data.type function | generation | agent | response), plus optional {"object":"ves.message"}.
// Everything parsed here is `traced` evidence: it can FAIL a safety grader, never PASS one. A trace written by the VES
// proxy itself carries `ves.proxy.signature` (HMAC-SHA256 over the canonical trace without that field, key
// VES_TRACE_KEY); `verifySignature` checks it.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TraceFormat = 'otel-genai' | 'atif' | 'openai-agents';
export type TraceEvent =
  | { kind: 'tool'; name: string; args: Record<string, unknown>; ok: boolean; result?: unknown; call_id?: string; at?: number }
  | { kind: 'message'; text: string; at?: number }
  | { kind: 'hitl'; tool: string; args: Record<string, unknown>; request_id: string; prompt?: string; at?: number }
  | { kind: 'usage'; input_tokens: number; output_tokens: number; model?: string; at?: number };
export type ParsedTrace = { format: TraceFormat; events: TraceEvent[]; agent?: { name?: string; model?: string }; warnings: string[] };

const asObj = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') { try { const j = JSON.parse(v); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch { /* not JSON */ } }
  return {};
};
const maybeJson = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

// ------------------------------------------------------------------------------------------------ OTLP / GenAI
type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: OtlpValue[] }; kvlistValue?: { values?: { key: string; value: OtlpValue }[] } };
const otlpVal = (v: OtlpValue | undefined): unknown => {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(otlpVal);
  if (v.kvlistValue) return Object.fromEntries((v.kvlistValue.values ?? []).map((x) => [x.key, otlpVal(x.value)]));
  return undefined;
};
const attrs = (list: unknown): Record<string, unknown> => {
  if (Array.isArray(list)) return Object.fromEntries(list.map((a: { key: string; value: OtlpValue }) => [a.key, otlpVal(a.value)]));
  return list && typeof list === 'object' ? (list as Record<string, unknown>) : {};
};
type Span = { name: string; start: number; a: Record<string, unknown>; error: boolean };

function otlpSpans(doc: unknown): Span[] {
  const docs = Array.isArray(doc) ? doc : [doc];
  const out: Span[] = [];
  for (const d of docs) for (const rs of (d as { resourceSpans?: unknown[] })?.resourceSpans ?? []) {
    for (const ss of (rs as { scopeSpans?: unknown[]; instrumentationLibrarySpans?: unknown[] }).scopeSpans ?? (rs as { instrumentationLibrarySpans?: unknown[] }).instrumentationLibrarySpans ?? []) {
      for (const sp of (ss as { spans?: any[] }).spans ?? []) {
        out.push({ name: String(sp.name ?? ''), start: Number(sp.startTimeUnixNano ?? 0) / 1e6, a: attrs(sp.attributes), error: sp.status?.code === 2 || sp.status?.code === 'STATUS_CODE_ERROR' });
      }
    }
  }
  return out.sort((x, y) => x.start - y.start);
}
const textOfMessages = (v: unknown): string[] => {
  const msgs = maybeJson(v);
  const out: string[] = [];
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (m?.role && m.role !== 'assistant') continue;
    if (typeof m?.content === 'string') { out.push(m.content); continue; }
    const parts = Array.isArray(m?.parts) ? m.parts : Array.isArray(m?.content) ? m.content : [];
    const t = parts.filter((p: any) => p?.type === 'text' || p?.type === 'output_text').map((p: any) => p.content ?? p.text ?? '').join('');
    if (t) out.push(t);
  }
  return out;
};

export function parseOtel(doc: unknown): ParsedTrace {
  const spans = otlpSpans(doc);
  const ev: TraceEvent[] = [];
  const warnings: string[] = [];
  let finalText: { text: string; at: number } | null = null;
  let agentText: { text: string; at: number } | null = null;
  let agent: ParsedTrace['agent'];
  let usageFromChat = false;
  const usage: TraceEvent[] = [];
  for (const s of spans) {
    const op = s.a['gen_ai.operation.name'];
    if (op === 'execute_tool' || s.name === 'ai.toolCall') {
      const legacy = s.name === 'ai.toolCall' && op !== 'execute_tool';
      const name = String((legacy ? s.a['ai.toolCall.name'] : s.a['gen_ai.tool.name']) ?? s.a['ai.toolCall.name'] ?? '');
      if (!name) { warnings.push(`tool span without a tool name at ${s.start}`); continue; }
      const args = asObj(legacy ? s.a['ai.toolCall.args'] : s.a['gen_ai.tool.call.arguments']);
      const result = maybeJson(legacy ? s.a['ai.toolCall.result'] : s.a['gen_ai.tool.call.result']);
      const id = legacy ? s.a['ai.toolCall.id'] : s.a['gen_ai.tool.call.id'];
      ev.push({ kind: 'tool', name, args, ok: !s.error, ...(result !== undefined ? { result } : {}), ...(id !== undefined ? { call_id: String(id) } : {}), at: s.start });
      continue;
    }
    if (op === 'invoke_agent') {
      agent = { ...(s.a['gen_ai.agent.name'] ? { name: String(s.a['gen_ai.agent.name']) } : {}), ...(s.a['gen_ai.request.model'] ? { model: String(s.a['gen_ai.request.model']) } : {}) };
      const t = textOfMessages(s.a['gen_ai.output.messages']);
      if (t.length) agentText = { text: t.join('\n'), at: s.start };
    }
    if (op === 'chat' || op === 'text_completion' || op === 'generate_content' || op === 'invoke_agent') {
      if (op !== 'invoke_agent') { const t = textOfMessages(s.a['gen_ai.output.messages']); if (t.length) finalText = { text: t.join('\n'), at: s.start }; }
      const i = s.a['gen_ai.usage.input_tokens'], o = s.a['gen_ai.usage.output_tokens'];
      if (i !== undefined || o !== undefined) {
        if (op !== 'invoke_agent') usageFromChat = true;
        usage.push({ kind: 'usage', input_tokens: Number(i ?? 0), output_tokens: Number(o ?? 0), ...(s.a['gen_ai.response.model'] ?? s.a['gen_ai.request.model'] ? { model: String(s.a['gen_ai.response.model'] ?? s.a['gen_ai.request.model']) } : {}), at: s.start, ...(op === 'invoke_agent' ? { agentLevel: true } : {}) } as TraceEvent);
      }
    }
    if (s.name === 'ai.generateText' || s.name === 'ai.streamText') {
      if (typeof s.a['ai.response.text'] === 'string' && s.a['ai.response.text']) finalText = { text: String(s.a['ai.response.text']), at: s.start };
      const i = s.a['ai.usage.inputTokens'] ?? s.a['ai.usage.promptTokens'], o = s.a['ai.usage.outputTokens'] ?? s.a['ai.usage.completionTokens'];
      if (i !== undefined || o !== undefined) { usageFromChat = true; usage.push({ kind: 'usage', input_tokens: Number(i ?? 0), output_tokens: Number(o ?? 0), ...(s.a['ai.model.id'] ? { model: String(s.a['ai.model.id']) } : {}), at: s.start }); }
    }
  }
  // usage: per-call spans if any, else the agent-level totals (never both: no double counting)
  for (const u of usage) if (!usageFromChat || !(u as { agentLevel?: boolean }).agentLevel) { delete (u as { agentLevel?: boolean }).agentLevel; ev.push(u); }
  const msg = agentText ?? finalText;
  if (msg) ev.push({ kind: 'message', text: msg.text, at: Number.MAX_SAFE_INTEGER }); // the final answer is delivered last
  if (!spans.length) warnings.push('no spans found (expected OTLP/JSON resourceSpans)');
  return { format: 'otel-genai', events: ev.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), ...(agent ? { agent } : {}), warnings };
}

// ------------------------------------------------------------------------------------------------------ ATIF
export function parseAtif(doc: unknown): ParsedTrace {
  const d = doc as { steps?: any[]; agent?: { name?: string; model_name?: string }; final_metrics?: Record<string, unknown> };
  const ev: TraceEvent[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(d?.steps)) return { format: 'atif', events: [], warnings: ['no steps[] (expected ATIF v1.x)'] };
  let stepUsage = false;
  for (const st of d.steps) {
    if (st?.source === 'user') continue;
    const results = new Map<string, unknown>((st?.observation?.results ?? []).map((r: any) => [String(r.source_call_id), r.content]));
    for (const tc of st?.tool_calls ?? []) {
      const name = String(tc.function_name ?? tc.name ?? '');
      if (!name) continue;
      const res = results.get(String(tc.tool_call_id));
      const ok = !(res && typeof res === 'object' && ((res as any).ok === false || (res as any).error));
      ev.push({ kind: 'tool', name, args: asObj(tc.arguments), ok, ...(res !== undefined ? { result: res } : {}), ...(tc.tool_call_id ? { call_id: String(tc.tool_call_id) } : {}) });
    }
    const hr = st?.vibiz?.hitl_request ?? st?.extra?.hitl_request;
    if (hr?.tool) ev.push({ kind: 'hitl', tool: String(hr.tool), args: asObj(hr.args), request_id: String(hr.request_id ?? `atif-${st.step_id}`), ...(hr.prompt ? { prompt: String(hr.prompt) } : {}) });
    else if (typeof st?.message === 'string' && st.message && !(st.tool_calls?.length)) ev.push({ kind: 'message', text: st.message });
    const m = st?.metrics;
    if (m && (m.prompt_tokens !== undefined || m.completion_tokens !== undefined)) { stepUsage = true; ev.push({ kind: 'usage', input_tokens: Number(m.prompt_tokens ?? 0), output_tokens: Number(m.completion_tokens ?? 0), ...(st.model_name ? { model: String(st.model_name) } : {}) }); }
  }
  const fm = d.final_metrics;
  if (!stepUsage && fm && (fm.total_prompt_tokens !== undefined || fm.total_completion_tokens !== undefined)) ev.push({ kind: 'usage', input_tokens: Number(fm.total_prompt_tokens ?? 0), output_tokens: Number(fm.total_completion_tokens ?? 0) });
  return { format: 'atif', events: ev, ...(d.agent ? { agent: { ...(d.agent.name ? { name: d.agent.name } : {}), ...(d.agent.model_name ? { model: d.agent.model_name } : {}) } } : {}), warnings };
}

// --------------------------------------------------------------------------------- OpenAI Agents SDK (JSONL)
export function parseOpenAIAgents(text: string): ParsedTrace {
  const ev: TraceEvent[] = [];
  const warnings: string[] = [];
  let agent: ParsedTrace['agent'];
  let lastGen: { text: string; at: number } | null = null;
  let explicit = false;
  const rows = text.split('\n').map((l, i) => { if (!l.trim()) return null; try { return JSON.parse(l); } catch { warnings.push(`line ${i + 1}: not JSON`); return null; } }).filter(Boolean) as any[];
  const at = (r: any) => (r.started_at ? Date.parse(r.started_at) : 0);
  rows.sort((a, b) => at(a) - at(b));
  for (const r of rows) {
    if (r.object === 'ves.message' && typeof r.text === 'string') { ev.push({ kind: 'message', text: r.text, at: at(r) || Number.MAX_SAFE_INTEGER }); explicit = true; continue; }
    const sd = r.span_data ?? {};
    if (sd.type === 'function') {
      const out = maybeJson(sd.output);
      ev.push({ kind: 'tool', name: String(sd.name ?? ''), args: asObj(sd.input), ok: !r.error, ...(out !== undefined && out !== null ? { result: out } : {}), ...(r.span_id ?? r.id ? { call_id: String(r.span_id ?? r.id) } : {}), at: at(r) });
    } else if (sd.type === 'generation' || sd.type === 'response') {
      const u = sd.usage ?? sd.response?.usage;
      if (u) ev.push({ kind: 'usage', input_tokens: Number(u.input_tokens ?? u.prompt_tokens ?? 0), output_tokens: Number(u.output_tokens ?? u.completion_tokens ?? 0), ...(sd.model ? { model: String(sd.model) } : {}), at: at(r) });
      const t = textOfMessages(sd.output);
      if (t.length) lastGen = { text: t.join('\n'), at: at(r) };
    } else if (sd.type === 'agent') {
      agent = { name: String(sd.name ?? 'agent') };
    }
  }
  if (!explicit && lastGen) ev.push({ kind: 'message', text: lastGen.text, at: lastGen.at });
  return { format: 'openai-agents', events: ev.filter((e) => e.kind !== 'tool' || e.name).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), ...(agent ? { agent } : {}), warnings };
}

export function parseTrace(format: string, text: string): ParsedTrace {
  if (format === 'openai-agents') return parseOpenAIAgents(text);
  let doc: unknown;
  try { doc = JSON.parse(text); } catch {
    // JSONL of OTLP exports (one export per line)
    doc = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  if (format === 'otel-genai') return parseOtel(doc);
  if (format === 'atif') return parseAtif(doc);
  throw new Error(`unknown trace format ${format} (otel-genai | atif | openai-agents)`);
}

// ------------------------------------------------------------------------------------------ proxy signature
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const strip = (doc: unknown): { body: unknown; sig: string | null } => {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { body: doc, sig: null };
  const { ['ves.proxy.signature']: sig, ...rest } = doc as Record<string, unknown>;
  return { body: rest, sig: typeof sig === 'string' ? sig : null };
};
export const signTrace = (doc: Record<string, unknown>, key: string): Record<string, unknown> =>
  ({ ...doc, 'ves.proxy.signature': createHmac('sha256', key).update(canonical(strip(doc).body)).digest('hex') });
/** True only when the trace carries a valid VES proxy signature for `key`. */
export function verifySignature(doc: unknown, key: string | undefined): boolean {
  if (!key) return false;
  const { body, sig } = strip(doc);
  if (!sig || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const want = createHmac('sha256', key).update(canonical(body)).digest();
  return timingSafeEqual(want, Buffer.from(sig, 'hex'));
}
