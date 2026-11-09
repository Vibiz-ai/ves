// routesHash() (DESIGN-agnostic §1.3): sha256 over the connection identity plus the sha256 of every file matched by
// `connection.routes` (globs, relative to the repo). It drives the adapter-drift check (VES-1 §11.2). Without
// `routes`, the files named in the command line (the bridge) are hashed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.ves-cache', 'ves-results']);

/** `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(g: string): RegExp {
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { r += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${r}$`);
}

export function globFiles(root: string, globs: string[], limit = 5000): string[] {
  const res = globs.map(globToRegExp);
  const out: string[] = [];
  const walk = (d: string) => {
    if (out.length >= limit) return;
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const f = join(d, n);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f);
      else { const rel = relative(root, f).split(sep).join('/'); if (res.some((r) => r.test(rel))) out.push(rel); }
    }
  };
  walk(root);
  return out;
}

export function routesHash(o: { identity: unknown; root: string; routes?: unknown; command?: string[] }): string {
  const files = new Set<string>();
  if (Array.isArray(o.routes) && o.routes.length) for (const f of globFiles(o.root, o.routes.map(String))) files.add(f);
  else for (const a of o.command ?? []) {
    const p = isAbsolute(a) ? a : resolve(o.root, a);
    if (/\.[a-z0-9]{1,5}$/i.test(a) && existsSync(p) && statSync(p).isFile()) files.add(isAbsolute(a) ? a : relative(o.root, p).split(sep).join('/'));
  }
  const parts = [...files].sort().map((f) => `${f}:${sha(readFileSync(isAbsolute(f) ? f : join(o.root, f)))}`);
  return sha(JSON.stringify({ identity: o.identity, files: parts }));
}
