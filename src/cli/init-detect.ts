// `ves init` framework detection (DESIGN-agnostic §5.1, §7.4). Reads the repo's manifests (package.json,
// pyproject.toml, requirements*.txt, uv.lock, go.mod) and greps a bounded set of source files, then scores every
// entry of examples/index.json. examples/index.json (connectors package) is authoritative; BUILTIN_EXAMPLES below
// is the fallback table so detection works before (or without) the connectors package, and an index entry with the
// same id replaces the built-in one.
//
// Scoring: a dependency hit (npm/pypi) is worth 3 (2 for a generic package many stacks pull in, WEAK_DEPS), a grep
// hit 2, a file hit 1, summed per entry. The best score wins;
// a tie between different frameworks at the top score is ambiguous (init then asks for --framework, or --yes takes
// the highest `rank`). Higher `rank` = preferred, the examples/index.json convention.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { ExampleIndexEntry } from '../core/types.ts';

const cmd = (command: string[]) => ({ type: 'command' as const, command });
const e = (id: string, framework: string, language: string, detect: Partial<ExampleIndexEntry['detect']>, connection: ExampleIndexEntry['connection'], bridge: string | null, deps_note: string, rank: number): ExampleIndexEntry =>
  ({ id, framework, language, detect: { pypi: [], npm: [], files_any: [], grep_any: [], ...detect }, connection, bridge, deps_note, rank });

/** The 16 required entries of DESIGN §7.4 with the signals of §5.1, kept in step with examples/index.json (the union
 *  of both signal sets). `rank`: HIGHER is preferred, as in examples/index.json (frameworks 10, plain 1). */
export const BUILTIN_EXAMPLES: ExampleIndexEntry[] = [
  e('openai-agents-python', 'openai-agents', 'python', { pypi: ['openai-agents'], grep_any: ['from agents import', 'from agents.mcp import'] }, cmd(['python', 'ves/bridge.py']), 'examples/openai-agents-python/bridge.py', 'pip install openai-agents', 10),
  e('openai-agents-ts', 'openai-agents', 'typescript', { npm: ['@openai/agents'] }, cmd(['node', 'ves/bridge.ts']), 'examples/openai-agents-ts/bridge.ts', 'npm i @openai/agents', 10),
  e('claude-agent-sdk-ts', 'claude-agent-sdk', 'typescript', { npm: ['@anthropic-ai/claude-agent-sdk'] }, cmd(['node', 'ves/bridge.ts']), 'examples/claude-agent-sdk-ts/bridge.ts', 'npm i @anthropic-ai/claude-agent-sdk', 10),
  e('claude-agent-sdk-python', 'claude-agent-sdk', 'python', { pypi: ['claude-agent-sdk'] }, cmd(['python', 'ves/bridge.py']), 'examples/claude-agent-sdk-python/bridge.py', 'pip install claude-agent-sdk', 10),
  e('mastra', 'mastra', 'typescript', { npm: ['@mastra/core', '@mastra/mcp'] }, cmd(['node', 'ves/bridge.ts']), 'examples/mastra/bridge.ts', 'npm i @mastra/core @mastra/mcp', 10),
  e('langgraph-python', 'langgraph', 'python', { pypi: ['langgraph', 'langchain-mcp-adapters'], grep_any: ['from langgraph'] }, cmd(['python', 'ves/bridge.py']), 'examples/langgraph-python/bridge.py', 'pip install langgraph langchain-mcp-adapters', 10),
  e('langgraph-js', 'langgraph', 'typescript', { npm: ['@langchain/langgraph', '@langchain/mcp-adapters'] }, cmd(['node', 'ves/bridge.ts']), 'examples/langgraph-js/bridge.ts', 'npm i @langchain/langgraph @langchain/mcp-adapters', 10),
  e('crewai', 'crewai', 'python', { pypi: ['crewai', 'crewai-tools'], grep_any: ['from crewai import'] }, cmd(['python', 'ves/bridge.py']), 'examples/crewai/bridge.py', 'pip install crewai crewai-tools[mcp]', 10),
  e('pydantic-ai', 'pydantic-ai', 'python', { pypi: ['pydantic-ai', 'pydantic-ai-slim'], grep_any: ['from pydantic_ai import'] }, cmd(['python', 'ves/bridge.py']), 'examples/pydantic-ai/bridge.py', 'pip install pydantic-ai', 10),
  e('vercel-ai-sdk', 'vercel-ai-sdk', 'typescript', { npm: ['ai'], grep_any: ["from 'ai'", 'from "ai"'] }, cmd(['node', 'ves/bridge.ts']), 'examples/vercel-ai-sdk/bridge.ts', 'npm i ai @ai-sdk/mcp', 9),
  e('mcp-server-node', 'mcp-server', 'typescript', { npm: ['@modelcontextprotocol/sdk'], grep_any: ['new McpServer(', 'StreamableHTTPServerTransport', '"tools/list"', "'tools/list'"] }, { type: 'mcp', transport: 'stdio', command: ['node', 'index.js'], mode: 'contract' }, null, 'npm i @modelcontextprotocol/sdk', 8),
  e('mcp-server-python', 'mcp-server', 'python', { pypi: ['mcp', 'fastmcp'], grep_any: ['FastMCP(', 'from mcp.server', '"tools/list"', "'tools/list'"] }, { type: 'mcp', transport: 'stdio', command: ['python', 'server.py'], mode: 'contract' }, null, 'pip install mcp', 8),
  e('openai-compatible', 'openai-compatible', 'any', { pypi: ['litellm', 'vllm'], files_any: ['litellm_config.yaml', 'litellm.config.yaml', 'Modelfile'], grep_any: ['/v1/chat/completions'] }, { type: 'openai-chat', base_url: 'http://127.0.0.1:4000/v1', model: 'agent' }, null, 'start your server before ves run', 7),
  e('http-server', 'http', 'any', { pypi: ['fastapi', 'flask', 'langserve'], npm: ['express', 'fastify', 'hono', 'next', '@langchain/langserve'], files_any: ['go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Gemfile'] }, { type: 'http', base_url: 'http://127.0.0.1:8000' }, 'examples/http-server/agent.ts', 'implement ves-agent/1 over HTTP (see examples/http-server)', 5),
  e('plain-python', 'plain-python', 'python', { files_any: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'uv.lock'] }, cmd(['python', 'ves/bridge.py']), 'examples/plain-python/agent.py', 'stdlib only', 1),
  e('plain-node', 'plain-node', 'javascript', { files_any: ['package.json'] }, cmd(['node', 'ves/bridge.mjs']), 'examples/plain-node/agent.mjs', 'node >= 22.18', 1),
];
export const REQUIRED_EXAMPLE_IDS = BUILTIN_EXAMPLES.map((x) => x.id);

/** examples/index.json merged over the built-in table (same id: the index wins). */
export function loadExampleIndex(harnessRoot: string): { entries: ExampleIndexEntry[]; source: 'index' | 'builtin' | 'merged' } {
  const f = join(harnessRoot, 'examples', 'index.json');
  let idx: ExampleIndexEntry[] = [];
  if (existsSync(f)) { try { const j = JSON.parse(readFileSync(f, 'utf8')); if (Array.isArray(j)) idx = j.filter((x) => x && typeof x.id === 'string' && x.detect); } catch { idx = []; } }
  if (!idx.length) return { entries: BUILTIN_EXAMPLES, source: 'builtin' };
  const byId = new Map(BUILTIN_EXAMPLES.map((x) => [x.id, x]));
  const blank: ExampleIndexEntry['detect'] = { pypi: [], npm: [], files_any: [], grep_any: [] };
  for (const x of idx) byId.set(x.id, { ...x, detect: Object.assign({}, blank, x.detect) });
  return { entries: [...byId.values()], source: idx.length >= BUILTIN_EXAMPLES.length ? 'index' : 'merged' };
}

export type RepoFacts = {
  root: string; name: string;
  npm: Set<string>; pypi: Set<string>; files: Set<string>;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  python: { manager: 'pip' | 'uv' | 'poetry' | null; requirements: string | null; pyproject: boolean };
  hasGoMod: boolean; dirs: string[]; envKeys: string[]; grepCorpus: { file: string; text: string }[];
  packageJson: Record<string, any> | null;
};

/** The harness's own package names (a package.json holding only these is the harness install, not the agent). */
export const HARNESS_PACKAGES = new Set(['@vibiz/evals', 'ves', 'ves-evals']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build', '.next', '.turbo', 'target', 'ves-results', '.ves-cache', 'coverage', '.mypy_cache', '.pytest_cache']);
const SRC_EXT = /\.(py|ts|tsx|js|mjs|cjs|go|rs|java|kt|rb)$/;
const normPy = (s: string): string => s.trim().toLowerCase().replace(/[_.]+/g, '-');

/** Dependency names from pyproject.toml (PEP 621, PEP 735 groups, uv, Poetry) without a TOML parser. Only
 *  dependency keys are read, so `keywords = ["mcp"]` or classifiers never count as dependencies. */
export function pyprojectDeps(text: string): string[] {
  const out = new Set<string>();
  const sections: { name: string; body: string }[] = [];
  let cur = { name: '', body: '' };
  for (const line of text.split('\n')) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (h) { sections.push(cur); cur = { name: h[1].trim(), body: '' }; } else cur.body += line + '\n';
  }
  sections.push(cur);
  const reqStrings = (arr: string) => { for (const m of arr.matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@ ][^"']*)?["']/g)) out.add(normPy(m[1])); };
  const arrays = (body: string, keys: RegExp) => { for (const m of body.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*\[([\s\S]*?)\]\s*(?:#.*)?$/gm)) if (keys.test(m[1])) reqStrings(m[2]); };
  for (const sec of sections) {
    if (sec.name === 'project') arrays(sec.body, /^dependencies$/);
    else if (sec.name === 'project.optional-dependencies' || sec.name === 'dependency-groups') arrays(sec.body, /.*/);
    else if (sec.name === 'tool.uv') arrays(sec.body, /^dev-dependencies$/);
    else if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(sec.name)) for (const m of sec.body.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) out.add(normPy(m[1]));
  }
  out.delete('python');
  return [...out];
}
export function requirementsDeps(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l && !l.startsWith('-'))
    .map((l) => /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l)?.[1]).filter((x): x is string => !!x).map(normPy);
}

export function scanRepo(root: string, o: { maxFiles?: number; maxBytes?: number; maxDepth?: number } = {}): RepoFacts {
  const maxFiles = o.maxFiles ?? 1500, maxBytes = o.maxBytes ?? 256 * 1024, maxDepth = o.maxDepth ?? 5;
  const has = (f: string) => existsSync(join(root, f));
  const read = (f: string) => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } };
  const npm = new Set<string>(), pypi = new Set<string>(), files = new Set<string>();
  let packageJson: Record<string, any> | null = null;
  if (has('package.json')) {
    try { packageJson = JSON.parse(read('package.json')); } catch { packageJson = null; }
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const d of Object.keys(packageJson?.[k] ?? {})) npm.add(d);
  }
  const top = existsSync(root) ? readdirSync(root) : [];
  for (const n of top) files.add(n);
  const reqFiles = top.filter((n) => /^requirements.*\.txt$/.test(n)).sort();
  for (const r of reqFiles) for (const d of requirementsDeps(read(r))) pypi.add(d);
  if (has('pyproject.toml')) for (const d of pyprojectDeps(read('pyproject.toml'))) pypi.add(d);
  if (has('uv.lock')) for (const m of read('uv.lock').matchAll(/^name\s*=\s*"([^"]+)"/gm)) pypi.add(normPy(m[1]));
  if (has('Pipfile')) for (const m of read('Pipfile').matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) pypi.add(normPy(m[1]));

  const grepCorpus: { file: string; text: string }[] = [];
  let count = 0;
  const walk = (d: string, depth: number) => {
    if (depth > maxDepth || count >= maxFiles) return;
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (count >= maxFiles) return;
      if (SKIP_DIRS.has(n) || (n.startsWith('.') && n !== '.github')) continue;
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (SRC_EXT.test(n) && st.size <= maxBytes) { count++; try { grepCorpus.push({ file: relative(root, p), text: readFileSync(p, 'utf8') }); } catch { /* unreadable */ } }
    }
  };
  if (existsSync(root)) walk(root, 0);

  // a package.json that only holds the harness (`npm i -D @vibiz/evals` in a Python repo creates one) is not a Node
  // signal (dogfood fix 2026-11-07: a Python repo then looked ambiguous, `--yes` picked plain-node, and the project
  // name came from that file)
  const depNames = packageJson ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(packageJson?.[k] ?? {})) : [];
  const harnessOnly = !!packageJson && depNames.every((d) => HARNESS_PACKAGES.has(d)) && !packageJson.main && !packageJson.bin
    && grepCorpus.some((x) => x.file.endsWith('.py')) && !grepCorpus.some((x) => /\.(m?[jt]s|cjs|tsx)$/.test(x.file));
  if (harnessOnly) { packageJson = null; npm.clear(); files.delete('package.json'); files.delete('package-lock.json'); }
  const packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : packageJson ? 'npm' : null;
  const pyManager = has('uv.lock') ? 'uv' : has('poetry.lock') ? 'poetry' : reqFiles.length || has('pyproject.toml') || has('setup.py') ? 'pip' : null;
  const envKeys = new Set<string>();
  for (const f of ['.env.example', '.env.sample', '.env.template', 'env.example']) for (const m of read(f).matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET))\s*=/gm)) envKeys.add(m[1]);
  const dirs = top.filter((n) => { try { return statSync(join(root, n)).isDirectory() && !SKIP_DIRS.has(n) && !n.startsWith('.'); } catch { return false; } }).sort();
  const rawName = String(packageJson?.name ?? (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(read('pyproject.toml'))?.[1] ?? basename(root)));
  return {
    root, name: rawName.replace(/^@[^/]+\//, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100) || 'agent',
    npm, pypi, files, packageManager, python: { manager: pyManager, requirements: reqFiles.includes('requirements.txt') ? 'requirements.txt' : reqFiles[0] ?? null, pyproject: has('pyproject.toml') },
    hasGoMod: has('go.mod'), dirs, envKeys: [...envKeys].sort(), grepCorpus, packageJson,
  };
}

/** Packages many stacks depend on without being built on them: Mastra apps carry `ai`, agents carry MCP clients, and
 *  a web framework alone does not make the repo an "agent behind HTTP" when an agent framework is also present. */
export const WEAK_DEPS = new Set(['ai', 'mcp', '@modelcontextprotocol/sdk', 'langchain', 'openai', 'express', 'fastify', 'hono', 'next', 'fastapi', 'flask']);

export type Candidate = { entry: ExampleIndexEntry; score: number; signals: string[] };
export type Detection = { candidates: Candidate[]; best: Candidate | null; ambiguous: boolean; facts: RepoFacts };

export function scoreEntry(entry: ExampleIndexEntry, f: RepoFacts): Candidate {
  const signals: string[] = [];
  let score = 0;
  const npmHit = entry.detect.npm.filter((d) => f.npm.has(d));
  const pyHit = entry.detect.pypi.filter((d) => f.pypi.has(normPy(d)));
  const depScore = (hits: string[]) => (hits.some((d) => !WEAK_DEPS.has(d)) ? 3 : 2);
  if (npmHit.length) { score += depScore(npmHit); signals.push(...npmHit.map((d) => `package.json: ${d}`)); }
  if (pyHit.length) { score += depScore(pyHit); signals.push(...pyHit.map((d) => `python dependency: ${d}`)); }
  // a grep signal counts only in files of the entry's language (a hand-rolled MCP server in server.mjs is not a Python
  // MCP server because both contain "tools/list")
  const langOk = (file: string) => (entry.language === 'python' ? file.endsWith('.py') : entry.language === 'typescript' || entry.language === 'javascript' ? /\.(m?[jt]s|cjs|tsx|jsx)$/.test(file) : true);
  const grepHit = entry.detect.grep_any.map((g) => ({ g, file: f.grepCorpus.find((x) => langOk(x.file) && x.text.includes(g))?.file })).filter((x) => x.file);
  if (grepHit.length) { score += 2; signals.push(...grepHit.slice(0, 2).map((x) => `grep "${x.g}" in ${x.file}`)); }
  const fileHit = entry.detect.files_any.filter((x) => f.files.has(x));
  if (fileHit.length) { score += 1; signals.push(...fileHit.map((x) => `file ${x}`)); }
  return { entry, score, signals };
}

export function detectFramework(root: string, entries: ExampleIndexEntry[]): Detection {
  const facts = scanRepo(root);
  const candidates = entries.map((x) => scoreEntry(x, facts)).filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.rank - a.entry.rank || (a.entry.id < b.entry.id ? -1 : 1));
  const best = candidates[0] ?? null;
  const top = best ? candidates.filter((c) => c.score === best.score) : [];
  const ambiguous = new Set(top.map((c) => c.entry.framework)).size > 1;
  return { candidates, best, ambiguous, facts };
}

/** Resolve `--framework <x>`: an entry id, or a framework name (highest rank, language-matched to the repo if possible). */
export function pickByFlag(flag: string, entries: ExampleIndexEntry[], facts: RepoFacts): ExampleIndexEntry | null {
  const byId = entries.find((x) => x.id === flag);
  if (byId) return byId;
  const same = entries.filter((x) => x.framework === flag).sort((a, b) => b.rank - a.rank);
  if (!same.length) return null;
  const py = facts.pypi.size > 0 || facts.python.manager !== null;
  const js = facts.packageJson !== null;
  return same.find((x) => (py && !js ? x.language === 'python' : js && !py ? x.language !== 'python' : true)) ?? same[0];
}
