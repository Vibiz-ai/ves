// GitHub workflow-command annotations (DESIGN-agnostic §6.3): `::error` for each failing gate row (at most 10) and
// `::warning` for advisory findings the card model carries (non-conformance, skipped packs, INVALID rows, report-only).
import type { CardModel } from '../../core/types.ts';

export const MAX_ERROR_ANNOTATIONS = 10;
/** Escaping from the GitHub workflow-commands spec: data escapes %, CR, LF; properties also escape : and ,. */
export const escData = (s: unknown): string => String(s ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const escProp = (s: unknown): string => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** A case file is a repo path only when it has no `#binding` suffix (pack templates are not files in the repo). */
const fileOf = (f: string): string | null => (f && !f.includes('#') && !f.startsWith('/') ? f : null);

export function renderAnnotations(m: CardModel): string[] {
  const out: string[] = [];
  // a failing check whose rule did not fire (a smoke canary that passed its retry, a regression with no reference)
  // is a warning, not an error: the annotation must not contradict the rule table (dogfood fix 2026-11-07)
  const fired = (rule: string) => (m.rules ?? []).some((r) => (r.rule === rule || r.rule.startsWith(`${rule} `)) && r.status === 'fired');
  for (const f of m.failures.slice(0, MAX_ERROR_ANNOTATIONS)) {
    const file = fileOf(f.case_file);
    const blocking = fired(f.rule);
    const props = [file ? `file=${escProp(file)}` : null, `title=${escProp(`VES ${f.rule}${blocking ? '' : ' (not blocking)'}`)}`].filter(Boolean).join(',');
    out.push(`::${blocking ? 'error' : 'warning'} ${props}::${escData(`${f.case_id}@${f.variant} (trial ${f.trial}, ${f.grader}): ${f.explanation}`)}`);
  }
  if (m.failures.length > MAX_ERROR_ANNOTATIONS) out.push(`::error title=${escProp('VES gate')}::${escData(`${m.failures.length - MAX_ERROR_ANNOTATIONS} more failing gate checks; see the job summary`)}`);
  if (m.conformance === 'custom' || m.loosened.length) out.push(`::warning title=${escProp('VES conformance')}::${escData(`Not VES-1 conformant: ${m.loosened.join('; ') || 'custom bars'}`)}`);
  for (const p of m.packs.filter((x) => x.skipped)) out.push(`::warning title=${escProp(`VES pack ${p.id}`)}::${escData(`skipped: ${p.skipped}`)}`);
  for (const v of m.variants.filter((x) => x.invalid > 0)) out.push(`::warning title=${escProp(`VES ${v.name}`)}::${escData(`${v.invalid} INVALID row(s) on variant ${v.name}`)}`);
  if (m.verdict === 'REPORT_ONLY' && m.would_be && m.would_be !== 'PASS' && m.would_be !== 'REPORT_ONLY') out.push(`::warning title=${escProp('VES report-only')}::${escData(`would be ${m.would_be}${m.decided_by ? ` (${m.decided_by})` : ''}; this run does not fail the check`)}`);
  return out;
}
