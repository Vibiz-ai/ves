// Google Cloud Storage backend over the JSON API with plain fetch (no SDK). Auth is Application Default Credentials:
// the token comes from `gcloud auth application-default print-access-token` (src/models/vertex.ts AdcToken, the same
// pattern as an earlier research harness (not public), lib/vertex.mjs), is sent only in the Authorization header and is never logged,
// printed, written or put in an error message. Every request carries `x-goog-user-project` (the billing/quota project).
//
// Write-once: every object is uploaded with `ifGenerationMatch=0`, so GCS itself refuses (HTTP 412) to replace an
// existing object; 412 is reported as 'exists'. The index is one object per run under index/, so concurrent pushes
// never read-modify-write a shared file.
import { checkKey, type IndexEntry, type PutResult, type StoreBackend, StoreError, type StoreFetch } from './types.ts';

export const GCS_API = 'https://storage.googleapis.com';

export type GcsOptions = {
  bucket: string; prefix: string; project: string;
  fetch: StoreFetch;
  /** Returns an OAuth access token; `force` asks for a fresh one (after a 401). */
  token: (force?: boolean) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Parallel GETs when reading the index (default 16). */
  concurrency?: number;
};

export function parseGsUrl(url: string): { bucket: string; prefix: string } {
  const m = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])(?:\/(.*))?$/.exec(url.trim());
  if (!m) throw new StoreError('config', `bad GCS store URL ${JSON.stringify(url)} (want gs://<bucket>[/<prefix>])`);
  return { bucket: m[1], prefix: (m[2] ?? '').replace(/^\/+|\/+$/g, '') };
}

const enc = encodeURIComponent;

export class GcsBackend implements StoreBackend {
  readonly kind = 'gcs' as const;
  readonly url: string;
  o: GcsOptions;
  constructor(o: GcsOptions) {
    if (!o.project) throw new StoreError('config', 'gcs store: no billing project for x-goog-user-project (set store.project in ves.config.json, or VES_STORE_PROJECT / GOOGLE_CLOUD_PROJECT)');
    this.o = o;
    this.url = `gs://${o.bucket}${o.prefix ? `/${o.prefix}` : ''}`;
  }

  name(key: string): string { checkKey(key); return this.o.prefix ? `${this.o.prefix}/${key}` : key; }

  /** One request with auth; a 401 refreshes the token once; 429/5xx/network errors retry 3 times with backoff. */
  async req(method: string, url: string, body?: Uint8Array, contentType?: string): Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let refreshed = false;
    let force = false;
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      let tok: string;
      try { tok = await this.o.token(force); force = false; } catch (e) { throw new StoreError('auth', `gcs store: ADC token unavailable (${String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200)}); run \`gcloud auth application-default login\``); }
      const headers: Record<string, string> = { authorization: `Bearer ${tok}`, 'x-goog-user-project': this.o.project };
      if (contentType) headers['content-type'] = contentType;
      let r;
      try { r = await this.o.fetch(url, { method, headers, ...(body ? { body } : {}) }); } catch (e) {
        lastErr = `network error: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
        throw new StoreError('io', `gcs ${method} ${this.redact(url)}: ${lastErr}`);
      }
      if (r.status === 401 && !refreshed) { refreshed = true; force = true; continue; }
      if (r.status === 429 || r.status >= 500) {
        lastErr = `HTTP ${r.status}`;
        if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
      }
      return r;
    }
    throw new StoreError('io', `gcs ${method} ${this.redact(url)}: ${lastErr || 'failed'}`);
  }

  /** URLs never carry credentials (the token is a header); strip the query for shorter messages. */
  redact(url: string): string { return url.split('?')[0]; }

  async fail(what: string, r: { status: number; text(): Promise<string> }): Promise<never> {
    let msg = '';
    try { const j = JSON.parse(await r.text()); msg = String(j?.error?.message ?? '').slice(0, 300); } catch { /* not JSON */ }
    throw new StoreError(r.status === 401 || r.status === 403 ? 'auth' : 'io', `gcs ${what}: HTTP ${r.status}${msg ? ` ${msg}` : ''}`);
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    const url = `${GCS_API}/upload/storage/v1/b/${enc(this.o.bucket)}/o?uploadType=media&name=${enc(this.name(key))}&ifGenerationMatch=0`;
    const r = await this.req('POST', url, body, contentType);
    if (r.status === 200 || r.status === 201) return 'created';
    if (r.status === 412) return 'exists'; // precondition ifGenerationMatch=0 failed: the object already exists
    return this.fail(`put ${key}`, r);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const r = await this.req('GET', `${GCS_API}/storage/v1/b/${enc(this.o.bucket)}/o/${enc(this.name(key))}?alt=media`);
    if (r.status === 404) return null;
    if (r.status !== 200) return this.fail(`get ${key}`, r);
    return new Uint8Array(await r.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    const full = prefix ? this.name(prefix.replace(/\/+$/, '')) + '/' : (this.o.prefix ? `${this.o.prefix}/` : '');
    const strip = this.o.prefix ? this.o.prefix.length + 1 : 0;
    const out: string[] = [];
    let page = '';
    for (let i = 0; i < 10000; i++) {
      const url = `${GCS_API}/storage/v1/b/${enc(this.o.bucket)}/o?prefix=${enc(full)}&fields=${enc('items(name),nextPageToken')}${page ? `&pageToken=${enc(page)}` : ''}`;
      const r = await this.req('GET', url);
      if (r.status !== 200) return this.fail(`list ${prefix}`, r);
      const j = JSON.parse(await r.text()) as { items?: { name: string }[]; nextPageToken?: string };
      for (const it of j.items ?? []) out.push(it.name.slice(strip));
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out.sort();
  }

  async appendIndex(entry: IndexEntry): Promise<void> {
    // one object per run: a second push of the same run finds it and leaves it (append-only)
    await this.put(`index/${entry.run_id}.json`, new TextEncoder().encode(JSON.stringify(entry)), 'application/json');
  }

  async readIndex(): Promise<{ entries: IndexEntry[]; problems: string[] }> {
    const keys = (await this.list('index')).filter((k) => k.endsWith('.json'));
    const entries: (IndexEntry | null)[] = new Array(keys.length).fill(null);
    const problems: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < keys.length) {
        const i = next++;
        const b = await this.get(keys[i]);
        if (!b) { problems.push(`${keys[i]}: listed but not readable`); continue; }
        try { entries[i] = JSON.parse(new TextDecoder().decode(b)); } catch { problems.push(`${keys[i]}: not JSON`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency ?? 16, keys.length) }, worker));
    return { entries: entries.filter((e): e is IndexEntry => !!e), problems };
  }
}
