// ci package: lint the composite action and the GitLab template as TEXT (no YAML dependency). Every
// `steps.<id>.outputs.<key>` referenced must be emitted by the `ves ci` subcommand that step runs; every input used
// is declared; every `ves run` flag used is one the CLI reads; every $VES_* the GitLab job reads is exported.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciMain } from '../../src/cli/ci.ts';
import { contextExports, contextOutputs, computeContext } from '../../src/cli/ci-context.ts';
import { cleanup, deps, fakeExec, parseExports, parseGithubOutput, ROOT, RUNS, tmpDir } from './helpers.ts';

after(cleanup);
const ACTION = readFileSync(join(ROOT, 'integrations', 'github-action', 'action.yml'), 'utf8');
const GITLAB = readFileSync(join(ROOT, 'integrations', 'gitlab', 'ves.gitlab-ci.yml'), 'utf8');

/** Splits `runs.steps` into blocks (each starts at a `    - ` line) with their id and text. */
function steps(): { id: string | null; text: string }[] {
  const body = ACTION.slice(ACTION.indexOf('\n  steps:\n'));
  return body.split(/\n(?=    - )/).slice(1).map((t) => ({ id: /(?:^|\n)\s*-?\s*id: ([\w-]+)/.exec(t)?.[1] ?? null, text: t }));
}

/** The keys each `ves ci <sub>` actually writes to $GITHUB_OUTPUT, obtained by running it against fakes. */
async function emittedKeys(): Promise<Record<string, Set<string>>> {
  const keys: Record<string, Set<string>> = {};
  const ws = tmpDir('lint-ws');
  writeFileSync(join(ws, 'ves.config.json'), JSON.stringify({ schema_version: 'ves-config/1', project: 'p', agent: { name: 'a', connection: { type: 'mock' } }, tools: { catalog: [] } }));
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_WORKSPACE: ws, GITHUB_SHA: 'a'.repeat(40), RUNNER_TEMP: tmpDir('lint-tmp') };
  const c = await computeContext({ provider: 'github', env, deps: { exec: fakeExec(() => ({ code: 1 })).exec, harnessRoot: ROOT } });
  keys.context = new Set(Object.keys(contextOutputs(c)));
  const run = async (argv: string[], e: Record<string, string> = env) => { const d = deps({ env: e, cwd: ws, exec: fakeExec(() => ({ code: 1 })).exec }); await ciMain(argv, d); return new Set(Object.keys(parseGithubOutput(d.out.join('')))); };
  keys.baseline = await run(['baseline', '--mode', 'none']);
  const f = join(tmpDir('lint-out'), 'run.json');
  writeFileSync(f, '{}');
  keys.outputs = await run(['outputs', '--from', f, '--exit', '0']);
  const runCopy = join(tmpDir('lint-run'), 'r');
  (await import('node:fs')).cpSync(RUNS.pass, runCopy, { recursive: true });
  keys.comment = await run(['comment', '--run', runCopy]);   // skipped branch (not a PR) emits the same keys as success
  return keys;
}

test('action.yml: every steps.*.outputs.* reference is emitted by the step it names', async () => {
  const st = steps();
  const ids = new Map(st.filter((s) => s.id).map((s) => [s.id!, s.text]));
  assert.deepEqual([...ids.keys()], ['ctx', 'baseline', 'run', 'comment']);
  const sub = (t: string) => [...t.matchAll(/src\/cli\.ts" ci (\w+)/g)].map((m) => m[1]).pop();
  const emitted = await emittedKeys();
  const refs = [...ACTION.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)].map((m) => ({ id: m[1], key: m[2] }));
  assert.ok(refs.length >= 15, `found ${refs.length} references`);
  for (const r of refs) {
    assert.ok(ids.has(r.id), `step id ${r.id} exists`);
    const s = sub(ids.get(r.id)!);
    assert.ok(s && emitted[s], `step ${r.id} runs a ves ci subcommand (${s})`);
    assert.ok(emitted[s!].has(r.key), `steps.${r.id}.outputs.${r.key}: \`ves ci ${s}\` emits ${[...emitted[s!]].join(', ')}`);
  }
  // the comment step also documents the id/url pair; comment-url output maps to it
  assert.match(ACTION, /comment-url: \{ description: PR comment URL, value: '\$\{\{ steps\.comment\.outputs\.url \}\}' \}/);
});

test('action.yml: inputs used are declared, subcommands exist, run flags are read by the CLI, the gate step always runs', () => {
  const declared = new Set([...ACTION.slice(ACTION.indexOf('inputs:'), ACTION.indexOf('outputs:')).matchAll(/^  ([\w-]+):/gm)].map((m) => m[1]));
  for (const m of ACTION.matchAll(/inputs\.([\w-]+)/g)) assert.ok(declared.has(m[1]), `input ${m[1]} declared`);
  for (const m of ACTION.matchAll(/src\/cli\.ts" ci (\w+)/g)) assert.ok(['context', 'baseline', 'outputs', 'comment', 'exit'].includes(m[1]), m[1]);
  for (const m of ACTION.matchAll(/src\/cli\.ts" report [^\n]*--format (\w+)/g)) assert.ok(['summary', 'annotations', 'pr', 'junit', 'md', 'json'].includes(m[1]));
  const runStep = steps().find((s) => s.id === 'run')!.text;
  const runFlags = [...runStep.slice(0, runStep.indexOf('code=$?')).matchAll(/--([a-z][\w-]*)/g)].map((m) => m[1]);
  const runSrc = readFileSync(join(ROOT, 'src', 'cli', 'run.ts'), 'utf8');
  for (const f of new Set(runFlags)) assert.ok(runSrc.includes(`a['${f}']`) || runSrc.includes(`a.${f}`) || runSrc.includes(`a.${f.replace(/-/g, '_')}`), `ves run reads --${f}`);
  assert.ok(runFlags.includes('suite-root') && runFlags.includes('json') && runFlags.includes('report-only'));
  const last = steps().pop()!.text;
  assert.match(last, /if: always\(\)/);
  assert.match(last, /ci exit --verdict '\$\{\{ steps\.run\.outputs\.verdict \}\}' --fail-on '\$\{\{ inputs\.fail-on \}\}'/);
  assert.match(ACTION, /using: composite/);
  assert.ok(!/pull_request_target/.test(ACTION.replace(/#.*$/gm, '')), 'never pull_request_target');
  assert.ok(!/@actions\//.test(ACTION), 'no @actions/* npm dependency');
  // the comment only runs on same-repo PRs, the artifact is the next baseline
  assert.match(ACTION, /github\.event_name == 'pull_request' && steps\.ctx\.outputs\.is_fork != 'true'/);
  assert.match(ACTION, /actions\/upload-artifact@v4[\s\S]*name: '\$\{\{ inputs\.artifact-name \}\}'/);
});

test('GitLab template: every $VES_* it reads is exported by ci context / baseline / outputs or set in the job', async () => {
  const ws = tmpDir('gl-lint');
  writeFileSync(join(ws, 'ves.config.json'), JSON.stringify({ schema_version: 'ves-config/1', project: 'p', agent: { name: 'a', connection: { type: 'mock' } }, tools: { catalog: [] } }));
  const env = { CI_PIPELINE_SOURCE: 'push', CI_PROJECT_DIR: ws, CI_COMMIT_SHA: 'a'.repeat(40), TMPDIR: tmpDir('gl-lint-tmp') };
  const c = await computeContext({ provider: 'gitlab', env, deps: { exec: fakeExec(() => ({ code: 1 })).exec, harnessRoot: ROOT } });
  const exported = new Set(Object.keys(contextExports(c)));
  const d = deps({ env, cwd: ws });
  await ciMain(['baseline', '--gitlab', '--mode', 'none'], d);
  for (const k of Object.keys(parseExports(d.out.join('')))) exported.add(k);
  const f = join(tmpDir('gl-lint-out'), 'r.json');
  writeFileSync(f, '{}');
  const d2 = deps({ env });
  await ciMain(['outputs', '--gitlab', '--from', f, '--exit', '0'], d2);
  for (const k of Object.keys(parseExports(d2.out.join('')))) exported.add(k);
  const setInJob = new Set(['VES_REPO', 'VES_REF', 'VES_SUBDIR', 'VES', 'VES_EVALS_SHA', 'VES_HARNESS_SOURCE', 'VES_FAIL_ON']);
  const used = new Set([...GITLAB.replace(/#.*$/gm, '').matchAll(/\$\{?(VES_[A-Z_]+|VES)\b/g)].map((m) => m[1]));
  for (const v of used) assert.ok(exported.has(v) || setInJob.has(v), `$${v} is exported or set`);
  assert.match(GITLAB, /reports: \{ junit: ves-results\/junit\.xml \}/);
  assert.match(GITLAB, /checkout --quiet --detach "\$VES_REF"/, 'pins by commit SHA (git clone --branch cannot take a SHA)');
});

test('pre-commit: hook manifest points at an executable script that runs validate --strict offline', () => {
  const y = readFileSync(join(ROOT, 'integrations', 'pre-commit', '.pre-commit-hooks.yaml'), 'utf8');
  assert.match(y, /- id: ves-validate/);
  assert.match(y, /pass_filenames: false/);
  assert.match(y, /files: \^\(ves\\\.config\\\.json\|ves\\\.intents\\\.json\|evals\/\)/);
  const entry = /entry: (\S+)/.exec(y)![1];
  const script = join(ROOT, entry);
  assert.ok(statSync(script).mode & 0o111, 'entry script is executable');
  assert.match(readFileSync(script, 'utf8'), /src\/cli\.ts" validate --strict/);
});
