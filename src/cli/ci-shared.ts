// Shared helpers for `ves ci …` and `ves init` (ci package, DESIGN-agnostic §6, §7.4). No dependencies: git and gh
// are reached through the injected ExecLike, HTTP through the injected FetchLike, so every path is testable offline.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CliDeps, ExecLike, FetchLike, Tier } from '../core/types.ts';

export type Env = Record<string, string | undefined>;
export const TIER_RANK: Record<Tier, number> = { smoke: 0, release: 1, research: 2 };
export const isTier = (s: unknown): s is Tier => s === 'smoke' || s === 'release' || s === 'research';
export const HEX40 = /^[a-f0-9]{40}$/;

/** `key=value` lines for $GITHUB_OUTPUT; multi-line values use the heredoc form GitHub documents. */
export function githubOutputs(o: Record<string, string | number | boolean | null | undefined>): string {
  let out = '';
  for (const [k, raw] of Object.entries(o)) {
    const v = raw === null || raw === undefined ? '' : String(raw);
    if (/[\r\n]/.test(v)) {
      let d = 'VES_EOF';
      while (v.includes(d)) d += '_';
      out += `${k}<<${d}\n${v}\n${d}\n`;
    } else out += `${k}=${v}\n`;
  }
  return out;
}

/** `export KEY='value'` lines (GitLab: `source ves.env`). Single quotes are closed, escaped and reopened. */
export function shellExports(o: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(o).map(([k, raw]) => `export ${k}='${(raw === null || raw === undefined ? '' : String(raw)).replace(/'/g, `'\\''`)}'`).join('\n') + '\n';
}

/** Parses one or more concatenated JSON values (`gh api --paginate` prints `[...][...]`). */
export function parseJsonStream(s: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    const start = i;
    if (s[i] === '[' || s[i] === '{') {
      let depth = 0, inStr = false;
      for (; i < n; i++) {
        const ch = s[i];
        if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { i++; break; } }
      }
    } else { while (i < n && !/\s/.test(s[i])) i++; }
    out.push(JSON.parse(s.slice(start, i)));
  }
  return out;
}

/** The last JSON object line of a text (`ves run --json` prints one line; tolerate stray log lines). */
export function lastJsonLine(s: string): Record<string, unknown> | null {
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* keep looking */ } }
  return null;
}

export async function git(exec: ExecLike, cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await exec('git', args, { cwd });
  return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

export const tempRoot = (env: Env): string => env.RUNNER_TEMP ?? env.TMPDIR?.replace(/\/$/, '') ?? '/tmp';
export const contextFile = (env: Env): string => join(tempRoot(env), 'ves-context.json');

/** What `ves ci context` decided, persisted so later steps (baseline, comment) agree with it. */
export type CiContext = {
  provider: 'github' | 'gitlab' | 'local';
  event: string; trigger: string; tier: Tier; change_class: number; change_reasons: string[];
  base_sha: string; head_sha: string; base_ref: string; suite_from: 'base' | 'head'; suite_root: string; head_root: string; base_worktree: string;
  is_fork: boolean; first_run: boolean; harness_sha: string; config: string; working_directory: string;
  new_cases: string[]; new_case_files: string[]; project: string; repo: string; pr_number: number | null; warnings: string[];
  /** PR whose git context could not be established (fail closed: class >= 2, never REPORT_ONLY). */
  degraded?: string[];
};
export function readContext(env: Env, file?: string): CiContext | null {
  const f = file ?? contextFile(env);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')) as CiContext; } catch { return null; }
}

/** A run directory is one with run.json and gate.json. Finds them up to `depth` levels below `dir` (artifact layouts). */
export function findRunDirs(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    if (!existsSync(d) || !statSync(d).isDirectory()) return;
    if (existsSync(join(d, 'run.json')) && existsSync(join(d, 'gate.json'))) { out.push(d); return; }
    if (left <= 0) return;
    for (const n of readdirSync(d).sort()) if (!n.startsWith('.')) walk(join(d, n), left - 1);
  };
  walk(dir, depth);
  return out;
}

export const readJson = <T = any>(f: string): T | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as T; } catch { return null; } };

/** Minimal GitHub/GitLab REST client over the injected fetch (fallback when `gh` is unavailable, and GitLab). */
export async function httpJson(fetch: FetchLike, method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: any; text: string; headers: { get(n: string): string | null } }> {
  const r = await fetch(url, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text, headers: r.headers };
}

/** Writes a line to stderr (human text) */
export const say = (deps: Pick<CliDeps, 'stderr'>, s: string): void => deps.stderr(s.endsWith('\n') ? s : s + '\n');
