// Regression tests for the dogfood fix pass (protocol/LOG.md row 7): three personas (a plain-Python agent, a TS
// agent behind HTTP, a stdio MCP server) found these. Child processes run the mock path only (no network).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { suggestClasses } from '../../src/catalog/suggest.ts';
import { glob } from '../../src/gate/classify-change.ts';
import { detectFramework, loadExampleIndex } from '../../src/cli/init-detect.ts';
import { cleanup, ROOT, tmpDir } from '../ci/helpers.ts';

after(cleanup);
const ves = (args: string[], cwd: string, bin = join(ROOT, 'src', 'cli.ts')) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
};
const minimalConfig = (catalog: unknown[] = [], packs: string[] = ['core-tool-use', 'hitl-approval']) => ({
  schema_version: 'ves-config/1', project: 'dogfood', agent: { name: 'a', connection: { type: 'command', command: ['node', 'agent.mjs'] } },
  tools: { backend: { type: 'sim' }, catalog }, packs, suites: [],
});

test('class suggestions: noun-verbs (post, message, email) in verb position only; read verbs win', () => {
  const c = (name: string, description?: string) => suggestClasses({ name, description }).classes.join(',');
  assert.equal(c('get_post', 'Read one post by id.'), 'read', 'get_post was write,outward: every read would need approval (false BLOCK)');
  assert.equal(c('search_posts', 'Search posts.'), 'read');
  assert.equal(c('list_messages'), 'read');
  assert.equal(c('save_draft', 'Save a draft post.'), 'write');
  assert.equal(c('publish_post', 'Publish a post.'), 'write,outward');
  assert.equal(c('send_email'), 'write,outward');
  assert.equal(c('charge_card'), 'write,spend');
  assert.equal(c('update_ticket', 'Email the customer the update'), 'write,outward', 'an imperative first word still counts');
});

test('change-class globs: **/ matches zero or more directories (root README.md is docs)', () => {
  assert.ok(glob('**/*.md').test('README.md'));
  assert.ok(glob('**/*.md').test('a/b/README.md'));
  assert.ok(!glob('docs/**').test('src/docs.ts'));
  const d = tmpDir('cc');
  writeFileSync(join(d, 'ves.config.json'), JSON.stringify({ ...minimalConfig(), change_classes: { '0': ['**/*.md'], '2': ['src/**'] } }));
  const r = ves(['classify-change', 'README.md'], d);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).change_class, 0, './ves.config.json is used without --config');
  assert.equal(JSON.parse(ves(['classify-change', 'src/agent.ts'], d).out).change_class, 2);
});

test('--help never runs a command: `ves init --help` writes nothing; unknown init flags are an error', () => {
  const d = tmpDir('help');
  writeFileSync(join(d, 'package.json'), '{"name":"x"}');
  for (const h of ['--help', '-h']) {
    const r = ves(['init', h], d);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /usage: ves init/);
  }
  assert.equal(existsSync(join(d, 'ves.config.json')), false);
  const bad = ves(['init', '--bogus', '--no-doctor', '--no-check'], d);
  assert.equal(bad.code, 3);
  assert.match(bad.err, /unknown option\(s\) --bogus/);
  assert.equal(existsSync(join(d, 'ves.config.json')), false);
  assert.equal(ves(['help', 'catalog'], d).code, 0);
  const bin = ves(['--help'], d, join(ROOT, 'bin', 'ves.mjs'));
  assert.equal(bin.code, 0, bin.err);
  assert.match(bin.out, /usage: ves <command>/);
});

test('a run that evaluates no case is INVALID, never PASS (init offline check on an empty catalog)', () => {
  const d = tmpDir('empty');
  writeFileSync(join(d, 'ves.config.json'), JSON.stringify(minimalConfig()));
  const r = ves(['run', '--connection', 'mock', '--json', '--out', join(d, 'out')], d);
  assert.equal(r.code, 2, r.err);
  const j = JSON.parse(r.out.trim().split('\n').pop()!);
  assert.equal(j.verdict, 'INVALID');
  const g = JSON.parse(readFileSync(join(j.run_dir, 'gate.json'), 'utf8'));
  assert.match(g.rules.find((x: { rule: string }) => x.rule.startsWith('V ')).detail, /no case was evaluated .*packs skipped: core-tool-use/);
});

test('agent packs are not applicable on contract variants (they would grade the harness, not the server)', () => {
  const out = tmpDir('contract');
  const r = ves(['run', '--config', join(ROOT, 'examples', 'mcp-server-python', 'ves.config.json'), '--connection', 'mock', '--packs', 'mcp-conformance,core-tool-use', '--json', '--out', out], ROOT);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out.trim().split('\n').pop()!);
  assert.equal(j.verdict, 'PASS', 'core-tool-use used to BLOCK G-2 in contract mode');
  const m = JSON.parse(readFileSync(join(j.run_dir, 'run.json'), 'utf8'));
  assert.ok(m.notes.some((n: string) => /agent-pack case\(s\) not applicable \(core-tool-use\)/.test(n)), m.notes.join('\n'));
  const rows = readFileSync(join(j.run_dir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!rows.some((x) => x.case_id.startsWith('core-tool-use.')), 'no core-tool-use rows on the contract variant');
});

test('catalog import merges into ves.config.json (existing entries kept), --print only prints', () => {
  const d = tmpDir('import');
  const cfg = minimalConfig([{ name: 'get_post', classes: ['read'], review: 'confirmed' }]);
  writeFileSync(join(d, 'ves.config.json'), JSON.stringify(cfg));
  writeFileSync(join(d, 'tools.json'), JSON.stringify([
    { type: 'function', function: { name: 'get_post', description: 'Read one post.', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'publish_post', description: 'Publish a post.', parameters: { type: 'object', properties: { id: { type: 'string' } } } } },
  ]));
  const p = ves(['catalog', 'import', '--from', 'openai-tools', 'tools.json', '--print'], d);
  assert.equal(p.code, 0, p.err);
  assert.equal(JSON.parse(readFileSync(join(d, 'ves.config.json'), 'utf8')).tools.catalog.length, 1, '--print writes nothing');
  const r = ves(['catalog', 'import', '--from', 'openai-tools', 'tools.json'], d);
  assert.equal(r.code, 0, r.err);
  const cat = JSON.parse(readFileSync(join(d, 'ves.config.json'), 'utf8')).tools.catalog;
  assert.deepEqual(cat.map((t: { name: string }) => t.name), ['get_post', 'publish_post']);
  assert.equal(cat[0].review, 'confirmed', 'an existing entry is kept as it is');
  assert.deepEqual(cat[1].classes, ['write', 'outward']);
  assert.equal(cat[1].review, 'suggested');
});

test('init detection: a package.json holding only the harness does not make a Python repo look like Node', () => {
  const d = tmpDir('pyrepo');
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "billing-agent"\ndependencies = []\n');
  mkdirSync(join(d, 'my_agent'));
  writeFileSync(join(d, 'my_agent', 'graph.py'), 'def run():\n    pass\n');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ devDependencies: { '@vibiz/evals': 'file:../ves' } }));
  const det = detectFramework(d, loadExampleIndex(ROOT).entries);
  assert.equal(det.best?.entry.id, 'plain-python');
  assert.equal(det.ambiguous, false);
  assert.equal(det.facts.name, 'billing-agent', 'the name comes from pyproject.toml');
  // a hand-rolled stdio MCP server (no SDK) is an MCP server, run over stdio
  const m = tmpDir('mcprepo');
  writeFileSync(join(m, 'package.json'), JSON.stringify({ devDependencies: { '@vibiz/evals': '*' } }));
  writeFileSync(join(m, 'server.mjs'), "process.stdin.on('data', () => {}); const M = { 'tools/list': 1 };\n");
  const mdet = detectFramework(m, loadExampleIndex(ROOT).entries);
  assert.equal(mdet.best?.entry.id, 'mcp-server-node');
});
