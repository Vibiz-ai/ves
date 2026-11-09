// Google Vertex AI (Gemini) provider, the DEFAULT for every harness-side model (judge, user simulator, host-sim,
// intent writer). Pattern: an earlier research harness (not public), lib/vertex.mjs, with these differences:
//  - project from `ref.project` (config, `${GOOGLE_CLOUD_PROJECT}` interpolated by core) or env GOOGLE_CLOUD_PROJECT;
//    a missing project is a UsageError, never a hardcoded default;
//  - a lost credential throws AuthLostError (INVALID infra_auth) instead of `process.exit(75)`: the harness decides;
//  - only `google/gemini-*` ids (`gemini-*` accepted as `google/gemini-*`); anything else is refused;
//  - fetch, exec, clock and sleep are injected; no hedging (the harness calls are short and few).
// Auth is Application Default Credentials: `gcloud auth application-default print-access-token`, cached 40 minutes,
// refreshed on a 401, 3 tries 5 s apart. In CI that is google-github-actions/auth (WIF) -> ADC. The token is never
// logged, printed, cached on disk or put in an error message.
import { AuthLostError, UsageError } from '../core/errors.ts';
import type { ChatMessage, ChatRequest, ExecLike, ModelRef } from '../core/types.ts';
import { postChat } from './http.ts';
import { baseBody, type Provider, type ProviderDeps, RpmLimiter, type Sleep } from './provider.ts';

export const VERTEX_DEFAULT_MODEL = 'google/gemini-3.8-flash';
export const ADC_CMD = ['gcloud', 'auth', 'application-default', 'print-access-token'] as const;
export const TOKEN_TTL_MS = 40 * 60_000;
export const VERTEX_DROP = ['store', 'service_tier', 'metadata', 'prompt_cache_key', 'user', 'prompt_cache_retention', 'safety_identifier'];
export const THOUGHT_SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator';
const DEFAULT_RPM: Record<string, number> = { 'google/gemini-4-argon': 60, 'google/gemini-3.8-flash': 300 };

/** `google/gemini-*` kept, `gemini-*` -> `google/gemini-*`, anything else null (refused). */
export function vertexModelId(m: string | undefined): string | null {
  if (!m) return null;
  if (/^google\/gemini-[A-Za-z0-9._-]+$/.test(m)) return m;
  if (/^gemini-[A-Za-z0-9._-]+$/.test(m)) return `google/${m}`;
  return null;
}

export function vertexUrl(project: string, location = 'global'): string {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/endpoints/openapi/chat/completions`;
}

export function vertexProject(ref: ModelRef, env: Record<string, string | undefined>): string {
  const fromRef = ref.project && !ref.project.includes('${') ? ref.project.trim() : '';
  const p = fromRef || (env.GOOGLE_CLOUD_PROJECT ?? '').trim();
  if (!p) throw new UsageError(`vertex model ${ref.model}: no Google Cloud project; set models.*.project or GOOGLE_CLOUD_PROJECT`);
  return p;
}

/** Gemini 3+ rejects an assistant tool call replayed without its thought signature. Clients that drop
 * `extra_content` get Google's documented placeholder on the first tool call of each replayed assistant message. */
export function applyThoughtSignatureShim(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc: any, i: number) => {
        if (i > 0 || tc?.extra_content?.google?.thought_signature) return tc;
        return { ...tc, extra_content: { ...(tc.extra_content ?? {}), google: { ...(tc.extra_content?.google ?? {}), thought_signature: THOUGHT_SIGNATURE_PLACEHOLDER } } };
      }),
    };
  });
}

export function shapeVertexBody(model: string, req: ChatRequest, ref: ModelRef): Record<string, unknown> {
  const b = baseBody(model, req, ref);
  for (const k of VERTEX_DROP) delete b[k];
  b.messages = applyThoughtSignatureShim(b.messages as ChatMessage[]);
  return b;
}

/** ADC token source: single-flight, cached TOKEN_TTL_MS, 3 tries 5 s apart, AuthLostError after the third. */
export class AdcToken {
  exec: ExecLike; now: () => Date; sleep: Sleep;
  tok: string | null = null;
  at = 0;
  pending: Promise<string> | null = null;
  constructor(exec: ExecLike, now: () => Date, sleep: Sleep) { this.exec = exec; this.now = now; this.sleep = sleep; }
  async fetchOnce(): Promise<string> {
    let r: { code: number; stdout: string; stderr: string };
    try { r = await this.exec(ADC_CMD[0], ADC_CMD.slice(1)); }
    catch (e) { throw new Error(`gcloud could not run: ${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200)}`); }
    if (r.code !== 0) throw new Error(`gcloud exited ${r.code}: ${String(r.stderr ?? '').split('\n')[0].slice(0, 200)}`);
    const t = String(r.stdout ?? '').trim();
    if (!t || /\s/.test(t)) throw new Error('gcloud printed an empty or malformed token');
    return t;
  }
  async fetchWithRetries(): Promise<string> {
    let last: Error | undefined;
    for (let i = 0; i < 3; i++) {
      try { return await this.fetchOnce(); }
      catch (e) { last = e as Error; if (i < 2) await this.sleep(5000); }
    }
    throw new AuthLostError(`Vertex ADC token unavailable after 3 tries (${last?.message ?? 'unknown'}); run \`gcloud auth application-default login\` or configure workload identity`);
  }
  token(force = false): Promise<string> {
    if (!force && this.tok && this.now().getTime() - this.at < TOKEN_TTL_MS) return Promise.resolve(this.tok);
    if (!this.pending) {
      this.pending = this.fetchWithRetries()
        .then((t) => { this.tok = t; this.at = this.now().getTime(); return t; })
        .finally(() => { this.pending = null; });
    }
    return this.pending;
  }
}

export type VertexShared = { adc: AdcToken; limiter: RpmLimiter };

export function createVertexProvider(ref: ModelRef, deps: ProviderDeps, shared: VertexShared): Provider {
  const model = vertexModelId(ref.model);
  if (!model) throw new UsageError(`vertex provider: model "${ref.model}" is not a Vertex Gemini id; use google/gemini-* (or gemini-*), or anthropic/claude-* for Claude on Vertex`);
  const project = vertexProject(ref, deps.env);
  const url = vertexUrl(project, ref.location || 'global');
  const rpm = ref.rpm ?? DEFAULT_RPM[model] ?? 120;
  return {
    name: 'vertex', model, family: 'google', local: false,
    effectiveBody: (req) => shapeVertexBody(model, req, ref),
    send: (body, signal) => postChat({
      fetch: deps.fetch, url, body, label: `vertex ${model}`, signal, sleep: deps.sleep, log: deps.log, maxAttempts: deps.maxAttempts,
      headers: async () => ({ authorization: `Bearer ${await shared.adc.token()}`, 'x-goog-user-project': project, 'content-type': 'application/json' }),
      onUnauthorized: async () => { await shared.adc.token(true); },
      limiter: () => shared.limiter.take(`vertex:${model}`, rpm),
    }),
  };
}
