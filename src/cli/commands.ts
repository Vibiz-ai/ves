// Command dispatch (DESIGN-agnostic §5). Core commands are static; `init` and `ci` come from the ci package through
// src/registry/commands.ts (dynamic import), so no shared file changes when it lands.
// Exit codes: 0 PASS / REPORT_ONLY, 1 BLOCK, 2 INVALID, 3 usage or validation error.
import { existsSync, readFileSync } from 'node:fs';
import { classifyByGlobs, classifyChange } from '../gate/classify-change.ts';
import { loadConfig } from '../config/load.ts';
import { CORE_COMMANDS, loadPluggableCommand } from '../registry/commands.ts';
import { cmdRun } from './run.ts';
import { cmdValidate } from './validate.ts';
import { cmdCatalog, cmdMigrate, cmdPacks } from './packs.ts';
import { cmdGate, cmdReport } from './report.ts';
import { CliUsage, parse, str } from './args.ts';
import { realExec, realSpawn } from './io.ts';
import type { CliDeps } from '../core/types.ts';

export function usage(): string {
  return ['usage: ves <command> [options]   (ves <command> --help for its options)', ...Object.entries(CORE_COMMANDS).map(([k, v]) => `  ${k.padEnd(16)} ${v}`), '  init             detect framework, write ves.config.json + bridge + workflow (ci package)', '  ci               context|baseline|outputs|comment|exit for GitHub/GitLab (ci package)'].join('\n');
}

/** Per-command help (dogfood fix 2026-11-07: `ves init --help` ran a real init and wrote files). */
export const HELP: Record<string, string> = {
  run: `ves run [--config ves.config.json] [--tier smoke|release|research] [--packs a,b] [--variants a,b|auto] [--case <glob>] [--persona <glob>]
        [--trigger manual|pr|deploy|pre_release|nightly|canary|research] [--target <sha>] [--change-class 0-3|auto] [--base-ref <ref>]
        [--baseline <run-dir>|none] [--anchor <run-dir>] [--connection mock] [--report-only] [--out <dir>] [--json]
        [--override-by x --override-reason y] [--extra-cases a.case.json,b.case.json] [--profile vibiz] [--store [<path|gs://bucket/prefix>]]
        [--simulator <model>] [--judge <model>]   (persona cases: e.g. anthropic/claude-sonnet-4-6 = Claude on Vertex)
  Exit 0 PASS / REPORT_ONLY, 1 BLOCK, 2 INVALID, 3 usage. --connection mock replays the case oracles ($0, tests wiring only).
  --store (or store.auto_push: true in ves.config.json) pushes the finished run directory to the run store; a failed
  push is reported on stderr (and as "store" in --json) and never changes the exit code.`,
  validate: `ves validate [--config ves.config.json] [--strict] [--json]   |   ves validate --profile vibiz [dirs...]
  Offline, $0: config schema, catalog rules, cases, pack expansion dry run, every oracle replayed on the MockAgent.`,
  doctor: `ves doctor [--config ves.config.json]
  Handshakes every variant's connection (health + info): is the agent reachable, which tools it declares, which are
  missing from tools.catalog. Exit 0 when every variant answers, 2 otherwise.`,
  packs: `ves packs list [--json] | show <id> | expand <id> [--out dir] | synthesize [--tools a,b] [--n 3] [--budget 1] [--yes]`,
  catalog: `ves catalog suggest [--config ves.config.json]
ves catalog import --from agent|bridge|mcp|http [--config ves.config.json] [--print]
ves catalog import --from openai-tools <tools.json> [--print]
  import merges the tools into ves.config.json tools.catalog (existing entries kept; new ones review: "suggested").
  --from agent|bridge|mcp|http asks the configured connection for its declared tools; --print only prints.`,
  gate: `ves gate --run <dir> [--run <dir>] | --require <sha> [--results <dir>] [--change-class n]`,
  report: `ves report --run <dir> --format md|json|pr|summary|junit|annotations|claims|efficiency [--config ves.config.json] [--json]
  claims and efficiency re-read the stored trajectories offline (read-only): claims_vs_ledger / silent_actions per
  trial, and the efficiency table with tool-call dedupe. Settings come from the run's config.snapshot.json, or from
  --config (its graders.claims and tools.reported_prefixes|reported_aliases).`,
  migrate: `ves migrate <dir> --to 2 --profile vibiz [--out <dir>]`,
  'classify-change': `ves classify-change [--config ves.config.json] [--files-from f] [paths...] [--model-change] [--new-variant] [--protocol-change]
  Uses ./ves.config.json change_classes when present (else the Vibiz defaults).`,
  proxy: `ves proxy --connect <tool_transport.mcp.url> [--header "name: value"]   (stdio MCP bridge for stdio-only MCP clients)`,
  init: `ves init [--framework <id>] [--connection command|http|openai-chat|mcp|trace] [--transport stdio|http] [--command "node server.mjs"]
         [--ci github|gitlab|none] [--packs a,b] [--yes] [--dry-run] [--force] [--dir <repo>] [--action <owner/repo[/path]@sha>]
         [--no-doctor] [--no-check]
  Detects the framework and writes ves.config.json, a bridge, an example case, the fixture state and the CI workflow.
  Never overwrites without --force; --dry-run prints every file instead.`,
  ui: `ves ui [--results ./results] [--port 4317] [--repo .] [--store <dir|gs://bucket/prefix>]
  Serves the local dashboard (read-only, 127.0.0.1 only) over the run directories in --results, plus History and
  Compare over the run store (same resolution as \`ves store\`; ./.ves/store when it exists). Never runs evals.`,
  ci: `ves ci context|baseline|outputs|comment|exit [--github|--gitlab]   (used by the GitHub Action and the GitLab template)`,
  store: `ves store push <run-dir>... [--branch b]          copy run dirs into the store unchanged (sha256 of every file; append-only)
ves store list [--branch b] [--tier t] [--variant v] [--since 7d|P7D|2026-11-01] [--sha s] [--limit n] [--json]
ves store verify [--json]                            re-hash every object; cross-check records and index (exit 1 on a problem)
ves store pull <run_id> --out <dir>                  write <dir>/<run_id>/ byte for byte (never overwrites)
  Store: --store <path|gs://bucket/prefix>, else $VES_STORE, else ves.config.json "store": {"url", "project", "auto_push"},
  else ./.ves/store. gs:// uses ADC (gcloud auth application-default print-access-token) and x-goog-user-project from
  store.project / $VES_STORE_PROJECT / $GOOGLE_CLOUD_PROJECT. Pushing a run again is a no-op if identical, refused if not.`,
  compare: `ves compare <base> <head> [--variant v] [--json]   |   ves compare --base main --head <sha|run_id|run-dir> [--tier t]
  A ref is a run dir, a run id (or unique prefix), a SHA (newest run of it) or a branch (newest run on it, same tier as
  the other side, preferring the same suite_version, then runs created before it). Defaults: head = newest stored run,
  base = main.
  Δ = head − base per surface: the runner's paired cluster bootstrap by case, Holm across surfaces, reading
  above|level|below (STANDARD §5.5); flipped cases (pass→fail, fail→pass, new, removed), safety violations new vs fixed,
  cost delta. Refused (exit 2) unless both runs share suite_version; per-case flips then cover only same-version cases.`,
  cases: `ves cases from-trace <trace> [--format atif|openai|otel] | --run <dir> --row <row_id|case@variant#trial>
        [--out <dir|file.case.json>] [--id <case-id>] [--owner <who>] [--config ves.config.json] [--no-redact] [--force]
        [--dry-run] [--json]
  Turns one real conversation into a ves-case/2 regression case: an ATIF trajectory (a run's trajectories/*.atif.json),
  a results row (its trajectory, expanded case and failed graders), OpenAI-chat messages ([{role, content,
  tool_calls}]) or OTel GenAI events JSONL. The case replays the user turns, keeps the fixture reference, lists the
  tools the original called as call_match ADVISORY, every failed safety grader (and claims_vs_ledger) as a gate, and a
  reply_check gate placeholder (TODO_REPLY_CHECK) a human must fill. Emails, phone numbers, tokens/keys and long
  digit runs are redacted unless --no-redact. Never overwrites without --force. Output: --out, else the config's
  first suite dir, else the current directory. Offline, $0.`,
  personas: `ves personas list [--config ves.config.json] [--json]   |   ves personas show <id>
  The persona library (<config dir>/personas/<id>.persona.json, schema ves-persona/1) and the cases that reference each
  person (input.persona.ref). show prints the person and the pinned user-simulator prompt for turn 1. Offline, $0.`,
  history: `ves history <case_id> [--variant v] [--branch b] [--tier t] [--since 30d] [--json]
  Status of one case in every stored run (oldest first), with a BREAK where the case version changes.`,
};
const wantsHelp = (rest: string[]): boolean => rest.includes('--help') || rest.includes('-h');

export async function main(argv: string[], root: string, env: Record<string, string | undefined> = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || (cmd === 'help' && !rest[0])) { process.stdout.write(usage() + '\n'); return 0; }
  if (cmd === 'help' || wantsHelp(rest)) {
    const which = cmd === 'help' ? rest[0] : cmd;
    if (!HELP[which]) { process.stderr.write(`unknown command ${which}\n${usage()}\n`); return 3; }
    process.stdout.write(`usage: ${HELP[which]}\n`);
    return 0;
  }
  const a = parse(rest);
  switch (cmd) {
    case 'doctor': {
      const { cmdDoctor } = await import('./doctor.ts');
      return cmdDoctor(a, { fetch: globalThis.fetch as never, spawn: realSpawn, env, now: () => new Date(), harnessRoot: root, out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) });
    }
    case 'ui': {
      const { cmdUi } = await import('./ui.ts');
      return cmdUi(a, root);
    }
    case 'run': return cmdRun(a, root, env);
    case 'store': case 'compare': case 'history': {
      const m = await import('./store.ts');
      const deps = { env, cwd: process.cwd(), exec: realExec, fetch: globalThis.fetch as never, out: (s: string) => process.stdout.write(s), err: (s: string) => process.stderr.write(s) };
      return cmd === 'store' ? m.cmdStore(a, deps) : cmd === 'compare' ? m.cmdCompare(a, deps) : m.cmdHistory(a, deps);
    }
    case 'validate': return cmdValidate(a, root, env);
    case 'cases': { const { cmdCases } = await import('./cases.ts'); return cmdCases(a, root, env); }
    case 'packs': return cmdPacks(a, root, env);
    case 'personas': { const { cmdPersonas } = await import('./personas.ts'); return cmdPersonas(a, env); }
    case 'catalog': return cmdCatalog(a, root, env);
    case 'migrate': return cmdMigrate(a, root);
    case 'proxy': {
      // `ves proxy --connect <url>`: the stdio MCP bridge for stdio-only MCP clients (tool_transport.mcp_stdio)
      const url = str(a.connect);
      if (!url) throw new CliUsage('usage: ves proxy --connect <tool_transport.mcp.url> [--header "name: value"]');
      const { runStdioBridge } = await import('../connectors/_shared/stdio-bridge.ts');
      const headers: Record<string, string> = {};
      for (const h of ([] as unknown[]).concat(a.header ?? []).filter((x): x is string => typeof x === 'string')) { const [k, ...v] = h.split(':'); headers[k.trim().toLowerCase()] = v.join(':').trim(); }
      process.stdin.setEncoding('utf8');
      await runStdioBridge({ url, headers, fetch: globalThis.fetch as never, input: process.stdin as AsyncIterable<string>, write: (l) => process.stdout.write(l + '\n'), log: (m) => process.stderr.write(m + '\n') });
      return 0;
    }
    case 'gate': return cmdGate(a, root);
    case 'report': return cmdReport(a, root);
    case 'classify-change': {
      const paths = [...a._, ...(a['files-from'] ? readFileSync(String(str(a['files-from'])), 'utf8').split('\n').filter(Boolean) : [])];
      const flags = { modelChange: !!a['model-change'], newSurface: !!(a['new-surface'] || a['new-variant']), protocolChange: !!a['protocol-change'], submission: !!a.submission, pooledLearning: !!a['pooled-learning'] };
      // ./ves.config.json is the default, as for run and validate (dogfood fix 2026-11-07)
      const cfgFile = str(a.config) ?? (existsSync('ves.config.json') ? 'ves.config.json' : undefined);
      const r = cfgFile ? (() => { const c = loadConfig(cfgFile, env); return classifyByGlobs(paths, c.change_classes, flags, c.suites.map((s) => s.replace(`${c.dir}/`, ''))); })() : classifyChange(paths, flags);
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'init': case 'ci': {
      const c = await loadPluggableCommand(cmd, root);
      if (!c) throw new CliUsage(`ves ${cmd} requires the ci package (src/cli/${cmd}.ts is not installed)`);
      const deps: CliDeps = { cwd: process.cwd(), env, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), fetch: globalThis.fetch as never, spawn: realSpawn, exec: realExec, harnessRoot: root, now: () => new Date() };
      return c.run(rest, deps);
    }
    default:
      process.stderr.write(usage() + '\n');
      return 3;
  }
}
