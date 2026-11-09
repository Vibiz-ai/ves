// CLI command table (DESIGN-agnostic §5, §7.1 item 8): the core commands are static; `init` and `ci` are imported
// from src/cli/init.ts and src/cli/ci.ts (the ci package) when present, each default-exporting a CliCommand.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_ROOT } from '../adapters/profiles.ts';
import type { CliCommand } from '../core/types.ts';

export const CORE_COMMANDS: Record<string, string> = {
  run: 'run evals and gate (ves.config.json or --profile vibiz)',
  gate: 'pure re-evaluation / "is there a PASS for this SHA"',
  report: 'render a run: md | json | pr | summary | junit | annotations',
  validate: 'config, catalog, cases (v1+v2), pack expansion dry run',
  packs: 'packs list | show <id> | expand <id> [--out dir]',
  doctor: 'handshake each connection: reachable? declared tools? catalog coverage?',
  catalog: 'catalog suggest | import --from agent|bridge|mcp|http|openai-tools (merges into ves.config.json)',
  migrate: 'ves-case/1 -> ves-case/2 (explicit only)',
  'classify-change': 'diff paths -> change class 0..3',
  proxy: 'proxy --connect <url>: stdio MCP bridge to a per-trial tool endpoint',
  ui: 'local read-only dashboard over a results directory (ui/)',
  store: 'run history: store push <run-dir>... | list | verify | pull <run_id> (local dir or gs://)',
  compare: 'compare two stored runs: per-surface pass^1 delta with paired bootstrap CI, flipped cases, safety, cost',
  history: 'history <case_id>: one case across every stored run',
  cases: 'cases from-trace: a real (failed) conversation -> a ves-case/2 regression case (PII redacted)',
  personas: 'personas list | show <id>: the persona library (personas/*.persona.json) and the cases using it',
};
export const PLUGGABLE = ['init', 'ci'] as const;

export async function loadPluggableCommand(name: string, root: string = HARNESS_ROOT): Promise<CliCommand | null> {
  if (!(PLUGGABLE as readonly string[]).includes(name)) return null;
  const f = join(root, 'src', 'cli', `${name}.ts`);
  if (!existsSync(f)) return null;
  const m = await import(pathToFileURL(f).href);
  const c = m.default as CliCommand | undefined;
  return c && typeof c.run === 'function' ? c : null;
}
