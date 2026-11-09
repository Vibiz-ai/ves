// `ves packs list|show|expand` and `ves catalog suggest|import` (DESIGN-agnostic §5.6), and `ves migrate` (§3.6).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadConfig } from '../config/load.ts';
import { buildCatalog } from '../catalog/catalog.ts';
import { suggestClasses } from '../catalog/suggest.ts';
import { loadIntents } from '../cases/intents.ts';
import { expandPack, describeSelector } from '../cases/expand.ts';
import { loadCases } from '../runner/load.ts';
import { migrateCase1 } from '../cases/migrate-v1.ts';
import { loadPacks } from '../registry/packs.ts';
import { slug } from '../runner/run.ts';
import { VIBIZ_PROFILE } from '../adapters/profiles.ts';
import { type Args, CliUsage, list, str } from './args.ts';
import { realExec } from './io.ts';
import { createModelsApi } from '../registry/models.ts';
import { intentKey } from '../cases/intents.ts';
import type { Catalog, ExecLike, FetchLike, IntentsLock, ResolvedConfig } from '../core/types.ts';

const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));

export async function cmdPacks(a: Args, root: string, env: Record<string, string | undefined>): Promise<number> {
  const sub = a._[0] ?? 'list';
  const cfgPath = resolve(str(a.config) ?? 'ves.config.json');
  const cfg = existsSync(cfgPath) ? loadConfig(cfgPath, env) : null;
  const { packs, errors } = await loadPacks({ harnessRoot: root, repoDir: cfg?.dir });
  for (const e of errors) process.stderr.write(`WARN  ${e}\n`);
  const catalog = cfg ? buildCatalog(cfg.tools.catalog, { gate_classes: cfg.tools.gate_classes }).catalog : null;
  const intents = cfg ? loadIntents(cfg.intents_path) : null;
  if (sub === 'list') {
    const rows = packs.map((p) => {
      const needs = [...(p.manifest.requires?.tools ?? []).map((s) => `${describeSelector(s)}${(s.min ?? 1) > 1 ? `≥${s.min}` : ''}`), ...(p.manifest.requires?.variant_roles_any ?? []).map((r) => `variant role=${r}`), ...(p.manifest.requires?.profile ? [`profile ${p.manifest.requires.profile}`] : [])].join('+') || '—';
      let on = 'no ves.config.json here';
      if (cfg && catalog && intents) {
        const always = cfg.packs.some((x) => x.id === p.manifest.id);
        const tiers = (['smoke', 'release', 'research'] as const).filter((t) => always || (cfg.tiers[t].packs ?? []).includes(p.manifest.id));
        const r = expandPack(p, { catalog, config: cfg, intents }, cfg.packs.find((x) => x.id === p.manifest.id)?.options ?? {});
        const bound = [...new Set(r.cases.flatMap((c) => Object.values(c.provenance.pack?.bindings ?? {})))];
        on = r.skipped ? `skipped: ${r.skipped}` : r.errors.length ? `ERROR: ${r.errors[0]}` : `${r.cases.length} cases${bound.length && bound.length <= 3 ? ` (${bound.join(', ')})` : ''}${r.lowRealism ? `, ${r.lowRealism} low-realism intents` : ''}`;
        if (!r.skipped && !r.errors.length) on += tiers.length === 3 ? ' · enabled' : tiers.length ? ` · enabled at ${tiers.join('+')}` : ' · not enabled in ves.config.json';
      }
      return { id: p.manifest.id, version: p.manifest.version, suite: p.manifest.suite ?? '—', needs, on };
    });
    if (a.json === true) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return 0; }
    process.stdout.write(`${pad('id', 18)}${pad('version', 9)}${pad('suite', 12)}${pad('needs', 28)}on your catalog\n`);
    for (const r of rows) process.stdout.write(`${pad(r.id, 18)}${pad(r.version, 9)}${pad(r.suite, 12)}${pad(r.needs, 28)}${r.on}\n`);
    return 0;
  }
  if (sub === 'synthesize') {
    if (!cfg || !catalog || !intents) throw new CliUsage('ves packs synthesize needs a ves.config.json (the catalog to write intents for)');
    return cmdSynthesize(a, cfg, catalog, intents, env, { fetch: globalThis.fetch as never, exec: realExec });
  }
  const id = a._[1];
  const p = packs.find((x) => x.manifest.id === id);
  if (!p) throw new CliUsage(`usage: ves packs ${sub} <id> (known: ${packs.map((x) => x.manifest.id).join(', ')})`);
  if (sub === 'show') {
    const readme = join(p.dir, 'README.md');
    process.stdout.write(`${JSON.stringify(p.manifest, null, 2)}\n\n${existsSync(readme) ? readFileSync(readme, 'utf8') : '(no README.md)'}\n\ntemplates: ${p.templates.map((t) => t.t.template).join(', ') || 'none'}\n`);
    return 0;
  }
  if (sub === 'expand') {
    if (!cfg || !catalog || !intents) throw new CliUsage('ves packs expand needs a ves.config.json (the catalog to expand over)');
    const r = expandPack(p, { catalog, config: cfg, intents }, cfg.packs.find((x) => x.id === id)?.options ?? {});
    if (r.errors.length) { for (const e of r.errors) process.stderr.write(`ERROR ${e}\n`); return 3; }
    const out = str(a.out);
    if (out) { mkdirSync(out, { recursive: true }); for (const c of r.cases) writeFileSync(join(out, `${slug(c.id)}.case.json`), JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('__'))), null, 2) + '\n'); }
    process.stdout.write(`${r.skipped ? `skipped: ${r.skipped}` : `${r.cases.length} case(s)${out ? ` written to ${out}` : ''}`}\n`);
    for (const s of r.skippedBindings) process.stderr.write(`WARN  ${s}\n`);
    if (!out) for (const c of r.cases) process.stdout.write(`  ${c.id}\n`);
    return 0;
  }
  throw new CliUsage('usage: ves packs list|show <id>|expand <id> [--out dir]|synthesize [--tools a,b] [--n 3] [--yes]');
}

export async function cmdCatalog(a: Args, _root: string, env: Record<string, string | undefined>): Promise<number> {
  const sub = a._[0] ?? 'suggest';
  const cfgPath = resolve(str(a.config) ?? 'ves.config.json');
  const cfg = existsSync(cfgPath) ? loadConfig(cfgPath, env) : null;
  if (sub === 'suggest' && !a.from) {
    if (!cfg) throw new CliUsage('ves catalog suggest needs a ves.config.json or --from openai-tools <file>');
    process.stdout.write(`${pad('tool', 28)}${pad('suggested classes', 28)}${pad('gated', 7)}why\n`);
    for (const e of cfg.tools.catalog) { const s = suggestClasses(e); process.stdout.write(`${pad(e.name, 28)}${pad(s.classes.join(','), 28)}${pad(s.gated_by_default ? 'yes' : 'no', 7)}${s.why.join('; ')}${e.review === 'confirmed' ? ' (you confirmed: ' + e.classes.join(',') + ')' : ''}\n`); }
    return 0;
  }
  if (sub === 'import' || sub === 'suggest') {
    // merges into ves.config.json (dogfood fix 2026-11-07: it used to print only); --from agent|bridge|mcp|http
    // handshakes the configured connection, so tool import no longer needs `ves init` or a running init
    const { cmdCatalogImport } = await import('./doctor.ts');
    const { realSpawn } = await import('./io.ts');
    return cmdCatalogImport(a, { fetch: globalThis.fetch as never, spawn: realSpawn, env, now: () => new Date(), harnessRoot: _root, out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) });
  }
  throw new CliUsage('usage: ves catalog suggest | import --from agent|bridge|mcp|http|openai-tools [<file>] [--print]');
}

export async function cmdMigrate(a: Args, root: string): Promise<number> {
  const dir = a._[0];
  if (!dir || str(a.to) !== '2' || str(a.profile) !== 'vibiz') throw new CliUsage('usage: ves migrate <dir> --to 2 --profile vibiz [--out <dir>]   (explicit only; v1 files keep loading without it)');
  const { cases, errors } = loadCases(root, [resolve(dir)]);
  if (errors.length) { for (const e of errors) process.stderr.write(`ERROR ${e}\n`); return 3; }
  const out = resolve(str(a.out) ?? `${resolve(dir)}-v2`);
  for (const c of cases) {
    const m = migrateCase1(c, VIBIZ_PROFILE);
    const rel = relative(resolve(dir), join(root, c.__file));
    mkdirSync(join(out, rel, '..'), { recursive: true });
    writeFileSync(join(out, rel), JSON.stringify(m, null, 2) + '\n');
  }
  process.stdout.write(`${cases.length} case(s) written to ${out} as ves-case/2 (fixture paths are relative to packs/vibiz)\n`);
  return 0;
}

/**
 * `ves packs synthesize [--tools a,b] [--n 3] [--budget 1] [--yes]` (DESIGN-agnostic §5.6): realistic requests + args
 * per tool through models.intent_writer (Vertex Gemini by default), written to ves.intents.json, which is committed and
 * reviewed like code so CI never calls a model to build cases. It prints the worst-case cost first and calls the model
 * only with --yes. Generated args that fail the tool's input_schema are dropped by the writer.
 */
export async function cmdSynthesize(a: Args, cfg: ResolvedConfig, catalog: Catalog, intents: IntentsLock, env: Record<string, string | undefined>, deps: { fetch: FetchLike; exec: ExecLike }): Promise<number> {
  const n = Number(str(a.n) ?? 3);
  const budget = Number(str(a.budget) ?? 1);
  const want = list(a.tools);
  const tools = catalog.tools.filter((t) => (want.length ? want.includes(t.name) : !t.examples?.length && !intents.entries[intentKey(t)]?.length));
  if (!tools.length) { process.stderr.write('nothing to synthesize: every tool has catalog examples or an intent (use --tools a,b to redo some)\n'); return 0; }
  const { api, installed } = await createModelsApi(cfg.models, { fetch: deps.fetch, exec: deps.exec, env, now: () => new Date(), cacheDir: join(cfg.dir, '.ves-cache', 'models'), budget: { pool: 'research', usd_cap: budget } });
  if (!installed) throw new CliUsage('ves packs synthesize needs the models package (src/models)');
  const ext = api as typeof api & { estimate?: (ref: string, req: unknown, purpose: string) => number; resolve?: (ref: string) => { provider: string; model: string } };
  const ref = ext.resolve?.('intent_writer');
  const est = tools.reduce((s, t) => s + (ext.estimate?.('intent_writer', { messages: [{ role: 'user', content: JSON.stringify(t.input_schema) + (t.description ?? '') }], max_tokens: 4096 }, 'intent_writer') ?? 0), 0);
  process.stderr.write(`intent writer: ${ref ? `${ref.provider} ${ref.model}` : 'models.intent_writer'}; ${tools.length} tool(s) x ${n}; worst case $${est.toFixed(4)} list (cap $${budget})\n`);
  if (a.yes !== true) { process.stderr.write(`dry run: re-run with --yes to call the model and write ${relative(process.cwd(), cfg.intents_path) || cfg.intents_path}\n`); return 0; }
  const out: IntentsLock = { schema_version: 'ves-intents/1', entries: { ...intents.entries } };
  const writer = api.intentWriter();
  for (const t of tools) {
    const got = await writer.write(t, n, 1);
    process.stderr.write(`  ${t.name}: ${got.length} intent(s)\n`);
    if (got.length) out.entries[intentKey(t)] = got;
  }
  writeFileSync(cfg.intents_path, JSON.stringify(out, null, 2) + '\n');
  const l = api.ledger();
  process.stderr.write(`wrote ${cfg.intents_path} (${l.calls} call(s), $${l.usd_list.toFixed(4)} list, cache hits ${(l.cache_hit_ratio * 100).toFixed(0)}%). Review it like code and commit it.\n`);
  return 0;
}
