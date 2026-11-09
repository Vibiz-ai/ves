// `ves init` (ci package, DESIGN-agnostic §5.1): detect the framework, write ves.config.json, the bridge, an example
// case, the fixture state and the CI workflow, then (optionally) handshake the agent to import its tools and run the
// offline check. Never overwrites a file without --force; --dry-run prints every file instead of writing it.
//
//   ves init [--framework <id>] [--connection command|http|openai-chat|mcp|trace] [--ci github|gitlab|none]
//            [--packs a,b] [--yes] [--dry-run] [--force] [--dir <repo>] [--action <owner/repo[/path]@sha>]
//            [--no-doctor] [--no-check] [--transport stdio|http] [--command "node server.mjs"]
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createConnector, loadConnectors, type ConnectorRegistry } from '../registry/connectors.ts';
import { buildCatalog } from '../catalog/catalog.ts';
import { suggestCatalog, suggestClasses } from '../catalog/suggest.ts';
import type { CatalogEntry, CliCommand, CliDeps, ConnectionKind, ExampleIndexEntry, ModelsApi } from '../core/types.ts';
import { list, parse, str } from './args.ts';
import { detectFramework, loadExampleIndex, pickByFlag, type Detection } from './init-detect.ts';
import {
  ACTION_PLACEHOLDER, AGENT_PACKS, bridgeSource, buildConfig, connectionFor, envPassthroughFor, EXAMPLE_PLACEHOLDER, exampleCase,
  githubWorkflow, gitlabSnippet, type InitPlan, MCP_PACKS, setupBase,
} from './init-templates.ts';
import { git, HEX40, lastJsonLine, say } from './ci-shared.ts';

export type InitHooks = { connectors?: ConnectorRegistry; doctorTimeoutMs?: number };
type FileOut = { path: string; content: string | null; copyFrom?: string; mode?: 'write' | 'append' };

const GENERIC_CONNECTIONS: Record<string, Record<string, unknown>> = {
  http: { type: 'http', base_url: 'http://127.0.0.1:8000' },
  'openai-chat': { type: 'openai-chat', base_url: 'http://127.0.0.1:4000/v1', model: 'agent' },
  mcp: { type: 'mcp', transport: 'stdio', command: ['node', 'server.js'], mode: 'contract' },
  trace: { type: 'trace', files: 'traces/*.jsonl', format: 'otel-genai' },
};

/** owner/repo[/subdir]@sha for the action `uses:` line, from the harness checkout's git remote (else a placeholder). */
export async function harnessPin(deps: Pick<CliDeps, 'exec' | 'harnessRoot'>): Promise<{ uses: string; gitlab: InitPlan['gitlab']; pinned: boolean }> {
  const placeholder = { uses: ACTION_PLACEHOLDER, gitlab: { repo: 'https://github.com/<org>/ves.git', ref: '<40-hex-sha>', subdir: '' }, pinned: false };
  const url = await git(deps.exec, deps.harnessRoot, ['remote', 'get-url', 'origin']);
  const sha = await git(deps.exec, deps.harnessRoot, ['rev-parse', 'HEAD']);
  const top = await git(deps.exec, deps.harnessRoot, ['rev-parse', '--show-toplevel']);
  if (!url.ok || !sha.ok || !HEX40.test(sha.out)) return placeholder;
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.out);
  const sub = top.ok ? relative(top.out, deps.harnessRoot).replace(/\\/g, '/') : '';
  const httpsUrl = url.out.startsWith('git@') ? url.out.replace(/^git@([^:]+):/, 'https://$1/') : url.out;
  const gitlab = { repo: httpsUrl, ref: sha.out, subdir: sub };
  if (!m) return { uses: ACTION_PLACEHOLDER, gitlab, pinned: false };
  return { uses: `${m[1]}/${m[2]}${sub ? `/${sub}` : ''}/integrations/github-action@${sha.out}`, gitlab, pinned: true };
}

function chooseEntry(a: Record<string, unknown>, det: Detection, entries: ExampleIndexEntry[], deps: CliDeps): ExampleIndexEntry | number {
  const ids = entries.map((x) => x.id).join(', ');
  const flag = str(a.framework);
  if (flag) {
    const e = pickByFlag(flag, entries, det.facts);
    if (!e) { say(deps, `ves init: unknown --framework ${flag}. Known: ${ids}`); return 3; }
    return e;
  }
  if (!det.best) { say(deps, `ves init: could not detect how your agent is built. Pass --framework <id> (one of: ${ids}).`); return 3; }
  if (det.ambiguous) {
    const top = det.candidates.filter((c) => c.score === det.best!.score);
    if (a.yes !== true) {
      say(deps, `ves init: more than one framework fits:\n${top.map((c) => `  ${c.entry.id.padEnd(24)} rank ${c.entry.rank}  ${c.signals.join('; ')}`).join('\n')}\nPass --framework <id>, or --yes to take the first ranked (${det.best.entry.id}).`);
      return 3;
    }
    say(deps, `ves init: ambiguous detection; --yes picked ${det.best.entry.id} (first ranked). Others: ${top.slice(1).map((c) => c.entry.id).join(', ')}`);
  }
  return det.best.entry;
}

const NO_MODELS = new Proxy({}, { get: () => () => { throw new Error('models are not used by ves init'); } }) as unknown as ModelsApi;

/** Step 3 (§5.1): handshake, import the declared tools, suggest classes (review: "suggested"). */
export async function doctor(plan: InitPlan, root: string, deps: CliDeps, hooks: InitHooks): Promise<{ catalog: CatalogEntry[]; note: string }> {
  const reg = hooks.connectors ?? (await loadConnectors(deps.harnessRoot));
  const kind = String(plan.connection.type) as ConnectionKind;
  if (!reg.factories.has(kind)) return { catalog: plan.catalog, note: `doctor skipped: connector ${kind} not installed in this harness` };
  const { catalog } = buildCatalog([], {});
  const conn = await createConnector(plan.connection as never, {
    fetch: deps.fetch, spawn: deps.spawn, env: deps.env, now: deps.now, models: NO_MODELS, log: () => {}, repoRoot: root, configDir: root, variant: 'default', catalog,
  }, reg);
  const timeout = hooks.doctorTimeoutMs ?? 30000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const h = await conn.health();
      if (!h.ok) return { catalog: plan.catalog, note: `doctor: agent not healthy (${[h.reason, h.detail].filter(Boolean).join(': ') || 'no detail'}); fix agent.connection, then \`ves doctor\` and \`ves catalog import --from agent\`` };
      const info = await conn.info();
      const tools = info.declaredTools ?? [];
      if (!tools.length) return { catalog: plan.catalog, note: `doctor: handshake ok (${info.name}${info.framework ? `, ${info.framework}` : ''}) but the agent declared no tools; add them to tools.catalog` };
      return { catalog: suggestCatalog(tools, plan.catalog), note: `doctor: handshake ok (${info.name}); imported ${tools.length} tool(s)` };
    })();
    return await Promise.race([work, new Promise<{ catalog: CatalogEntry[]; note: string }>((res) => { timer = setTimeout(() => res({ catalog: plan.catalog, note: `doctor: no handshake within ${timeout / 1000}s; run \`ves doctor\` once the agent starts` }), timeout); })]);
  } catch (e) {
    return { catalog: plan.catalog, note: `doctor failed: ${(e as Error).message.split('\n')[0]}` };
  } finally {
    if (timer) clearTimeout(timer);
    await conn.dispose?.().catch(() => {});
  }
}

export function suggestionTable(catalog: CatalogEntry[]): string {
  const rows = catalog.map((t) => {
    const s = suggestClasses(t);
    return `  ${t.name.padEnd(28)} ${t.classes.join(',').padEnd(26)} ${String(t.gated ?? s.gated_by_default).padEnd(6)} ${s.why.join('; ')}`;
  });
  return [`  ${'tool'.padEnd(28)} ${'suggested classes'.padEnd(26)} ${'gated'.padEnd(6)} why`, ...rows].join('\n');
}

function plannedFiles(plan: InitPlan, root: string, deps: CliDeps): { files: FileOut[]; notes: string[] } {
  const notes: string[] = [];
  const files: FileOut[] = [];
  const cfg = buildConfig(plan);
  files.push({ path: 'ves.config.json', content: JSON.stringify(cfg, null, 2) + '\n' });
  const br = bridgeSource(deps.harnessRoot, plan.entry);
  if (br) {
    // the plain bridges ship with a deterministic FakeLLM whose rules file lives in the harness's examples/fixtures;
    // copy it next to the bridge and point the bridge at it (dogfood fix 2026-11-07: the copied bridge crashed on
    // start with ENOENT because <repo>/fixtures/support-desk.fake-llm.json does not exist in a user's repo)
    const src = readFileSync(br.from, 'utf8');
    if (src.includes('support-desk.fake-llm.json')) {
      const fixed = src
        .replace(/os\.path\.join\(HERE, "\.\.", "fixtures", "support-desk\.fake-llm\.json"\)/, 'os.path.join(HERE, "fake-llm.json")')
        .replace(/new URL\('\.\.\/fixtures\/support-desk\.fake-llm\.json', import\.meta\.url\)/, "new URL('./fake-llm.json', import.meta.url)");
      files.push({ path: br.to, content: fixed });
      const rules = join(deps.harnessRoot, 'examples', 'fixtures', 'support-desk.fake-llm.json');
      if (existsSync(rules)) files.push({ path: 'ves/fake-llm.json', content: null, copyFrom: rules });
      notes.push(`${br.to} is a working starter agent with a deterministic FakeLLM (ves/fake-llm.json): replace FakeLLM with a call into your own agent loop; the protocol handling and the approval checks stay`);
    } else files.push({ path: br.to, content: null, copyFrom: br.from });
  }
  else if (plan.connection.type === 'command') notes.push(`no bridge for ${plan.entry.id} in this harness (examples/${plan.entry.id}/); write ves/bridge (ves-agent/1, see examples/README.md) or install the connectors package`);
  const ex = exampleCase(plan);
  files.push(ex ? { path: 'evals/cases/example.case.json', content: JSON.stringify(ex, null, 2) + '\n' } : { path: 'evals/cases/example.case.json.example', content: JSON.stringify(EXAMPLE_PLACEHOLDER, null, 2) + '\n' });
  if (!ex) notes.push('no read tool known yet: wrote evals/cases/example.case.json.example (rename it once the catalog is filled)');
  files.push({ path: 'evals/fixtures/state.json', content: '{}\n' });
  if (plan.ci === 'github') files.push({ path: '.github/workflows/ves.yml', content: githubWorkflow(plan) });
  if (plan.ci === 'gitlab') files.push({ path: 'ves.gitlab-ci.yml', content: gitlabSnippet(deps.harnessRoot, plan.gitlab) });
  if (plan.ci !== 'none') files.push({ path: 'ves/setup-base.sh', content: setupBase(plan) });
  const gi = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
  const missing = ['ves-results/', '.ves-cache/'].filter((l) => !gi.split('\n').map((x) => x.trim()).includes(l));
  if (missing.length) files.push({ path: '.gitignore', content: `${gi && !gi.endsWith('\n') ? '\n' : ''}# ves\n${missing.join('\n')}\n`, mode: 'append' });
  return { files, notes };
}

const INIT_FLAGS = new Set(['framework', 'connection', 'transport', 'command', 'ci', 'packs', 'yes', 'dry-run', 'force', 'dir', 'action', 'no-doctor', 'no-check', 'help']);

/** `python` when it runs, else `python3` (macOS ships only python3), else `python` (CI's setup-python provides it). */
async function pythonBin(deps: Pick<CliDeps, 'exec'>): Promise<string> {
  for (const bin of ['python', 'python3']) {
    try { const r = await deps.exec(bin, ['--version']); if (r.code === 0) return bin; } catch { /* not installed */ }
  }
  return 'python';
}

export async function runInit(argv: string[], deps: CliDeps, hooks: InitHooks = {}): Promise<number> {
  const a = parse(argv);
  // unknown flags are an error, not silently ignored (dogfood fix 2026-11-07; `--help` is handled by the CLI)
  const unknown = Object.keys(a).filter((k) => k !== '_' && !INIT_FLAGS.has(k));
  if (unknown.length || a._.length) { say(deps, `ves init: unknown option(s) ${[...unknown.map((k) => `--${k}`), ...a._].join(' ')}. See: ves init --help`); return 3; }
  const root = resolve(deps.cwd, str(a.dir) ?? '.');
  if (!existsSync(root)) { say(deps, `ves init: ${root} does not exist`); return 3; }
  const dry = a['dry-run'] === true, force = a.force === true;
  const ci = (str(a.ci) ?? 'github') as InitPlan['ci'];
  if (!['github', 'gitlab', 'none'].includes(ci)) { say(deps, '--ci must be github|gitlab|none'); return 3; }
  if (existsSync(join(root, 'ves.config.json')) && !force && !dry) {
    // Re-running init on an initialised repo is a no-op (like `git init`): exit 0, nothing touched.
    say(deps, `ves init: ${join(root, 'ves.config.json')} already exists; nothing written. Use --force to overwrite, or --dry-run to preview.`);
    return 0;
  }

  // 1. detect
  const { entries, source } = loadExampleIndex(deps.harnessRoot);
  const det = detectFramework(root, entries);
  const picked = chooseEntry(a, det, entries, deps);
  if (typeof picked === 'number') return picked;
  const entry = picked;
  let connection = connectionFor(entry, det.facts);
  const connFlag = str(a.connection);
  if (connFlag && connFlag !== connection.type) {
    if (connFlag === 'command') connection = { type: 'command', command: entry.language === 'python' ? ['python', 'ves/bridge.py'] : ['node', 'ves/bridge.mjs'] };
    else if (GENERIC_CONNECTIONS[connFlag]) connection = { ...GENERIC_CONNECTIONS[connFlag] };
    else { say(deps, `--connection must be command|http|openai-chat|mcp|trace`); return 3; }
  }
  const br = bridgeSource(deps.harnessRoot, entry);
  if (br && Array.isArray(connection.command)) connection.command = (connection.command as string[]).map((x) => (/^ves\/bridge\.[a-z]+$/.test(x) ? br.to : x));
  // MCP servers: --transport stdio|http and --command "<how to start it>" (dogfood fix 2026-11-07: a stdio Node
  // server could not be configured without hand edits)
  const transport = str(a.transport), command = str(a.command);
  if (transport && !['stdio', 'http'].includes(transport)) { say(deps, '--transport must be stdio|http'); return 3; }
  if ((transport || command) && connection.type !== 'mcp' && connection.type !== 'command') { say(deps, `--transport/--command apply to mcp and command connections, not ${connection.type}`); return 3; }
  if (transport === 'stdio') { delete connection.url; connection.transport = 'stdio'; }
  if (transport === 'http') { delete connection.command; connection.transport = 'http'; connection.url = connection.url ?? 'http://127.0.0.1:3100/mcp'; }
  if (command) connection.command = command.split(/\s+/).filter(Boolean);
  if (Array.isArray(connection.command) && (connection.command as string[])[0] === 'python') (connection.command as string[])[0] = await pythonBin(deps);
  const isMcp = connection.type === 'mcp';
  const pin = await harnessPin(deps);
  const today = deps.now().toISOString().slice(0, 10);
  const plan: InitPlan = {
    entry, facts: det.facts, packs: list(a.packs).length ? list(a.packs) : isMcp ? MCP_PACKS : AGENT_PACKS, ci,
    actionUses: str(a.action) ? (str(a.action)!.includes('/integrations/github-action@') ? str(a.action)! : str(a.action)!.replace('@', '/integrations/github-action@')) : pin.uses,
    gitlab: pin.gitlab, connection, envPassthrough: envPassthroughFor(entry, det.facts), catalog: [], today,
  };
  say(deps, `ves init: detected ${entry.id} (${entry.framework}, ${entry.language}) in ${root}${det.best && det.best.entry.id === entry.id ? `: ${det.best.signals.join('; ')}` : ' (from --framework)'}`);
  say(deps, `  detection table: ${source === 'builtin' ? 'built-in (examples/index.json is empty)' : `examples/index.json (${source})`}`);
  say(deps, `  plan: connection ${connection.type}${Array.isArray(connection.command) ? ` \`${(connection.command as string[]).join(' ')}\`` : ''}; packs ${plan.packs.join(', ')}; CI ${ci}${plan.envPassthrough.length ? `; secrets ${plan.envPassthrough.join(', ')}` : ''}`);

  // 2. write (or print)
  const { files, notes } = plannedFiles(plan, root, deps);
  const written: string[] = [];
  const writeAll = () => {
    for (const f of files) {
      const p = join(root, f.path);
      if (f.mode !== 'append' && existsSync(p) && !force) { notes.push(`kept existing ${f.path} (use --force to overwrite)`); continue; }
      mkdirSync(dirname(p), { recursive: true });
      if (f.copyFrom) copyFileSync(f.copyFrom, p);
      else if (f.mode === 'append') appendFileSync(p, f.content ?? '');
      else writeFileSync(p, f.content ?? '');
      written.push(f.path);
    }
  };
  if (dry) {
    for (const f of files) deps.stdout(`--- ${f.path}${f.mode === 'append' ? ' (append)' : ''}${f.copyFrom ? ` (copy of ${relative(deps.harnessRoot, f.copyFrom)})` : ''}\n${f.copyFrom ? '' : f.content}${f.copyFrom || (f.content ?? '').endsWith('\n') ? '' : '\n'}`);
    for (const n of notes) say(deps, `  note: ${n}`);
    say(deps, 'ves init --dry-run: nothing written.');
    return 0;
  }
  writeAll();
  for (const w of written) say(deps, `  wrote ${w}`);

  // 3. doctor: handshake + tool import + class suggestions
  if (a['no-doctor'] !== true) {
    const d = await doctor(plan, root, deps, hooks);
    say(deps, `  ${d.note}`);
    if (d.catalog.length) {
      plan.catalog = d.catalog;
      writeFileSync(join(root, 'ves.config.json'), JSON.stringify(buildConfig(plan), null, 2) + '\n');
      const ex = exampleCase(plan);
      if (ex && !existsSync(join(root, 'evals/cases/example.case.json'))) {
        writeFileSync(join(root, 'evals/cases/example.case.json'), JSON.stringify(ex, null, 2) + '\n');
        const i = notes.findIndex((n) => n.startsWith('no read tool known yet'));
        if (i >= 0) notes.splice(i, 1, `wrote evals/cases/example.case.json on ${ex.capability} (delete evals/cases/example.case.json.example)`);
      }
      say(deps, suggestionTable(plan.catalog));
      say(deps, '  Review the classes in ves.config.json, set review: "confirmed".');
    }
  }

  // 4. offline check: validate + a $0 mock smoke run (pack oracles on the proxy sim; no agent, no model)
  if (a['no-check'] !== true) {
    const cli = join(deps.harnessRoot, 'bin', 'ves.mjs'); // works when the harness is installed under node_modules
    const v = await deps.exec(process.execPath, [cli, 'validate', '--config', join(root, 'ves.config.json'), '--json'], { cwd: root });
    say(deps, `  offline check: ves validate ${v.code === 0 ? 'ok' : `reported problems (exit ${v.code}): ${(v.stderr || v.stdout).trim().split('\n').slice(0, 5).join(' | ')}`}`);
    const r = await deps.exec(process.execPath, [cli, 'run', '--config', join(root, 'ves.config.json'), '--tier', 'smoke', '--connection', 'mock', '--out', join(root, 'ves-results'), '--json'], { cwd: root });
    const j = lastJsonLine(r.stdout);
    say(deps, `  offline check: mock smoke run ${j ? `${j.verdict}${j.decided_by ? ` (${j.decided_by})` : ''} -> ${j.run_dir}` : `did not complete (exit ${r.code}): ${r.stderr.trim().split('\n')[0] ?? ''}`}`);
    if (j?.verdict === 'INVALID' && j.run_dir) {
      try {
        const g = JSON.parse(readFileSync(join(String(j.run_dir), 'gate.json'), 'utf8'));
        const why = (g.rules ?? []).filter((x: { status: string }) => x.status === 'fired').map((x: { detail: string }) => x.detail).join('; ');
        if (why) say(deps, `    why: ${why.slice(0, 400)}`);
      } catch { /* no gate.json */ }
      if (!plan.catalog.length) say(deps, '    next: list your tools: `ves catalog import --from agent` (agent running) or `--from openai-tools tools.json`, or edit tools.catalog');
    }
  }
  for (const n of notes) say(deps, `  note: ${n}`);
  if (ci === 'github' && plan.actionUses === ACTION_PLACEHOLDER) say(deps, '  note: edit the `uses:` line in .github/workflows/ves.yml to pin the harness action by full commit SHA (or pass --action owner/repo@sha)');
  if (ci === 'gitlab') say(deps, '  note: add `include: { local: ves.gitlab-ci.yml }` to .gitlab-ci.yml and a GITLAB_TOKEN variable for MR comments');

  // 5. next steps
  say(deps, ['', 'Next steps:', '  1. ves run --tier smoke            # against your real agent ($0 harness-side)', `  2. git add ves.config.json evals ves ${ci === 'github' ? '.github/workflows/ves.yml' : ci === 'gitlab' ? 'ves.gitlab-ci.yml' : ''} && git commit -m "Add VES evals"`, '  3. open a PR to see the VES comment and check'].join('\n'));
  return 0;
}

const command: CliCommand = { name: 'init', summary: 'detect framework, write ves.config.json + bridge + workflow', run: (argv, deps) => runInit(argv, deps) };
export default command;
