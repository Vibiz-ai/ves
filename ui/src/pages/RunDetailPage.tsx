import { useMemo, useState, type ReactNode } from 'react';
import { IconArrowLeft, IconShieldCheck, IconAlertTriangle, IconChevronDown } from '@tabler/icons-react';
import { useApi } from '../lib/api.ts';
import { buildMatrix, cardSurfaceMetrics, normVerdict, ruleId, safetyViolations, surfaceCounts } from '../lib/shape.ts';
import { absTime, DASH, niceTime, pct, show, shortSha } from '../lib/format.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { href, type Route } from '../lib/router.ts';
import type { GateRule, ResultRow, RowsResponse, RunDetail, VariantEfficiency } from '../lib/types.ts';
import { Badge, ErrorState, Section, Skeleton, TrialDot, VerdictMark, cx } from '../components/ui.tsx';
import { TrialDrawer } from './TrialView.tsx';
import { personaIdOf, runTitle } from '../lib/people.ts';
import { RunPeople } from '../components/People.tsx';

const FIRED = (s?: string) => !!s && !['clear', 'not_evaluated', 'pass', 'ok', 'skipped'].includes(s);

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mono-label">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[14px]">{children}</dd>
    </div>
  );
}

function RuleRow({ r }: { r: GateRule }) {
  const { id, name } = ruleId(r.rule);
  const fired = FIRED(r.status);
  return (
    <li className="flex flex-col gap-1 border-b border-line py-3 last:border-0 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="w-40 shrink-0 font-mono text-[13px]"><span className="font-semibold">{id || r.rule}</span>{id && <span className="text-muted"> {name}</span>}</span>
      <span className={cx('w-28 shrink-0 font-mono text-[12px] uppercase tracking-[0.06em]', fired ? 'text-block' : r.status === 'clear' ? 'text-pass' : 'text-muted')}>{(r.status ?? DASH).replace(/_/g, ' ')}</span>
      <span className="min-w-0 flex-1 text-[14px] text-ink">{r.detail ?? DASH}{r.evidence?.length ? <span className="ml-2 font-mono text-[12px] text-muted">{r.evidence.length} evidence row(s)</span> : null}</span>
    </li>
  );
}

function SafetyStrip({ detail, rows, runId }: { detail: RunDetail; rows: ResultRow[] | null; runId: string }) {
  const g3 = detail.gate?.rules?.find((r) => /^G-3\b/.test(r.rule ?? ''));
  const g4 = detail.gate?.rules?.find((r) => /^G-4\b/.test(r.rule ?? ''));
  const violations = rows ? safetyViolations(rows) : null;
  const invalidSuites = (detail.extra?.safety_validity ?? []).filter((x) => x.ok === false);
  const bad = (violations?.length ?? 0) > 0 || FIRED(g3?.status) || invalidSuites.length > 0;
  return (
    <section aria-labelledby="safety-h" className="mt-8 rounded-lg border border-line bg-sheet shadow-card">
      <div className="rounded-lg bg-sheet p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={cx('flex size-10 items-center justify-center rounded-md bg-tile', bad ? 'text-block' : 'text-pass')}>
              {bad ? <IconAlertTriangle size={22} stroke={1.75} aria-hidden /> : <IconShieldCheck size={22} stroke={1.75} aria-hidden />}
            </span>
            <div>
              <div className="mono-label">Safety · zero tolerance</div>
              <h2 id="safety-h" className="text-[20px] leading-tight font-semibold tracking-[-0.01em]">
                {violations === null ? 'Loading trial rows…' : violations.length === 0 ? 'No safety violations' : `${violations.length} safety violation${violations.length === 1 ? '' : 's'}`}
              </h2>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {g3 && <Badge tone={FIRED(g3.status) ? 'block' : g3.status === 'clear' ? 'pass' : 'neutral'} title={g3.detail}>G-3 {g3.status?.replace(/_/g, ' ')}</Badge>}
            {g4 && <Badge tone={FIRED(g4.status) ? 'block' : g4.status === 'clear' ? 'pass' : 'neutral'} title={g4.detail}>G-4 {g4.status?.replace(/_/g, ' ')}</Badge>}
          </div>
        </div>
        <p className="mt-3 text-[14px] text-muted">
          {g3?.detail ? <>gate.json: {g3.detail}. </> : null}
          {g4?.detail ? <>Validity: {g4.detail}. </> : null}
          Violations are counted from rows where a safety grader (approval, guard, injection, isolation) scored fail or error.
        </p>
        {violations && violations.length > 0 && (
          <ul className="mt-4 flex flex-col gap-1">
            {violations.slice(0, 50).map(({ row, score }) => (
              <li key={`${row.row_id}:${score.name}`}>
                <a href={href.trial(runId, row.row_id)} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl px-3 py-2 hover:bg-tile">
                  <TrialDot status="fail" />
                  <span className="font-mono text-[13px]">{row.case_id}</span>
                  <span className="font-mono text-[12px] text-muted">{row.surface} · t{row.trial}</span>
                  <span className="font-mono text-[12px] text-block">{score.grader_id ?? score.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{score.explanation}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {invalidSuites.length > 0 && (
          <ul className="mt-3 text-[14px]">
            {invalidSuites.map((s, i) => <li key={i} className="text-block">{s.safety_suite} on {s.surface}: {(s.reasons ?? []).join('; ') || 'validity check failed'}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

function SurfaceTable({ detail, rows }: { detail: RunDetail; rows: ResultRow[] }) {
  const order = detail.run?.surfaces ?? detail.summary?.surfaces ?? [];
  const counted = surfaceCounts(rows, order);
  const card = cardSurfaceMetrics(detail.card);
  const comps = detail.extra?.comparisons ?? null;
  const base = detail.extra?.baselines ?? {};
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[860px] border-collapse text-[14px]">
        <thead>
          <tr className="bg-tile text-left">
            {['Surface', 'Cases', 'k', 'Trials P / F / I / S', 'Trial pass rate (counted)', 'pass^1 [95% CI]', 'pass^k', 'Δ vs baseline [CI]', 'Oracle'].map((h) => (
              <th key={h} scope="col" className="px-4 py-3 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {counted.map((s) => {
            const m = card[s.surface];
            const cs = (comps ?? []).filter((c) => c.surface === s.surface);
            const b = base[s.surface];
            return (
              <tr key={s.surface} className="border-t border-line">
                <th scope="row" className="px-4 py-3 text-left font-mono text-[13px] font-medium">{s.surface}</th>
                <td className="px-4 py-3 font-mono tabular-nums">{m?.nCases ?? s.n_cases}</td>
                <td className="px-4 py-3 font-mono tabular-nums">{show(m?.k ?? detail.run?.k?.[s.surface])}</td>
                <td className="px-4 py-3 font-mono tabular-nums"><span className="text-pass">{s.pass}</span> / <span className={s.fail ? 'text-block' : ''}>{s.fail}</span> / <span className={s.invalid ? 'text-invalid' : ''}>{s.invalid}</span> / <span className="text-muted">{s.skip}</span></td>
                <td className="px-4 py-3 font-mono tabular-nums">{pct(s.trial_pass_rate)}</td>
                <td className="px-4 py-3 font-mono tabular-nums">{m?.pass1 ?? DASH}{m?.pass1Ci && <span className="text-muted"> {m.pass1Ci}</span>}</td>
                <td className="px-4 py-3 font-mono tabular-nums">{m?.passk ?? DASH}</td>
                <td className="px-4 py-3 font-mono tabular-nums">
                  {cs.length === 0 ? <span className="text-muted" title={comps === null ? 'run-extra.json comparisons is null: no reference run was supplied' : 'no comparison for this surface'}>{DASH}</span> : cs.map((c, i) => (
                    <div key={i} title={`${c.metric ?? ''} ${c.reading ?? ''}`}>
                      {c.diff !== undefined ? `${c.diff >= 0 ? '+' : ''}${(c.diff * 100).toFixed(1)}pp` : DASH}
                      {c.ci && <span className="text-muted"> [{(c.ci[0] * 100).toFixed(1)}, {(c.ci[1] * 100).toFixed(1)}]</span>}
                      {c.reading && <span className="ml-1 text-muted">{c.reading}</span>}
                    </div>
                  ))}
                </td>
                <td className="px-4 py-3 font-mono tabular-nums">{b?.oracle_n !== undefined ? `${b.oracle_pass ?? 0}/${b.oracle_n}` : DASH}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const num = (x: number | null | undefined, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : x.toFixed(d)) : DASH);

/** run-extra.json `efficiency` per variant: advisory numbers, never part of the verdict. */
function Efficiency({ eff }: { eff: Record<string, VariantEfficiency> }) {
  const cols: [string, (e: VariantEfficiency) => ReactNode][] = [
    ['Trials (pass)', (e) => `${num(e.trials)} (${num(e.passing)})`],
    ['Tool calls / trial', (e) => num(e.tool_calls_per_trial)],
    ['Duplicates', (e) => <span className={e.flags?.length ? 'text-block' : ''}>{num(e.duplicate_tool_calls)}{typeof e.duplicate_rate === 'number' ? ` (${pct(e.duplicate_rate, 0)})` : ''}</span>],
    ['Turns / trial', (e) => num(e.turns_per_trial)],
    ['Calls / success', (e) => num(e.tool_calls_per_success)],
    ['Tokens / success', (e) => (e.usage_reported_trials ? num(e.tokens_per_success, 0) : <span className="text-muted">not reported</span>)],
    ['USD / success', (e) => (typeof e.usd_per_success === 'number' ? `$${e.usd_per_success.toFixed(4)}` : DASH)],
    ['Wall p50 / p95', (e) => `${num(e.wall_ms_p50, 0)} / ${num(e.wall_ms_p95, 0)} ms`],
  ];
  const flags = Object.entries(eff).flatMap(([v, e]) => (e.flags ?? []).map((f) => `${v}: ${f}`));
  return (
    <div className="rounded-lg border border-line bg-sheet">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-[14px]">
          <thead>
            <tr className="text-left">
              <th scope="col" className="mono-label px-4 py-3">Surface</th>
              {cols.map(([h]) => <th key={h} scope="col" className="mono-label px-4 py-3">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {Object.entries(eff).map(([v, e]) => (
              <tr key={v} className="border-t border-line">
                <th scope="row" className="px-4 py-3 text-left font-mono text-[13px] font-medium">{v}</th>
                {cols.map(([h, f]) => <td key={h} className="px-4 py-3 font-mono tabular-nums">{f(e)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {flags.length > 0 && <ul className="border-t border-line px-4 py-3 text-[14px] text-block">{flags.map((f) => <li key={f}>{f}</li>)}</ul>}
    </div>
  );
}

function Matrix({ runId, rows, surfaces }: { runId: string; rows: ResultRow[]; surfaces: string[] }) {
  const m = useMemo(() => buildMatrix(rows, surfaces), [rows, surfaces]);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const ids = onlyProblems ? m.caseIds.filter((c) => Object.values(m.cells[c]).some((l) => l.some((r) => r.status === 'fail' || r.status === 'invalid'))) : m.caseIds;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><TrialDot status="pass" />pass</span>
        <span className="flex items-center gap-1.5"><TrialDot status="fail" />fail</span>
        <span className="flex items-center gap-1.5"><TrialDot status="invalid" />invalid</span>
        <span className="flex items-center gap-1.5"><TrialDot status="skip" />skip</span>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-ink">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="size-4 accent-ink" />
          Only cases with fail or invalid
        </label>
      </div>
      {ids.length === 0 ? (
        <p className="rounded-lg bg-tile px-5 py-6 text-[14px] text-muted">{onlyProblems ? 'No case has a failing or INVALID trial.' : 'No trial rows in results.jsonl.'}</p>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-line">
          <table className="border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-tile">
              <tr>
                <th scope="col" className="sticky left-0 z-20 bg-tile px-4 py-3 text-left font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">Case</th>
                {m.surfaces.map((s) => (
                  <th key={s} scope="col" className="px-3 py-3 text-left font-mono text-[11px] font-medium whitespace-nowrap text-muted">{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ids.map((c) => (
                <tr key={c} className="border-t border-line">
                  <th scope="row" className="sticky left-0 z-[1] max-w-[46vw] truncate bg-sheet px-4 py-2 text-left font-mono text-[12px] font-normal sm:max-w-[320px]" title={c}>{c}</th>
                  {m.surfaces.map((s) => {
                    const list = m.cells[c]?.[s] ?? [];
                    return (
                      <td key={s} className="px-3 py-2 align-middle">
                        {list.length === 0 ? <span className="text-line-strong" aria-label="not run">·</span> : (
                          <span className="flex flex-wrap items-center gap-1">
                            {list.map((r) => (
                              <a key={r.row_id} href={href.trial(runId, r.row_id)} className="flex size-5 items-center justify-center rounded-md hover:bg-tile" aria-label={`${c} on ${s}, trial ${r.trial ?? '?'}: ${r.status ?? 'unknown'}${r.skip_reason ? ` (${r.skip_reason})` : ''}`} title={`t${r.trial ?? '?'} ${r.status ?? ''}${r.skip_reason ? `: ${r.skip_reason}` : ''}${r.invalid_reason ? `: ${r.invalid_reason}` : ''}`}>
                                <TrialDot status={r.status} />
                              </a>
                            ))}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Card({ md }: { md: string }) {
  const html = useMemo(() => renderMarkdown(md), [md]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function RunDetailPage({ id, route }: { id: string; route: Route }) {
  const detail = useApi<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, 10000);
  const rows = useApi<RowsResponse>(`/api/runs/${encodeURIComponent(id)}/rows`, 10000);
  const [showRules, setShowRules] = useState(false);
  const rowParam = route.query.get('row');

  const back = <a href="#/runs" className="mb-6 inline-flex items-center gap-2 rounded-full text-[14px] text-muted hover:text-ink"><IconArrowLeft size={18} stroke={1.75} aria-hidden />Runs</a>;

  if (detail.error && !detail.data) {
    return <>{back}<ErrorState title={`Could not open run ${id}`} error={detail.error.message} hint={detail.error.status === 404 ? 'The run directory may have been moved or deleted. Go back to Runs to see what is available.' : undefined} onRetry={detail.reload} /></>;
  }
  if (!detail.data) {
    return (
      <div aria-busy="true" aria-label="Loading run">
        {back}
        <Skeleton className="h-16 w-80 max-w-full" />
        <Skeleton className="mt-4 h-5 w-96 max-w-full" />
        <Skeleton className="mt-8 h-28 w-full" />
        <Skeleton className="mt-8 h-64 w-full" />
      </div>
    );
  }
  const d = detail.data;
  const run = d.run ?? {};
  const gate = d.gate;
  const v = normVerdict(gate?.verdict ?? run.verdict);
  const fired = (gate?.rules ?? []).filter((r) => FIRED(r.status));
  const decided = gate?.decided_by ? ruleId(gate.decided_by) : null;
  const decidedRule = gate?.decided_by ? (gate.rules ?? []).find((r) => r.rule === gate.decided_by || ruleId(r.rule).id === ruleId(gate.decided_by!).id) : null;
  const mock = (run.adapters ?? []).filter((a) => /mock|stub/i.test(a.version ?? ''));
  const surfaces = run.surfaces ?? d.summary?.surfaces ?? [];
  const rowList = rows.data?.rows ?? null;

  return (
    <>
      {back}
      <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[32px] leading-[1.1] font-semibold tracking-[-0.04em] sm:text-[40px]">{d.summary ? runTitle(d.summary) : `${run.tier ?? 'run'} · ${run.trigger ?? DASH}`}</h1>
          <p className="mt-2 text-[14px] text-muted">{niceTime(d.summary?.created)}{d.summary?.agent_models.length ? <> · <span className="font-mono text-[13px]">{d.summary.agent_models.join(', ')}</span></> : null}</p>
          <p className="mt-1 font-mono text-[12px] break-all text-faint">{d.id} · {run.tier ?? 'run'}/{run.trigger ?? DASH}</p>
        </div>
        <div className="shrink-0 rounded-lg border border-line bg-sheet shadow-card lg:w-[400px]">
          <div className="rounded-lg bg-sheet p-5">
            <div className="mono-label">Gate verdict</div>
            <div className="mt-2"><VerdictMark verdict={v} size="md" /></div>
            <p className="mt-2 text-[14px]">
              {decided ? <>Decided by <span className="font-mono font-semibold">{decided.id || gate?.decided_by}</span>{decided.name && <span className="text-muted"> {decided.name}</span>}</> : <span className="text-muted">decided_by: none (no rule blocked)</span>}
            </p>
            {gate?.would_be && normVerdict(gate.would_be) !== v && <p className="mt-1 font-mono text-[12px] text-muted">would be {gate.would_be}</p>}
            {decidedRule?.detail && <p className="mt-2 text-[14px] text-ink">{decidedRule.detail}</p>}
          </div>
        </div>
      </header>

      {fired.length > 0 && (
        <div className="mt-6">
          <div className="mono-label mb-2">Reasons ({fired.length})</div>
          <ul className="rounded-lg border border-line px-4">{fired.map((r, i) => <RuleRow key={i} r={r} />)}</ul>
        </div>
      )}

      {rowList && rowList.some((r) => personaIdOf(r)) && (
        <section aria-labelledby="persona-h" className="mt-8">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <div>
              <div className="mono-label mb-1">Simulated users · advisory</div>
              <h2 id="persona-h" className="font-display text-[20px] leading-tight font-semibold tracking-[-0.02em]">People in this run</h2>
            </div>
            <p className="text-[13px] text-muted">Click a person for their profile, or a <span className="text-ink">Chat</span> chip to read the conversation.</p>
          </div>
          <RunPeople runId={id} rows={rowList} names={new Map((d.summary?.personas ?? []).map((p) => [p.id, p.name]))} />
          <p className="mt-2 text-[12px] text-faint">Goal met, frustration (0–3) and tone fit (0–3) are persona_outcome judge reads: never part of the verdict. INVALID trials are not judged.</p>
        </section>
      )}

      <SafetyStrip detail={d} rows={rowList} runId={id} />

      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg bg-tile p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Target sha">{shortSha(run.target?.sha ?? gate?.sha)}</Fact>
        <Fact label="Change class">{show(run.target?.change_class ?? gate?.change_class)}</Fact>
        <Fact label="Cases">{show(run.suite?.case_count)}</Fact>
        <Fact label="Run status">{show(run.status)}</Fact>
        <Fact label="INVALID share">{pct(run.invalid_row_share)}</Fact>
        <Fact label="Cost (actual)">{typeof run.cost?.actual_usd === 'number' ? `$${run.cost.actual_usd.toFixed(2)}` : DASH}</Fact>
        <Fact label="Created"><span title={absTime(d.summary?.created)}>{d.summary?.created ? d.summary.created.slice(0, 10) : DASH}</span></Fact>
        <Fact label="Schema">{show(run.schema_version)}</Fact>
        <Fact label="Judge model">{show(run.judge_config?.model)}</Fact>
        <Fact label="Deploy targets">{run.target?.deploy_targets?.length ? run.target.deploy_targets.join(', ') : DASH}</Fact>
        <Fact label="Suite version">{run.suite?.version ? `${run.suite.version.slice(0, 12)}…` : DASH}</Fact>
        <Fact label="Trials">{show(d.summary?.row_count)}</Fact>
      </dl>

      {mock.length > 0 && (
        <p className="mt-4 rounded-lg border border-line px-5 py-4 text-[14px]">
          <span className="mono-label mr-2 !text-ink">Mock run</span>
          {mock.length === (run.adapters ?? []).length ? 'Every surface' : `${mock.length} surface(s)`} ran through a mock adapter. {mock[0]?.diffs_from_prod?.find((x) => /verdicts/.test(x)) ?? 'These verdicts test the harness, not the agent.'}
        </p>
      )}

      <Section title="Surfaces" label="Never pooled" id="surf-h">
        {rows.error ? <ErrorState title="Could not load results.jsonl" error={rows.error.message} onRetry={rows.reload} /> : !rowList ? <Skeleton className="h-56 w-full" /> : <SurfaceTable detail={d} rows={rowList} />}
        <p className="mt-2 text-[13px] text-muted">pass^1, CI and pass^k are copied from card.md; Δ from run-extra.json comparisons. Trial counts and the trial pass rate are counted from results.jsonl.</p>
      </Section>

      {d.extra?.efficiency && Object.keys(d.extra.efficiency).length > 0 && (
        <Section title="Efficiency" label="Advisory · never gating" id="eff-h">
          <Efficiency eff={d.extra.efficiency} />
          <p className="mt-2 text-[13px] text-muted">From run-extra.json. Each tool call counts once (a self-reported event matching a proxied call is not counted again); duplicates repeat an earlier call with the same args, flagged above 20%. Tokens and USD are agent-reported; trials without a report are unmeasured.</p>
        </Section>
      )}

      <Section title="Case × surface" label={rowList ? `${new Set(rowList.map((r) => r.case_id)).size} cases · ${rowList.length} trials` : 'Trials'} id="matrix-h">
        {rows.error ? null : !rowList ? <Skeleton className="h-96 w-full" /> : <Matrix runId={id} rows={rowList} surfaces={surfaces} />}
        {rows.data && rows.data.parse_errors > 0 && <p className="mt-2 font-mono text-[12px] text-block">{rows.data.parse_errors} line(s) of results.jsonl could not be parsed and are not shown.</p>}
      </Section>

      <Section title="All gate rules" label="gate.json" id="rules-h" actions={
        <button type="button" onClick={() => setShowRules((s) => !s)} aria-expanded={showRules} aria-controls="rules-list" className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[14px] hover:bg-tile">
          {showRules ? 'Hide' : `Show ${gate?.rules?.length ?? 0}`}<IconChevronDown size={16} stroke={1.75} className={cx('transition-transform', showRules && 'rotate-180')} aria-hidden />
        </button>
      }>
        {showRules && (gate?.rules?.length ? <ul id="rules-list" className="rounded-lg border border-line px-4">{gate.rules.map((r, i) => <RuleRow key={i} r={r} />)}</ul> : <p id="rules-list" className="text-muted">No gate.json in this run.</p>)}
      </Section>

      <Section title="Results card" label="card.md" id="card-h">
        {d.card ? <div className="rounded-lg border border-line bg-sheet shadow-card"><div className="rounded-lg bg-sheet p-5 sm:p-8"><Card md={d.card} /></div></div> : <p className="rounded-lg bg-tile px-5 py-6 text-[14px] text-muted">This run has no card.md. Regenerate it with <code className="font-mono text-ink">npx ves report --run results/{id} --format md</code>.</p>}
      </Section>

      {rowParam && <TrialDrawer runId={id} rowId={rowParam} />}
    </>
  );
}
