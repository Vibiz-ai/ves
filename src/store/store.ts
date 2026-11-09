// RunStore: content-addressed, append-only archive of run directories on any StoreBackend.
//   push(runDir)       hash every file, upload missing objects, write the run record, append the index entry
//   index()            entries deduplicated by run_id, ordered by created then push order
//   record / readFile  read a run back (every object is re-hashed on read)
//   pull / materialise write a run directory back out, byte for byte
//   verify()           re-hash every object of every record; cross-check records and index
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { sha256 } from '../lib/hash.ts';
import { buildIndexEntry, type BranchInfo } from './entry.ts';
import {
  type IndexEntry, objectKey, type PushResult, RECORD_SCHEMA, recordKey, RUN_ID_RE, type RunRecord, STORE_SCHEMA, type StoreBackend, StoreError, type VerifyReport,
} from './types.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const hex = (b: Uint8Array) => sha256(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

export const treeHash = (files: { path: string; sha256: string; size: number }[]): string =>
  sha256([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\t${f.sha256}\t${f.size}\n`).join(''));
/** The record is serialised deterministically, so the same run always gives the same record bytes. */
export const recordBytes = (r: RunRecord): Uint8Array => enc(JSON.stringify(r, null, 1) + '\n');

const CTYPE: Record<string, string> = { '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const ctypeOf = (p: string) => CTYPE[p.slice(p.lastIndexOf('.'))] ?? 'application/octet-stream';

/** Every regular file under `dir` as a `/`-separated relative path. Symlinks are refused (they could point anywhere). */
export function walkRunDir(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new StoreError('io', `${relative(dir, p)} is a symlink; the store archives regular files only`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Branch for the index: --branch, else run.json target.branch, else the CI env, else git when HEAD is the target SHA. */
export function detectBranch(o: { arg?: string; manifestBranch?: string | null; targetSha?: string | null; env: Record<string, string | undefined>; git?: () => { branch: string; head: string } | null }): BranchInfo {
  if (o.arg) return { branch: o.arg, source: 'args' };
  if (o.manifestBranch) return { branch: o.manifestBranch, source: 'manifest' };
  const ci = o.env.GITHUB_HEAD_REF || (o.env.GITHUB_REF?.startsWith('refs/heads/') ? o.env.GITHUB_REF.slice(11) : undefined) || o.env.CI_COMMIT_REF_NAME;
  if (ci) return { branch: ci, source: 'ci-env' };
  const g = o.git?.() ?? null;
  // only when the checkout IS the run's target: a branch guessed from an unrelated checkout would be a lie
  if (g && g.branch && g.branch !== 'HEAD' && o.targetSha && g.head.startsWith(o.targetSha)) return { branch: g.branch, source: 'git' };
  return { branch: null, source: null };
}

export type IndexView = IndexEntry & { seq: number };

export class RunStore {
  backend: StoreBackend;
  now: () => Date;
  constructor(backend: StoreBackend, o: { now?: () => Date } = {}) { this.backend = backend; this.now = o.now ?? (() => new Date()); }

  async ensureHeader(): Promise<void> {
    await this.backend.put('STORE.json', enc(JSON.stringify({ schema_version: STORE_SCHEMA, layout: 'cas-sha256', note: 'append-only VES run archive; see the VES README "History & comparisons"' }, null, 1) + '\n'), 'application/json');
  }

  /** Build the record of a run directory without writing anything. */
  static recordOf(runDir: string): { record: RunRecord; blobs: Map<string, Uint8Array> } {
    const runJson = join(runDir, 'run.json');
    if (!existsSync(runJson)) throw new StoreError('not_found', `${runDir}: no run.json (not a run directory)`);
    let runId: string;
    try { runId = String(JSON.parse(readFileSync(runJson, 'utf8')).run_id ?? ''); } catch { throw new StoreError('io', `${runJson}: not JSON`); }
    if (!RUN_ID_RE.test(runId)) throw new StoreError('io', `${runJson}: bad run_id ${JSON.stringify(runId)}`);
    const blobs = new Map<string, Uint8Array>();
    const files = walkRunDir(runDir).map((p) => {
      const b = new Uint8Array(readFileSync(join(runDir, ...p.split('/'))));
      const h = hex(b);
      blobs.set(h, b);
      return { path: p, sha256: h, size: b.byteLength };
    });
    return { record: { schema_version: RECORD_SCHEMA, run_id: runId, tree_sha256: treeHash(files), files }, blobs };
  }

  async push(runDir: string, o: { branch: BranchInfo }): Promise<PushResult> {
    const { record, blobs } = RunStore.recordOf(runDir);
    const rb = recordBytes(record);
    const rsha = hex(rb);
    const existing = await this.backend.get(recordKey(record.run_id));
    if (existing) return this.alreadyStored(record, existing, runDir, o);
    await this.ensureHeader();
    let created = 0;
    for (const [h, b] of blobs) {
      const f = record.files.find((x) => x.sha256 === h)!;
      if ((await this.backend.put(objectKey(h), b, ctypeOf(f.path))) === 'created') created++;
    }
    // objects first, then the record, then the index: a reader never sees a record whose objects are missing
    const put = await this.backend.put(recordKey(record.run_id), rb, 'application/json');
    if (put === 'exists') {
      // a concurrent push won the write-once race: the same content is a no-op, anything else is a conflict
      const now = await this.backend.get(recordKey(record.run_id));
      return this.alreadyStored(record, now ?? new Uint8Array(), runDir, o);
    }
    const entry = buildIndexEntry(runDir, record, rsha, { branch: o.branch, pushedAt: this.now().toISOString() });
    await this.backend.appendIndex(entry);
    return { run_id: record.run_id, status: 'stored', files: record.files.length, bytes: entry.bytes, new_objects: created, entry, indexed: true };
  }

  async alreadyStored(record: RunRecord, existing: Uint8Array, runDir: string, o: { branch: BranchInfo }): Promise<PushResult> {
    let prev: RunRecord | null = null;
    try { prev = JSON.parse(dec(existing)); } catch { prev = null; }
    if (!prev || prev.tree_sha256 !== record.tree_sha256) {
      const diff = prev ? diffRecords(prev, record) : ['stored record unreadable'];
      throw new StoreError('tamper', `run ${record.run_id} is already in the store with DIFFERENT content (stored tree ${prev?.tree_sha256?.slice(0, 12) ?? '?'}, local ${record.tree_sha256.slice(0, 12)}): ${diff.slice(0, 5).join('; ')}. The store is append-only; a run directory must not change after it is pushed.`);
    }
    // the same run again: a no-op, except that a push interrupted before its index entry gets one now
    const { entries } = await this.backend.readIndex();
    let indexed = false;
    if (!entries.some((e) => e.run_id === record.run_id)) {
      await this.backend.appendIndex(buildIndexEntry(runDir, record, hex(existing), { branch: o.branch, pushedAt: this.now().toISOString() }));
      indexed = true;
    }
    return { run_id: record.run_id, status: 'unchanged', files: record.files.length, bytes: record.files.reduce((a, f) => a + f.size, 0), new_objects: 0, entry: null, indexed };
  }

  /** Index entries, first entry per run_id wins, ordered by created then push time (stable: append order last). */
  async index(): Promise<{ entries: IndexView[]; problems: string[] }> {
    const { entries, problems } = await this.backend.readIndex();
    const seen = new Set<string>();
    const out: IndexView[] = [];
    entries.forEach((e, i) => {
      if (!e || typeof e.run_id !== 'string' || seen.has(e.run_id)) return;
      seen.add(e.run_id);
      out.push({ ...e, seq: i });
    });
    out.sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')) || String(a.pushed_at).localeCompare(String(b.pushed_at)) || a.seq - b.seq);
    out.forEach((e, i) => { e.seq = i; });
    return { entries: out, problems };
  }

  async record(runId: string): Promise<RunRecord | null> {
    if (!RUN_ID_RE.test(runId)) throw new StoreError('not_found', `bad run id ${JSON.stringify(runId)}`);
    const b = await this.backend.get(recordKey(runId));
    if (!b) return null;
    try { return JSON.parse(dec(b)); } catch { throw new StoreError('tamper', `runs/${runId}.json is not JSON`); }
  }

  async object(sha: string, what: string): Promise<Uint8Array> {
    const b = await this.backend.get(objectKey(sha));
    if (!b) throw new StoreError('tamper', `${what}: object ${sha.slice(0, 12)} is missing from the store`);
    if (hex(b) !== sha) throw new StoreError('tamper', `${what}: object ${sha.slice(0, 12)} does not hash to its address (modified in the store)`);
    return b;
  }

  async readFile(runId: string, path: string): Promise<Uint8Array | null> {
    const r = await this.record(runId);
    const f = r?.files.find((x) => x.path === path);
    return f ? this.object(f.sha256, `${runId}/${path}`) : null;
  }

  /** Write the run (or only `only` paths) to `dir` exactly as it was pushed. Refuses to overwrite anything. */
  async materialise(runId: string, dir: string, only?: string[]): Promise<string> {
    const r = await this.record(runId);
    if (!r) throw new StoreError('not_found', `run ${runId} is not in the store ${this.backend.url}`);
    for (const f of r.files) {
      if (only && !only.includes(f.path)) continue;
      const dest = join(dir, ...f.path.split('/'));
      if (existsSync(dest)) throw new StoreError('conflict', `${dest} exists; refusing to overwrite`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, await this.object(f.sha256, `${runId}/${f.path}`), { flag: 'wx' });
    }
    return dir;
  }

  async pull(runId: string, outDir: string): Promise<string> {
    const dest = join(outDir, runId);
    if (existsSync(dest) && readdirSync(dest).length) throw new StoreError('conflict', `${dest} exists and is not empty; refusing to overwrite`);
    return this.materialise(runId, dest);
  }

  async verify(): Promise<VerifyReport> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const { entries: raw, problems } = await this.backend.readIndex();
    errors.push(...problems);
    const byId = new Map<string, IndexEntry[]>();
    for (const e of raw) byId.set(e.run_id, [...(byId.get(e.run_id) ?? []), e]);
    for (const [id, es] of byId) if (es.length > 1) {
      const shas = new Set(es.map((e) => e.record_sha256));
      (shas.size > 1 ? errors : warnings).push(`index: run ${id} appears ${es.length} times${shas.size > 1 ? ' with different record hashes' : ' (same record)'}`);
    }
    const recordKeys = (await this.backend.list('runs')).filter((k) => k.endsWith('.json'));
    const recordIds = new Set(recordKeys.map((k) => k.slice('runs/'.length, -'.json'.length)));
    const checked = new Set<string>();
    let objects = 0;
    for (const id of recordIds) {
      const b = await this.backend.get(recordKey(id));
      if (!b) { errors.push(`runs/${id}.json listed but not readable`); continue; }
      let r: RunRecord;
      try { r = JSON.parse(dec(b)); } catch { errors.push(`runs/${id}.json is not JSON`); continue; }
      if (r.run_id !== id) errors.push(`runs/${id}.json names run ${r.run_id}`);
      if (treeHash(r.files) !== r.tree_sha256) errors.push(`run ${id}: tree_sha256 does not match its file list (record modified)`);
      const es = byId.get(id);
      if (!es) errors.push(`run ${id}: record has no index entry`);
      else if (!es.some((e) => e.record_sha256 === hex(b))) errors.push(`run ${id}: record bytes do not match the index record_sha256 (record modified after push)`);
      for (const f of r.files) {
        if (checked.has(f.sha256)) continue;
        checked.add(f.sha256);
        objects++;
        const o = await this.backend.get(objectKey(f.sha256));
        if (!o) errors.push(`run ${id}: ${f.path}: object ${f.sha256.slice(0, 12)} missing`);
        else if (hex(o) !== f.sha256) errors.push(`run ${id}: ${f.path}: object ${f.sha256.slice(0, 12)} was modified (hash mismatch)`);
        else if (o.byteLength !== f.size) errors.push(`run ${id}: ${f.path}: size ${o.byteLength} != ${f.size}`);
      }
    }
    for (const id of byId.keys()) if (!recordIds.has(id)) errors.push(`index: run ${id} has no record (runs/${id}.json missing)`);
    return { ok: errors.length === 0, runs: recordIds.size, objects_checked: objects, errors, warnings };
  }
}

export function diffRecords(a: RunRecord, b: RunRecord): string[] {
  const am = new Map(a.files.map((f) => [f.path, f.sha256]));
  const bm = new Map(b.files.map((f) => [f.path, f.sha256]));
  const out: string[] = [];
  for (const [p, h] of bm) if (!am.has(p)) out.push(`+${p}`); else if (am.get(p) !== h) out.push(`~${p}`);
  for (const p of am.keys()) if (!bm.has(p)) out.push(`-${p}`);
  return out;
}
