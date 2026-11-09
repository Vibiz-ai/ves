// Any OpenAI-compatible `/chat/completions` endpoint (OpenAI, Azure OpenAI v1, OpenRouter, Together, Groq, vLLM,
// Ollama, LM Studio, LiteLLM, ...). The key comes from env[`api_key_env`]; with no `api_key_env` no authorization
// header is sent (local servers). A 401 is a lost credential (AuthLostError): API keys have no refresh.
import { UsageError } from '../core/errors.ts';
import type { ModelRef } from '../core/types.ts';
import { postChat } from './http.ts';
import { baseBody, familyOf, isLocalUrl, type Provider, type ProviderDeps, type RpmLimiter } from './provider.ts';

export function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

export function createOpenAICompatibleProvider(ref: ModelRef, deps: ProviderDeps, limiter: RpmLimiter): Provider {
  if (!ref.base_url || ref.base_url.includes('${')) throw new UsageError(`openai-compatible model ${ref.model}: base_url is required`);
  let parsed: URL;
  try { parsed = new URL(ref.base_url); } catch { throw new UsageError(`openai-compatible model ${ref.model}: base_url is not a URL`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new UsageError(`openai-compatible model ${ref.model}: base_url must be http(s)`);
  let key: string | undefined;
  if (ref.api_key_env) {
    key = deps.env[ref.api_key_env];
    if (!key) throw new UsageError(`openai-compatible model ${ref.model}: env ${ref.api_key_env} (api_key_env) is not set`);
  }
  const url = chatCompletionsUrl(ref.base_url);
  const local = isLocalUrl(ref.base_url);
  return {
    name: 'openai-compatible', model: ref.model, family: familyOf(ref.model), local,
    effectiveBody: (req) => baseBody(ref.model, req, ref),
    send: (body, signal) => postChat({
      fetch: deps.fetch, url, body, label: `openai-compatible ${ref.model}`, signal, sleep: deps.sleep, log: deps.log, maxAttempts: deps.maxAttempts,
      headers: async () => ({ 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }),
      limiter: ref.rpm ? () => limiter.take(`oai:${url}:${ref.model}`, ref.rpm as number) : undefined,
    }),
  };
}
