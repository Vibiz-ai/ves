// End-to-end runs through the MOCK adapter only (deterministic, no network, $0). Output goes under results/.test-*.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { runOnce, runWithRetry, type RunOptions } from '../src/runner/run.ts';
import { canonicalJson } from '../src/lib/canonicalise.ts';
import { sha256 } from '../src/lib/hash.ts';

// Hard rule: no network in tests. Any accidental real fetch throws.
(globalThis as any).fetch = () => { throw new Error('network call attempted in a test'); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIBIZ = join(ROOT, 'packs', 'vibiz'); // Vibiz assets moved here by the Core step (DESIGN-agnostic §7.1 item 10)
const TMP = join(ROOT, 'results', `.test-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let tick = Date.parse('2026-11-06T12:00:00Z');
const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  repoRoot: ROOT, suites: [join(VIBIZ, 'cases', 'smoke')], tier: 'smoke', trigger: 'manual', surfaces: 'auto', mode: 'mock',
  target: { sha: 'abc1234', deploy_targets: ['app'], change_class: 1 }, outDir: TMP, now: () => new Date((tick += 1000)), bootstrapN: 2000, ...o,
});

test('mock smoke suite: PASS, schema-valid rows, manifest, card, gate.json, OTel events', async () => {
  const r = await runOnce(opts());
  assert.equal(r.gate.verdict, 'PASS', JSON.stringify(r.gate.rules.filter((x) => x.status === 'fired')));
  for (const f of ['run.json', 'results.jsonl', 'gate.json', 'card.md', 'otel-events.jsonl', 'baselines/baselines.jsonl']) assert.ok(existsSync(join(r.runDir, f)), f);
  assert.match(r.runId, /^ves-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/);
  assert.equal(r.manifest.status, 'valid');
  assert.ok(r.rows.some((x) => x.status === 'skip' && x.surface === 'eve/slack'), 'ask_mode case skipped on slack');
  const ev = readFileSync(join(r.runDir, 'otel-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ev.every((e) => e.name === 'gen_ai.evaluation.result' && 'gen_ai.evaluation.score.label' in e.attributes));
});

test('S0 determinism: two fresh runs give identical canonical outputs', async () => {
  const strip = (rows: any[]) => sha256(canonicalJson(rows.map(({ row_id, run_id, created_at, usage, trace, ...rest }) => rest), { dropVolatile: true }));
  const a = await runOnce(opts());
  const b = await runOnce(opts());
  assert.equal(strip(a.rows), strip(b.rows));
});

test('approval bypass on one canary blocks via G-3 with no retry', async () => {
  const r = await runOnce(opts({ faults: { unsafeCases: ['smoke.reply-lead-chat-yes'] } }));
  assert.equal(r.gate.verdict, 'BLOCK');
  assert.equal(r.gate.decided_by, 'G-3 safety');
  const cell = r.rows.filter((x) => x.case_id === 'smoke.reply-lead-chat-yes' && x.surface === 'eve/web');
  assert.equal(cell.length, 1, 'safety failures get no confirmation retry');
});

test('a broken canary is retried once and blocks via G-5 when the retry also fails', async () => {
  const r = await runOnce(opts({ faults: { breakCases: ['smoke.status-leads'] } }));
  assert.equal(r.gate.decided_by, 'G-5 smoke canaries');
  assert.equal(r.rows.filter((x) => x.case_id === 'smoke.status-leads' && x.surface === 'eve/web').length, 2);
});

test('HOST_CONFIRMS_WRITES on a host-declared client is caught by G1 (VH-01 shape)', async () => {
  const dir = join(TMP, 'cases-vh01');
  mkdirSync(dir, { recursive: true });
  const c = JSON.parse(readFileSync(join(VIBIZ, 'cases/safety/rt-client-no-token.case.json'), 'utf8'));
  c.surfaces = ['gateway/openai-sim'];
  writeFileSync(join(dir, 'x.case.json'), JSON.stringify(c));
  const r = await runOnce(opts({ suites: [dir], tier: 'release', surfaces: ['gateway/openai-sim'], faults: { hostConfirmsWrites: true } }));
  assert.equal(r.gate.decided_by, 'G-3 safety');
  const clean = await runOnce(opts({ suites: [dir], tier: 'release', surfaces: ['gateway/openai-sim'] }));
  assert.equal(clean.gate.verdict, 'PASS');
});

test('release safety suites at k=4/k=1 with valid oracle arms; Class 2 regression vs reference reads below', async () => {
  const suites = [join(VIBIZ, 'cases', 'smoke'), join(VIBIZ, 'cases', 'safety')];
  const ref = await runOnce(opts({ suites, tier: 'release', surfaces: ['eve/web', 'gateway/contract'], target: { sha: 'aaaaaaa', deploy_targets: ['agent'], change_class: 1 } }));
  assert.equal(ref.gate.verdict, 'PASS', JSON.stringify(ref.gate.rules.filter((x) => x.status === 'fired')));
  assert.equal(ref.manifest.k['eve/web'], 4);
  assert.equal(ref.manifest.k['gateway/contract'], 2);
  const broken = ['smoke.quick-intro-offer', 'smoke.status-leads', 'smoke.create-ad-image', 'smoke.crm-no-external', 'smoke.kills-zero-lead-ad', 'smoke.mass-email-confirmed', 'smoke.guard-ad-budget-in-budget', 'smoke.reply-lead-chat-yes'];
  const cand = await runOnce(opts({ suites, tier: 'release', surfaces: ['eve/web', 'gateway/contract'], compare: ref.runDir, differsIn: ['agent_commit'], faults: { breakCases: broken },
    target: { sha: 'bbbbbbb', deploy_targets: ['agent'], change_class: 2 } }));
  assert.equal(cand.gate.verdict, 'BLOCK');
  assert.equal(cand.gate.decided_by, 'G-6 regression below');
  const noRef = await runOnce(opts({ suites, tier: 'release', surfaces: ['eve/web'], target: { sha: 'ccccccc', deploy_targets: ['agent'], change_class: 2 } }));
  assert.equal(noRef.gate.verdict, 'INVALID', 'Class 2 without a reference is inadmissible');
});

test('comparator hygiene refuses a reference on another suite version', async () => {
  const ref = await runOnce(opts({ surfaces: ['eve/web'] }));
  const cand = await runOnce(opts({ suites: [join(VIBIZ, 'cases', 'smoke'), join(VIBIZ, 'cases', 'safety')], tier: 'release', surfaces: ['eve/web'], compare: ref.runDir, differsIn: [], target: { sha: 'abc1234', deploy_targets: ['app'], change_class: 2 } }));
  assert.equal(cand.gate.decided_by, 'G-1 admissibility');
  assert.match(cand.gate.rules[0].detail, /suite_version differs/);
});

test('stub adapters make the run INVALID, it is re-run once, and INVALID twice blocks (G-11)', async () => {
  const r = await runWithRetry(opts({ mode: 'real', surfaces: ['eve/web'] }));
  assert.equal(r.gate.verdict, 'BLOCK');
  assert.equal(r.gate.decided_by, 'G-11 infrastructure');
  assert.match(r.runDir, /INVALID-harness_bug/);
});

test('a mock adapter can never gate a deploy (G-1)', async () => {
  const r = await runOnce(opts({ trigger: 'deploy', surfaces: ['eve/web'] }));
  assert.equal(r.gate.verdict, 'INVALID');
  assert.match(r.gate.rules[0].detail, /mock\/stub adapters cannot gate/);
});
