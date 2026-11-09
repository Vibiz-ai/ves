// examples/ (DESIGN-agnostic §1.9, §7.4): the index.json contract that `ves init` reads, the example configs, the
// framework bridge snippets, and the runnable plain-node example end to end. Also: core's registry discovers all five
// connectors by directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConnectors } from '../../src/registry/connectors.ts';
import { resolveConfig } from '../../src/config/load.ts';
import { runConfigOnce } from '../../src/runner/run-v2.ts';
import { realSpawn } from '../../src/connectors/_shared/spawn.ts';
import { registry, ROOT, supportDesk } from './helpers.ts';
import type { ExampleIndexEntry, VesConfig } from '../../src/core/types.ts';

const EX = join(ROOT, 'examples');
const index = JSON.parse(readFileSync(join(EX, 'index.json'), 'utf8')) as ExampleIndexEntry[];
const REQUIRED = ['openai-agents-python', 'openai-agents-ts', 'claude-agent-sdk-ts', 'claude-agent-sdk-python', 'vercel-ai-sdk', 'langgraph-python', 'langgraph-js', 'crewai', 'mastra', 'pydantic-ai', 'plain-python', 'plain-node', 'http-server', 'openai-compatible', 'mcp-server-node', 'mcp-server-python'];
const TMP = join(ROOT, 'results', `.test-connectors-ex-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));

test('core registry discovers the five connectors by directory (no shared file edited)', async () => {
  const reg = await loadConnectors(ROOT, true);
  for (const k of ['mock', 'command', 'http', 'openai-chat', 'mcp', 'trace']) assert.ok(reg.factories.has(k), k);
  assert.equal(reg.sources.command, 'src/connectors/command/index.ts');
});
test('examples/index.json: every required entry, ExampleIndexEntry shape, unique ids, bridges exist, connection kinds installed', async () => {
  const reg = await loadConnectors(ROOT, true);
  assert.deepEqual(index.map((e) => e.id).sort(), [...REQUIRED].sort());
  for (const e of index) {
    assert.deepEqual(Object.keys(e).sort(), ['bridge', 'connection', 'deps_note', 'detect', 'framework', 'id', 'language', 'rank'], e.id);
    assert.deepEqual(Object.keys(e.detect).sort(), ['files_any', 'grep_any', 'npm', 'pypi'], e.id);
    for (const k of ['pypi', 'npm', 'files_any', 'grep_any'] as const) assert.ok(Array.isArray(e.detect[k]), `${e.id}.detect.${k}`);
    assert.ok(Object.values(e.detect).some((v) => v.length), `${e.id} detects something`);
    assert.ok(reg.factories.has(e.connection.type), `${e.id}: connector ${e.connection.type}`);
    assert.equal(typeof e.rank, 'number');
    if (e.bridge !== null) assert.ok(existsSync(join(ROOT, e.bridge)), `${e.id}: ${e.bridge}`);
    assert.ok(e.deps_note.length > 10);
  }
});
test('framework bridges: short (< 120 lines), speak ves-agent/1, map the framework approval onto hitl.request, take tools from the proxy', () => {
  for (const e of index.filter((x) => x.bridge && /\/bridge\.(py|ts)$/.test(x.bridge))) {
    const src = readFileSync(join(ROOT, e.bridge!), 'utf8');
    assert.ok(src.split('\n').length < 120, `${e.bridge} is ${src.split('\n').length} lines`);
    for (const must of ['ves-agent/1', 'hitl.request', 'session.opened', 'turn.end', 'awaiting_hitl']) assert.ok(src.includes(must), `${e.bridge} lacks ${must}`);
    assert.ok(/tool_transport|tool_call/.test(src), `${e.bridge} must use the proxy (tool_transport.mcp.url or tool_call)`);
  }
});
const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('python examples parse (python3 ast)', { skip: hasPython ? false : 'python3 not installed' }, () => {
  const files = index.filter((e) => e.bridge?.endsWith('.py')).map((e) => join(ROOT, e.bridge!));
  files.push(join(EX, 'openai-agents-python', 'ves_trace_processor.py'));
  for (const f of files) execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', f]);
  assert.ok(files.length >= 7);
});
test('every example ves.config.json resolves with no errors (openai-compatible, MCP over http and stdio, plain agents, http server, trace)', () => {
  const dirs = readdirSync(EX).filter((d) => existsSync(join(EX, d, 'ves.config.json')));
  assert.deepEqual(dirs.sort(), ['http-server', 'mcp-server-node', 'mcp-server-python', 'openai-compatible', 'personas', 'plain-node', 'plain-python', 'trace']);
  for (const d of dirs) {
    const c = JSON.parse(readFileSync(join(EX, d, 'ves.config.json'), 'utf8')) as VesConfig;
    const r = resolveConfig(c, { dir: join(EX, d), env: { GOOGLE_CLOUD_PROJECT: 'demo-project', MCP_TEST_TOKEN: 't', AGENT_KEY: 'k' } });
    assert.deepEqual(r.errors, [], d);
    assert.equal(r.config.conformance, 'VES-1', `${d} keeps the VES-1 bars`);
    const ix = index.find((e) => e.id === d);
    if (ix) assert.equal(ix.connection.type, c.agent.connection.type, `${d}: index and config agree on the connection kind`);
  }
  const mcp = JSON.parse(readFileSync(join(EX, 'mcp-server-node', 'ves.config.json'), 'utf8'));
  assert.equal(mcp.tools.schemas_from, 'mcp');
  assert.ok(existsSync(join(dirname(join(EX, 'openai-compatible', 'ves.config.json')), 'prompts', 'system.md')));
});
test('examples/plain-node/agent.mjs (fake LLM, no network) passes the skeleton cases over `command` as a real child process', async () => {
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'command', command: [process.execPath, join(EX, 'plain-node', 'agent.mjs')] }; });
  const r = await runConfigOnce({ harnessRoot: ROOT, config: cfg, tier: 'smoke', trigger: 'pr', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, bootstrapN: 200, connectors: registry(), spawn: realSpawn, env: process.env });
  assert.equal(r.gate.verdict, 'PASS', JSON.stringify(r.gate.rules.filter((x) => x.status === 'fired')));
  assert.equal(r.manifest.connections.default.agent.name, 'plain-node-agent');
});
