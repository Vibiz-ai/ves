import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('The VES UI server is not reachable. Start it with `npm run dev` or `node server/index.mjs --results <dir>` in ui/.', 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  if (body === null) throw new ApiError(`Expected JSON from ${url}; got something else. Is this the VES UI server?`, res.status);
  return body as T;
}

export type FetchState<T> = { data: T | null; error: ApiError | null; loading: boolean; reload: () => void };

/** Fetch JSON; optionally re-poll every `pollMs` (keeps the last good data on screen while polling). */
export function useApi<T>(url: string | null, pollMs?: number): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);
  const [tick, setTick] = useState(0);
  const lastUrl = useRef<string | null>(null);
  const lastBody = useRef<string>('');

  useEffect(() => {
    if (!url) { setLoading(false); return; }
    const ctl = new AbortController();
    if (lastUrl.current !== url) { setData(null); setError(null); setLoading(true); lastUrl.current = url; lastBody.current = ''; }
    getJson<T>(url, ctl.signal)
      .then((d) => {
        const s = JSON.stringify(d);
        if (s !== lastBody.current) { lastBody.current = s; setData(d); }
        setError(null);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e : new ApiError(String(e.message), 0));
        setLoading(false);
      });
    return () => ctl.abort();
  }, [url, tick]);

  useEffect(() => {
    if (!url || !pollMs) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') setTick((x) => x + 1); }, pollMs);
    return () => clearInterval(t);
  }, [url, pollMs]);

  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data, error, loading, reload };
}
