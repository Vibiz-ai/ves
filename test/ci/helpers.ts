// Shared fakes for the ci package tests: CliDeps with injected exec / fetch / spawn and captured output.
// No network, no real gh/git: every external call is a scripted fake.
import { cpSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliDeps, ExecLike, FetchLike } from '../../src/core/types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIX = join(ROOT, 'test', 'ci', 'fixtures');
export const RUNS = { pass: runDir('pass'), block: runDir('block') };
function runDir(k: string): string { const d = join(FIX, 'runs', k); return join(d, readdirSync(d).find((n) => n.startsWith('ves-'))!); }

/** Per-test temp dirs inside the package (work stays inside the harness checkout); removed by cleanup(). */
const TMP_ROOT = join(ROOT, 'test', 'ci', '.tmp');
const TMP = join(TMP_ROOT, String(process.pid));   // test files run in parallel processes: each cleans only its own
export function tmpDir(name: string): string {
  const d = join(TMP, `${name}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  return d;
}
export function copyFixture(src: string, name: string): string { const d = tmpDir(name); cpSync(src, d, { recursive: true }); return d; }
export function cleanup(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  try { rmdirSync(TMP_ROOT); } catch { /* another test process still uses it */ }
}

export type ExecCall = { cmd: string; args: string[]; cwd?: string; env?: Record<string, string>; input?: string };
export type ExecHandler = (c: ExecCall) => { code?: number; stdout?: string; stderr?: string } | undefined;
export function fakeExec(h: ExecHandler): { exec: ExecLike; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecLike = async (cmd, args, o) => {
    const c = { cmd, args, cwd: o?.cwd, env: o?.env, input: o?.input };
    calls.push(c);
    const r = h(c) ?? { code: 127, stderr: `fake exec: unexpected ${cmd} ${args.join(' ')}` };
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}

export type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: string };
export function fakeFetch(h: (c: FetchCall) => { status?: number; json?: unknown; text?: string }): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    const r = h(c);
    const text = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json));
    return { status: r.status ?? 200, headers: { get: () => null }, text: async () => text, body: null };
  };
  return { fetch, calls };
}

export function deps(o: { cwd?: string; env?: Record<string, string | undefined>; exec?: ExecLike; fetch?: FetchLike; now?: Date } = {}): CliDeps & { out: string[]; err: string[] } {
  const out: string[] = [], err: string[] = [];
  const never = (what: string) => () => { throw new Error(`test: unexpected ${what}`); };
  return {
    cwd: o.cwd ?? ROOT, env: o.env ?? {}, stdout: (s) => { out.push(s); }, stderr: (s) => { err.push(s); },
    fetch: o.fetch ?? (never('fetch') as unknown as FetchLike), spawn: never('spawn') as never, exec: o.exec ?? fakeExec(() => ({ code: 1, stderr: 'not a git repo' })).exec,
    harnessRoot: ROOT, now: () => o.now ?? new Date('2026-11-07T10:00:00Z'), out, err,
  };
}

/** Parses `key=value` / heredoc lines as GitHub does for $GITHUB_OUTPUT. */
export function parseGithubOutput(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(l);
    if (h) { const buf: string[] = []; i++; while (i < lines.length && lines[i] !== h[2]) buf.push(lines[i++]); out[h[1]] = buf.join('\n'); continue; }
    const k = l.indexOf('=');
    if (k > 0) out[l.slice(0, k)] = l.slice(k + 1);
  }
  return out;
}
export function parseExports(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/^export ([A-Z0-9_]+)='((?:[^']|'\\'')*)'$/gm)) out[m[1]] = m[2].replace(/'\\''/g, "'");
  return out;
}
