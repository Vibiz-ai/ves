// Read-only reader for a VES run store (README "History & comparisons"), for the dashboard server only.
// It reads the documented store layout and never imports harness code (../src):
//   objects/sha256/<aa>/<sha256>   file bytes, addressed by their sha256 (re-hashed here on every read)
//   runs/<run_id>.json             the run record: { run_id, tree_sha256, files: [{ path, sha256, size }] }
//   index.jsonl                    local: one index entry per line
//   index/<run_id>.json            gcs: one index entry object per run
// gs:// stores use Application Default Credentials on the SERVER: `gcloud auth application-default print-access-token`
// (cached 40 minutes, refreshed on a 401). The token is only ever sent to storage.googleapis.com in an Authorization
// header; it never reaches the browser, a log line or an error message.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const GCS = 'https://storage.googleapis.com';
const sha = (b) => createHash('sha256').update(b).digest('hex');

export function realGcloudToken() {
  return new Promise((res, rej) => {
    execFile('gcloud', ['auth', 'application-default', 'print-access-token'], { timeout: 60_000 }, (e, out) => {
      if (e) return rej(new Error(`ADC token unavailable (gcloud: ${String(e.message).split('\n')[0].slice(0, 160)}); run \`gcloud auth application-default login\``));
      const t = String(out).trim();
      if (!t || /\s/.test(t)) return rej(new Error('ADC token unavailable (gcloud printed nothing usable)'));
      res(t);
    });
  });
}

function localBackend(root) {
  const p = (key) => join(root, ...key.split('/'));
  return {
    kind: 'local', url: root,
    exists: () => existsSync(root),
    async get(key) { try { return readFileSync(p(key)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async readIndex() {
      const f = join(root, 'index.jsonl');
      if (!existsSync(f)) return { entries: [], problems: [] };
      const entries = [], problems = [];
      readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (!l.trim()) return; try { entries.push(JSON.parse(l)); } catch { problems.push(`index.jsonl line ${i + 1}: not JSON`); } });
      return { entries, problems };
    },
  };
}

function gcsBackend(url, o) {
  const m = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])(?:\/(.*))?$/.exec(url);
  if (!m) throw new Error(`bad gs:// store URL ${url}`);
  const bucket = m[1], prefix = (m[2] ?? '').replace(/^\/+|\/+$/g, '');
  const name = (key) => (prefix ? `${prefix}/${key}` : key);
  let tok = null, at = 0;
  const token = async (force) => {
    if (!force && tok && o.now() - at < 40 * 60_000) return tok;
    tok = await o.token(); at = o.now();
    return tok;
  };
  const req = async (u) => {
    if (!o.project) throw new Error('gcs store: no billing project for x-goog-user-project (pass --store-project or set VES_STORE_PROJECT)');
    for (let i = 0; i < 2; i++) {
      const r = await o.fetch(u, { method: 'GET', headers: { authorization: `Bearer ${await token(i > 0)}`, 'x-goog-user-project': o.project } });
      if (r.status === 401 && i === 0) continue;
      return r;
    }
  };
  const fail = async (what, r) => { let msg = ''; try { msg = String(JSON.parse(await r.text())?.error?.message ?? '').slice(0, 200); } catch { /* not JSON */ } throw new Error(`gcs ${what}: HTTP ${r.status}${msg ? ` ${msg}` : ''}`); };
  const get = async (key) => {
    const r = await req(`${GCS}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name(key))}?alt=media`);
    if (r.status === 404) return null;
    if (r.status !== 200) return fail(`get ${key}`, r);
    return Buffer.from(await r.arrayBuffer());
  };
  const list = async (pfx) => {
    const out = [];
    let page = '';
    for (let i = 0; i < 1000; i++) {
      const r = await req(`${GCS}/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(name(pfx) + '/')}&fields=${encodeURIComponent('items(name),nextPageToken')}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      if (r.status !== 200) return fail(`list ${pfx}`, r);
      const j = JSON.parse(await r.text());
      for (const it of j.items ?? []) out.push(prefix ? it.name.slice(prefix.length + 1) : it.name);
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return out;
  };
  return {
    kind: 'gcs', url: `gs://${bucket}${prefix ? `/${prefix}` : ''}`,
    exists: () => true,
    get,
    async readIndex() {
      const keys = (await list('index')).filter((k) => k.endsWith('.json')).sort();
      const problems = [];
      const entries = await Promise.all(keys.map(async (k) => {
        const b = await get(k);
        if (!b) { problems.push(`${k}: not readable`); return null; }
        try { return JSON.parse(b.toString('utf8')); } catch { problems.push(`${k}: not JSON`); return null; }
      }));
      return { entries: entries.filter(Boolean), problems };
    },
  };
}

/**
 * openStoreReader(url, { fetch, token, project, now }) -> reader with index(), record(id), readFile(id, path).
 * `fetch` / `token` are injectable (tests use fakes); defaults are globalThis.fetch and gcloud ADC.
 */
export function openStoreReader(url, o = {}) {
  const deps = { fetch: o.fetch ?? globalThis.fetch, token: o.token ?? realGcloudToken, project: o.project, now: o.now ?? (() => Date.now()) };
  const b = url.startsWith('gs://') ? gcsBackend(url, deps) : localBackend(url);
  const objects = new Map(); // sha -> Buffer (immutable, so cached; bounded)
  const records = new Map();
  let idx = null, idxAt = 0;

  const object = async (h, what) => {
    if (objects.has(h)) return objects.get(h);
    const buf = await b.get(`objects/sha256/${h.slice(0, 2)}/${h}`);
    if (!buf) throw new Error(`${what}: object ${h.slice(0, 12)} missing from the store`);
    if (sha(buf) !== h) throw new Error(`${what}: object ${h.slice(0, 12)} does not match its hash (modified in the store)`);
    if (objects.size > 2000) objects.clear();
    objects.set(h, buf);
    return buf;
  };

  return {
    kind: b.kind,
    url: b.url,
    exists: b.exists,
    /** Index entries: first per run_id wins, ordered by created then push time then append order; seq = position. */
    async index(maxAgeMs = 3000) {
      if (idx && deps.now() - idxAt < maxAgeMs) return idx;
      const { entries, problems } = await b.readIndex();
      const seen = new Set();
      const out = [];
      entries.forEach((e, i) => { if (e && typeof e.run_id === 'string' && !seen.has(e.run_id)) { seen.add(e.run_id); out.push({ ...e, seq: i }); } });
      out.sort((x, y) => String(x.created ?? '').localeCompare(String(y.created ?? '')) || String(x.pushed_at ?? '').localeCompare(String(y.pushed_at ?? '')) || x.seq - y.seq);
      const labels = new Map();
      out.forEach((e, i) => {
        e.seq = i;
        if (e.suite_version && !labels.has(e.suite_version)) labels.set(e.suite_version, `v${labels.size + 1}`);
        e.suite_label = e.suite_version ? labels.get(e.suite_version) : null;
      });
      idx = { entries: out, problems };
      idxAt = deps.now();
      return idx;
    },
    async record(runId) {
      if (!RUN_ID_RE.test(runId ?? '')) return null;
      if (records.has(runId)) return records.get(runId);
      const buf = await b.get(`runs/${runId}.json`);
      if (!buf) return null;
      const r = JSON.parse(buf.toString('utf8'));
      records.set(runId, r);
      return r;
    },
    async readFile(runId, path) {
      const r = await this.record(runId);
      const f = r?.files?.find((x) => x.path === path);
      return f ? object(f.sha256, `${runId}/${path}`) : null;
    },
  };
}
