// Provider contract for the models package (DESIGN-agnostic §7.5). A Provider turns a ChatRequest into the exact
// upstream body (the "effective body", which is also the cache-key input) and sends it. Everything above a provider
// (cache, spend ledger, purpose accounting, judge/simulator prompts) is shared and lives in chat.ts / index.ts.
import type { ChatRequest, ExecLike, FetchLike, ModelRef, ModelsDeps } from '../core/types.ts';

/** A provider failure with an HTTP status the §5.7 classifier understands (402/429 -> infra_rate_limit, 5xx -> infra_upstream_5xx,
 * 403 -> infra_auth). 599 = network error after retries. Report origin 'provider'. */
export class ModelHttpError extends Error {
  http_status: number;
  origin = 'provider' as const;
  name = 'ModelHttpError';
  constructor(message: string, status: number) { super(message); this.http_status = status; }
}

export type ProviderName = 'vertex' | 'openai-compatible' | 'fake';
export type RawCompletion = { json: any };
export interface Provider {
  readonly name: ProviderName;
  /** Normalised model id as sent upstream (e.g. `google/gemini-3.8-flash`). */
  readonly model: string;
  readonly family: string;
  /** A model served on this machine (localhost base_url, fake): its default price is 0, not the unknown-model fallback. */
  readonly local: boolean;
  effectiveBody(req: ChatRequest): Record<string, unknown>;
  send(body: Record<string, unknown>, signal?: AbortSignal): Promise<RawCompletion>;
}

export type Sleep = (ms: number) => Promise<void>;
export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
/** Optional extras createModels accepts beyond core's ModelsDeps (all optional; core may pass none of them). */
export type ModelsDepsExt = ModelsDeps & {
  /** Injected for tests (retry back-off, ADC retries, RPM bucket). Default: real setTimeout. */
  sleep?: Sleep;
  log?: LogFn;
  /** The agent under test, for the judge family rule (§4.2) and name redaction. */
  agent?: { model?: string; name?: string; host_families?: string[] };
  /** Judge registry: a path or the parsed object. Default `<harness>/judges/registry.json`. */
  judgeRegistry?: string | JudgeRegistry;
  /** Max HTTP attempts per call (default 6). */
  maxAttempts?: number;
};
export type JudgeRegistryEntry = { dimension: string; model: string; prompt_sha256: string; rubric_sha256?: string; suspended?: boolean; [k: string]: unknown };
export type JudgeRegistry = { schema_version?: string; admitted: JudgeRegistryEntry[]; [k: string]: unknown };

export type ProviderDeps = { fetch: FetchLike; exec: ExecLike; env: Record<string, string | undefined>; now: () => Date; sleep: Sleep; log: LogFn; maxAttempts: number };

export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Model family from its id, for the §4.2 rule "the judge's family differs from every agent under test". */
export function familyOf(model: string | undefined | null): string {
  const m = String(model ?? '').toLowerCase();
  if (!m) return 'unknown';
  if (/(^|\/)(gemini|gemma)|^google\//.test(m)) return 'google';
  if (/claude|anthropic/.test(m)) return 'anthropic';
  if (/(^|\/)(gpt|o[1-9]|chatgpt|davinci)|^openai\//.test(m)) return 'openai';
  if (/llama|^meta/.test(m)) return 'meta';
  if (/qwen|qwq/.test(m)) return 'alibaba';
  if (/mistral|mixtral|codestral|magistral|devstral/.test(m)) return 'mistral';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/grok|^xai/.test(m)) return 'xai';
  if (/command|cohere/.test(m)) return 'cohere';
  if (/^fake/.test(m)) return 'fake';
  return 'unknown';
}

export function isLocalUrl(u: string | undefined): boolean {
  if (!u) return false;
  try { const h = new URL(u).hostname.replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost'); }
  catch { return false; }
}

/** The request fields shared by every OpenAI-shaped provider, undefined dropped, then `ref.params` as defaults for unset fields. */
export function baseBody(model: string, req: ChatRequest, ref: ModelRef): Record<string, unknown> {
  const b: Record<string, unknown> = { model, messages: req.messages };
  const opt: (keyof ChatRequest)[] = ['tools', 'tool_choice', 'temperature', 'max_tokens', 'seed', 'response_format'];
  for (const k of opt) if (req[k] !== undefined) b[k] = req[k];
  for (const [k, v] of Object.entries(ref.params ?? {})) if (b[k] === undefined && k !== 'model' && k !== 'messages') b[k] = v;
  return b;
}

/** Per-model requests-per-minute bucket (the lab's rateLimit, on an injected clock and sleep). */
export class RpmLimiter {
  next = new Map<string, number>();
  now: () => Date;
  sleep: Sleep;
  constructor(now: () => Date, sleep: Sleep) { this.now = now; this.sleep = sleep; }
  async take(key: string, rpm: number): Promise<void> {
    if (!(rpm > 0) || !Number.isFinite(rpm)) return;
    const gap = 60_000 / rpm;
    const t = this.now().getTime();
    const at = Math.max(t, this.next.get(key) ?? 0);
    this.next.set(key, at + gap);
    if (at > t) await this.sleep(at - t);
  }
}
