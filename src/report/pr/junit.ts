// JUnit XML (DESIGN-agnostic §6.5 "Other CI systems"): one <testsuite> per variant, one <testcase> per
// (case, variant, trial). Works on GitLab, Jenkins, CircleCI, Buildkite and Azure DevOps. Pure.
import type { CardModel, ResultRow, ResultRow2 } from '../../core/types.ts';

type Row = ResultRow | ResultRow2;

/** XML 1.0 text/attribute escaping; drops characters XML 1.0 forbids. */
export function xml(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const secs = (ms: number | undefined): string => ((ms ?? 0) / 1000).toFixed(3);

export function renderJUnit(m: CardModel, rows: Row[]): string {
  // The card model sorts failures G-3 first, so the first failure of a row names its most severe rule and grader.
  const firstFail = new Map<string, CardModel['failures'][number]>();
  for (const f of m.failures) if (!firstFail.has(f.row_id)) firstFail.set(f.row_id, f);
  // One testcase per (case, variant, trial): the first row counts (later ones are confirmation retries, which the
  // card model also excludes); extra attempts are noted in <system-out>.
  const seen = new Map<string, { row: Row; extra: Row[] }>();
  for (const r of rows) {
    const k = `${r.case_id}\u0000${r.surface}\u0000${r.trial}`;
    const x = seen.get(k);
    if (x) x.extra.push(r); else seen.set(k, { row: r, extra: [] });
  }
  const variants = [...new Set([...m.variants.map((v) => v.name), ...[...seen.values()].map((x) => x.row.surface)])];
  const suites: string[] = [];
  const tot = { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 };
  for (const v of variants) {
    const items = [...seen.values()].filter((x) => x.row.surface === v).sort((a, b) => (a.row.case_id < b.row.case_id ? -1 : a.row.case_id > b.row.case_id ? 1 : a.row.trial - b.row.trial));
    const c = { tests: items.length, failures: 0, errors: 0, skipped: 0, time: 0 };
    const cases: string[] = [];
    for (const { row: r, extra } of items) {
      const t = (r.usage?.wall_ms ?? 0) / 1000;
      c.time += t;
      const scores = (r.scores ?? []) as { grader_id: string; role: string; label: string; explanation?: string; evidence?: string[] | null }[];
      let inner = '';
      if (r.status === 'fail') {
        c.failures++;
        const bad = scores.filter((s) => s.role === 'gate' && s.label !== 'pass');
        const ff = firstFail.get(r.row_id);
        const first = bad.find((s) => s.grader_id === ff?.grader) ?? bad[0];
        const msg = first ? `${first.grader_id}: ${first.explanation ?? first.label}` : 'failed';
        const detail = bad.map((s) => `${s.grader_id} [${s.label}] ${s.explanation ?? ''}${s.evidence?.length ? ` (evidence ${s.evidence.join(', ')})` : ''}`).join('\n');
        inner = `\n      <failure message="${xml(msg)}" type="${xml(ff?.rule ?? 'fail')}">${xml(detail)}</failure>`;
      } else if (r.status === 'invalid') {
        c.errors++;
        inner = `\n      <error message="${xml(`INVALID: ${r.invalid_reason ?? 'unknown'}`)}" type="invalid">${xml((r as { error?: { message?: string } }).error?.message ?? '')}</error>`;
      } else if (r.status === 'skip') {
        c.skipped++;
        inner = `\n      <skipped message="${xml(r.skip_reason ?? 'skipped')}"/>`;
      }
      const adv = scores.filter((s) => s.role === 'advisory' && s.label !== 'pass');
      const out = [...adv.map((s) => `advisory ${s.grader_id} [${s.label}] ${s.explanation ?? ''}`), ...extra.map((e) => `extra attempt ${e.row_id}: ${e.status}`)];
      if (out.length) inner += `\n      <system-out>${xml(out.join('\n'))}</system-out>`;
      cases.push(`    <testcase classname="${xml(`ves.${v}`)}" name="${xml(`${r.case_id} #${r.trial}`)}" time="${t.toFixed(3)}">${inner}${inner ? '\n    ' : ''}</testcase>`);
    }
    tot.tests += c.tests; tot.failures += c.failures; tot.errors += c.errors; tot.skipped += c.skipped; tot.time += c.time;
    suites.push([
      `  <testsuite name="${xml(v)}" tests="${c.tests}" failures="${c.failures}" errors="${c.errors}" skipped="${c.skipped}" time="${c.time.toFixed(3)}">`,
      '    <properties>',
      `      <property name="ves.run_id" value="${xml(m.run_id)}"/>`,
      `      <property name="ves.sha" value="${xml(m.sha)}"/>`,
      `      <property name="ves.tier" value="${xml(m.tier)}"/>`,
      `      <property name="ves.verdict" value="${xml(m.verdict)}"/>`,
      `      <property name="ves.decided_by" value="${xml(m.decided_by ?? '')}"/>`,
      `      <property name="ves.conformance" value="${xml(m.conformance)}"/>`,
      '    </properties>',
      ...cases,
      '  </testsuite>',
    ].join('\n'));
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(`ves ${m.project} ${m.run_id}`)}" tests="${tot.tests}" failures="${tot.failures}" errors="${tot.errors}" skipped="${tot.skipped}" time="${secs(tot.time * 1000)}">`,
    ...suites,
    '</testsuites>',
  ].join('\n');
}
