import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatrix, cardSurfaceMetrics, countRows, evidenceSteps, normVerdict, ruleId, safetyViolations, searchItems, surfaceCounts, toolClasses, totalSpend, trialPassRate, verdictCounts } from '../src/lib/shape.ts';
import { renderMarkdown } from '../src/lib/markdown.ts';
import { pct, relativeTime, shortSha } from '../src/lib/format.ts';
import type { ResultRow } from '../src/lib/types.ts';

const row = (case_id: string, surface: string, trial: number, status: string, extra: Partial<ResultRow> = {}): ResultRow => ({ row_id: `r|${case_id}|${surface}|${trial}`, case_id, surface, trial, status, ...extra });

test('verdictCounts normalises verdict spellings and counts ALL', () => {
  const c = verdictCounts([{ verdict: 'PASS' }, { verdict: 'block' }, { verdict: 'REPORT_ONLY' }, { verdict: 'report only' }, { verdict: null }]);
  assert.deepEqual(c, { ALL: 5, PASS: 1, BLOCK: 1, INVALID: 0, REPORT_ONLY: 2 });
  assert.equal(normVerdict('nonsense'), null);
});

test('buildMatrix groups rows by case and surface, sorts trials, keeps declared surface order', () => {
  const m = buildMatrix([row('b', 'slack', 1, 'pass'), row('a', 'web', 0, 'fail'), row('b', 'slack', 0, 'skip')], ['web', 'slack', 'empty']);
  assert.deepEqual(m.caseIds, ['a', 'b']);
  assert.deepEqual(m.surfaces, ['web', 'slack', 'empty']);
  assert.deepEqual(m.cells.b.slack.map((r) => r.trial), [0, 1]);
  assert.equal(m.cells.a.slack, undefined);
});

test('counts and trial pass rate exclude skips and INVALID', () => {
  const rows = [row('a', 's', 0, 'pass'), row('a', 's', 1, 'fail'), row('b', 's', 0, 'skip'), row('c', 's', 0, 'invalid')];
  const c = countRows(rows);
  assert.deepEqual(c, { pass: 1, fail: 1, skip: 1, invalid: 1, total: 4 });
  assert.equal(trialPassRate(c), 0.5);
  assert.equal(trialPassRate({ pass: 0, fail: 0 }), null);
  const s = surfaceCounts(rows, ['s', 'unused']);
  assert.equal(s[0].n_cases, 2); // a and c (b only skipped)
  assert.equal(s[1].total, 0);
});

test('safetyViolations uses scores[].safety (v2) and the v1 grader list', () => {
  const rows = [
    row('a', 's', 0, 'fail', { scores: [{ grader_id: 'approval_invariant', label: 'fail', role: 'gate' }] }),
    row('b', 's', 0, 'fail', { scores: [{ grader_id: 'custom', label: 'error', safety: true }] }),
    row('c', 's', 0, 'fail', { scores: [{ grader_id: 'call_match', label: 'fail' }, { grader_id: 'tenant_isolation', label: 'pass' }] }),
  ];
  assert.deepEqual(safetyViolations(rows).map((v) => v.row.case_id), ['a', 'b']);
});

test('ruleId splits gate rule labels', () => {
  assert.deepEqual(ruleId('G-3 safety'), { id: 'G-3', name: 'safety' });
  assert.deepEqual(ruleId('V §4.1 suite validity'), { id: 'V §4.1', name: 'suite validity' });
  assert.deepEqual(ruleId('§5.7 run INVALID'), { id: '§5.7', name: 'run INVALID' });
});

test('cardSurfaceMetrics reads the per-surface table verbatim', () => {
  const card = `# x\n\n## Per-surface metrics (never pooled)\n\n| surface | n cases | k | pass^1 [Wilson 95% over cases] | pass^k | pass@k (report only) | latency p50 / p95 ms |\n|---|---|---|---|---|---|---|\n| eve/web | 24 | 4 | 100.0% [86.2%, 100.0%] | n/a | n/a | 0 / 0 |\n\n## Next\n`;
  const m = cardSurfaceMetrics(card);
  assert.equal(m['eve/web'].pass1, '100.0%');
  assert.equal(m['eve/web'].pass1Ci, '[86.2%, 100.0%]');
  assert.equal(m['eve/web'].passk, null);
  assert.equal(m['eve/web'].nCases, '24');
  assert.deepEqual(cardSurfaceMetrics(null), {});
});

test('evidenceSteps matches exact ids and ledger sequence numbers', () => {
  const steps = [
    { step_id: 1, source: 'user', message: 'x' },
    { step_id: 2, source: 'agent', tool_calls: [{ tool_call_id: 'call_0003_abc', function_name: 'f' }] },
    { step_id: 3, source: 'agent', message: 'done', vibiz: { id: 'ap_0009_z' } },
  ];
  const hits = evidenceSteps(steps, ['fx_0003_125990ad', 'ap_0009_z', '1', 'nope']);
  assert.deepEqual(hits.get(1), { ids: ['fx_0003_125990ad'], how: 'sequence' });
  assert.equal(hits.get(2)?.how, 'exact');
  assert.equal(hits.get(0)?.how, 'exact');
  assert.equal(hits.size, 3);
});

test('toolClasses prefers explicit classes, falls back to the catalog', () => {
  const cat = { gated_classes: ['spend'], ids: { 'ads.set_budget': { class: 'spend', classes: null, gated: null } } };
  assert.deepEqual(toolClasses({ function_name: 'x', vibiz: { canonical_id: 'ads.set_budget' } }, cat), { classes: ['spend'], gated: true, canonical: 'ads.set_budget' });
  assert.deepEqual(toolClasses({ function_name: 'x', ves: { classes: ['write', 'outward'], gated: true } }, null), { classes: ['write', 'outward'], gated: true, canonical: null });
  assert.deepEqual(toolClasses({ function_name: 'x' }, cat), { classes: [], gated: false, canonical: null });
});

test('searchItems requires every term and ranks prefix matches first', () => {
  const items = [
    { kind: 'case' as const, id: 'smoke.status-leads', title: 'smoke.status-leads', subtitle: 'smoke', href: '#' },
    { kind: 'run' as const, id: 'ves-1', title: 'release · manual · PASS', subtitle: 'abc1234', href: '#' },
  ];
  assert.deepEqual(searchItems(items, 'release abc').map((i) => i.id), ['ves-1']);
  assert.deepEqual(searchItems(items, 'smoke').map((i) => i.id), ['smoke.status-leads']);
  assert.equal(searchItems(items, '').length, 2);
});

test('totalSpend sums only what files carry', () => {
  assert.deepEqual(totalSpend([{ usd_rows: 0.5, usd_actual: 9, usd_cap: null }, { usd_rows: null, usd_actual: 1, usd_cap: 5 }]), { usd: 1.5, cap: 5 });
  assert.deepEqual(totalSpend([{ usd_rows: null, usd_actual: null, usd_cap: null }]), { usd: null, cap: null });
});

test('markdown renderer escapes HTML and renders tables, code and safe links only', () => {
  const html = renderMarkdown('# T\n\n<script>x</script> **b** `c<d>`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[ok](https://x.y) [bad](javascript:alert(1))');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>b</strong>'));
  assert.ok(html.includes('<code>c&lt;d&gt;</code>'));
  assert.ok(html.includes('<td>2</td>'));
  assert.ok(html.includes('href="https://x.y"'));
  assert.ok(!html.includes('javascript:'));
});

test('format helpers', () => {
  assert.equal(pct(0.5), '50.0%');
  assert.equal(pct(null), '—');
  assert.equal(shortSha('tree:b5e1f90f2ef0'), 'b5e1f90');
  assert.equal(relativeTime('2026-11-07T10:00:00Z', Date.parse('2026-11-07T12:00:00Z')), '2h ago');
  assert.equal(relativeTime(undefined), '—');
});
