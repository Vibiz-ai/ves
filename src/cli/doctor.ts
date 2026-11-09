// `ves doctor` and `ves catalog import --from agent|bridge|mcp|openai-tools` (DESIGN-agnostic §5.6, §5.7).
// doctor: for each variant's connection, health() then info(): is the agent reachable, what did it declare, does the
// catalog cover it. catalog import: the same handshake (or an OpenAI tools file), class suggestions, and a MERGE into
// ves.config.json tools.catalog (existing entries are kept as they are; new ones get review: "suggested").
// `--print` prints the merged catalog instead of writing it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/load.ts';
import { buildCatalog } from '../catalog/catalog.ts';
import { suggestCatalog, suggestClasses } from '../catalog/suggest.ts';
import { createConnector, loadConnectors } from '../registry/connectors.ts';
import type { CatalogEntry, ConnectionConfig, FetchLike, ModelsApi, SpawnLike, ToolSpec } from '../core/types.ts';
import { type Args, CliUsage, str } from './args.ts';

export type DoctorDeps = { fetch: FetchLike; spawn: SpawnLike; env: Record<string, string | undefined>; now: () => Date; harnessRoot: string; out: (s: string) => void; err: (s: string) => void; timeoutMs?: number };
type Declared = { name: string; description?: string; input_schema?: unknown; annotations?: CatalogEntry['annotations'] };
export type Handshake = { ok: boolean; note: string; name?: string; framework?: string; tools: Declared[] };

const NO_MODELS = new Proxy({}, { get: () => () => { throw new Error('models are not used by ves doctor'); } }) as unknown as ModelsApi;

/** health() + info() on one connection, with a timeout. Never throws: the note says what went wrong. */
export async function handshake(connection: ConnectionConfig, dir: string, deps: Pick<DoctorDeps, 'fetch' | 'spawn' | 'env' | 'now' | 'harnessRoot' | 'timeoutMs'>): Promise<Handshake> {
  const reg = await loadConnectors(deps.harnessRoot);
  if (!reg.factories.has(connection.type as never)) return { ok: false, note: `connector ${connection.type} not installed in this harness`, tools: [] };
  const { catalog } = buildCatalog([], {});
  let conn;
  try {
    conn = await createConnector(connection, { fetch: deps.fetch, spawn: deps.spawn, env: deps.env, now: deps.now, models: NO_MODELS, log: () => {}, repoRoot: dir, configDir: dir, variant: 'default', catalog }, reg);
  } catch (e) { return { ok: false, note: `could not create the ${connection.type} connector: ${(e as Error).message.split('\n')[0]}`, tools: [] }; }
  const timeout = deps.timeoutMs ?? 30000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async (): Promise<Handshake> => {
      const h = await conn.health();
      if (!h.ok) return { ok: false, note: `agent not healthy (${[h.reason, h.detail].filter(Boolean).join(': ') || 'no detail'})`, tools: [] };
      const info = await conn.info();
      const tools = (info.declaredTools ?? []) as Declared[];
      return { ok: true, note: `handshake ok (${info.name}${info.framework ? `, ${info.framework}` : ''}); ${tools.length} tool(s) declared`, name: info.name, framework: info.framework, tools };
    })();
    return await Promise.race([work, new Promise<Handshake>((res) => { timer = setTimeout(() => res({ ok: false, note: `no handshake within ${timeout / 1000}s`, tools: [] }), timeout); })]);
  } catch (e) {
    return { ok: false, note: `handshake failed: ${(e as Error).message.split('\n')[0]}`, tools: [] };
  } finally {
    if (timer) clearTimeout(timer);
    await conn.dispose?.().catch(() => {});
  }
}

const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));
export function suggestionTable(catalog: CatalogEntry[]): string {
  const rows = catalog.map((t) => { const s = suggestClasses(t); return `  ${pad(t.name, 28)}${pad(t.classes.join(','), 26)}${pad(String(t.gated ?? s.gated_by_default), 7)}${t.review === 'confirmed' ? 'confirmed by you' : s.why.join('; ')}`; });
  return [`  ${pad('tool', 28)}${pad('classes', 26)}${pad('gated', 7)}why`, ...rows].join('\n');
}

export async function cmdDoctor(a: Args, deps: DoctorDeps): Promise<number> {
  const cfgPath = resolve(str(a.config) ?? 'ves.config.json');
  const cfg = loadConfig(cfgPath, deps.env);
  let bad = 0;
  for (const v of Object.values(cfg.variants)) {
    const h = await handshake(v.connection, cfg.dir, deps);
    deps.out(`variant ${v.name} (${v.role}, ${v.connection.type}): ${h.note}\n`);
    if (!h.ok) { bad++; continue; }
    const have = new Set(cfg.tools.catalog.map((t) => t.name));
    const approvalTool = (v.connection as { approval?: { tool?: string } }).approval?.tool;
    const missing = h.tools.filter((t) => !have.has(t.name) && t.name !== approvalTool).map((t) => t.name);
    const unused = cfg.tools.catalog.filter((t) => h.tools.length && !h.tools.some((d) => d.name === t.name)).map((t) => t.name);
    if (missing.length) deps.out(`  not in tools.catalog: ${missing.join(', ')}  ->  ves catalog import --from agent\n`);
    if (unused.length) deps.out(`  in tools.catalog but not declared by the agent: ${unused.join(', ')} (fine when the proxy serves them)\n`);
    const unreviewed = cfg.tools.catalog.filter((t) => t.review !== 'confirmed').map((t) => t.name);
    if (unreviewed.length) deps.out(`  classes not confirmed yet: ${unreviewed.join(', ')} (set review: "confirmed" after checking them)\n`);
  }
  return bad ? 2 : 0;
}

/** Tools from an OpenAI-style tools file ([{type:"function",function:{name,description,parameters}}] or plain entries). */
export function toolsFromOpenAIFile(file: string): Declared[] {
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const arr = (Array.isArray(raw) ? raw : raw?.tools ?? []) as any[];
  return arr.map((t) => (t?.type === 'function' ? { name: t.function.name, description: t.function.description, input_schema: t.function.parameters } : t));
}

export async function cmdCatalogImport(a: Args, deps: DoctorDeps): Promise<number> {
  const from = str(a.from);
  const cfgPath = resolve(str(a.config) ?? 'ves.config.json');
  const hasCfg = existsSync(cfgPath);
  let tools: Declared[];
  if (from === 'openai-tools') {
    const file = a._[1] ?? str(a.file);
    if (!file) throw new CliUsage('usage: ves catalog import --from openai-tools <file.json> [--print]');
    tools = toolsFromOpenAIFile(file);
  } else if (from === 'agent' || from === 'bridge' || from === 'mcp' || from === 'http') {
    if (!hasCfg) throw new CliUsage(`ves catalog import --from ${from} needs a ves.config.json with agent.connection (run \`ves init\`)`);
    const cfg = loadConfig(cfgPath, deps.env);
    const v = Object.values(cfg.variants).find((x) => (from === 'mcp' ? x.connection.type === 'mcp' : from === 'bridge' ? x.connection.type === 'command' : from === 'http' ? x.connection.type === 'http' : true));
    if (!v) throw new CliUsage(`no variant has a ${from} connection in ${cfgPath}`);
    const h = await handshake(v.connection, cfg.dir, deps);
    deps.err(`variant ${v.name} (${v.connection.type}): ${h.note}\n`);
    if (!h.ok) return 2;
    const approvalTool = (v.connection as { approval?: { tool?: string } }).approval?.tool;
    tools = h.tools.filter((t) => t.name !== approvalTool);
    if (!tools.length) { deps.err('the agent declared no tools: list them in tools.catalog by hand, or export them as an OpenAI tools file and use --from openai-tools\n'); return 3; }
  } else throw new CliUsage('usage: ves catalog import --from agent|bridge|mcp|http|openai-tools [<file.json>] [--print] [--config ves.config.json]');

  const raw = hasCfg ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null;
  const existing: CatalogEntry[] = raw?.tools?.catalog ?? [];
  const merged = suggestCatalog(tools as ToolSpec[] as never, existing);
  const added = merged.slice(existing.length);
  if (a.print === true || !raw) {
    deps.out(JSON.stringify(merged, null, 2) + '\n');
    if (!raw) deps.err(`no ${cfgPath}: printed only (run \`ves init\` first to write it into a config)\n`);
  } else {
    raw.tools = { ...(raw.tools ?? {}), catalog: merged };
    writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    deps.err(`${cfgPath}: ${added.length} tool(s) added to tools.catalog${existing.length ? `, ${existing.length} existing entr${existing.length === 1 ? 'y' : 'ies'} kept as they are` : ''}\n`);
  }
  deps.err(suggestionTable(added.length ? added : merged) + '\n');
  deps.err('Review the classes (a wrong class is a false BLOCK or a missed check), then set review: "confirmed".\n');
  return 0;
}
