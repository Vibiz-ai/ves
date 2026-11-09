// Shared fakes for the connectors tests: in-memory child processes, a fetch that calls in-process handlers, a
// recording HarnessIO, and the support-desk config over core's skeleton cases. No network (test/setup.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../../src/config/load.ts';
import { buildCatalog } from '../../src/catalog/catalog.ts';
import { NO_MODELS } from '../../src/registry/models.ts';
import { mockFactory } from '../../src/core/mock-agent.ts';
import { AsyncQueue } from '../../src/connectors/_shared/queue.ts';
import commandFactory from '../../src/connectors/command/index.ts';
import httpFactory from '../../src/connectors/http/index.ts';
import openaiFactory from '../../src/connectors/openai-chat/index.ts';
import mcpFactory from '../../src/connectors/mcp/index.ts';
import traceFactory from '../../src/connectors/trace/index.ts';
import type { ConnectorRegistry } from '../../src/registry/connectors.ts';
import type {
  AgentToHarness, Catalog, ChildLike, ConnectorDeps, ConnectorFactory, FetchLike, HarnessIO, ResolvedConfig, SessionOpen, SpawnLike, ToolSpec, VesConfig,
} from '../../src/core/types.ts';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const CORE_FIX = join(ROOT, 'test', 'core', 'fixtures');
export const SCRIPT = JSON.parse(readFileSync(join(ROOT, 'examples', 'reference-agent', 'support-desk.script.json'), 'utf8'));

export const registry = (...extra: ConnectorFactory[]): ConnectorRegistry => {
  const all = [mockFactory, commandFactory, httpFactory, openaiFactory, mcpFactory, traceFactory, ...extra];
  return { factories: new Map(all.map((f) => [f.kind, f])), sources: {} };
};

/** support-desk.json (core's public sample) over core's 6 skeleton cases, with a given connection. */
export function supportDesk(mut: (c: any) => void = () => {}): ResolvedConfig {
  const dir = join(CORE_FIX, 'catalogs');
  const c = JSON.parse(readFileSync(join(dir, 'support-desk.json'), 'utf8')) as VesConfig;
  (c as any).suites = ['../skeleton-cases'];
  c.agent.model = 'fake-llm';
  mut(c);
  const r = resolveConfig(c, { dir, env: {} });
  assert.deepEqual(r.errors, []);
  return r.config;
}
export const catalogOf = (cfg: ResolvedConfig): Catalog => buildCatalog(cfg.tools.catalog, { gate_classes: cfg.tools.gate_classes }).catalog;
export const toolSpecs = (cat: Catalog): ToolSpec[] => cat.tools.map((t) => ({ name: t.name, input_schema: t.input_schema, classes: [...t.classes], gated: t.gated, ...(t.description ? { description: t.description } : {}) }));

export function deps(o: Partial<ConnectorDeps> & { catalog?: Catalog } = {}): ConnectorDeps {
  return {
    fetch: (() => { throw new Error('no fetch in this test'); }) as unknown as FetchLike,
    spawn: (() => { throw new Error('no spawn in this test'); }) as unknown as SpawnLike,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, now: () => new Date('2026-11-07T12:00:00Z'), models: NO_MODELS, log: () => {},
    repoRoot: ROOT, configDir: ROOT, variant: 'default', catalog: o.catalog ?? catalogOf(supportDesk()), ...o,
  };
}

// ------------------------------------------------------------------------------------------ fake processes
/** A child process whose "program" is a function receiving stdin lines and writing stdout lines. */
export type FakeProgram = (io: { stdin: AsyncQueue<string>; out: (line: string) => void; err: (s: string) => void; exit: (code: number) => void; argv: string[]; env: Record<string, string> }) => void | Promise<void>;
export function fakeSpawn(program: FakeProgram, seen: { cmd?: string; args?: string[]; env?: Record<string, string>; spawns: number; stdin: string[] } = { spawns: 0, stdin: [] }): SpawnLike & { seen: typeof seen } {
  const f = ((cmd: string, args: string[], o: { cwd: string; env: Record<string, string> }): ChildLike => {
    seen.cmd = cmd; seen.args = args; seen.env = o.env; seen.spawns++;
    const stdin = new AsyncQueue<string>();
    const stdout = new AsyncQueue<string>();
    const stderr = new AsyncQueue<string>();
    let done!: (x: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { done = r; });
    let alive = true;
    const exit = (code: number, signal: string | null = null) => { if (!alive) return; alive = false; stdin.close(); setImmediate(() => { stdout.close(); stderr.close(); done({ code, signal }); }); };
    const iter = (q: AsyncQueue<string>): AsyncIterable<string> => ({ async *[Symbol.asyncIterator]() { for (;;) { const v = await q.next(); if (v === null) return; yield v; } } });
    void Promise.resolve(program({ stdin, out: (l) => { if (alive) stdout.push(l.endsWith('\n') ? l : l + '\n'); }, err: (s) => stderr.push(s), exit: (c) => exit(c), argv: args, env: o.env }));
    return {
      stdin: { write: (s: string) => { if (!alive) return false; for (const l of s.split('\n').filter(Boolean)) { seen.stdin.push(l); stdin.push(l); } return true; }, end: () => { stdin.close(); exit(0); } }, // a well-behaved process exits on EOF
      stdout: iter(stdout), stderr: iter(stderr), kill: (sig?: string) => exit(143, sig ?? 'SIGTERM'), exited,
    };
  }) as SpawnLike & { seen: typeof seen };
  f.seen = seen;
  return f;
}
/** Read the next parsed stdin message of a fake program. */
export async function nextMsg(q: AsyncQueue<string>): Promise<any | null> { const l = await q.next(); return l === null ? null : JSON.parse(l); }

// ------------------------------------------------------------------------------------------ fake fetch
export type Handler = (method: string, path: string, body: string, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
/** A FetchLike that serves `base` from an in-process handler, recording every request. */
export function fetchFrom(routes: Record<string, Handler>, log: { method: string; url: string; body?: string; headers: Record<string, string> }[] = []): FetchLike & { log: typeof log } {
  const f = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    log.push({ method: init.method, url, ...(init.body !== undefined ? { body: init.body } : {}), headers: init.headers });
    const base = Object.keys(routes).find((b) => url.startsWith(b));
    if (!base) throw new Error(`fake fetch: no route for ${url}`);
    const r = await routes[base](init.method, url.slice(base.length) || '/', init.body ?? '', init.headers);
    const h = new Map(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: async () => r.body };
  }) as FetchLike & { log: typeof log };
  f.log = log;
  return f;
}

// ------------------------------------------------------------------------------------------ fake HarnessIO
export type Recorded = { calls: { name: string; args: Record<string, unknown>; transport: string }[]; reports: { ev: AgentToHarness; level?: string }[] };
export function recordingIO(exec: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string; details?: unknown }> = async (name) => ({ ok: true, result: { ok: true, tool: name } })): HarnessIO & { rec: Recorded } {
  const rec: Recorded = { calls: [], reports: [] };
  return {
    rec,
    callTool: async (c) => { rec.calls.push({ name: c.name, args: c.args, transport: c.transport }); return exec(c.name, c.args); },
    report: (ev, level) => { rec.reports.push({ ev, ...(level ? { level } : {}) }); },
    toolTransport: () => ({ pipe: true }),
  };
}
export const sessionOpen = (tools: ToolSpec[], o: Partial<SessionOpen> = {}): SessionOpen => ({
  type: 'session.open', v: 1, session_id: o.session_id ?? 'S1', case_id: 'c', trial: 0, seed: 1, clock: '2026-01-05T09:00:00.000Z', variant: 'default',
  principal: { role: 'owner', id: 'u_owner' }, tools, tool_transport: { pipe: true }, ...o,
});
