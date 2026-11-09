// Content-hash response cache (DESIGN-agnostic §7.5): key = sha256(canonical({provider, model, effective body, salt})),
// one JSON file per key under `<cacheDir>` (default `.ves-cache/models/`). Same request + same salt = same answer, at
// $0; a new salt is a fresh sample (test-retest, A/A runs). Rows carry `cached`, which feeds cache.hit_ratio (VES-1
// §5.8): cached rows are excluded from variance, flip-rate, ICC and k analyses. Only successful completions are
// stored; credentials are never part of the key or the file.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson } from '../lib/canonicalise.ts';
import { sha256 } from '../lib/hash.ts';
import type { ChatResponse } from '../core/types.ts';

export type CacheRecord = { schema: 'ves-model-cache/1'; key: string; provider: string; model: string; salt: string; at: string;
                            response: Omit<ChatResponse, 'cached' | 'request_sha256'> };

export const cacheKey = (provider: string, model: string, body: unknown, salt: string): string =>
  sha256(canonicalJson({ provider, model, body, salt }));

export class ModelCache {
  dir: string | null;
  constructor(dir: string | null | undefined) { this.dir = dir ? dir : null; }
  path(key: string): string { return join(this.dir as string, key.slice(0, 2), `${key}.json`); }
  get(key: string): CacheRecord | null {
    if (!this.dir) return null;
    const p = this.path(key);
    if (!existsSync(p)) return null;
    try {
      const r = JSON.parse(readFileSync(p, 'utf8')) as CacheRecord;
      return r && r.key === key && r.response?.message ? r : null;
    } catch { return null; } // a torn or foreign file is a miss, never a crash
  }
  put(rec: CacheRecord): void {
    if (!this.dir) return;
    const p = this.path(rec.key);
    mkdirSync(join(this.dir, rec.key.slice(0, 2)), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, p);
  }
}
