// Markdown renderers of the card model (DESIGN-agnostic §6.3, §7.4): the upserted PR/MR comment and the job summary.
// Pure functions of CardModel. Untrusted text (grader explanations quote agent output) is escaped so it can neither
// break a table nor forge the comment marker.
import type { CardModel } from '../../core/types.ts';

export const MARKER_PREFIX = '<!-- ves:pr-comment project=';
export const markerFor = (project: string): string => `${MARKER_PREFIX}${project.replace(/[^A-Za-z0-9._-]/g, '_')} -->`;
export const DEFAULT_MAX_CHARS = 65000;

type Model = CardModel;
type VariantRow = CardModel['variants'][number];

/** Escapes text for a markdown table cell / inline use: no HTML, no pipes, no newlines, no backtick breakouts. */
export function esc(s: unknown, max = 300): string {
  let t = String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/`/g, "'");
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t;
}
const code = (s: unknown, max = 120): string => '`' + String(s ?? '').replace(/[`\r\n]/g, ' ').slice(0, max) + '`';
const short = (sha: string): string => (sha ?? '').replace(/^tree:/, '').slice(0, 7);
const num = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));
const signed = (x: number, d = 2): string => (Math.abs(x) < 0.5 * 10 ** -d ? (0).toFixed(d) : (x < 0 ? '−' : '+') + Math.abs(x).toFixed(d));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
export function duration(s: number): string {
  const t = Math.max(0, Math.round(s || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

export const isMock = (m: Model): boolean => Object.values(m.diffs_from_prod ?? {}).some((d) => d.some((x) => /^MOCK\b/.test(x)));
const g3Count = (m: Model): number => m.variants.reduce((a, v) => a + v.safety.violations, 0);

/** "BLOCK, G-3 safety (1 violation)" / "REPORT_ONLY (would be BLOCK, G-3 safety)" / "PASS". */
export function headline(m: Model): string {
  const viol = () => ` (${g3Count(m)} violation${g3Count(m) === 1 ? '' : 's'})`;
  const why = (v: string) => {
    if (!m.decided_by) return v;
    const extra = /^G-3\b/.test(m.decided_by) ? viol() : '';
    // the first rule decides (§7.2), but a safety violation is never hidden behind it (dogfood fix 2026-11-07)
    const also = (m.rules ?? []).filter((r) => r.status === 'fired' && r.rule !== m.decided_by).map((r) => `${r.rule}${/^G-3\b/.test(r.rule) ? viol() : ''}`);
    return `${v}, ${m.decided_by}${extra}${also.length ? `; also fired: ${also.join(', ')}` : ''}`;
  };
  if (m.verdict === 'REPORT_ONLY') return `REPORT_ONLY (would be ${m.would_be && m.would_be !== 'REPORT_ONLY' ? why(m.would_be) : 'PASS'})`;
  return why(m.verdict);
}

function contextLine(m: Model): string {
  const obs = [...new Set(m.variants.map((v) => v.observation))].join('/') || '—';
  const base = m.baseline ? ` vs baseline ${/^0+$/.test(m.baseline.sha ?? '') ? 'local run' : code(short(m.baseline.sha))} (${esc(m.baseline.source)}, run ${esc(m.baseline.run_id)})` : ' · no baseline';
  return `${code(short(m.sha))}${base} · tier ${m.tier} · trigger ${esc(m.trigger)} · class ${m.change_class} · conformance ${m.conformance} · observation ${obs}`;
}

function banners(m: Model): string[] {
  const out: string[] = [];
  if (m.conformance === 'custom' || m.loosened.length) out.push(`> [!CAUTION]\n> **Not VES-1 conformant:** ${m.loosened.map((l) => esc(l, 120)).join('; ') || 'custom bars'}. The verdict is still binding for this repo.`);
  if (isMock(m)) out.push('> [!NOTE]\n> **Mock run.** Every variant ran on the MockAgent (oracle replay): this tests wiring, cases, packs and gate, not the agent.');
  if (m.verdict === 'REPORT_ONLY') out.push(`> [!NOTE]\n> **Report only** (fork PR, first run, nightly or \`--report-only\`): this run never fails the check. It would be **${m.would_be}**.`);
  if (!m.baseline && (m.verdict === 'PASS' || m.would_be === 'PASS') && m.failures.length) out.push(`> [!WARNING]\n> **PASS without a baseline:** ${m.failures.length} non-safety failure(s) shown below do not block until a baseline exists (G-6/G-7 need a reference run). Merging to main stores one.`);
  return out;
}

function deltaCell(v: VariantRow): [string, string] {
  if (!v.delta) return ['—', '—'];
  const d = v.delta;
  const reading = d.powered ? d.reading : `${d.reading} (unpowered, MDE ${num(d.mde)})`;
  return [`${signed(d.diff)} [${signed(d.ci[0])}, ${signed(d.ci[1])}]`, reading];
}

function variantsTable(m: Model): string {
  if (!m.variants.length) return '_No variants ran._';
  const ks = [...new Set(m.variants.map((v) => v.k))];
  const kHead = ks.length === 1 && ks[0] > 1 ? `pass^${ks[0]}` : 'pass^k';
  const lines = [
    `| variant | role | cases | pass^1 [95% CI] | ${kHead} | Δ vs base [CI] | reading | safety | skipped / invalid |`,
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const v of m.variants) {
    const [dc, rd] = deltaCell(v);
    const pk = v.k <= 1 ? '—' : `${num(v.passk)}${ks.length === 1 ? '' : ` (k=${v.k})`}`;
    const safety = v.safety.violations ? `**${v.safety.violations} violation${v.safety.violations === 1 ? '' : 's'}**` : `0 (CP ≤ ${pct(v.safety.cp_upper)})`;
    lines.push(`| ${esc(v.name)} | ${esc(v.role)} | ${v.n_cases} | ${num(v.pass1)} [${num(v.pass1_ci[0])}, ${num(v.pass1_ci[1])}] | ${pk} | ${dc} | ${rd} | ${safety} | ${v.skipped} / ${v.invalid} |`);
  }
  return lines.join('\n');
}

function failureLine(f: CardModel['failures'][number]): string {
  const ev = f.evidence?.length ? ` (evidence ${f.evidence.slice(0, 3).map((e) => code(e, 60)).join(', ')})` : '';
  return `${esc(f.rule)} — ${code(f.case_id)} on ${code(f.variant)}, trial ${f.trial}: ${esc(f.grader)}: ${esc(f.explanation)}${ev}`;
}

function firedBlock(m: Model, limit: number): string[] {
  const out: string[] = [];
  const fired = m.rules.filter((r) => r.status === 'fired');
  if (fired.length) out.push(`**Fired:** ${fired.map((r) => `${esc(r.rule)}${r.effect ? ` → ${r.effect}` : ''}: ${esc(r.detail, 200)}`).join(' · ')}`);
  if (m.failures.length) {
    out.push('', '**Failing gate checks:**', '');
    for (const f of m.failures.slice(0, limit)) out.push(`- ${failureLine(f)}`);
    if (m.failures.length > limit) out.push(`- … and ${m.failures.length - limit} more (see the full card)`);
  }
  return out;
}

function packsLine(m: Model): string {
  const parts: string[] = [];
  if (m.new_cases.length) parts.push(`New cases in this PR (advisory until merged): ${m.new_cases.length}`);
  const skipped = m.packs.filter((p) => p.skipped);
  if (skipped.length) parts.push(`Skipped packs: ${skipped.map((p) => `${esc(p.id)} (${esc(p.skipped, 80)})`).join(', ')}`);
  const lr = m.packs.reduce((a, p) => a + (p.low_realism_intents ?? 0), 0);
  if (lr) parts.push(`Low-realism intents: ${lr}`);
  const ran = m.packs.filter((p) => !p.skipped);
  if (ran.length) parts.push(`Packs: ${ran.map((p) => `${esc(p.id)}@${esc(p.version)} (${p.cases})`).join(', ')}`);
  return parts.join(' · ');
}

function rulesTable(m: Model): string {
  if (!m.rules.length) return '_No gate rules recorded._';
  return ['| rule | status | effect | detail |', '|---|---|---|---|', ...m.rules.map((r) => `| ${esc(r.rule)} | ${r.status === 'fired' ? '**fired**' : r.status} | ${r.effect ?? ''} | ${esc(r.detail, 240)} |`)].join('\n');
}

function costLine(m: Model): string {
  const agent = m.cost.agent_usd_reported === null ? 'agent cost self-reported or unmeasured' : `agent $${m.cost.agent_usd_reported.toFixed(2)} (self-reported)`;
  return `Cost $${(m.cost.usd ?? 0).toFixed(2)} (harness) · ${agent} · ${duration(m.cost.wall_s)}`;
}

function links(o: { runUrl?: string; artifactUrl?: string }): string {
  const l: string[] = [];
  if (o.runUrl) l.push(`[Full card](${o.runUrl})`);
  if (o.artifactUrl ?? o.runUrl) l.push(`[Artifacts](${o.artifactUrl ?? `${o.runUrl}#artifacts`})`);
  return l.join(' · ');
}

/** Cuts at a line boundary so the result plus `tail` fits in `max`; closes an open <details>. */
function fit(body: string, tail: string, max: number): string {
  if (body.length + tail.length <= max) return body + tail;
  const note = '\n\n_… truncated: the comment exceeded the size limit._';
  let cut = body.slice(0, Math.max(0, max - tail.length - note.length - 20));
  cut = cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0));
  const open = (cut.match(/<details>/g) ?? []).length - (cut.match(/<\/details>/g) ?? []).length;
  return cut + (open > 0 ? '\n</details>' : '') + note + tail;
}

/** The single upserted PR/MR comment. First line is the marker `<!-- ves:pr-comment project=<p> -->`. */
export function renderPrComment(m: Model, o: { runUrl?: string; artifactUrl?: string; maxChars?: number } = {}): string {
  const max = o.maxChars ?? DEFAULT_MAX_CHARS;
  const head = [markerFor(m.project), `### VES gate: ${headline(m)}`, contextLine(m)];
  const body = [
    ...head, '',
    ...banners(m).flatMap((b) => [b, '']),
    variantsTable(m), '',
    ...firedBlock(m, 10),
    ...(packsLine(m) ? ['', packsLine(m)] : []),
    '', '<details><summary>All rules</summary>', '', rulesTable(m), '', '</details>',
  ].join('\n');
  const tailParts = [links(o), costLine(m)].filter(Boolean).join(' · ');
  return fit(body, `\n\n${tailParts}`, max);
}

/** The job summary ($GITHUB_STEP_SUMMARY): the same card with every rule's status and more failures. */
export function renderJobSummary(m: Model, o: { runUrl?: string } = {}): string {
  const diffs = Object.entries(m.diffs_from_prod ?? {}).filter(([, d]) => d.length);
  return [
    `## VES gate: ${headline(m)}`,
    `${esc(m.project)} · run ${code(m.run_id)} · ${contextLine(m)}`, '',
    ...banners(m).flatMap((b) => [b, '']),
    variantsTable(m), '',
    '### Gate rules', '', rulesTable(m), '',
    ...(m.failures.length ? ['### Failing gate checks', '', ...m.failures.slice(0, 50).map((f) => `- ${failureLine(f)}`), ...(m.failures.length > 50 ? [`- … and ${m.failures.length - 50} more`] : []), ''] : []),
    ...(m.packs.length ? ['### Packs', '', '| pack | version | cases | skipped | low-realism intents |', '|---|---|---|---|---|', ...m.packs.map((p) => `| ${esc(p.id)} | ${esc(p.version)} | ${p.cases} | ${esc(p.skipped ?? '')} | ${p.low_realism_intents} |`), ''] : []),
    ...(m.new_cases.length ? ['### New cases in this PR (advisory until merged)', '', ...m.new_cases.map((c) => `- ${code(c)}`), ''] : []),
    ...(diffs.length ? ['### Differences from production', '', ...diffs.flatMap(([v, d]) => d.map((x) => `- ${esc(v)}: ${esc(x, 300)}`)), ''] : []),
    [links(o), costLine(m)].filter(Boolean).join(' · '), '',
  ].join('\n');
}
