// `ves compare` / `ves history` math on hand-checkable fixtures, the suite_version honesty rule, and the CLI paths.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseHistory, compareRunDirs, renderCompareMd, renderHistoryMd, suiteLabels } from '../../src/store/compare.ts';
import { LocalBackend } from '../../src/store/local.ts';
import { RunStore } from '../../src/store/store.ts';
import { cmdCompare, cmdHistory, cmdStore, parseSince, pushAfterRun } from '../../src/cli/store.ts';
import { parse } from '../../src/cli/args.ts';
import { runOnce, loadRun } from '../../src/runner/run.ts';
import { makeRun, type CaseSpec } from './fixtures.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'ves-compare-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => { const d = join(TMP, `${name}-${n++}`); mkdirSync(d, { recursive: true }); return d; };
const id = (i: number, h = 'aaaaaaaa') => `ves-20261107T10${String(i).padStart(2, '0')}00Z-${h}`;
const cases = (nCases: number, failing: string[] = [], surf = 'web'): CaseSpec[] =>
  Array.from({ length: nCases }, (_, i) => `c${String(i + 1).padStart(2, '0')}`).map((c) => ({ id: c, [surf]: [failing.includes(c) ? 'fail' : 'pass'] }));
const cmp = (base: string, head: string, o: { bootstrapN?: number } = {}) => compareRunDirs(base, head, { base: { source: 'dir' }, head: { source: 'dir' }, bootstrapN: o.bootstrapN });

test('identical runs: Δ 0, CI [0, 0], level, no flips', () => {
  const r = fresh('r');
  const a = makeRun(r, { run_id: id(1), suite: 'S', surfaces: ['web'], cases: cases(4) });
  const b = makeRun(r, { run_id: id(2), suite: 'S', surfaces: ['web'], cases: cases(4) });
  const c = cmp(a, b);
  assert.equal(c.comparable, true);
  const s = c.surfaces[0];
  assert.deepEqual([s.pass1!.diff, s.pass1!.ci[0], s.pass1!.ci[1], s.pass1!.reading], [0, 0, 0, 'level']);
  assert.equal(c.flips.length, 0);
});

test('every case fails in head: Δ −1, CI [−1, −1] (every resample is −1), below; 4 pass→fail flips', () => {
  const r = fresh('r');
  const a = makeRun(r, { run_id: id(1), suite: 'S', surfaces: ['web'], cases: cases(4) });
  const b = makeRun(r, { run_id: id(2), suite: 'S', surfaces: ['web'], cases: cases(4, ['c01', 'c02', 'c03', 'c04']) });
  const c = cmp(a, b);
  assert.deepEqual([c.surfaces[0].pass1!.diff, ...c.surfaces[0].pass1!.ci, c.surfaces[0].pass1!.reading], [-1, -1, -1, 'below']);
  assert.equal(c.flip_counts['pass→fail'], 4);
  assert.equal(c.surfaces[0].base.pass1, 1);
  assert.equal(c.surfaces[0].head.pass1, 0);
});

test('2 of 10 cases flip: Δ −0.2 exactly; P(resample has no flipped case) = 0.8^10 ≈ 0.107 > 2.5%, so the upper bound is 0 and the reading is level', () => {
  const r = fresh('r');
  const a = makeRun(r, { run_id: id(1), suite: 'S', surfaces: ['web'], cases: cases(10) });
  const b = makeRun(r, { run_id: id(2), suite: 'S', surfaces: ['web'], cases: cases(10, ['c01', 'c02']) });
  const p = cmp(a, b).surfaces[0].pass1!;
  assert.ok(Math.abs(p.diff + 0.2) < 1e-12);
  assert.equal(p.ci[1], 0);
  assert.ok(p.ci[0] <= -0.1 && p.ci[0] >= -0.6, String(p.ci[0]));
  assert.equal(p.reading, 'level');
  assert.equal(p.n_pairs, 10);
});

test('10 of 30 cases flip: Δ −1/3; P(no flipped case in a resample) = (2/3)^30 ≈ 5e-6, so the CI excludes 0: below', () => {
  const r = fresh('r');
  const fails = Array.from({ length: 10 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
  const a = makeRun(r, { run_id: id(1), suite: 'S', surfaces: ['web'], cases: cases(30) });
  const b = makeRun(r, { run_id: id(2), suite: 'S', surfaces: ['web'], cases: cases(30, fails) });
  const p = cmp(a, b).surfaces[0].pass1!;
  assert.ok(Math.abs(p.diff + 1 / 3) < 1e-12);
  assert.ok(p.ci[1] < 0, String(p.ci));
  assert.equal(p.reading, 'below');
});

test('fail→pass, k=2 partial passes, retries excluded, safety new vs fixed, cost delta', () => {
  const r = fresh('r');
  const base = makeRun(r, { run_id: id(1), suite: 'S', surfaces: ['web'], k: 2, cost_usd: 0.1, tokens: 10, cases: [
    { id: 'c1', web: ['fail', 'fail'] }, { id: 'c2', web: ['pass', 'pass'] }, { id: 'c3', web: ['unsafe', 'pass'] }, { id: 'c4', web: ['pass', 'pass'] },
  ] });
  const head = makeRun(r, { run_id: id(2), suite: 'S', surfaces: ['web'], k: 2, cost_usd: 0.25, tokens: 20, retry: [`${id(2)}|c4@1|web|2`], cases: [
    { id: 'c1', web: ['pass', 'pass'] }, { id: 'c2', web: ['pass', 'fail'] }, { id: 'c3', web: ['pass', 'pass'] }, { id: 'c4', web: ['unsafe', 'pass', 'fail'] },
  ] });
  const c = cmp(base, head);
  // per-case pass^1 base [0, 1, .5, 1] = .625; head [1, .5, 1, .5] = .75 (c4's third trial is a retry: not counted)
  assert.ok(Math.abs(c.surfaces[0].base.pass1 - 0.625) < 1e-12);
  assert.ok(Math.abs(c.surfaces[0].head.pass1 - 0.75) < 1e-12);
  assert.ok(Math.abs(c.surfaces[0].pass1!.diff - 0.125) < 1e-12);
  assert.deepEqual(c.surfaces[0].other_metrics.map((m) => m.metric), ['pass^2'], 'k=2 on both sides: pass^2 compared too');
  const kinds = Object.fromEntries(c.flips.map((f) => [f.case_id, f.kind]));
  assert.deepEqual(kinds, { c1: 'fail→pass', c2: 'pass→fail', c3: 'fail→pass', c4: 'pass→fail' });
  assert.equal(c.flips.find((f) => f.case_id === 'c2')!.head!.c, 1);
  assert.equal(c.flips.find((f) => f.case_id === 'c2')!.head!.n, 2);
  assert.deepEqual(c.safety.new, ['c4@1|web#approval_invariant']);
  assert.deepEqual(c.safety.fixed, ['c3@1|web#approval_invariant']);
  assert.ok(Math.abs(c.cost.delta.actual_usd! - 0.15) < 1e-12);
  assert.equal(c.cost.delta.tokens, 20 * 9 - 10 * 8, 'every row counts its tokens (head has 9 rows incl. the retry, base 8)');
  const md = renderCompareMd(c);
  assert.match(md, /NEW c4@1\|web#approval_invariant/);
  assert.match(md, /\| fail→pass \| c1@1 \| web \| fail 0\/2 \| pass 2\/2 \|/);
});

test('HONESTY: different suite_version refuses the aggregate; flips only for same-version cases; version changes listed', () => {
  const r = fresh('r');
  const base = makeRun(r, { run_id: id(1), suite: 'S1', surfaces: ['web'], cases: [{ id: 'c1', web: ['pass'] }, { id: 'c2', web: ['fail'] }, { id: 'c3', version: 1, web: ['pass'] }, { id: 'c4', web: ['pass'] }] });
  const head = makeRun(r, { run_id: id(2), suite: 'S2', surfaces: ['web'], cases: [{ id: 'c1', web: ['fail'] }, { id: 'c2', web: ['pass'] }, { id: 'c3', version: 2, web: ['fail'] }, { id: 'c5', web: ['pass'] }] });
  const c = cmp(base, head);
  assert.equal(c.comparable, false);
  assert.match(c.refused!.reason, /suite_version differs/);
  assert.deepEqual(c.surfaces, [], 'no pass^1 delta, no CI, no reading');
  assert.deepEqual(c.flips.map((f) => `${f.kind} ${f.case_id}`), ['pass→fail c1', 'fail→pass c2', 'new c5', 'removed c4']);
  assert.deepEqual(c.version_changed, [{ case_id: 'c3', base_version: 1, head_version: 2, surfaces: ['web'] }]);
  assert.ok(!c.flips.some((f) => f.case_id === 'c3'), 'a changed case is never compared');
  assert.match(renderCompareMd(c), /Aggregate comparison refused/);
});

test('surfaces only in one run are listed; multiple surfaces get Holm-adjusted CIs', () => {
  const r = fresh('r');
  const both = (failWeb: string[]) => cases(6, failWeb).map((x) => ({ ...x, slack: ['pass'] }));
  const a = makeRun(r, { run_id: id(1), suite: 'S', surfaces: ['web', 'slack', 'old'], cases: both([]).map((x) => ({ ...x, old: ['pass'] })) });
  const b = makeRun(r, { run_id: id(2), suite: 'S', surfaces: ['web', 'slack', 'new'], cases: both(['c01']).map((x) => ({ ...x, new: ['pass'] })) });
  const c = cmp(a, b);
  assert.deepEqual(c.only_in_base, ['old']);
  assert.deepEqual(c.only_in_head, ['new']);
  assert.deepEqual(c.surfaces.map((s) => s.surface), ['web', 'slack']);
  assert.ok(c.surfaces.every((s) => s.pass1!.holm_alpha <= 0.05));
  assert.ok(c.flips.every((f) => f.surface !== 'old' && f.surface !== 'new'), 'whole-surface changes are not per-case flips');
});

test('caseHistory: one case across runs, BREAK where the case version changes; suite labels v1, v2', () => {
  const r = fresh('r');
  const dirs = [
    makeRun(r, { run_id: id(1), suite: 'S1', surfaces: ['web', 'slack'], cases: [{ id: 'c1', web: ['pass'], slack: ['pass'] }] }),
    makeRun(r, { run_id: id(2), suite: 'S1', surfaces: ['web', 'slack'], cases: [{ id: 'c1', web: ['fail'], slack: ['pass'] }] }),
    makeRun(r, { run_id: id(3), suite: 'S2', surfaces: ['web'], cases: [{ id: 'c9', web: ['pass'] }] }),
    makeRun(r, { run_id: id(4), suite: 'S3', surfaces: ['web'], cases: [{ id: 'c1', version: 2, web: ['pass'] }] }),
  ];
  const runs = dirs.map((d, i) => { const L = loadRun(d); return { info: { run_id: L.manifest.run_id, created: null, sha: null, branch: 'main', tier: 'smoke', trigger: 'manual', suite_version: L.manifest.suite.version, suite_label: null, verdict: 'PASS', decided_by: null, source: 'test' }, seq: i, rows: L.rows, retry: L.retry }; });
  const h = caseHistory('c1', runs);
  assert.deepEqual(h.runs.map((p) => p.run_id), [id(1), id(2), id(4)]);
  assert.deepEqual(h.runs.map((p) => p.cells.map((c) => `${c.surface}:${c.status}`).join(',')), ['slack:pass,web:pass', 'slack:pass,web:fail', 'web:pass']);
  assert.deepEqual(h.runs.map((p) => p.version_break), [null, null, { from: 1, to: 2 }]);
  assert.deepEqual(h.versions, [1, 2]);
  assert.equal(caseHistory('c1', runs, { variant: 'slack' }).runs.length, 2);
  assert.match(renderHistoryMd(h), /BREAK\*\* case v1→v2/);
  const labels = suiteLabels(runs.map((x) => ({ suite_version: x.info.suite_version })));
  assert.deepEqual([...labels.values()], ['v1', 'v2', 'v3']);
});

test('parseSince: relative, ISO duration, date', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  assert.equal(parseSince('7d', now), '2026-10-31T12:00:00.000Z');
  assert.equal(parseSince('12h', now), '2026-11-07T00:00:00.000Z');
  assert.equal(parseSince('P1DT1H', now), '2026-11-06T11:00:00.000Z');
  assert.equal(parseSince('2026-11-01', now), '2026-11-01T00:00:00.000Z');
  assert.throws(() => parseSince('yesterday', now), /--since/);
});

// ------------------------------------------------------------------------------------------------ CLI

function cli(cwd: string) {
  const out: string[] = [], err: string[] = [];
  const deps = { env: {}, cwd, exec: async () => ({ code: 1, stdout: '', stderr: '' }), fetch: (() => { throw new Error('no network'); }) as never, out: (s: string) => out.push(s), err: (s: string) => err.push(s), now: () => new Date('2026-11-07T12:00:00Z') };
  return { deps, out, err, text: () => out.join(''), errText: () => err.join('') };
}

test('CLI: store push/list, compare --base main --head <sha>, refusal exit 2, history --json', async () => {
  const cwd = fresh('cwd');
  const runs = fresh('runs');
  const store = join(cwd, 'st');
  const d1 = makeRun(runs, { run_id: id(1), suite: 'S1', branch: 'main', sha: 'aaaaaaa', surfaces: ['web'], cases: cases(4) });
  const d2 = makeRun(runs, { run_id: id(2), suite: 'S1', branch: 'feat', sha: 'bbbbbbb', surfaces: ['web'], cases: cases(4, ['c01', 'c02', 'c03', 'c04']), verdict: 'BLOCK', decided_by: 'G-5 smoke canaries' });
  const d3 = makeRun(runs, { run_id: id(3), suite: 'S2', branch: 'feat', sha: 'ccccccc', surfaces: ['web'], cases: [...cases(3), { id: 'c04', version: 2, web: ['pass'] }] });
  let c = cli(cwd);
  assert.equal(await cmdStore(parse(['push', d1, d2, d3, '--store', store]), c.deps), 0);
  assert.match(c.errText(), /stored +ves-20261107T100100Z-aaaaaaaa/);
  c = cli(cwd);
  assert.equal(await cmdStore(parse(['push', d1, '--store', store]), c.deps), 0);
  assert.match(c.errText(), /unchanged ves-20261107T100100Z/);
  c = cli(cwd);
  await cmdStore(parse(['list', '--store', store, '--branch', 'feat', '--json']), c.deps);
  const listed = JSON.parse(c.text());
  assert.deepEqual(listed.entries.map((e: { run_id: string; suite_label: string }) => [e.run_id, e.suite_label]), [[id(2), 'v1'], [id(3), 'v2']]);
  c = cli(cwd);
  assert.equal(await cmdStore(parse(['verify', '--store', store]), c.deps), 0);
  assert.match(c.text(), /3 run\(s\).*OK/);

  // head by sha, base = newest main run of the same tier with the same suite
  c = cli(cwd);
  assert.equal(await cmdCompare(parse(['--store', store, '--base', 'main', '--head', 'bbbbbbb', '--json']), c.deps), 0);
  const j = JSON.parse(c.text());
  assert.equal(j.base.run_id, id(1));
  assert.equal(j.head.run_id, id(2));
  assert.equal(j.base.branch, 'main');
  assert.equal(j.surfaces[0].pass1.reading, 'below');
  assert.equal(j.head.suite_label, 'v1');
  // positional run ids; different suites -> refused, exit 2
  c = cli(cwd);
  assert.equal(await cmdCompare(parse([id(1), id(3), '--store', store]), c.deps), 2);
  assert.match(c.text(), /Aggregate comparison refused/);
  assert.match(c.text(), /Not compared \(case version changed\): c04 v1→v2/);
  // a run directory works as a ref too, and an unknown ref is a usage error
  c = cli(cwd);
  assert.equal(await cmdCompare(parse([d1, d2, '--store', store, '--json']), c.deps), 0);
  await assert.rejects(cmdCompare(parse(['nope', id(1), '--store', store]), cli(cwd).deps), /no stored run matches "nope"/);

  c = cli(cwd);
  assert.equal(await cmdHistory(parse(['c04', '--store', store, '--json']), c.deps), 0);
  const h = JSON.parse(c.text());
  assert.deepEqual(h.runs.map((p: { cells: { status: string }[] }) => p.cells[0].status), ['pass', 'fail', 'pass']);
  assert.deepEqual(h.runs[2].version_break, { from: 1, to: 2 });
  assert.equal(h.runs[0].suite_label, 'v1');

  // pull
  c = cli(cwd);
  assert.equal(await cmdStore(parse(['pull', id(2), '--store', store, '--out', join(cwd, 'pulled')]), c.deps), 0);
  assert.equal(readFileSync(join(cwd, 'pulled', id(2), 'results.jsonl'), 'utf8'), readFileSync(join(d2, 'results.jsonl'), 'utf8'));
});

test('pushAfterRun: nothing without --store / auto_push (ves run unchanged); --store pushes; config auto_push pushes', async () => {
  const cwd = fresh('cwd');
  const run = makeRun(fresh('runs'), { run_id: id(1), suite: 'S', surfaces: ['web'], cases: cases(2) });
  let c = cli(cwd);
  assert.equal(await pushAfterRun(run, parse([]), c.deps), null);
  assert.equal(c.errText(), '');
  const r = await pushAfterRun(run, parse(['--store', join(cwd, 'a')]), c.deps);
  assert.deepEqual([r!.pushed, r!.status], [true, 'stored']);
  writeFileSync(join(cwd, 'ves.config.json'), JSON.stringify({ store: { url: 'auto', auto_push: true } }));
  c = cli(cwd);
  const r2 = await pushAfterRun(run, parse([]), c.deps);
  assert.equal(r2!.url, join(cwd, 'auto'));
  assert.equal((await new RunStore(new LocalBackend(join(cwd, 'auto'))).index()).entries.length, 1);
  assert.equal(await pushAfterRun(run, parse(['--no-store']), c.deps), null);
  // a failing push is reported, never thrown (the run's exit code stays the gate's)
  writeFileSync(join(run, 'card.md'), 'changed');
  const r3 = await pushAfterRun(run, parse([]), c.deps);
  assert.equal(r3!.pushed, false);
  assert.match(c.errText(), /PUSH FAILED/);
});

test('integration: two real mock runs (clean vs approval bypass) through the store: G-3 shows as a NEW safety violation', async () => {
  const out = fresh('real');
  let tick = Date.parse('2026-11-07T09:00:00Z');
  const opts = (faults = {}) => ({ repoRoot: ROOT, suites: [join(ROOT, 'packs', 'vibiz', 'cases', 'smoke')], tier: 'smoke' as const, trigger: 'manual' as const, surfaces: 'auto' as const, mode: 'mock' as const, target: { sha: 'abc1234', deploy_targets: [], change_class: 0 as const }, outDir: out, now: () => new Date((tick += 1000)), bootstrapN: 500, faults });
  const clean = await runOnce(opts());
  const bad = await runOnce(opts({ unsafeCases: ['smoke.reply-lead-chat-yes'] }));
  assert.equal(bad.gate.decided_by, 'G-3 safety');
  const store = new RunStore(new LocalBackend(fresh('store')));
  await store.push(clean.runDir, { branch: { branch: 'main', source: 'args' } });
  await store.push(bad.runDir, { branch: { branch: 'feat', source: 'args' } });
  const c = cli(fresh('cwd'));
  assert.equal(await cmdCompare(parse([clean.runId, bad.runId, '--store', store.backend.url, '--json']), c.deps), 0);
  const j = JSON.parse(c.text());
  assert.equal(j.comparable, true);
  assert.ok(j.safety.new.some((k: string) => k.startsWith('smoke.reply-lead-chat-yes@1|')), JSON.stringify(j.safety));
  assert.equal(j.safety.fixed.length, 0);
  assert.ok(j.flips.some((f: { kind: string; case_id: string }) => f.kind === 'pass→fail' && f.case_id === 'smoke.reply-lead-chat-yes'));
  assert.equal(j.head.verdict, 'BLOCK');
});
