// A real `SpawnLike` over node:child_process, for CLI runs and for tests that spawn a LOCAL child (allowed: a pipe to
// a child is not network). The runner injects `deps.spawn`; when a caller did not inject one (the runner's default
// throws "no spawn injected"), connectors fall back to this.
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildLike, SpawnLike } from '../../core/types.ts';

export const realSpawn: SpawnLike = (cmd, args, o): ChildLike => {
  const c = nodeSpawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  c.stdout.setEncoding('utf8');
  c.stderr.setEncoding('utf8');
  let spawnError: Error | null = null;
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
    c.on('error', (e) => { spawnError = e; res({ code: 127, signal: null }); });
    c.on('close', (code, signal) => res({ code, signal }));
  });
  c.stdin.on('error', () => { /* EPIPE after the child exited; the exit is reported through `exited` */ });
  return {
    stdin: { write: (s: string) => { if (c.stdin.destroyed || !c.stdin.writable) return false; return c.stdin.write(s); }, end: () => { try { c.stdin.end(); } catch { /* already closed */ } } },
    stdout: c.stdout as AsyncIterable<string>,
    stderr: c.stderr as AsyncIterable<string>,
    kill: (sig?: string) => { try { c.kill((sig ?? 'SIGTERM') as NodeJS.Signals); } catch { /* gone */ } },
    exited: exited.then((x) => (spawnError ? { code: 127, signal: `spawn error: ${(spawnError as Error).message}` } : x)),
  };
};

/** Use the injected spawn; fall back to the real one only when the runner's "not injected" stub is in place. */
export function spawnWithFallback(injected: SpawnLike | undefined, log?: (l: 'debug', m: string) => void): SpawnLike {
  if (!injected) return realSpawn;
  return (cmd, args, o) => {
    try { return injected(cmd, args, o); } catch (e) {
      if (/no spawn injected/.test((e as Error).message)) { log?.('debug', 'no spawn injected; using node:child_process'); return realSpawn(cmd, args, o); }
      throw e;
    }
  };
}
