// Local directory backend (default ./.ves/store). Write-once by construction: each object is written to a temp file
// and hard-linked into place (link(2) fails with EEXIST, so a racing writer can never replace a file), then made
// read-only. The index is one JSON line per run appended to index.jsonl.
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { checkKey, type IndexEntry, type PutResult, type StoreBackend, StoreError } from './types.ts';

export class LocalBackend implements StoreBackend {
  readonly kind = 'local' as const;
  readonly url: string;
  readonly root: string;
  constructor(root: string) { this.root = root; this.url = root; }

  path(key: string): string { return join(this.root, ...checkKey(key).split('/')); }

  async put(key: string, body: Uint8Array): Promise<PutResult> {
    const p = this.path(key);
    if (existsSync(p)) return 'exists';
    mkdirSync(dirname(p), { recursive: true });
    const tmp = join(this.root, '.tmp', `${randomBytes(8).toString('hex')}`);
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, body, { flag: 'wx' });
    try {
      linkSync(tmp, p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw new StoreError('io', `cannot write ${key}: ${(e as Error).message}`);
    } finally {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
    try { chmodSync(p, 0o444); } catch { /* best effort: immutability is also checked by verify */ }
    return 'created';
  }

  async get(key: string): Promise<Uint8Array | null> {
    try { return readFileSync(this.path(key)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new StoreError('io', `cannot read ${key}: ${(e as Error).message}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const base = prefix.replace(/\/+$/, '');
    const start = base ? this.path(base) : this.root;
    const walk = (dir: string, rel: string) => {
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else if (e.isFile()) out.push(r);
      }
    };
    walk(start, base);
    return out.sort();
  }

  async appendIndex(entry: IndexEntry): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    // one write(2) per line with O_APPEND: concurrent pushes interleave whole lines, never bytes
    appendFileSync(join(this.root, 'index.jsonl'), JSON.stringify(entry) + '\n');
  }

  async readIndex(): Promise<{ entries: IndexEntry[]; problems: string[] }> {
    const f = join(this.root, 'index.jsonl');
    if (!existsSync(f)) return { entries: [], problems: [] };
    const entries: IndexEntry[] = [];
    const problems: string[] = [];
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      try { entries.push(JSON.parse(line)); } catch { problems.push(`index.jsonl line ${i + 1}: not JSON`); }
    });
    return { entries, problems };
  }
}
