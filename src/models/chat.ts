// The ChatModel every purpose uses: provider-shaped effective body -> cache lookup -> worst-case reservation ->
// upstream call -> actual cost -> cache write. One code path for Vertex, OpenAI-compatible and fake providers.
import { AuthLostError, HarnessError, SpendStopError, UsageError } from '../core/errors.ts';
import type { ChatMessage, ChatModel, ChatRequest, ChatResponse, ModelPurpose, ModelRef } from '../core/types.ts';
import { cacheKey, type ModelCache } from './cache.ts';
import type { SpendLedger } from './ledger.ts';
import { estimateInputTokens, lookupPrice, usdOf, type PriceOverride } from './prices.ts';
import { ModelHttpError, type LogFn, type Provider } from './provider.ts';

/** Output caps sent when the caller sets none, so the reserved worst case is a real bound (thinking tokens included). */
export const DEFAULT_MAX_TOKENS: Record<ModelPurpose, number> = { judge: 4096, user_simulator: 4096, intent_writer: 4096, host_sim: 8192 };

export type ChatCtx = { cache: ModelCache; ledger: SpendLedger; prices?: PriceOverride; log: LogFn; warn: (msg: string) => void };

/** A call that failed mid-flight may still be billed: charge its worst case. A refused request (4xx, auth) costs 0. */
export function chargesWorstCase(e: unknown): boolean {
  if (e instanceof AuthLostError || e instanceof HarnessError || e instanceof UsageError || e instanceof SpendStopError) return false;
  if (e instanceof ModelHttpError) return e.http_status >= 500;
  return true; // abort, timeout, unknown
}

function textOf(c: unknown): string | null {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return null;
}

export function parseCompletion(json: any): { message: ChatMessage; finish_reason: string; model?: string; usage: { input_tokens: number; output_tokens: number } | null } {
  const ch = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const m = ch?.message ?? {};
  const message: ChatMessage = { role: 'assistant', content: textOf(m.content) };
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    message.tool_calls = m.tool_calls.map((tc: any, i: number) => ({
      ...tc, // keeps provider extras such as Gemini's extra_content.google.thought_signature for faithful replay
      id: typeof tc?.id === 'string' && tc.id ? tc.id : `call_${i}`,
      type: 'function' as const,
      function: { name: String(tc?.function?.name ?? ''), arguments: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? {}) },
    }));
  }
  const u = json?.usage;
  let usage: { input_tokens: number; output_tokens: number } | null = null;
  if (u && typeof u === 'object') {
    const inT = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
    const outC = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
    const total = Number(u.total_tokens ?? 0) || 0;
    usage = { input_tokens: inT, output_tokens: Math.max(outC, total - inT) }; // Gemini: total - prompt includes thinking
  }
  return { message, finish_reason: String(ch?.finish_reason ?? (ch ? 'stop' : 'no_choices')), model: typeof json?.model === 'string' ? json.model : undefined, usage };
}

export function createChatModel(provider: Provider, ref: ModelRef, ctx: ChatCtx): ChatModel {
  const { row: price, fallback } = lookupPrice(provider.model, { local: provider.local, overrides: ctx.prices });
  let warned = false;
  return {
    ref, family: provider.family,
    async chat(req: ChatRequest, o: { purpose: ModelPurpose; salt: string; signal?: AbortSignal }): Promise<ChatResponse> {
      if (typeof o?.salt !== 'string') throw new HarnessError('ChatModel.chat: a salt string is required (cache key, test-retest)');
      const maxTok = req.max_tokens ?? (typeof ref.params?.max_tokens === 'number' ? (ref.params.max_tokens as number) : DEFAULT_MAX_TOKENS[o.purpose] ?? 4096);
      const body = provider.effectiveBody({ ...req, max_tokens: maxTok });
      const key = cacheKey(provider.name, provider.model, body, o.salt);
      const base = { purpose: o.purpose, provider: provider.name, model: provider.model, price_verified: price.verified, request_sha256: key };
      const hit = ctx.cache.get(key);
      if (hit) {
        ctx.ledger.cached({ ...base, status: 'ok', input_tokens: hit.response.usage.input_tokens, output_tokens: hit.response.usage.output_tokens, usage_estimated: false });
        return { ...hit.response, usd_list: 0, cached: true, request_sha256: key };
      }
      if (fallback && !warned) { warned = true; ctx.warn(`no list price for ${provider.model}; reserving at the fallback $${price.in}/$${price.out} per 1M tokens (set prices to override)`); }
      const inEst = estimateInputTokens(body);
      const worst = usdOf(price, inEst, maxTok);
      let rid: number;
      try { rid = ctx.ledger.reserve(worst, `${o.purpose} ${provider.model}`); }
      catch (e) { ctx.ledger.refused({ ...base, input_tokens: 0, output_tokens: 0, usage_estimated: true }, (e as Error).message); throw e; }
      let raw;
      try { raw = await provider.send(body, o.signal); }
      catch (e) {
        const charge = chargesWorstCase(e) ? worst : 0;
        ctx.ledger.settle(rid, charge, { ...base, cached: false, status: 'error', input_tokens: charge ? inEst : 0, output_tokens: charge ? maxTok : 0, usage_estimated: true, error: String((e as Error)?.message ?? e).slice(0, 300) });
        throw e;
      }
      const p = parseCompletion(raw.json);
      const usage = p.usage ?? { input_tokens: inEst, output_tokens: maxTok };
      const usd = usdOf(price, usage.input_tokens, usage.output_tokens);
      ctx.ledger.settle(rid, usd, { ...base, cached: false, status: 'ok', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, usage_estimated: !p.usage });
      const response = { message: p.message, finish_reason: p.finish_reason, model: provider.model, usage, usd_list: Math.round(usd * 1e6) / 1e6 };
      ctx.cache.put({ schema: 'ves-model-cache/1', key, provider: provider.name, model: provider.model, salt: o.salt, at: ctx.ledger.now().toISOString(), response });
      return { ...response, cached: false, request_sha256: key };
    },
  };
}

/** List-price upper bound for one request (for "print the cost estimate first", e.g. `ves packs synthesize`). */
export function worstCaseUsd(provider: Provider, req: ChatRequest, purpose: ModelPurpose, prices?: PriceOverride): number {
  const maxTok = req.max_tokens ?? DEFAULT_MAX_TOKENS[purpose];
  const body = provider.effectiveBody({ ...req, max_tokens: maxTok });
  return usdOf(lookupPrice(provider.model, { local: provider.local, overrides: prices }).row, estimateInputTokens(body), maxTok);
}
