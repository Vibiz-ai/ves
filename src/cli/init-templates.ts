// Files `ves init` writes (DESIGN-agnostic §5.1, §6.1, §6.5). Pure string/object builders over the detection
// result, so `ves init --dry-run` and the snapshot tests see exactly what would be written.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { synthArgs } from '../catalog/synth-args.ts';
import type { CatalogEntry, ExampleIndexEntry } from '../core/types.ts';
import type { RepoFacts } from './init-detect.ts';

export const AGENT_PACKS = ['core-tool-use', 'hitl-approval', 'prompt-injection', 'data-isolation', 'over-refusal'];
export const MCP_PACKS = ['mcp-conformance'];
export const ACTION_PLACEHOLDER = '<org>/ves/integrations/github-action@<40-hex-sha>';

const FRAMEWORK_KEYS: Record<string, string[]> = {
  'openai-agents': ['OPENAI_API_KEY'], 'claude-agent-sdk': ['ANTHROPIC_API_KEY'], crewai: ['OPENAI_API_KEY'],
  'pydantic-ai': ['OPENAI_API_KEY'], langgraph: ['OPENAI_API_KEY'], mastra: ['OPENAI_API_KEY'], 'vercel-ai-sdk': ['OPENAI_API_KEY'],
};

export type InitPlan = {
  entry: ExampleIndexEntry; facts: RepoFacts; packs: string[]; ci: 'github' | 'gitlab' | 'none';
  actionUses: string; gitlab: { repo: string; ref: string; subdir: string };
  connection: Record<string, unknown>; envPassthrough: string[]; catalog: CatalogEntry[]; today: string;
};

/** The agent's own runtime command, adjusted to the repo's Python/Node toolchain. */
export function connectionFor(entry: ExampleIndexEntry, f: RepoFacts): Record<string, unknown> {
  const c: Record<string, unknown> = JSON.parse(JSON.stringify(entry.connection));
  const cmd = Array.isArray(c.command) ? (c.command as string[]) : null;
  if (cmd && cmd[0] === 'python') {
    if (f.python.manager === 'uv') c.command = ['uv', 'run', ...cmd];
    else if (f.python.manager === 'poetry') c.command = ['poetry', 'run', ...cmd];
  }
  if (entry.id === 'mcp-server-node' && cmd) {
    const bin = f.packageJson?.bin;
    const main = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? String(Object.values(bin)[0]) : f.packageJson?.main;
    if (main) c.command = ['node', String(main)];
  }
  if (entry.id === 'mcp-server-node') {
    // a server that reads stdin and has no HTTP transport is a stdio server: run it, do not expect :3100
    const hit = f.grepCorpus.find((x) => /\.(m?[jt]s|cjs)$/.test(x.file) && /new McpServer\(|["']tools\/list["']/.test(x.text));
    if (hit && /process\.stdin|StdioServerTransport/.test(hit.text) && !/StreamableHTTPServerTransport|createServer\(|\.listen\(/.test(hit.text)) {
      for (const k of ['url']) delete c[k];
      c.transport = 'stdio';
      c.command = ['node', hit.file];
    }
  }
  if (entry.id === 'mcp-server-python' && cmd) {
    const hit = f.grepCorpus.find((x) => x.file.endsWith('.py') && /FastMCP\(|from mcp\.server/.test(x.text));
    if (hit) c.command = [...(f.python.manager === 'uv' ? ['uv', 'run'] : f.python.manager === 'poetry' ? ['poetry', 'run'] : []), 'python', hit.file];
  }
  return c;
}

export function envPassthroughFor(entry: ExampleIndexEntry, f: RepoFacts): string[] {
  return f.envKeys.length ? f.envKeys : FRAMEWORK_KEYS[entry.framework] ?? [];
}

/** Agent-code globs are class 2 (behaviour change); docs class 0; anything unmatched is class 1 (§2.7). */
export function changeClassesFor(f: RepoFacts): Record<'0' | '2', string[]> {
  const agentDirs = ['src', 'app', 'agent', 'agents', 'lib', 'prompts', 'tools', 'server', 'pkg', 'cmd', 'internal'].filter((d) => f.dirs.includes(d));
  const py = f.grepCorpus.filter((x) => !x.file.includes('/') && /\.(py|ts|js|mjs|go)$/.test(x.file)).map((x) => x.file).slice(0, 10);
  return { '2': [...agentDirs.map((d) => `${d}/**`), ...py, 'ves/**', 'evals/**', 'ves.config.json', 'ves.intents.json'], '0': ['docs/**', '**/*.md', 'LICENSE*'] };
}

export function buildConfig(p: InitPlan): Record<string, unknown> {
  const mcp = p.connection.type === 'mcp';
  const conn = { ...p.connection, ...(p.envPassthrough.length && p.connection.type === 'command' ? { env_passthrough: p.envPassthrough } : {}) };
  const schemasFrom = p.connection.type === 'mcp' ? 'mcp' : p.connection.type === 'command' ? 'bridge' : 'inline';
  return {
    $schema: 'https://vibiz.ai/schemas/ves/config-1.json',
    $comment: `Written by ves init on ${p.today} (detected ${p.entry.id}). Review tools.catalog (set review: "confirmed"), then run: ves run --tier smoke`,
    schema_version: 'ves-config/1',
    project: p.facts.name,
    agent: { name: p.facts.name, framework: p.entry.framework, connection: conn },
    tools: { backend: { type: 'sim' }, gate_classes: ['spend', 'outward', 'destructive'], catalog: p.catalog, schemas_from: schemasFrom },
    hitl: { mode: 'auto', binding: 'args', ttl_s: 1800, authorized: ['owner'] },
    fixtures: { state: 'evals/fixtures/state.json', principal: { role: 'owner', tenant: p.facts.name, id: 'u_owner' } },
    // a contract variant needs `rpc` (transcript checks) and, with connection.approval, `hitl_structured` (dogfood fix
    // 2026-11-07: without them every mcp-conformance case was SKIP and the offline check read PASS on 0 cases)
    variants: mcp ? { contract: { role: 'contract', capabilities: ['rpc', ...(p.connection.approval ? ['hitl_structured'] : [])] } } : { default: {} },
    packs: p.packs,
    suites: ['evals/cases'],
    change_classes: changeClassesFor(p.facts),
    models: { default: { provider: 'vertex', model: 'google/gemini-3.8-flash', project: '${GOOGLE_CLOUD_PROJECT}', location: 'global' }, judge: 'default', user_simulator: 'default', host_sim: 'default', intent_writer: 'default' },
    results: { dir: 'ves-results' },
  };
}

/** One v2 example case on the first read tool of the catalog, or null when no tool is known yet. */
export function exampleCase(p: InitPlan): Record<string, unknown> | null {
  const read = p.catalog.find((t) => t.classes.length === 1 && t.classes[0] === 'read');
  if (!read) return null;
  const args = (read.input_schema ? synthArgs(read.input_schema, 1) : {}) ?? {};
  const argText = Object.entries(args).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ');
  return {
    schema_version: 'ves-case/2', id: `example.read-${read.name.replace(/[^A-Za-z0-9_-]+/g, '-')}`, version: 1, owner: p.facts.name,
    provenance: { author: 'ves init', created: p.today, source: 'hand', source_ref: 'ves init example; edit or replace it' },
    fixture: { seed: 1, clock: `${p.today}T09:00:00Z` }, suite: 'regression', capability: `example.${read.name}`,
    input: { turns: [{ say: `Please look this up with ${read.title ?? read.name}${argText ? ` (${argText})` : ''}.` }] },
    expect: { calls: [{ tool: read.name, ...(Object.keys(args).length ? { args } : {}), min: 1 }] },
    oracle: { kind: 'scripted', steps: [{ call: read.name, args }, { reply: 'Here is what I found.' }] },
  };
}

/** Shown (as evals/cases/example.case.json.example) when no tool is known: it does not load until renamed. */
export const EXAMPLE_PLACEHOLDER = {
  $comment: 'Rename to example.case.json after replacing your_read_tool with a read tool from tools.catalog. Cases a do-nothing agent passes break the trivial-agent bar, so every case must require an action.',
  schema_version: 'ves-case/2', id: 'example.read', version: 1, owner: 'you',
  provenance: { author: 'ves init', created: '2026-01-01', source: 'hand' },
  fixture: { seed: 1, clock: '2026-01-01T09:00:00Z' }, suite: 'regression', capability: 'example.read',
  input: { turns: [{ say: 'Find the order O-1 for me.' }] },
  expect: { calls: [{ tool: 'your_read_tool', args: { id: 'O-1' }, min: 1 }] },
  oracle: { kind: 'scripted', steps: [{ call: 'your_read_tool', args: { id: 'O-1' } }, { reply: 'Order O-1 is on its way.' }] },
};

function runtimeSteps(f: RepoFacts, entry: ExampleIndexEntry): string[] {
  const L: string[] = [];
  const lang = entry.language;
  const usesPython = lang === 'python' || (lang === 'any' && f.python.manager !== null && !f.packageJson);
  const usesNode = !usesPython && (f.packageJson !== null || lang === 'typescript' || lang === 'javascript');
  if (usesPython) {
    if (f.python.manager === 'uv') L.push('      - uses: astral-sh/setup-uv@v6', '      - run: uv sync --frozen');
    else {
      L.push('      - uses: actions/setup-python@v5', "        with: { python-version: '3.12' }");
      if (f.python.manager === 'poetry') L.push('      - run: pipx install poetry && poetry install --no-interaction');
      else if (f.python.requirements) L.push(`      - run: pip install -r ${f.python.requirements}`);
      else if (f.python.pyproject) L.push('      - run: pip install -e .');
      else L.push('      # - run: pip install -r requirements.txt   # install your agent');
    }
  } else if (usesNode) {
    const pm = f.packageManager ?? 'npm';
    if (pm === 'pnpm') L.push('      - uses: pnpm/action-setup@v4');
    if (pm === 'bun') L.push('      - uses: oven-sh/setup-bun@v2', '      - run: bun install --frozen-lockfile');
    else {
      L.push('      - uses: actions/setup-node@v4', `        with: { node-version: '22'${f.packageJson ? `, cache: ${pm}` : ''} }`);
      if (f.packageJson) L.push(`      - run: ${pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : 'npm ci'}`);
    }
  } else if (f.hasGoMod) L.push('      - uses: actions/setup-go@v5', '        with: { go-version-file: go.mod }', '      - run: go build ./...');
  else L.push("      # Add your agent's runtime setup here (language toolchain + dependency install).");
  return L;
}

/** .github/workflows/ves.yml (§6.1). */
export function githubWorkflow(p: InitPlan): string {
  const env = p.envPassthrough.map((k) => `          ${k}: \${{ secrets.${k} }}`);
  return [
    '# Written by `ves init`. VES runs your evals on every PR, gates it, comments the result card and stores',
    '# the baseline on pushes to main. Docs: integrations/github-action/README.md in the harness.',
    'name: ves',
    'on:',
    '  pull_request:',
    '  push: { branches: [main] }          # produces the baseline artifact',
    "  schedule: [{ cron: '17 3 * * *' }]  # nightly release tier, REPORT_ONLY",
    '  workflow_dispatch:',
    'permissions: { contents: read, pull-requests: write, actions: read }',
    'concurrency: { group: ves-${{ github.ref }}, cancel-in-progress: true }',
    'jobs:',
    '  ves:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with: { fetch-depth: 0 }',
    `      # Your agent's own runtime (detected: ${p.entry.id}):`,
    ...runtimeSteps(p.facts, p.entry),
    '      # Only if a pack/persona needs harness-side models (judge, user simulator, host-sim): Vertex via WIF -> ADC',
    '      # - uses: google-github-actions/auth@v2',
    '      #   with: { workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}, service_account: ${{ vars.GCP_SA }} }',
    `      - uses: ${p.actionUses}   # pin by full SHA`,
    '        with:',
    '          config: ves.config.json',
    ...(env.length ? ['        env:   # the agent\'s own keys, passed through agent.connection.env_passthrough', ...env] : []),
    '',
  ].join('\n');
}

/** ves.gitlab-ci.yml (§6.5) from integrations/gitlab/ves.gitlab-ci.yml with the harness pin filled in. */
export function gitlabSnippet(harnessRoot: string, g: InitPlan['gitlab']): string {
  const t = readFileSync(join(harnessRoot, 'integrations', 'gitlab', 'ves.gitlab-ci.yml'), 'utf8');
  return t.replace(/VES_REPO: ".*"/, `VES_REPO: "${g.repo}"`).replace(/VES_REF: ".*"/, `VES_REF: "${g.ref}"`).replace(/VES_SUBDIR: ".*"/, `VES_SUBDIR: "${g.subdir}"`);
}

/** ves/setup-base.sh: installs the base branch's dependencies for the run-base baseline (§6.4), isolated from the
 *  PR head's install (pip goes into .ves-base-venv, which `ves ci baseline` puts first on PATH; npm/uv/poetry
 *  environments are per-directory already, and the script runs inside the base worktree). */
export function setupBase(p: InitPlan): string {
  const s = runtimeSteps(p.facts, p.entry).filter((l) => l.trim().startsWith('- run:')).map((l) => l.replace(/^\s*- run:\s*/, ''));
  const pip = s.some((x) => /^pip install/.test(x));
  const body = pip ? ['python -m venv .ves-base-venv', '. .ves-base-venv/bin/activate', ...s] : s;
  return ['#!/usr/bin/env bash', '# Run by `ves ci baseline --mode run-base` inside the base-branch worktree before it runs the base agent.', '# Keep it isolated from the PR head install. Edit if the base needs a different install.', 'set -euo pipefail', ...(body.length ? body : ['true']), ''].join('\n');
}

/** Bridge source for a command connection: examples/<id>/bridge.* in the harness (connectors package). */
export function bridgeSource(harnessRoot: string, entry: ExampleIndexEntry): { from: string; to: string } | null {
  if (entry.connection.type !== 'command') return null;
  const cands = [entry.bridge, ...(existsSync(join(harnessRoot, 'examples', entry.id)) ? readdirSync(join(harnessRoot, 'examples', entry.id)).filter((n) => n.startsWith('bridge.')).map((n) => `examples/${entry.id}/${n}`) : [])].filter((x): x is string => !!x);
  for (const c of cands) if (existsSync(join(harnessRoot, c))) return { from: join(harnessRoot, c), to: `ves/bridge.${c.split('.').pop()}` };
  return null;
}
