// Run store (history of every eval run): types shared by the backends, the store logic and the CLI.
//
// Layout (the same keys on every backend, relative to the store root or bucket prefix):
//   STORE.json                       {schema_version: "ves-store/1", layout: "cas-sha256"}, written once
//   objects/sha256/<aa>/<sha256>     every file of every run, addressed by the sha256 of its bytes (write-once)
//   runs/<run_id>.json               the run record: every file path of the run dir with its sha256 and size (write-once)
//   index.jsonl                      local backend: one IndexEntry per line, appended
//   index/<run_id>.json              gcs backend: one IndexEntry object per run (no read-modify-write of a shared file)
// Nothing is ever overwritten or deleted. Pushing a run twice is a no-op when the record matches and an error when it
// differs (tamper evident). `verify` re-hashes every object a record references.

export const STORE_SCHEMA = 'ves-store/1';
export const RECORD_SCHEMA = 'ves-store-run/1';
export const INDEX_SCHEMA = 'ves-store-index/1';
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export type PutResult = 'created' | 'exists';

/** Byte-level, write-once key/value backend. Keys are `/`-separated, relative, without `..`. */
export interface StoreBackend {
  readonly kind: 'local' | 'gcs';
  /** Display form (a path or gs://bucket/prefix); never contains a credential. */
  readonly url: string;
  /** Create `key` with `body` unless it exists. Never overwrites. */
  put(key: string, body: Uint8Array, contentType: string): Promise<PutResult>;
  get(key: string): Promise<Uint8Array | null>;
  /** Every key under `prefix` (relative to the store root). */
  list(prefix: string): Promise<string[]>;
  appendIndex(entry: IndexEntry): Promise<void>;
  /** Index entries in append order (local) or listing order (gcs), plus unreadable lines/objects. */
  readIndex(): Promise<{ entries: IndexEntry[]; problems: string[] }>;
}

export type RecordFile = { path: string; sha256: string; size: number };
export type RunRecord = {
  schema_version: typeof RECORD_SCHEMA;
  run_id: string;
  /** sha256 over the sorted `path\tsha256\tsize\n` lines: the content address of the whole run directory. */
  tree_sha256: string;
  files: RecordFile[];
};

export type SurfaceSummary = {
  pass1: number; ci: [number, number]; n_cases: number; k: number;
  violations: number; invalid: number; skipped: number;
};

export type IndexEntry = {
  schema_version: typeof INDEX_SCHEMA;
  run_id: string;
  /** Earliest result row created_at (ms precision), else the run_id timestamp. */
  created: string | null;
  pushed_at: string;
  project: string | null;
  tier: string | null;
  trigger: string | null;
  status: string | null;
  verdict: string | null;
  would_be: string | null;
  decided_by: string | null;
  target: { sha: string | null; branch: string | null; change_class: number | null };
  branch_source: 'args' | 'manifest' | 'ci-env' | 'git' | null;
  suite_version: string | null;
  case_count: number | null;
  config_sha256: string | null;
  catalog_sha256: string | null;
  agent_models: string[];
  host_families: string[];
  variants: string[];
  surfaces: Record<string, SurfaceSummary>;
  cost: { actual_usd: number | null; agent_usd_reported: number | null; tokens: number; wall_s: number | null };
  record_sha256: string;
  tree_sha256: string;
  files: number;
  bytes: number;
};

export type PushResult = { run_id: string; status: 'stored' | 'unchanged'; files: number; bytes: number; new_objects: number; entry: IndexEntry | null; indexed: boolean };
export type VerifyReport = { ok: boolean; runs: number; objects_checked: number; errors: string[]; warnings: string[] };

/** fetch as used by the gcs backend (binary bodies). globalThis.fetch satisfies it; tests inject a fake. */
export type StoreFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) =>
  Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export class StoreError extends Error {
  code: 'tamper' | 'conflict' | 'not_found' | 'auth' | 'io' | 'config';
  constructor(code: StoreError['code'], message: string) { super(message); this.code = code; }
}

export function checkKey(key: string): string {
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw new StoreError('io', `bad store key ${JSON.stringify(key)}`);
  }
  return key;
}
export const objectKey = (sha: string): string => `objects/sha256/${sha.slice(0, 2)}/${sha}`;
export const recordKey = (runId: string): string => `runs/${runId}.json`;
