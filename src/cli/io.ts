// Real process I/O for the CLI (never used by tests, which inject fakes): exec for one-shot commands (gcloud ADC,
// git, gh) and spawn for long-lived agent / MCP server processes. Passed explicitly into runs and ci commands.
import { execFile, spawn } from 'node:child_process';
import type { ChildLike, ExecLike, SpawnLike } from '../core/types.ts';

export const realExec: ExecLike = (cmd, args, o) => new Promise((res) => {
  const p = execFile(cmd, args, { cwd: o?.cwd, env: o?.env ? { ...process.env, ...o.env } : process.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
    res({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  if (o?.input !== undefined) { p.stdin?.write(o.input); p.stdin?.end(); }
});
/** Robust against ENOENT (a missing interpreter is exit 127 with the reason, not an unhandled error) and EPIPE. */
export const realSpawn: SpawnLike = (cmd, args, o): ChildLike => {
  const c = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  c.stdout.setEncoding('utf8');
  c.stderr.setEncoding('utf8');
  let spawnError: Error | null = null;
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
    c.on('error', (e) => { spawnError = e; res({ code: 127, signal: null }); });
    c.on('close', (code, signal) => res({ code, signal }));
  });
  c.stdin.on('error', () => { /* EPIPE after the child exited; reported through `exited` */ });
  return {
    stdin: { write: (s: string) => (c.stdin.destroyed || !c.stdin.writable ? false : c.stdin.write(s)), end: () => { try { c.stdin.end(); } catch { /* closed */ } } },
    stdout: c.stdout as AsyncIterable<string>, stderr: c.stderr as AsyncIterable<string>,
    kill: (sig?: string) => { try { c.kill((sig ?? 'SIGTERM') as NodeJS.Signals); } catch { /* gone */ } },
    exited: exited.then((x) => (spawnError ? { code: 127, signal: `spawn error: ${(spawnError as Error).message}` } : x)),
  };
};
