// ci package: `ves init` framework detection on fixture repos (one per examples/index.json entry), the --dry-run
// snapshot, file writing (never overwriting), the doctor step through a fake connector, and the offline check.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BUILTIN_EXAMPLES, detectFramework, loadExampleIndex, pickByFlag, pyprojectDeps, REQUIRED_EXAMPLE_IDS, requirementsDeps } from '../../src/cli/init-detect.ts';
import { runInit } from '../../src/cli/init.ts';
import { resolveConfig } from '../../src/config/load.ts';
import { validate } from '../../src/lib/jsonschema.ts';
import { mockFactory } from '../../src/core/mock-agent.ts';
import type { ConnectorFactory, ExampleIndexEntry } from '../../src/core/types.ts';
import { cleanup, copyFixture, deps, fakeExec, FIX, ROOT, tmpDir } from './helpers.ts';

after(cleanup);
const REPOS = join(FIX, 'repos');
const SNAP = join(FIX, 'snapshots', 'init-openai-agents-python.dry-run.txt');
/** A harness root without examples/ bridges, so snapshots do not change when the connectors package lands. */
function isolatedHarness(): string {
  const h = tmpDir('harness-iso');
  mkdirSync(join(h, 'examples'), { recursive: true });
  writeFileSync(join(h, 'examples', 'index.json'), '[]');
  cpSync(join(ROOT, 'integrations'), join(h, 'integrations'), { recursive: true });
  return h;
}

test('detection: every required examples/index.json entry has a fixture repo and is detected as itself', () => {
  assert.equal(REQUIRED_EXAMPLE_IDS.length, 16);
  const { entries } = loadExampleIndex(ROOT);
  for (const id of REQUIRED_EXAMPLE_IDS) {
    assert.ok(existsSync(join(REPOS, id)), `fixture repo for ${id}`);
    const d = detectFramework(join(REPOS, id), entries);
    assert.equal(d.best?.entry.id, id, `${id}: got ${d.candidates.map((c) => `${c.entry.id}:${c.score}`).join(' ')}`);
    assert.equal(d.ambiguous, false, `${id} is unambiguous`);
  }
});

test('detection: ambiguity, nothing to detect, --framework by id or by framework name', () => {
  const amb = detectFramework(join(REPOS, '_ambiguous'), BUILTIN_EXAMPLES);
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(amb.candidates.filter((c) => c.score === amb.best!.score).map((c) => c.entry.id).sort(), ['claude-agent-sdk-ts', 'openai-agents-ts']);
  assert.equal(detectFramework(join(REPOS, '_empty'), BUILTIN_EXAMPLES).best, null);
  const facts = detectFramework(join(REPOS, 'plain-python'), BUILTIN_EXAMPLES).facts;
  assert.equal(pickByFlag('langgraph', BUILTIN_EXAMPLES, facts)?.id, 'langgraph-python', 'python repo -> python flavour');
  assert.equal(pickByFlag('langgraph', BUILTIN_EXAMPLES, detectFramework(join(REPOS, 'plain-node'), BUILTIN_EXAMPLES).facts)?.id, 'langgraph-js');
  assert.equal(pickByFlag('crewai', BUILTIN_EXAMPLES, facts)?.id, 'crewai');
  assert.equal(pickByFlag('nope', BUILTIN_EXAMPLES, facts), null);
});

test('detection: manifest parsing ignores keywords/classifiers, handles extras, groups, poetry and requirements', () => {
  assert.deepEqual(pyprojectDeps('[project]\nkeywords = ["mcp"]\nclassifiers = ["Framework :: Pydantic"]\ndependencies = [\n "openai-agents>=0.3",\n "crewai[tools]==1.0",\n]\n[dependency-groups]\ndev = ["pytest"]\n[tool.poetry.dependencies]\npython = "^3.12"\nLangGraph = "*"\n').sort(), ['crewai', 'langgraph', 'openai-agents', 'pytest']);
  assert.deepEqual(requirementsDeps('# c\n-r base.txt\npydantic_ai-slim[openai]>=1  # x\n\nclaude-agent-sdk==0.1\n'), ['pydantic-ai-slim', 'claude-agent-sdk']);
});

test('detection: examples/index.json entries replace built-in ones by id (connectors -> ci contract)', () => {
  const harness = tmpDir('harness');
  const entry: ExampleIndexEntry = { ...BUILTIN_EXAMPLES[0], rank: 1, deps_note: 'pip install openai-agents==0.4.2', connection: { type: 'command', command: ['python', 'ves/bridge.py', '--pinned'] } };
  mkdirSync(join(harness, 'examples'), { recursive: true });
  writeFileSync(join(harness, 'examples', 'index.json'), JSON.stringify([entry]));
  const r = loadExampleIndex(harness);
  assert.equal(r.source, 'merged');
  assert.equal(r.entries.length, 16);
  assert.deepEqual(r.entries.find((x) => x.id === 'openai-agents-python')?.connection, entry.connection);
  writeFileSync(join(harness, 'examples', 'index.json'), '[]');
  assert.equal(loadExampleIndex(harness).source, 'builtin', 'an empty index falls back to the built-in table');
});

test('init --dry-run: writes nothing and prints every planned file (snapshot)', async () => {
  const repo = copyFixture(join(REPOS, 'openai-agents-python'), 'dry');
  const d = { ...deps({ cwd: repo }), harnessRoot: isolatedHarness() };
  const code = await runInit(['--dry-run'], d);
  assert.equal(code, 0, d.err.join(''));
  assert.ok(!existsSync(join(repo, 'ves.config.json')), 'dry run writes nothing');
  const out = d.out.join('');
  if (process.env.VES_UPDATE_SNAPSHOTS === '1') { mkdirSync(dirname(SNAP), { recursive: true }); writeFileSync(SNAP, out); }
  assert.equal(out, readFileSync(SNAP, 'utf8'), 'dry-run output matches the snapshot (VES_UPDATE_SNAPSHOTS=1 to refresh)');
  for (const f of ['ves.config.json', 'evals/cases/example.case.json.example', 'evals/fixtures/state.json', '.github/workflows/ves.yml', 'ves/setup-base.sh', '.gitignore (append)']) assert.ok(out.includes(`--- ${f}`), f);
  assert.match(out, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(out, /ZENDESK_API_KEY: \$\{\{ secrets\.ZENDESK_API_KEY \}\}/, 'secrets from .env.example');
  assert.match(out, /- uses: <org>\/ves\/integrations\/github-action@<40-hex-sha>/);
  assert.match(d.err.join(''), /detected openai-agents-python .*python dependency: openai-agents/);
});

test('init writes a valid config + workflow, pins the action from the harness git remote, never overwrites', async () => {
  const repo = copyFixture(join(REPOS, 'openai-agents-ts'), 'write');
  const sha = 'a'.repeat(40);
  const { exec, calls } = fakeExec((c) => {
    if (c.cmd === 'git' && c.args.join(' ') === 'remote get-url origin') return { stdout: 'git@github.com:acme/ves.git\n' };
    if (c.cmd === 'git' && c.args.join(' ') === 'rev-parse HEAD') return { stdout: `${sha}\n` };
    if (c.cmd === 'git' && c.args.join(' ') === 'rev-parse --show-toplevel') return { stdout: dirname(harness) + '\n' };
    if (c.cmd === process.execPath && c.args[1] === 'validate') return { stdout: '{"ok":true}' };
    if (c.cmd === process.execPath && c.args[1] === 'run') return { stdout: '{"verdict":"PASS","run_dir":"/x/ves-1","run_id":"ves-1"}' };
    return undefined;
  });
  const harness = isolatedHarness();
  const d = { ...deps({ cwd: repo, exec }), harnessRoot: harness };
  assert.equal(await runInit(['--no-doctor'], d), 0, d.err.join(''));
  const cfg = JSON.parse(readFileSync(join(repo, 'ves.config.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'config-1.schema.json'), 'utf8'));
  assert.deepEqual(validate(schema, cfg), [], 'config-1 schema valid');
  const r = resolveConfig(cfg, { dir: repo, path: join(repo, 'ves.config.json'), env: { GOOGLE_CLOUD_PROJECT: 'p' } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.conformance, 'VES-1', 'init never loosens a bar');
  assert.equal(cfg.agent.framework, 'openai-agents');
  assert.deepEqual(cfg.agent.connection, { type: 'command', command: ['node', 'ves/bridge.ts'], env_passthrough: ['OPENAI_API_KEY'] });
  assert.deepEqual(cfg.change_classes['2'].slice(0, 1), ['src/**']);
  const wf = readFileSync(join(repo, '.github/workflows/ves.yml'), 'utf8');
  assert.match(wf, new RegExp(`- uses: acme/ves/${basename(harness)}/integrations/github-action@a{40}   # pin by full SHA`));
  assert.match(wf, /- run: npm ci/);
  assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /ves-results\/\n\.ves-cache\//);
  assert.ok(calls.some((c) => c.args[1] === 'validate'), 'offline check: validate');
  assert.ok(calls.some((c) => c.args[1] === 'run' && c.args.includes('--connection') && c.args.includes('mock')), 'offline check: $0 mock smoke run');
  // second run: refuses without --force; --force keeps nothing stale
  const d2 = deps({ cwd: repo, exec });
  const before = readFileSync(join(repo, 'ves.config.json'), 'utf8');
  assert.equal(await runInit(['--no-doctor', '--no-check'], d2), 0, 'an initialised repo is a no-op');
  assert.match(d2.err.join(''), /already exists; nothing written/);
  assert.equal(readFileSync(join(repo, 'ves.config.json'), 'utf8'), before);
  writeFileSync(join(repo, 'evals/fixtures/state.json'), '{"mine":1}');
  const d3 = deps({ cwd: repo, exec });
  assert.equal(await runInit(['--no-doctor', '--no-check', '--force'], d3), 0);
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8').match(/ves-results\//g)?.length, 1, '.gitignore not appended twice');
});

test('init: ambiguity needs --framework or --yes; unknown repos need --framework; --ci gitlab writes the snippet', async () => {
  const amb = copyFixture(join(REPOS, '_ambiguous'), 'amb');
  const d = deps({ cwd: amb });
  assert.equal(await runInit(['--no-doctor', '--no-check'], d), 3);
  assert.match(d.err.join(''), /more than one framework fits[\s\S]*claude-agent-sdk-ts[\s\S]*openai-agents-ts/);
  const d2 = deps({ cwd: amb });
  assert.equal(await runInit(['--yes', '--no-doctor', '--no-check', '--ci', 'gitlab'], d2), 0, d2.err.join(''));
  assert.match(d2.err.join(''), /--yes picked claude-agent-sdk-ts/);
  const gl = readFileSync(join(amb, 'ves.gitlab-ci.yml'), 'utf8');
  assert.match(gl, /ci context --gitlab/);
  assert.ok(!existsSync(join(amb, '.github')), 'no GitHub workflow with --ci gitlab');
  assert.deepEqual(JSON.parse(readFileSync(join(amb, 'ves.config.json'), 'utf8')).agent.connection.env_passthrough, ['ANTHROPIC_API_KEY']);
  const empty = copyFixture(join(REPOS, '_empty'), 'empty');
  const d3 = deps({ cwd: empty });
  assert.equal(await runInit(['--no-doctor', '--no-check'], d3), 3);
  assert.match(d3.err.join(''), /could not detect .* Pass --framework <id>/);
  const d4 = deps({ cwd: empty });
  assert.equal(await runInit(['--framework', 'http-server', '--no-doctor', '--no-check', '--ci', 'none'], d4), 0);
  assert.equal(JSON.parse(readFileSync(join(empty, 'ves.config.json'), 'utf8')).agent.connection.type, 'http');
});

test('init: MCP servers get the contract variant and mcp-conformance; uv projects run through uv', async () => {
  const mcp = copyFixture(join(REPOS, 'mcp-server-node'), 'mcp');
  const d = { ...deps({ cwd: mcp }), harnessRoot: isolatedHarness() };   // built-in table: stdio + the package bin
  assert.equal(await runInit(['--no-doctor', '--no-check'], d), 0, d.err.join(''));
  const c = JSON.parse(readFileSync(join(mcp, 'ves.config.json'), 'utf8'));
  assert.deepEqual(c.agent.connection, { type: 'mcp', transport: 'stdio', command: ['node', 'dist/server.js'], mode: 'contract' });
  assert.deepEqual(c.variants, { contract: { role: 'contract', capabilities: ['rpc'] } }, 'rpc: the transcript checks need it (dogfood fix)');
  assert.deepEqual(c.packs, ['mcp-conformance']);
  assert.equal(c.tools.schemas_from, 'mcp');
  const lg = copyFixture(join(REPOS, 'langgraph-python'), 'uv');
  const d2 = { ...deps({ cwd: lg }), harnessRoot: isolatedHarness() };
  assert.equal(await runInit(['--no-doctor', '--no-check'], d2), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(lg, 'ves.config.json'), 'utf8')).agent.connection.command, ['uv', 'run', 'python', 'ves/bridge.py']);
  assert.match(readFileSync(join(lg, '.github/workflows/ves.yml'), 'utf8'), /astral-sh\/setup-uv@v6[\s\S]*uv sync --frozen/);
  // with the real harness (connectors' examples/index.json, when present) an MCP server still gets the contract setup
  const mcp2 = copyFixture(join(REPOS, 'mcp-server-node'), 'mcp2');
  assert.equal(await runInit(['--no-doctor', '--no-check'], deps({ cwd: mcp2 })), 0);
  const c2 = JSON.parse(readFileSync(join(mcp2, 'ves.config.json'), 'utf8'));
  assert.equal(c2.agent.connection.type, 'mcp');
  assert.equal(c2.agent.connection.mode, 'contract');
  assert.deepEqual(c2.packs, ['mcp-conformance']);
});

test('init with the real harness copies the bridge the index names and points the command at it', async () => {
  const { entries } = loadExampleIndex(ROOT);
  const e = entries.find((x) => x.id === 'openai-agents-python')!;
  if (!e.bridge || !existsSync(join(ROOT, e.bridge))) return;   // connectors package not installed: nothing to copy
  const repo = copyFixture(join(REPOS, 'openai-agents-python'), 'bridge');
  const d = deps({ cwd: repo });
  assert.equal(await runInit(['--no-doctor', '--no-check'], d), 0, d.err.join(''));
  assert.equal(readFileSync(join(repo, 'ves', 'bridge.py'), 'utf8'), readFileSync(join(ROOT, e.bridge), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'ves.config.json'), 'utf8')).agent.connection.command, ['python', 'ves/bridge.py']);
});

test('init doctor: handshake through a connector, tools imported with review "suggested", example case written', async () => {
  const repo = copyFixture(join(REPOS, 'plain-node'), 'doctor');
  const fake: ConnectorFactory = {
    kind: 'command', version: 'fake@1',
    create: () => ({
      kind: 'command', version: 'fake@1', capabilities: () => new Set<string>(), routesHash: async () => 'x',
      health: async () => ({ ok: true }),
      info: async () => ({ name: 'plain-bot', capabilities: [], diffsFromProd: [], declaredTools: [
        { name: 'search_orders', description: 'Find orders', input_schema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false } },
        { name: 'refund_order', description: 'Refund an order', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
        { name: 'email_customer', description: 'Send an email' },
      ] }),
      open: async () => ({ id: 's' }), turn: async () => ({ status: 'done' }), decide: async () => ({ status: 'done' }), close: async () => {},
    }),
  };
  const d = deps({ cwd: repo });
  assert.equal(await runInit(['--no-check'], d, { connectors: { factories: new Map([['mock', mockFactory], ['command', fake]]), sources: {} } }), 0, d.err.join(''));
  const cfg = JSON.parse(readFileSync(join(repo, 'ves.config.json'), 'utf8'));
  const by = Object.fromEntries(cfg.tools.catalog.map((t: any) => [t.name, t]));
  assert.deepEqual(by.search_orders.classes, ['read']);
  assert.deepEqual(by.refund_order.classes, ['write', 'spend']);
  assert.deepEqual(by.email_customer.classes, ['write', 'outward']);
  assert.ok(cfg.tools.catalog.every((t: any) => t.review === 'suggested'));
  const err = d.err.join('');
  assert.match(err, /doctor: handshake ok \(plain-bot\); imported 3 tool\(s\)/);
  assert.match(err, /refund_order\s+write,spend\s+true/);
  assert.match(err, /set review: "confirmed"/);
  const ex = JSON.parse(readFileSync(join(repo, 'evals/cases/example.case.json'), 'utf8'));
  assert.equal(ex.id, 'example.read-search_orders');
  assert.deepEqual(validate(JSON.parse(readFileSync(join(ROOT, 'schemas', 'case-2.schema.json'), 'utf8')), ex), [], 'example case is case-2 valid');
  assert.deepEqual(resolveConfig(cfg, { dir: repo, env: {} }).errors, []);
});

test('init doctor: a missing connector is skipped with a clear note (connectors package not installed)', async () => {
  const repo = copyFixture(join(REPOS, 'plain-python'), 'nodoc');
  const d = deps({ cwd: repo });
  assert.equal(await runInit(['--no-check'], d, { connectors: { factories: new Map([['mock', mockFactory]]), sources: {} } }), 0);
  assert.match(d.err.join(''), /doctor skipped: connector command not installed/);
});
