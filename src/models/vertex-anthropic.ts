// Claude on Google Vertex AI (Anthropic partner models), billed to the Google Cloud project like Gemini. Selected by
// `provider: "vertex"` with an `anthropic/claude-*` model id (vertex.ts keeps the Gemini ids). Same ADC token and RPM
// limiter as the Gemini provider; the endpoint is the Anthropic `rawPredict` route:
//   POST https://{location}-aiplatform.googleapis.com/v1/projects/{p}/locations/{loc}/publishers/anthropic/models/{id}:rawPredict
//   (location `global` -> host aiplatform.googleapis.com)
// The body is the Anthropic Messages format with `anthropic_version: "vertex-2023-10-16"` and no `model` field.
// Mapping from the shared ChatRequest (OpenAI-shaped):
//   - system messages -> top-level `system`; user/assistant turns kept in order (consecutive same-role turns merged);
//   - `response_format` json_schema -> one appended system line asking for a JSON object of that schema (the callers
//     already parse leniently; Vertex structured-output support differs per model, so it is not relied on);
//   - `temperature` sent only to models that accept it (Claude 5.x reject non-default sampling: dropped there);
//   - `seed`, `tool_choice`, `tools` are not sent (the harness models never use tools here).
// The response is mapped back to an OpenAI-shaped completion (choices[0].message.content, usage prompt/completion
// tokens with cache reads and writes counted as input), so chat.ts, the cache and the spend ledger stay unchanged.
// An alternative without Google Cloud: `provider: "openai-compatible"`, `base_url: "https://api.anthropic.com/v1/"`,
// `api_key_env: "ANTHROPIC_API_KEY"` (Anthropic's OpenAI-compatible endpoint; billed by Anthropic, not Google).
import { UsageError } from '../core/errors.ts';
import type { ChatMessage, ChatRequest, ModelRef } from '../core/types.ts';
import { postChat } from './http.ts';
import type { Provider, ProviderDeps } from './provider.ts';
import { vertexProject, type VertexShared } from './vertex.ts';

export const ANTHROPIC_VERTEX_VERSION = 'vertex-2023-10-16';
/** VES model ref -> Vertex model id. Current-generation models use the bare id; dated snapshots use `@`. */
export const ANTHROPIC_VERTEX_IDS: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-4-5@20251001',
  'claude-sonnet-4-5': 'claude-sonnet-4-5@20250929',
  'claude-opus-4-5': 'claude-opus-4-5@20251101',
};
const DEFAULT_RPM = 60;

/** `anthropic/claude-sonnet-4-6` (or `claude-sonnet-4-6`, or an explicit `claude-x@date`) -> `{ref, vertexId}`; null if not Claude. */
export function anthropicVertexModel(m: string | undefined): { ref: string; vertexId: string } | null {
  if (!m) return null;
  const bare = m.replace(/^anthropic\//, '');
  if (!/^claude-[a-z0-9.-]+(@\d{8})?$/.test(bare)) return null;
  const base = bare.split('@')[0];
  return { ref: `anthropic/${base}`, vertexId: bare.includes('@') ? bare : ANTHROPIC_VERTEX_IDS[base] ?? bare };
}

export function anthropicVertexUrl(project: string, location: string, vertexId: string): string {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/anthropic/models/${encodeURIComponent(vertexId)}:rawPredict`;
}

/** Claude 5.x reject non-default temperature/top_p; older Claude accepts temperature. */
export const acceptsTemperature = (vertexId: string): boolean => !/^claude-[a-z]+-5(?:-|@|$)/.test(vertexId);

const textOf = (c: ChatMessage['content']): string => (typeof c === 'string' ? c : '');

export function shapeAnthropicBody(vertexId: string, req: ChatRequest, ref: ModelRef): Record<string, unknown> {
  const system: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') { system.push(textOf(m.content)); continue; }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = m.role === 'tool' ? `[tool result] ${textOf(m.content)}` : textOf(m.content);
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else messages.push({ role, content: text });
  }
  if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(start)' });
  const rf = req.response_format;
  if (rf?.type === 'json_schema') system.push(`Answer with one JSON object matching this JSON Schema, and nothing else: ${JSON.stringify(rf.json_schema.schema)}`);
  else if (rf?.type === 'json_object') system.push('Answer with one JSON object and nothing else.');
  const b: Record<string, unknown> = { anthropic_version: ANTHROPIC_VERTEX_VERSION, messages, max_tokens: req.max_tokens ?? 1024 };
  if (system.length) b.system = system.join('\n\n');
  if (req.temperature !== undefined && acceptsTemperature(vertexId)) b.temperature = req.temperature;
  for (const [k, v] of Object.entries(ref.params ?? {})) if (b[k] === undefined && !['model', 'messages', 'seed', 'temperature', 'max_tokens'].includes(k)) b[k] = v;
  return b;
}

/** Anthropic Messages response -> the OpenAI-shaped completion chat.ts parses. */
export function mapAnthropicResponse(j: any, ref: string): Record<string, unknown> {
  const text = Array.isArray(j?.content) ? j.content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('') : '';
  const u = j?.usage ?? {};
  const inTok = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
  const outTok = Number(u.output_tokens) || 0;
  const stop = String(j?.stop_reason ?? 'end_turn');
  const finish = stop === 'end_turn' || stop === 'stop_sequence' ? 'stop' : stop === 'max_tokens' ? 'length' : stop;
  return {
    id: j?.id, object: 'chat.completion', model: ref,
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: text } }],
    ...(j?.usage ? { usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok } } : {}),
  };
}

export function createVertexAnthropicProvider(r: ModelRef, deps: ProviderDeps, shared: VertexShared): Provider {
  const m = anthropicVertexModel(r.model);
  if (!m) throw new UsageError(`vertex provider: "${r.model}" is not a Claude id; use anthropic/claude-* (e.g. anthropic/claude-sonnet-4-6)`);
  const project = vertexProject(r, deps.env);
  const location = r.location || 'global';
  const url = anthropicVertexUrl(project, location, m.vertexId);
  const rpm = r.rpm ?? DEFAULT_RPM;
  return {
    name: 'vertex', model: m.ref, family: 'anthropic', local: false,
    // the vertex id goes in the cache-key input, so a remapped snapshot never reuses another snapshot's answers
    effectiveBody: (req) => ({ ...shapeAnthropicBody(m.vertexId, req, r), __vertex_model: m.vertexId }),
    send: async (body, signal) => {
      const { __vertex_model: _drop, ...wire } = body;
      const raw = await postChat({
        fetch: deps.fetch, url, body: wire, label: `vertex ${m.ref}`, signal, sleep: deps.sleep, log: deps.log, maxAttempts: deps.maxAttempts,
        headers: async () => ({ authorization: `Bearer ${await shared.adc.token()}`, 'x-goog-user-project': project, 'content-type': 'application/json' }),
        onUnauthorized: async () => { await shared.adc.token(true); },
        limiter: () => shared.limiter.take(`vertex:${m.ref}`, rpm),
      });
      return { json: mapAnthropicResponse(raw.json, m.ref) };
    },
  };
}
