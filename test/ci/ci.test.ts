// ci package: `ves ci context|baseline|outputs|comment|exit` with injected git/gh (exec) and HTTP (fetch).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ciMain, exitFor } from '../../src/cli/ci.ts';
import { autoTier, computeContext, contextExports } from '../../src/cli/ci-context.ts';
import { pickRun, preHygiene, selectBaseline } from '../../src/cli/ci-baseline.ts';
import { ghStore, githubApiStore, gitlabStore, upsertComment } from '../../src/cli/ci-comment.ts';
import { githubOutputs, parseJsonStream, shellExports } from '../../src/cli/ci-shared.ts';
import { loadPluggableCommand } from '../../src/registry/commands.ts';
import type { CiContext } from '../../src/cli/ci-shared.ts';
import { cleanup, deps, type ExecCall, fakeExec, fakeFetch, parseExports, parseGithubOutput, ROOT, RUNS, tmpDir } from './helpers.ts';

after(cleanup);
/** `ves ci comment` writes pr-comment.md into the run dir, so comment tests work on copies of the fixture runs. */
const RUN = { block: '', pass: '' };
function runCopies() { RUN.block = join(tmpDir('run-b'), 'ves-run'); cpSync(RUNS.block, RUN.block, { recursive: true }); RUN.pass = join(tmpDir('run-p'), 'ves-run'); cpSync(RUNS.pass, RUN.pass, { recursive: true }); }
const BASE = 'b'.repeat(40), HEAD = 'c'.repeat(40);
const ok = (stdout = '') => ({ code: 0, stdout });

/** A PR workspace: head checkout with a ves.config.json and a GitHub pull_request event payload. */
function prWorkspace(o: { fork?: boolean; number?: number } = {}) {
  const ws = tmpDir('ws');
  const tmp = tmpDir('runner-temp');
  const cfg = { schema_version: 'ves-config/1', project: 'acme-agent', agent: { name: 'a', connection: { type: 'mock' } }, tools: { catalog: [] }, suites: ['evals/cases'], change_classes: { '2': ['agent/**'], '0': ['docs/**'] } };
  writeFileSync(join(ws, 'ves.config.json'), JSON.stringify(cfg));
  mkdirSync(join(ws, 'evals/cases'), { recursive: true });
  writeFileSync(join(ws, 'evals/cases/new.case.json'), JSON.stringify({ id: 'acme.new-case' }));
  const ev = join(tmp, 'event.json');
  writeFileSync(ev, JSON.stringify({ pull_request: { number: o.number ?? 7, head: { sha: HEAD, repo: { full_name: o.fork ? 'evil/agent' : 'acme/agent', fork: !!o.fork } }, base: { sha: BASE, ref: 'main', repo: { full_name: 'acme/agent' } } }, repository: { default_branch: 'main' } }));
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: ev, GITHUB_WORKSPACE: ws, GITHUB_REPOSITORY: 'acme/agent', GITHUB_BASE_REF: 'main', GITHUB_SHA: 'd'.repeat(40), RUNNER_TEMP: tmp, GITHUB_WORKFLOW_REF: 'acme/agent/.github/workflows/ves.yml@refs/pull/7/merge', VES_ACTION_REF: 'e'.repeat(40) };
  return { ws, tmp, env, cfg };
}
/** Fake git for a PR: the base has the config (unless firstRun), worktree add copies the head as the "base". */
function gitFor(ws: string, o: { firstRun?: boolean; changed?: string[]; worktreeFails?: boolean } = {}) {
  return (c: ExecCall) => {
    if (c.cmd !== 'git') return undefined;
    const a = c.args.join(' ');
    if (a.startsWith('cat-file -e') && a.endsWith('^{commit}')) return { code: 0 };
    if (a.startsWith('cat-file -e')) return { code: o.firstRun ? 128 : 0, stderr: o.firstRun ? 'fatal: path does not exist' : '' };
    if (a.startsWith('worktree add')) { if (o.worktreeFails) return { code: 128, stderr: 'fatal: worktree' }; const dest = c.args[4]; cpSync(ws, dest, { recursive: true }); writeFileSync(join(dest, '.git'), 'gitdir: x'); return ok(); }
    if (a.startsWith('diff --name-only --diff-filter=AMR')) return ok('evals/cases/new.case.json\n');
    if (a.startsWith('diff --name-only')) return ok((o.changed ?? ['agent/main.py', 'README.md']).join('\n') + '\n');
    return undefined;
  };
}

test('the ci and init commands are discovered by the core registry', async () => {
  assert.equal((await loadPluggableCommand('ci', ROOT))?.name, 'ci');
  assert.equal((await loadPluggableCommand('init', ROOT))?.name, 'init');
});

test('ci context (GitHub PR): base worktree suite, change class from the diff, tier auto, new cases, harness SHA', async () => {
  const { ws, tmp, env } = prWorkspace();
  const { exec, calls } = fakeExec(gitFor(ws));
  const d = deps({ cwd: ws, env, exec });
  assert.equal(await ciMain(['context', '--github'], d), 0, d.err.join(''));
  const o = parseGithubOutput(d.out.join(''));
  assert.equal(o.trigger, 'pr');
  assert.equal(o.change_class, '2', 'agent/** is class 2');
  assert.equal(o.tier, 'release', 'PR Class 2+ -> release');
  assert.equal(o.base_sha, BASE);
  assert.equal(o.head_sha, HEAD);
  assert.equal(o.suite_root, join(tmp, 'ves-base'));
  assert.equal(o.suite_from, 'base');
  assert.equal(o.is_fork, 'false');
  assert.equal(o.first_run, 'false');
  assert.equal(o.harness_sha, 'e'.repeat(40));
  assert.equal(o.new_cases, 'acme.new-case');
  assert.equal(o.pr_number, '7');
  assert.ok(calls.some((c) => c.args.join(' ') === `worktree add --detach --force ${join(tmp, 'ves-base')} ${BASE}`));
  const saved = JSON.parse(readFileSync(join(tmp, 'ves-context.json'), 'utf8'));
  assert.equal(saved.project, 'acme-agent');
});

test('ci context: first run (no config on base) -> head + REPORT_ONLY; fork; docs-only -> class 0 smoke; GitLab exports', async () => {
  let w = prWorkspace();
  let c = await computeContext({ provider: 'github', env: w.env, deps: { exec: fakeExec(gitFor(w.ws, { firstRun: true })).exec, harnessRoot: ROOT } });
  assert.equal(c.first_run, true);
  assert.equal(c.suite_root, w.ws);
  w = prWorkspace({ fork: true });
  c = await computeContext({ provider: 'github', env: w.env, deps: { exec: fakeExec(gitFor(w.ws, { changed: ['docs/a.md'] })).exec, harnessRoot: ROOT } });
  assert.equal(c.is_fork, true);
  assert.equal(c.change_class, 0);
  assert.equal(c.tier, 'smoke');
  w = prWorkspace();
  c = await computeContext({ provider: 'github', env: { ...w.env, VES_ACTION_REF: 'v1' }, deps: { exec: fakeExec(gitFor(w.ws, { worktreeFails: true })).exec, harnessRoot: ROOT }, overrides: { tier: 'smoke' } });
  assert.equal(c.suite_from, 'head', 'worktree failure falls back to head and says so');
  assert.ok(c.warnings.some((x) => /self-gating/.test(x)));
  assert.equal(c.tier, 'smoke', 'explicit tier wins');
  assert.match(c.harness_sha, /^tree:[a-f0-9]{64}$/, 'non-SHA action ref -> tree hash');
  assert.deepEqual([autoTier('deploy', 1), autoTier('nightly', 0), autoTier('manual', 2), autoTier('pr', 1)], ['release', 'release', 'smoke', 'smoke']);
  // GitLab merge request from a fork
  const gl = tmpDir('gl');
  writeFileSync(join(gl, 'ves.config.json'), JSON.stringify(w.cfg));
  const genv = { GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: '12', CI_MERGE_REQUEST_DIFF_BASE_SHA: BASE, CI_COMMIT_SHA: HEAD, CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main', CI_PROJECT_DIR: gl, CI_PROJECT_ID: '1', CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '2', TMPDIR: tmpDir('gltmp') };
  const d = deps({ cwd: gl, env: genv, exec: fakeExec(gitFor(gl)).exec });
  assert.equal(await ciMain(['context', '--gitlab'], d), 0);
  const e = parseExports(d.out.join(''));
  assert.equal(e.VES_TRIGGER, 'pr');
  assert.equal(e.VES_IS_FORK, 'true');
  assert.equal(e.VES_REPORT_ONLY, '1');
  assert.equal(e.VES_CONNECTION, 'mock');
  assert.equal(e.VES_HEAD_SHA, HEAD);
});

test('ci context fails closed when git is broken: not a first run, class >= 2, release tier, error annotation (dogfood fix)', async () => {
  // no git at all (the default fake exec fails every call), a shallow clone without the base, and a failing diff
  for (const exec of [
    fakeExec(() => ({ code: 127, stderr: 'git: command not found' })).exec,
    fakeExec((c) => (c.cmd === 'git' && c.args.join(' ').endsWith('^{commit}') ? { code: 128, stderr: 'fatal: Not a valid object name' } : undefined)).exec,
  ]) {
    const w = prWorkspace();
    const c = await computeContext({ provider: 'github', env: w.env, deps: { exec, harnessRoot: ROOT } });
    assert.equal(c.first_run, false, 'a broken git context is never a first run (that would be REPORT_ONLY)');
    assert.ok(c.change_class >= 2);
    assert.equal(c.tier, 'release');
    assert.ok(c.degraded?.length);
    assert.equal(contextExports(c).VES_REPORT_ONLY, '');
  }
  const w = prWorkspace();
  const diffFails = (x: ExecCall) => (x.cmd === 'git' && x.args[0] === 'diff' ? { code: 128, stderr: 'fatal: bad revision' } : gitFor(w.ws)(x));
  const c = await computeContext({ provider: 'github', env: w.env, deps: { exec: fakeExec(diffFails).exec, harnessRoot: ROOT } });
  assert.equal(c.first_run, false);
  assert.equal(c.change_class, 2);
  assert.match(c.change_reasons[0], /fail closed/);
  const d = deps({ cwd: w.ws, env: w.env });
  assert.equal(await ciMain(['context', '--github'], d), 0);
  assert.match(d.err.join(''), /::error title=VES git context::/);
  assert.equal(parseGithubOutput(d.out.join('')).first_run, 'false');
});

/** Builds a fake baseline artifact: copies a fixture run into <dest>/ves-results/<run>, optionally edited. */
function artifactWith(dest: string, edit?: (m: any) => void) {
  const to = join(dest, 'ves-results', 'run');
  cpSync(RUNS.pass, to, { recursive: true });
  if (edit) { const m = JSON.parse(readFileSync(join(to, 'run.json'), 'utf8')); edit(m); writeFileSync(join(to, 'run.json'), JSON.stringify(m)); }
  return to;
}
const ctxFor = (over: Partial<CiContext> = {}): CiContext => ({
  provider: 'github', event: 'pull_request', trigger: 'pr', tier: 'smoke', change_class: 2, change_reasons: [], base_sha: BASE, head_sha: HEAD, base_ref: 'main', suite_from: 'base',
  suite_root: tmpDir('suite'), head_root: tmpDir('head'), base_worktree: '', is_fork: false, first_run: false, harness_sha: 'tree:' + '0'.repeat(64), config: 'ves.config.json',
  working_directory: '.', new_cases: [], new_case_files: [], project: 'heldout-vet-clinic', repo: 'acme/agent', pr_number: 7, warnings: [], ...over,
});

test('baseline: pre-run hygiene and newest-usable pick', () => {
  const m = JSON.parse(readFileSync(join(RUNS.pass, 'run.json'), 'utf8'));
  const want = { project: 'heldout-vet-clinic', tier: 'smoke' as const, harness_sha: m.harness.evals_sha, config_sha256: m.config_sha256 };
  assert.deepEqual(preHygiene(RUNS.pass, want), []);
  assert.match(preHygiene(RUNS.pass, { ...want, tier: 'release' }).join(), /tier smoke != release/);
  assert.match(preHygiene(RUNS.pass, { ...want, project: 'other' }).join(), /project/);
  assert.match(preHygiene(RUNS.pass, { ...want, config_sha256: 'x' }).join(), /config_sha256 differs/);
  assert.match(preHygiene(RUNS.block, { ...want, harness_sha: 'tree:' + '1'.repeat(64) }).join(), /harness/);
  const dir = tmpDir('pick');
  cpSync(RUNS.pass, join(dir, 'a', 'ves-20260101T000000Z-aaaaaaaa'), { recursive: true });
  const newer = join(dir, 'b', 'ves-20270101T000000Z-bbbbbbbb');
  cpSync(RUNS.pass, newer, { recursive: true });
  const nm = JSON.parse(readFileSync(join(newer, 'run.json'), 'utf8')); nm.run_id = 'ves-20270101T000000Z-bbbbbbbb'; nm.status = 'invalid';
  writeFileSync(join(newer, 'run.json'), JSON.stringify(nm));
  const p = pickRun(dir, { ...want, harness_sha: '' });
  assert.equal(p.run_id, m.run_id, 'the newer run is invalid, so the older valid one is picked');
  assert.match(p.rejected.join(), /status invalid/);
});

test('baseline auto: main artifact used when hygienic (gh run list/download through exec)', async () => {
  const ctx = ctxFor();
  const m = JSON.parse(readFileSync(join(RUNS.pass, 'run.json'), 'utf8'));
  ctx.harness_sha = m.harness.evals_sha;
  const { exec, calls } = fakeExec((c) => {
    if (c.cmd === 'gh' && c.args[0] === 'run' && c.args[1] === 'list') return ok(JSON.stringify([{ databaseId: 501, headSha: BASE }]));
    if (c.cmd === 'gh' && c.args[0] === 'run' && c.args[1] === 'download') { artifactWith(c.args[c.args.indexOf('-D') + 1]); return ok(); }
    return undefined;
  });
  const tmp = tmpDir('bl');
  const r = await selectBaseline({ mode: 'auto', provider: 'github', ctx, env: { GITHUB_WORKFLOW_REF: 'acme/agent/.github/workflows/ves.yml@refs/pull/7/merge' }, deps: { exec, harnessRoot: ROOT }, artifact: 'ves-results', tmp });
  assert.equal(r.source, 'artifact', JSON.stringify(r));
  assert.ok(existsSync(join(r.dir, 'run.json')));
  const list = calls.find((c) => c.args[1] === 'list')!;
  assert.deepEqual(list.args, ['run', 'list', '--repo', 'acme/agent', '--workflow', 'ves.yml', '--branch', 'main', '--status', 'success', '-L', '5', '--json', 'databaseId,headSha,createdAt,event']);
  assert.deepEqual(calls.find((c) => c.args[1] === 'download')!.args.slice(0, 6), ['run', 'download', '501', '--repo', 'acme/agent', '-n']);
});

test('baseline auto on a Class 0/1 smoke PR: a release artifact is rejected (exact tier) and run-base is not started (dogfood fix)', async () => {
  const ctx = ctxFor({ tier: 'smoke', change_class: 1 });
  const { exec, calls } = fakeExec((c) => {
    if (c.cmd === 'gh' && c.args[1] === 'list') return ok(JSON.stringify([{ databaseId: 9 }]));
    if (c.cmd === 'gh' && c.args[1] === 'download') { artifactWith(c.args[c.args.indexOf('-D') + 1], (m) => { m.tier = 'release'; }); return ok(); }
    return undefined;
  });
  const r = await selectBaseline({ mode: 'auto', provider: 'github', ctx, env: {}, deps: { exec, harnessRoot: ROOT }, artifact: 'ves-results', tmp: tmpDir('bl-tier') });
  assert.equal(r.source, 'none', JSON.stringify(r));
  assert.match(r.reason, /optional below Class 2/);
  assert.ok(r.tried.some((t) => /tier release != smoke/.test(t)));
  assert.ok(!calls.some((c) => c.cmd === process.execPath), 'no run-base for a Class <2 PR');
});

test('baseline auto: hygiene failure falls back to run-base (base agent from the base worktree); then none', async () => {
  const ctx = ctxFor({ tier: 'release' });
  const wt = tmpDir('wt');
  writeFileSync(join(wt, 'ves.config.json'), '{}');
  mkdirSync(join(wt, 'ves'), { recursive: true });
  writeFileSync(join(wt, 'ves', 'setup-base.sh'), 'true');
  ctx.base_worktree = wt;
  const fixtureSmoke = (c: ExecCall) => {
    if (c.cmd === 'gh' && c.args[1] === 'list') return ok(JSON.stringify([{ databaseId: 9 }]));
    if (c.cmd === 'gh' && c.args[1] === 'download') { artifactWith(c.args[c.args.indexOf('-D') + 1]); return ok(); }   // a smoke run: tier < release
    if (c.cmd === 'bash') return ok();
    return undefined;
  };
  const { exec, calls } = fakeExec((c) => fixtureSmoke(c) ?? (c.cmd === process.execPath && c.args[1] === 'run' ? ok('log line\n{"verdict":"PASS","run_dir":"/base/ves-x","run_id":"ves-x"}\n') : undefined));
  const r = await selectBaseline({ mode: 'auto', provider: 'github', ctx, env: {}, deps: { exec, harnessRoot: ROOT }, artifact: 'ves-results', tmp: tmpDir('bl2') });
  assert.equal(r.source, 'run-base', JSON.stringify(r));
  assert.equal(r.dir, '/base/ves-x');
  assert.ok(r.tried.some((t) => /tier smoke != release/.test(t)));
  const run = calls.find((c) => c.cmd === process.execPath)!;
  assert.equal(run.cwd, wt, 'the base agent runs from the base worktree');
  assert.deepEqual(run.args.slice(1, 4), ['run', '--config', 'ves.config.json']);
  assert.ok(run.args.includes('--target') && run.args[run.args.indexOf('--target') + 1] === BASE);
  assert.ok(calls.some((c) => c.cmd === 'bash' && c.args[0] === 'ves/setup-base.sh'));
  // artifact mode never runs the base agent
  const r2 = await selectBaseline({ mode: 'artifact', provider: 'github', ctx, env: {}, deps: { exec: fakeExec(fixtureSmoke).exec, harnessRoot: ROOT }, artifact: 'ves-results', tmp: tmpDir('bl3') });
  assert.equal(r2.source, 'none');
  // run-base INVALID -> none with the VES-1 "no reference" advice
  const r3 = await selectBaseline({ mode: 'run-base', provider: 'github', ctx, env: {}, deps: { exec: fakeExec((c) => (c.cmd === 'bash' ? ok() : c.cmd === process.execPath ? ok('{"verdict":"INVALID","run_dir":"/b"}') : undefined)).exec, harnessRoot: ROOT }, artifact: 'x', tmp: tmpDir('bl4') });
  assert.equal(r3.source, 'none');
  assert.match(r3.reason, /merge to main once/);
  // forks and first runs: no comparison at all
  assert.equal((await selectBaseline({ mode: 'auto', provider: 'github', ctx: { ...ctx, is_fork: true }, env: {}, deps: { exec: fakeExec(() => undefined).exec, harnessRoot: ROOT }, artifact: 'x', tmp: tmpDir('bl5') })).source, 'none');
  // explicit path
  const p = await selectBaseline({ mode: RUNS.pass, provider: 'github', ctx: ctxFor(), env: {}, deps: { exec: fakeExec(() => undefined).exec, harnessRoot: ROOT }, artifact: 'x', tmp: tmpDir('bl6') });
  assert.equal(p.source, 'path');
});

test('baseline (GitLab): job artifact via curl with JOB-TOKEN, unzip fallback to python3', async () => {
  const ctx = ctxFor({ provider: 'gitlab' });
  ctx.harness_sha = JSON.parse(readFileSync(join(RUNS.pass, 'run.json'), 'utf8')).harness.evals_sha;
  const { exec, calls } = fakeExec((c) => {
    if (c.cmd === 'curl') return ok();
    if (c.cmd === 'unzip') return { code: 127, stderr: 'unzip: not found' };
    if (c.cmd === 'python3') { artifactWith(c.args[4]); return ok(); }
    return undefined;
  });
  const r = await selectBaseline({ mode: 'artifact', provider: 'gitlab', ctx, env: { CI_API_V4_URL: 'https://gl/api/v4', CI_PROJECT_ID: '42', CI_JOB_TOKEN: 'tok' }, deps: { exec, harnessRoot: ROOT }, artifact: 'ves', tmp: tmpDir('gl-bl') });
  assert.equal(r.source, 'artifact', JSON.stringify(r));
  const curl = calls.find((c) => c.cmd === 'curl')!;
  assert.ok(curl.args.includes('JOB-TOKEN: tok'));
  assert.equal(curl.args[curl.args.length - 1], 'https://gl/api/v4/projects/42/jobs/artifacts/main/download?job=ves');
});

/** Fake gh holding a comment list in memory. */
function fakeGh(initial: { id: number; body: string }[] = []) {
  const comments = [...initial.map((c) => ({ ...c, html_url: `https://gh/c/${c.id}` }))];
  let next = 1000;
  return fakeExec((c) => {
    if (c.cmd !== 'gh') return undefined;
    if (c.args[0] === '--version') return ok('gh version 2.60.0');
    const method = c.args.includes('-X') ? c.args[c.args.indexOf('-X') + 1] : 'GET';
    const path = c.args.find((x) => x.startsWith('repos/'))!;
    if (method === 'GET') return ok(JSON.stringify(comments.slice(0, 2)) + JSON.stringify(comments.slice(2)));   // --paginate prints one array per page
    if (method === 'POST') { const b = JSON.parse(c.input!); const n = { id: next++, body: b.body, html_url: `https://gh/c/${next - 1}` }; comments.push(n); return ok(JSON.stringify(n)); }
    const id = Number(path.split('/').pop());
    const i = comments.findIndex((x) => x.id === id);
    if (method === 'PATCH') { comments[i].body = JSON.parse(c.input!).body; return ok(JSON.stringify(comments[i])); }
    if (method === 'DELETE') { comments.splice(i, 1); return ok(''); }
    return undefined;
  });
}

test('comment upsert (fake gh): creates once, then PATCHes in place, never duplicates; removes stray duplicates', async () => {
  runCopies();
  const other = { id: 1, body: 'LGTM' }, otherProject = { id: 2, body: '<!-- ves:pr-comment project=other -->\nx' };
  const gh = fakeGh([other, otherProject]);
  const { tmp, env, ws } = prWorkspace();
  const d = deps({ cwd: ws, env: { ...env, RUNNER_TEMP: tmp }, exec: gh.exec });
  assert.equal(await ciMain(['comment', '--run', RUN.block, '--run-url', 'https://gh/run/1'], d), 0, d.err.join(''));
  let o = parseGithubOutput(d.out.join(''));
  assert.equal(o.action, 'created');
  assert.match(o.url, /^https:\/\/gh\/c\/1000$/);
  const posts = () => gh.calls.filter((c) => c.args.includes('POST')).length;
  assert.equal(posts(), 1);
  const post = gh.calls.find((c) => c.args.includes('POST'))!;
  assert.deepEqual(post.args.slice(0, 4), ['api', '-X', 'POST', 'repos/acme/agent/issues/7/comments']);
  assert.match(JSON.parse(post.input!).body, /^<!-- ves:pr-comment project=heldout-vet-clinic -->\n### VES gate: BLOCK/);
  for (let i = 0; i < 2; i++) {
    const d2 = deps({ cwd: ws, env, exec: gh.exec });
    assert.equal(await ciMain(['comment', '--run', i ? RUN.pass : RUN.block], d2), 0);
    o = parseGithubOutput(d2.out.join(''));
    assert.equal(o.action, 'updated');
    assert.equal(o.comment_id, '1000');
  }
  assert.equal(posts(), 1, 'never a second POST');
  assert.deepEqual(gh.calls.filter((c) => c.args.includes('PATCH')).map((c) => c.args[3]), ['repos/acme/agent/issues/comments/1000', 'repos/acme/agent/issues/comments/1000']);
  // a race left two VES comments for this project: update the oldest, delete the other; foreign comments untouched
  const marker = '<!-- ves:pr-comment project=heldout-vet-clinic -->';
  const gh2 = fakeGh([{ id: 5, body: `${marker}\nold` }, other, { id: 6, body: `${marker}\nolder dup` }, otherProject, { id: 7, body: `quote:\n${marker}` }]);
  const r = await upsertComment(ghStore(gh2.exec, 'acme/agent', 7), marker, `${marker}\nnew`);
  assert.deepEqual([r.action, r.id, r.removed_duplicates], ['updated', '5', 1]);
  assert.deepEqual(gh2.calls.filter((c) => c.args.includes('DELETE')).map((c) => c.args[3]), ['repos/acme/agent/issues/comments/6']);
});

test('comment: skipped on forks and outside PRs; REST fallback over fetch when gh is missing; API errors never fail the step', async () => {
  runCopies();
  const f = prWorkspace({ fork: true });
  const d = deps({ cwd: f.ws, env: f.env, exec: fakeExec(() => { throw new Error('gh must not be called for forks'); }).exec });
  assert.equal(await ciMain(['comment', '--run', RUN.block], d), 0);
  assert.equal(parseGithubOutput(d.out.join('')).action, 'skipped');
  const push = deps({ env: { GITHUB_EVENT_NAME: 'push' } });
  assert.equal(await ciMain(['comment', '--run', RUN.block], push), 0);
  assert.match(push.err.join(''), /not a pull\/merge request/);
  // no gh -> REST API with the token; pages until a short page
  const w = prWorkspace();
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'chatter', html_url: `u${i}` }));
  const api = fakeFetch((c) => {
    if (c.method === 'GET' && /[?&]page=1$/.test(c.url)) return { json: page1 };
    if (c.method === 'GET') return { json: [{ id: 300, body: '<!-- ves:pr-comment project=heldout-vet-clinic -->\nold', html_url: 'https://gh/c/300' }] };
    if (c.method === 'PATCH') return { json: { id: 300, body: JSON.parse(c.body!).body, html_url: 'https://gh/c/300' } };
    return { status: 500, text: 'unexpected' };
  });
  const d2 = deps({ cwd: w.ws, env: { ...w.env, GH_TOKEN: 'ghs_x', GITHUB_API_URL: 'https://api.gh' }, exec: fakeExec((c) => (c.cmd === 'gh' ? { code: 127, stderr: 'gh: not found' } : undefined)).exec, fetch: api.fetch });
  assert.equal(await ciMain(['comment', '--run', RUN.pass], d2), 0, d2.err.join(''));
  assert.equal(parseGithubOutput(d2.out.join('')).action, 'updated', d2.err.join(''));
  assert.equal(api.calls.filter((c) => c.method === 'GET').length, 2);
  const patch = api.calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.url, 'https://api.gh/repos/acme/agent/issues/comments/300');
  assert.equal(patch.headers.authorization, 'Bearer ghs_x');
  // API failure: reported, exit 0 (the verdict is decided by `ci exit`, not by the comment)
  const bad = fakeFetch(() => ({ status: 403, text: 'Resource not accessible by integration' }));
  const d3 = deps({ cwd: w.ws, env: { ...w.env, GH_TOKEN: 't' }, exec: fakeExec(() => ({ code: 127 })).exec, fetch: bad.fetch });
  assert.equal(await ciMain(['comment', '--run', RUN.pass], d3), 0);
  assert.equal(parseGithubOutput(d3.out.join('')).action, 'error');
  assert.match(d3.err.join(''), /403/);
  // githubApiStore direct: create
  const created = fakeFetch((c) => (c.method === 'GET' ? { json: [] } : { status: 201, json: { id: 1, body: 'b', html_url: 'https://gh/c/1' } }));
  const r = await upsertComment(githubApiStore(created.fetch, { apiUrl: 'https://api.gh', token: 't', repo: 'o/r', pr: 3 }), '<!-- m -->', '<!-- m -->\nb');
  assert.deepEqual([r.action, r.url], ['created', 'https://gh/c/1']);
});

test('comment (GitLab): one MR note per project via the notes API with PRIVATE-TOKEN; forks skipped', async () => {
  runCopies();
  const notes: any[] = [{ id: 1, body: 'hi', system: false }, { id: 2, body: 'added 1 commit', system: true }];
  const api = fakeFetch((c) => {
    const u = new URL(c.url);
    if (c.method === 'GET') return { json: notes };
    if (c.method === 'POST') { const n = { id: 50, body: JSON.parse(c.body!).body }; notes.push(n); return { status: 201, json: n }; }
    if (c.method === 'PUT') { const id = Number(u.pathname.split('/').pop()); const n = notes.find((x) => x.id === id); n.body = JSON.parse(c.body!).body; return { json: n }; }
    return { status: 500 };
  });
  const env = { GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: '12', CI_PROJECT_ID: '42', CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '42', CI_API_V4_URL: 'https://gl/api/v4', GITLAB_TOKEN: 'glpat', CI_MERGE_REQUEST_PROJECT_URL: 'https://gl/acme/agent', TMPDIR: tmpDir('gl-c') };
  for (const run of [RUN.block, RUN.pass]) {
    const d = deps({ env, fetch: api.fetch });
    assert.equal(await ciMain(['comment', '--gitlab', '--run', run], d), 0, d.err.join(''));
    assert.match(d.out.join(''), /export VES_COMMENT_URL='https:\/\/gl\/acme\/agent\/-\/merge_requests\/12#note_50'/);
  }
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(api.calls.filter((c) => c.method === 'PUT').length, 1);
  assert.equal(api.calls[0].headers['private-token'], 'glpat');
  assert.equal(api.calls.find((c) => c.method === 'POST')!.url, 'https://gl/api/v4/projects/42/merge_requests/12/notes');
  const r = await upsertComment(gitlabStore(api.fetch, { apiUrl: 'https://gl/api/v4', token: 't', projectId: '42', iid: 12, mrUrl: 'u' }), '<!-- ves:pr-comment project=heldout-vet-clinic -->', 'x');
  assert.equal(r.action, 'updated');
  const fork = deps({ env: { ...env, CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '99' }, fetch: fakeFetch(() => { throw new Error('no API for forks'); }).fetch });
  assert.equal(await ciMain(['comment', '--gitlab', '--run', RUN.pass], fork), 0);
  assert.match(fork.err.join(''), /skipped \(fork PR/);
});

test('ci outputs: parses ves run --json, writes pr-comment.md and junit.xml into the run dir', async () => {
  const run = join(tmpDir('out'), 'ves-run');
  cpSync(RUNS.block, run, { recursive: true });
  const f = join(tmpDir('out-json'), 'ves-run.json');
  writeFileSync(f, `noise\n${JSON.stringify({ verdict: 'BLOCK', would_be: 'BLOCK', decided_by: 'G-3 safety', run_dir: run, run_id: 'ves-x', conformance: 'VES-1' })}\n`);
  const d = deps();
  assert.equal(await ciMain(['outputs', '--from', f, '--exit', '1'], d), 0);
  const o = parseGithubOutput(d.out.join(''));
  assert.deepEqual([o.verdict, o.decided_by, o.run_dir, o.exit_code], ['BLOCK', 'G-3 safety', run, '1']);
  assert.match(readFileSync(join(run, 'pr-comment.md'), 'utf8'), /^<!-- ves:pr-comment project=heldout-vet-clinic -->/);
  assert.match(readFileSync(join(run, 'junit.xml'), 'utf8'), /^<\?xml version="1.0"/);
  const empty = join(tmpDir('out-empty'), 'x.json');
  writeFileSync(empty, 'usage: ves run ...\n');
  const d2 = deps();
  assert.equal(await ciMain(['outputs', '--from', empty, '--exit', '3', '--gitlab'], d2), 0);
  const e = parseExports(d2.out.join(''));
  assert.deepEqual([e.VES_VERDICT, e.VES_RUN_DIR, e.VES_EXIT_CODE], ['', '', '3']);
});

test('ci exit: the fail-on mapping', async () => {
  const table: [string, string, number][] = [
    ['PASS', 'block', 0], ['REPORT_ONLY', 'block', 0], ['BLOCK', 'block', 1], ['INVALID', 'block', 2], ['', 'block', 2],
    ['PASS', 'invalid', 0], ['BLOCK', 'invalid', 0], ['INVALID', 'invalid', 2], ['', 'invalid', 2],
    ['BLOCK', 'never', 0], ['INVALID', 'never', 0], ['', 'never', 0], ['REPORT_ONLY', 'never', 0],
  ];
  for (const [v, f, code] of table) assert.equal(exitFor(v, f).code, code, `${v || '<none>'} / ${f}`);
  const d = deps();
  assert.equal(await ciMain(['exit', '--verdict', 'BLOCK', '--fail-on', 'block'], d), 1);
  assert.match(d.err.join(''), /BLOCK: failing the step/);
  assert.equal(await ciMain(['exit', '--verdict', 'PASS', '--fail-on', 'sometimes'], deps()), 3);
  assert.equal(await ciMain(['nope'], deps()), 3);
});

test('output encodings: GitHub heredoc for multi-line values, shell-safe exports, gh --paginate streams', () => {
  const g = githubOutputs({ a: '1', b: 'x\ny', c: null });
  assert.deepEqual(parseGithubOutput(g), { a: '1', b: 'x\ny', c: '' });
  assert.match(g, /^b<<VES_EOF$/m);
  const s = shellExports({ A: "it's $(rm -rf /)" });
  assert.equal(s, "export A='it'\\''s $(rm -rf /)'\n");
  assert.deepEqual(parseExports(s), { A: "it's $(rm -rf /)" });
  assert.deepEqual(parseJsonStream('[1,2]\n[3]{"a":"]["}'), [[1, 2], [3], { a: '][' }]);
});
