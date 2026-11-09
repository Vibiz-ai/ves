// `ves run` (DESIGN-agnostic §5.2). Two paths, one gate:
//   config path   ves.config.json -> runConfig (generic: any framework, packs, variants)
//   vibiz profile --profile vibiz (or the v1 aliases --suite/--surfaces/--adapter) -> runWithRetry, exact v1 semantics
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runWithRetry } from '../runner/run.ts';
import { runConfig, type Trigger2 } from '../runner/run-v2.ts';
import { loadCaseFiles } from '../cases/load.ts';
import { loadConfig } from '../config/load.ts';
import { classifyByGlobs } from '../gate/classify-change.ts';
import { exitCodeFor } from '../gate/gate.ts';
import { vibizPackDir, VIBIZ_PROFILE } from '../adapters/profiles.ts';
import { serveToolEndpoints } from '../proxy/http-binding.ts';
import { createMcpHandler } from '../proxy/mcp-server.ts';
import type { MockFaults } from '../adapters/mock.ts';
import type { ServeTools } from '../core/connector-adapter.ts';
import type { Tier } from '../types.ts';
import type { ResolvedConfig } from '../core/types.ts';
import { type Args, CliUsage, list, str } from './args.ts';
import { realExec, realSpawn } from './io.ts';
import { pushAfterRun } from './store.ts';

/** `--store` / store.auto_push: archive the finished run. Without either, nothing changes (and nothing is printed). */
const archive = (runDir: string, a: Args, env: Record<string, string | undefined>, configPath?: string) =>
  pushAfterRun(runDir, a, { env, cwd: process.cwd(), exec: realExec, fetch: globalThis.fetch as never, out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, configPath);

const TRIGGERS = ['manual', 'pr', 'deploy', 'pre_release', 'nightly', 'canary', 'research'];

function faultsOf(a: Args): MockFaults {
  const faults: MockFaults = {};
  for (const f of list(a.fault)) {
    const [k, v] = f.split('=');
    if (k === 'unsafe') (faults.unsafeCases ??= []).push(v);
    else if (k === 'break') (faults.breakCases ??= []).push(v);
    else if (k === 'flaky') faults.flakyRate = Number(v);
    else if (k === 'host-confirms-writes') faults.hostConfirmsWrites = true;
    else throw new CliUsage(`unknown fault ${f}`);
  }
  return faults;
}

/**
 * `--simulator <ref>` / `--judge <ref>`: one run with another harness model, without editing ves.config.json. `<ref>` is
 * a models.named key or purpose (`default`, `judge`, ...), or a Vertex model id (`google/gemini-*`, `anthropic/claude-*`:
 * Claude on Vertex, billed to the same Google Cloud project as the default). The override is a manifest note.
 */
export function overrideModel(cfg: ResolvedConfig, purpose: 'user_simulator' | 'judge', v: string): void {
  const named = !!cfg.models.named?.[v.replace(/^named\./, '')] || ['default', 'judge', 'user_simulator', 'host_sim', 'intent_writer'].includes(v);
  if (!named && !/^(google|anthropic)\/[A-Za-z0-9._@-]+$/.test(v)) throw new CliUsage(`--${purpose === 'judge' ? 'judge' : 'simulator'} ${v}: use a models.named key, a purpose, or a Vertex model id (google/gemini-*, anthropic/claude-*)`);
  const project = cfg.models.default?.provider === 'vertex' ? cfg.models.default.project : undefined;
  cfg.models = { ...cfg.models, [purpose]: named ? v : { provider: 'vertex', model: v, location: 'global', ...(project ? { project } : {}) } };
  cfg.notes = [...cfg.notes, `models.${purpose} set on the command line: ${v}`];
}

export const isProfileRun = (a: Args): boolean => str(a.profile) === 'vibiz' || (!a.config && (a.suite !== undefined || a.surfaces !== undefined || a.adapter !== undefined));

/** Real per-trial tool endpoints on 127.0.0.1 (never used by tests: they run on MockAgent / injected connectors). */
export const serveTools: ServeTools = async (proxy, tools) => {
  const invoke = (name: string, args: Record<string, unknown>) => proxy.invoke({ name, args, transport: 'mcp' });
  const ep = await serveToolEndpoints({
    mcp: createMcpHandler({ tools: () => tools, invoke }),
    http: (name, args, meta) => proxy.invoke({ name, args, transport: 'http', ...(meta?.thread ? { thread: meta.thread } : {}) }),
  });
  return { transport: ep.transport, close: ep.close };
};

export async function cmdRun(a: Args, root: string, env: Record<string, string | undefined>): Promise<number> {
  const sha = String(str(a.target) ?? env.GITHUB_SHA ?? '0000000');
  if (!/^[a-f0-9]{7,40}$/.test(sha)) throw new CliUsage(`--target must be a hex SHA, got ${sha}`);
  const tier = (str(a.tier) ?? 'smoke') as Tier;
  if (!['smoke', 'release', 'research'].includes(tier)) throw new CliUsage(`--tier must be smoke|release|research, got ${tier}`);
  const trigger = (str(a.trigger) ?? 'manual') as Trigger2;
  if (!TRIGGERS.includes(trigger)) throw new CliUsage(`--trigger must be one of ${TRIGGERS.join('|')}`);
  const baseline = str(a.baseline) ?? str(a.compare);
  const json = a.json === true;
  const override = a['override-by'] ? { by: String(str(a['override-by'])), reason: String(str(a['override-reason']) ?? '') } : null;

  if (isProfileRun(a)) {
    // ---- Vibiz profile: today's npm run smoke:mock / release:mock, unchanged
    if (trigger === 'pr') throw new CliUsage('--trigger pr writes run-2 manifests; the vibiz profile writes run-1 (use --trigger manual|deploy, or a ves.config.json run)');
    const suites = list(a.suite).length ? list(a.suite).map((s) => resolve(s)) : (VIBIZ_PROFILE.suites[tier] ?? VIBIZ_PROFILE.suites.smoke).map((s) => join(vibizPackDir(root), s));
    const mode = (str(a.adapter) ?? (str(a.connection) === 'mock' ? 'mock' : str(a.connection) === 'real' ? 'real' : 'mock')) as 'mock' | 'real';
    const out = await runWithRetry({
      repoRoot: root, suites, tier, trigger: trigger as never, surfaces: !a.surfaces || a.surfaces === 'auto' ? 'auto' : list(a.surfaces), mode, faults: faultsOf(a),
      outDir: resolve(String(str(a.out) ?? join(root, 'results'))),
      target: { sha, branch: str(a.branch), deploy_targets: list(a['deploy-targets']) as never, change_class: Number(str(a['change-class']) ?? 0) as 0 },
      compare: baseline ? resolve(baseline) : undefined, anchor: a.anchor ? resolve(String(str(a.anchor))) : undefined, differsIn: list(a['differs-in']),
      history: a.history ? JSON.parse(readFileSync(String(str(a.history)), 'utf8')) : undefined, quarantine: list(a.quarantine), override, env, reportOnly: a['report-only'] === true,
    });
    if (!json) { console.log(out.card.split('\n## Surface')[0].trim()); console.log(`\nrun dir: ${out.runDir}`); console.log(`gate:    ${out.gate.verdict}${out.gate.decided_by ? ` (${out.gate.decided_by})` : ''}`); }
    const stored = await archive(out.runDir, a, env);
    if (json) process.stdout.write(JSON.stringify({ verdict: out.gate.verdict, would_be: out.gate.would_be, decided_by: out.gate.decided_by, run_dir: out.runDir, run_id: out.runId, ...(stored ? { store: stored } : {}) }) + '\n');
    return exitCodeFor(out.gate.verdict);
  }

  // ---- config path
  const suiteRoot = str(a['suite-root']);
  const cfgPath = resolve(suiteRoot ?? '.', str(a.config) ?? 'ves.config.json');
  const cfg = loadConfig(cfgPath, env);
  for (const [flag, purpose] of [['simulator', 'user_simulator'], ['judge', 'judge']] as const) { const v = str(a[flag]); if (v) overrideModel(cfg, purpose, v); }
  let cc: 0 | 1 | 2 | 3;
  const ccArg = str(a['change-class']) ?? 'auto';
  if (ccArg === 'auto') {
    const baseRef = str(a['base-ref']);
    let paths: string[] | null = null;
    if (baseRef) { try { paths = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: process.cwd(), encoding: 'utf8' }).split('\n').filter(Boolean); } catch { paths = null; } }
    cc = paths ? classifyByGlobs(paths, cfg.change_classes, { modelChange: a['model-change'] === true, newSurface: a['new-variant'] === true, protocolChange: a['protocol-change'] === true }, cfg.suites.map((s) => s.replace(`${cfg.dir}/`, ''))).change_class : 1;
  } else cc = Number(ccArg) as 0 | 1 | 2 | 3;
  if (a['model-change'] === true || a['new-variant'] === true || a['protocol-change'] === true) cc = 3;
  if (cfg.gate.auto_class3 && baseline && existsSync(join(resolve(baseline), 'run.json'))) {
    const bm = JSON.parse(readFileSync(join(resolve(baseline), 'run.json'), 'utf8'));
    const models = Object.values(bm.connections ?? {}).map((c: any) => c.agent?.model).filter(Boolean);
    if (cfg.agent.model && models.length && !models.includes(cfg.agent.model)) cc = 3;
  }
  const connection = str(a.connection) === 'mock' || str(a.adapter) === 'mock' ? 'mock' as const : undefined;
  const extraFiles = list(a['extra-cases']).map((f) => resolve(f));
  const extra = extraFiles.length ? loadCaseFiles(process.cwd(), extraFiles, { fixtureDirs: [process.cwd(), cfg.dir] }) : { v2: [], errors: [] };
  if (extra.errors.length) throw new CliUsage(`--extra-cases:\n  ${extra.errors.join('\n  ')}`);
  const bsrc = str(a['baseline-source']);
  if (bsrc && !['artifact', 'run-base', 'path', 'none'].includes(bsrc)) throw new CliUsage('--baseline-source must be artifact|run-base|path');
  const out = await runConfig({
    harnessRoot: root, config: cfg, tier, trigger, variants: !a.variants || str(a.variants) === 'auto' ? 'auto' : list(a.variants),
    ...(a.packs ? { packs: list(a.packs) } : {}), caseFilter: str(a.case), ...(str(a.persona) ? { personaFilter: str(a.persona) } : {}), connection, faults: { unsafeCases: faultsOf(a).unsafeCases, breakCases: faultsOf(a).breakCases, flakyRate: faultsOf(a).flakyRate },
    target: { sha, branch: str(a.branch), change_class: cc, deploy_targets: list(a['deploy-targets']) },
    outDir: resolve(String(str(a.out) ?? cfg.results.dir)), baseline: baseline && baseline !== 'none' ? resolve(baseline) : undefined,
    anchor: a.anchor ? resolve(String(str(a.anchor))) : undefined, differsIn: list(a['differs-in']), override, reportOnly: a['report-only'] === true,
    env, fetch: globalThis.fetch as never, spawn: realSpawn, exec: realExec, harnessSource: (env.VES_HARNESS_SOURCE as never) ?? 'local', newCases: list(a['new-cases']),
    serveTools: connection ? undefined : serveTools, ...(suiteRoot ? { agentRoot: process.cwd(), suiteFromBase: resolve(suiteRoot) !== process.cwd() } : {}),
    ...(extra.v2.length ? { extraCases: extra.v2 } : {}), ...(bsrc && bsrc !== 'none' ? { baselineSource: bsrc as 'artifact' | 'run-base' | 'path' } : {}), history: a.history ? JSON.parse(readFileSync(String(str(a.history)), 'utf8')) : undefined, quarantine: list(a.quarantine),
  });
  if (!json) {
    process.stderr.write(out.card.split('\n## Variant')[0].trim() + '\n');
    process.stderr.write(`\nrun dir: ${out.runDir}\ngate:    ${out.gate.verdict}${out.gate.decided_by ? ` (${out.gate.decided_by})` : ''}\n`);
  }
  const stored = await archive(out.runDir, a, env, cfgPath);
  if (json) process.stdout.write(JSON.stringify({ verdict: out.gate.verdict, would_be: out.gate.would_be, decided_by: out.gate.decided_by, run_dir: out.runDir, run_id: out.runId, conformance: out.manifest.conformance, ...(stored ? { store: stored } : {}) }) + '\n');
  return exitCodeFor(out.gate.verdict);
}
