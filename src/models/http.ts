// POST with the lab's retry policy (an earlier research harness (not public), lib/vertex.mjs `post`), on injected fetch and sleep:
// 429, 5xx, transient HTML 404s from the Google front end and network errors are retried with exponential back-off;
// a 401 triggers one credential refresh (when the provider has one), and a second 401 is a lost credential
// (AuthLostError, INVALID infra_auth; never process.exit). Other 4xx are request defects (HarnessError). Headers,
// and so tokens, are never logged or put in an error message.
import { AuthLostError, HarnessError, UsageError } from '../core/errors.ts';
import type { FetchLike } from '../core/types.ts';
import { ModelHttpError, type LogFn, type RawCompletion, type Sleep } from './provider.ts';

export type PostOpts = {
  fetch: FetchLike; url: string; body: Record<string, unknown>; label: string;
  headers: () => Promise<Record<string, string>>;
  /** Refresh the credential after a 401. Absent: the first 401 is AuthLostError. */
  onUnauthorized?: () => Promise<void>;
  limiter?: () => Promise<void>;
  sleep: Sleep; log: LogFn; signal?: AbortSignal; maxAttempts?: number;
};

const excerpt = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 300);
export const backoffMs = (attempt: number): number => Math.min(60_000, 2000 * 2 ** attempt);
const isHtml = (s: string): boolean => /^\s*<(!DOCTYPE|html)/i.test(s);

export async function postChat(o: PostOpts): Promise<RawCompletion> {
  const payload = JSON.stringify(o.body);
  const max = o.maxAttempts ?? 6;
  let refreshed = false;
  let last: Error = new ModelHttpError(`${o.label}: no attempt made`, 599);
  for (let attempt = 0; attempt < max; attempt++) {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error('aborted');
    await o.limiter?.();
    const headers = await o.headers(); // may throw AuthLostError / UsageError: never retried as a network error
    let status: number;
    let text: string;
    try {
      const r = await o.fetch(o.url, { method: 'POST', headers, body: payload, signal: o.signal });
      status = r.status;
      text = await r.text();
    } catch (e) {
      if (e instanceof AuthLostError || e instanceof UsageError || o.signal?.aborted) throw e;
      last = new ModelHttpError(`${o.label}: network error: ${excerpt(String((e as Error)?.message ?? e))}`, 599);
      o.log('warn', `${last.message}; retry ${attempt + 1}/${max - 1}`);
      if (attempt < max - 1) await o.sleep(backoffMs(attempt));
      continue;
    }
    if (status >= 200 && status < 300) {
      try { return { json: JSON.parse(text) }; }
      catch { last = new ModelHttpError(`${o.label}: HTTP ${status} with a non-JSON body: ${excerpt(text)}`, 502); }
      if (attempt < max - 1) await o.sleep(backoffMs(attempt));
      continue;
    }
    if (status === 401) {
      if (o.onUnauthorized && !refreshed) { refreshed = true; o.log('info', `${o.label}: HTTP 401, refreshing the credential`); await o.onUnauthorized(); continue; }
      throw new AuthLostError(`${o.label}: HTTP 401${refreshed ? ' after a credential refresh' : ''}; the model credential is lost`);
    }
    if (status === 402 || status === 403) throw new ModelHttpError(`${o.label}: HTTP ${status}: ${excerpt(text)}`, status);
    const html404 = status === 404 && isHtml(text);
    if (status === 429 || status >= 500 || html404) {
      last = new ModelHttpError(`${o.label}: HTTP ${status}${html404 ? ' (transient HTML 404)' : ''}: ${excerpt(text)}`, html404 ? 503 : status);
      o.log('warn', `${o.label}: HTTP ${status}, retry ${attempt + 1}/${max - 1}`);
      if (attempt < max - 1) await o.sleep(backoffMs(attempt));
      continue;
    }
    throw new HarnessError(`${o.label}: HTTP ${status} (request refused by the provider): ${excerpt(text)}`);
  }
  throw last;
}
