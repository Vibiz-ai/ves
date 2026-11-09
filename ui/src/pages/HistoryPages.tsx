// History, Compare and Case timeline: read-only views over the run store (/api/store/*). The comparison numbers come
// from `ves compare --json` / `ves history --json` (shelled out by the server), never from code in this bundle.
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { IconArrowsDiff, IconArrowRight, IconChartDots3, IconChartLine, IconSwitchHorizontal, IconTimeline } from '@tabler/icons-react';
import { useApi } from '../lib/api.ts';
import { useAppData } from '../lib/data.tsx';
import { defaultPair, prevComparable, fromEntry, pts, short, trendSeries, uniq } from '../lib/history.ts';
import { absTime, pct, relativeTime, usd } from '../lib/format.ts';
import { href, navigate, type Route } from '../lib/router.ts';
import { normVerdict } from '../lib/shape.ts';
import type { CaseCell, CompareResult, Flip, HistoryResult, ResultRow, RowsResponse, StoreEntry, StoreRunsResponse } from '../lib/types.ts';
import { hasPersona, personaTable } from '../lib/persona.ts';
import { PersonaTableView } from '../components/Persona.tsx';
import { Badge, Button, Chip, EmptyState, ErrorState, ICON, PageHeader, Section, Skeleton, Tile, TrialDot, VerdictDot, VerdictMark, cx } from '../components/ui.tsx';
import { TrendChart } from '../components/TrendChart.tsx';
import { TrialBody } from './TrialView.tsx';
import { pathHref } from './PathViews.tsx';

export const storeHref = {
  history: (q: Record<string, string | null | undefined> = {}) => `#/history${qs(q)}`,
  compare: (a?: string | null, b?: string | null, extra: Record<string, string | null | undefined> = {}) => `#/compare${qs({ a, b, ...extra })}`,
  timeline: (c: string, variant?: string | null) => `#/history/case${qs({ case: c, variant })}`,
  trial: (run: string, row: string) => `#/store/${encodeURIComponent(run)}/trial?row=${encodeURIComponent(row)}`,
};
function qs(q: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
const setQuery = (base: string, q: Record<string, string | null | undefined>) => navigate(`${base}${qs(q)}`);

function useStoreRuns() {
  return useApi<StoreRunsResponse>('/api/store/runs', 10000);
}

function NoStore({ data }: { data: StoreRunsResponse }) {
  return (
    <EmptyState
      icon={<IconChartLine {...ICON} />}
      title={data.configured ? 'The run store is empty' : 'No run store configured'}
      body={data.configured
        ? <>Push run directories into <span className="font-mono text-[13px] text-ink">{data.url}</span> and they show up here, kept forever and comparable.</>
        : <>History and Compare read an append-only run store (a local directory or <span className="font-mono text-[13px] text-ink">gs://bucket/prefix</span>). Push runs into one, then start the dashboard with <span className="font-mono text-[13px] text-ink">--store</span>.</>}
      command={data.configured ? 'npx ves store push results/ves-*' : 'npx ves store push results/ves-* && npx ves ui --store .ves/store'}
    />
  );
}

function StoreGate({ children }: { children: (d: StoreRunsResponse) => ReactNode }) {
  const st = useStoreRuns();
  if (st.error && !st.data) return <ErrorState title="Could not read the run store" error={st.error.message} onRetry={st.reload} />;
  if (!st.data) return <div aria-busy="true" className="grid gap-5 md:grid-cols-2"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>;
  if (!st.data.configured || !st.data.entries.length) return <NoStore data={st.data} />;
  return <>{children(st.data)}</>;
}

const runLabel = (e: StoreEntry) => `#${e.seq} · ${e.target.branch ?? 'no branch'} · ${short(e.target.sha).slice(0, 7)} · ${e.tier ?? '—'} · ${e.verdict ?? '—'} · suite ${e.suite_label ?? '—'}`;

// ============================================================================================== History

export function HistoryPage({ route }: { route: Route }) {
  const branch = route.query.get('branch');
  const tier = route.query.get('tier');
  return (
    <>
      <PageHeader title="History" sub="Every stored run, oldest to newest. A BREAK marks a suite_version change: pass^1 on either side of it measures different cases." actions={<a href="#/compare" className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-4 text-[14px] font-medium text-white hover:bg-primary-hover"><IconArrowsDiff size={18} stroke={1.75} aria-hidden />Compare runs</a>} />
      <StoreGate>{(d) => <HistoryBody d={d} branch={branch} tier={tier} />}</StoreGate>
    </>
  );
}

function HistoryBody({ d, branch, tier }: { d: StoreRunsResponse; branch: string | null; tier: string | null }) {
  const branches = uniq(d.entries.map((e) => e.target.branch));
  const tiers = uniq(d.entries.map((e) => e.tier));
  const shown = d.entries.filter((e) => (!branch || e.target.branch === branch) && (!tier || e.tier === tier));
  const surfaces = uniq(shown.flatMap((e) => Object.keys(e.surfaces ?? {})));
  const [caseQ, setCaseQ] = useState('');
  const { cases } = useAppData();
  const go = (q: Record<string, string | null>) => setQuery('#/history', { branch, tier, ...q });
  const openCase = (e: FormEvent) => { e.preventDefault(); if (caseQ.trim()) navigate(storeHref.timeline(caseQ.trim())); };
  return (
    <>
      <p className="-mt-3 mb-6 font-mono text-[12px] break-all text-muted">store {d.url} · {d.entries.length} run(s){d.problems.length ? ` · ${d.problems.length} problem(s)` : ''}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by branch">
        <span className="mono-label mr-1 w-14">Branch</span>
        <Chip active={!branch} count={d.entries.length} onClick={() => go({ branch: null })}>All</Chip>
        {branches.map((b) => <Chip key={b} active={branch === b} count={d.entries.filter((e) => e.target.branch === b).length} onClick={() => go({ branch: b })}>{b}</Chip>)}
      </div>
      <div className="mb-8 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by tier">
        <span className="mono-label mr-1 w-14">Tier</span>
        <Chip active={!tier} onClick={() => go({ tier: null })}>All</Chip>
        {tiers.map((t) => <Chip key={t} active={tier === t} onClick={() => go({ tier: t })}>{t}</Chip>)}
      </div>

      {!shown.length ? <EmptyState title="No runs match" body="No stored run has this branch and tier. Clear a filter." /> : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {surfaces.map((s) => {
            const { points, breaks } = trendSeries(d.entries, s, { branch, tier });
            const last = points[points.length - 1];
            const prev = points.length > 1 && points[points.length - 2].suite_version === last?.suite_version ? points[points.length - 2] : null;
            return (
              <Tile key={s} className="min-w-0" inner="min-w-0 p-5 sm:p-6">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mono-label">[{s}]</div>
                    <div className="mt-1 flex items-baseline gap-3">
                      <span className="text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{last ? pct(last.pass1, 0) : '—'}</span>
                      <span className="font-mono text-[12px] text-muted">pass^1 latest{last ? ` · n=${last.n}` : ''}</span>
                    </div>
                  </div>
                  <span className="font-mono text-[12px] text-muted" title="Point difference against the previous run in this series with the same suite_version (no CI; open Compare for the paired bootstrap)">
                    {prev ? `${pts(last!.pass1 - prev.pass1)} vs previous` : 'no comparable previous point'}
                  </span>
                </div>
                <TrendChart points={points} breaks={breaks} title={`${s} pass^1 history`} onPick={(p) => {
                  const e = d.entries.find((x) => x.run_id === p.run_id)!;
                  const pc = prevComparable(fromEntry(e), d.entries.map(fromEntry));
                  navigate(storeHref.compare(pc?.id ?? null, p.run_id));
                }} />
              </Tile>
            );
          })}
        </div>
      )}

      <Section title="Case timeline" label="One case across runs">
        <form onSubmit={openCase} className="flex max-w-xl flex-col gap-2 sm:flex-row">
          <label htmlFor="case-q" className="sr-only">Case id</label>
          <input id="case-q" list="case-ids" value={caseQ} onChange={(e) => setCaseQ(e.target.value)} placeholder="case id, e.g. smoke.status-leads" className="h-11 min-w-0 flex-1 rounded-md bg-tile px-4 font-mono text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-ink" />
          <datalist id="case-ids">{(cases.data?.cases ?? []).map((c) => <option key={c.id} value={c.id} />)}</datalist>
          <Button variant="primary" className="h-11" type="submit"><IconTimeline size={18} stroke={1.75} aria-hidden />Open timeline</Button>
        </form>
      </Section>

      <Section title="Runs" label="Newest first">
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="bg-tile font-mono text-[11px] tracking-[0.06em] text-muted uppercase">
              <tr><th className="px-3 py-2 text-left font-medium">#</th><th className="px-3 py-2 text-left font-medium">Run</th><th className="px-3 py-2 text-left font-medium">Branch</th><th className="px-3 py-2 text-left font-medium">Verdict</th><th className="px-3 py-2 text-left font-medium">Suite</th><th className="px-3 py-2 text-right font-medium">Compare</th></tr>
            </thead>
            <tbody>
              {[...shown].reverse().map((e) => {
                const pc = prevComparable(fromEntry(e), d.entries.map(fromEntry));
                return (
                  <tr key={e.run_id} className="border-t border-line">
                    <td className="px-3 py-2 font-mono text-muted">{e.seq}</td>
                    <td className="px-3 py-2"><span className="font-mono">{short(e.target.sha).slice(0, 7)}</span> <span className="text-muted" title={absTime(e.created)}>{relativeTime(e.created)}</span><div className="font-mono text-[11px] text-faint">{e.run_id}</div></td>
                    <td className="px-3 py-2 font-mono">{e.target.branch ?? '—'}</td>
                    <td className="px-3 py-2"><span className="inline-flex items-center gap-2"><VerdictDot verdict={normVerdict(e.verdict)} /><span className="font-mono text-[12px]">{e.verdict ?? '—'}</span></span>{e.decided_by && <div className="font-mono text-[11px] text-muted">{e.decided_by}</div>}</td>
                    <td className="px-3 py-2 font-mono">{e.suite_label ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{pc ? <a className="font-mono text-[12px] underline underline-offset-2" href={storeHref.compare(pc.id, e.run_id)}>vs #{d.entries.find((x) => x.run_id === pc.id)?.seq}</a> : <span className="font-mono text-[12px] text-faint">first of its suite</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

// ============================================================================================== Compare

const READING_STYLE: Record<string, string> = { above: 'text-pass', below: 'text-block', level: 'text-ink' };
const FLIP_TONE: Record<string, 'block' | 'pass' | 'neutral' | 'dark'> = { 'pass→fail': 'block', 'fail→pass': 'pass', new: 'dark', removed: 'neutral', unscored: 'neutral' };

export function ComparePage({ route }: { route: Route }) {
  return (
    <>
      <PageHeader title="Compare" sub="Δ = head − base, per surface: paired cluster bootstrap by case with Holm across surfaces, read above / level / below (STANDARD §5.5). Computed by ves compare." />
      <StoreGate>{(d) => <CompareBody d={d} route={route} />}</StoreGate>
    </>
  );
}

function RunPicker({ id, label, value, entries, onChange }: { id: string; label: string; value: string | null; entries: StoreEntry[]; onChange: (v: string) => void }) {
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="mono-label mb-2 block">{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="h-11 w-full min-w-0 truncate rounded-md bg-tile px-3 font-mono text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-ink">
        {!value && <option value="">pick a run</option>}
        {[...entries].reverse().map((e) => <option key={e.run_id} value={e.run_id}>{runLabel(e)}</option>)}
      </select>
    </div>
  );
}

function CompareBody({ d, route }: { d: StoreRunsResponse; route: Route }) {
  const def = useMemo(() => defaultPair(d.entries, d.current_branch), [d.entries, d.current_branch]);
  const a = route.query.get('a') ?? def.base;
  const b = route.query.get('b') ?? def.head;
  const sel = route.query.get('case');
  const selSurface = route.query.get('surface');
  const cmp = useApi<CompareResult>(a && b && a !== b ? `/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` : null);
  const set = (q: Record<string, string | null>) => setQuery('#/compare', { a, b, case: sel, surface: selSurface, ...q });
  const ea = d.entries.find((e) => e.run_id === a) ?? null, eb = d.entries.find((e) => e.run_id === b) ?? null;
  // the previous pair's result stays in state for one render after the URL changes: never mix it with the new ids
  const c = cmp.data && cmp.data.base.run_id === a && cmp.data.head.run_id === b ? cmp.data : null;
  const flip = c?.flips.find((f) => f.case_id === sel && f.surface === selSurface) ?? null;
  return (
    <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end">
        <RunPicker id="cmp-a" label="Base (reference)" value={a} entries={d.entries} onChange={(v) => set({ a: v, case: null, surface: null })} />
        <Button className="h-11 self-start bg-tile sm:self-auto" onClick={() => set({ a: b, b: a, case: null, surface: null })} aria-label="Swap base and head"><IconSwitchHorizontal size={18} stroke={1.75} aria-hidden />Swap</Button>
        <RunPicker id="cmp-b" label="Head (candidate)" value={b} entries={d.entries} onChange={(v) => set({ b: v, case: null, surface: null })} />
      </div>
      {!route.query.get('a') && !route.query.get('b') && <p className="-mt-3 mb-6 font-mono text-[12px] text-muted">Default pair: newest run on {d.current_branch && d.current_branch !== 'main' ? d.current_branch : 'any branch'} vs the newest earlier main run of the same tier.</p>}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {[['Base', ea], ['Head', eb]].map(([lbl, e]) => (
          <Tile key={lbl as string} inner="p-5 sm:p-6">
            <div className="mono-label">{lbl as string}{e ? ` · #${(e as StoreEntry).seq}` : ''}</div>
            {e ? (() => { const x = e as StoreEntry; return (
              <>
                <div className="mt-3"><VerdictMark verdict={normVerdict(x.verdict)} size="md" /></div>
                {x.decided_by && <div className="mt-1 font-mono text-[12px] text-muted">{x.decided_by}</div>}
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[12px]">
                  <div><dt className="text-faint">branch</dt><dd className="truncate">{x.target.branch ?? '—'}</dd></div>
                  <div><dt className="text-faint">sha</dt><dd>{short(x.target.sha)}</dd></div>
                  <div><dt className="text-faint">suite</dt><dd>{x.suite_label ?? '—'} · {short(x.suite_version)}</dd></div>
                  <div><dt className="text-faint">created</dt><dd title={absTime(x.created)}>{relativeTime(x.created)}</dd></div>
                </dl>
                <p className="mt-3 truncate font-mono text-[11px] text-faint">{x.run_id}</p>
              </>
            ); })() : <p className="mt-3 text-[14px] text-muted">Pick a run.</p>}
          </Tile>
        ))}
      </div>

      {a && b && a === b && <p className="mt-6 rounded-lg bg-tile px-5 py-4 text-[14px] text-muted">Base and head are the same run. Pick two different runs.</p>}
      {cmp.error && <div className="mt-6"><ErrorState title="Comparison failed" error={cmp.error.message} onRetry={cmp.reload} /></div>}
      {!cmp.error && a && b && a !== b && !c && <Skeleton className="mt-6 h-48 w-full" />}
      {c && (
        <>
          {c.refused ? (
            <div role="status" className="mt-6 rounded-lg bg-ink p-6 text-white sm:p-8">
              <div className="font-mono text-[11px] tracking-[0.14em] text-white/70 uppercase">[Aggregate comparison refused]</div>
              <p className="mt-3 max-w-3xl text-[20px] leading-snug font-semibold tracking-[-0.01em]">{c.refused.reason}.</p>
              <ul className="mt-3 flex flex-col gap-1 font-mono text-[12px] text-white/80">{c.refused.detail.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          ) : (
            <Section title="Per surface" label="pass^1 · Δ with Holm-adjusted 95% CI">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {c.surfaces.map((s) => (
                  <div key={s.surface} className="rounded-lg border border-line p-5">
                    <div className="mono-label">[{s.surface}]</div>
                    <div className={cx('mt-2 text-[34px] leading-none font-semibold tracking-[-0.03em] uppercase', READING_STYLE[s.pass1?.reading ?? 'level'])}>{s.pass1?.reading ?? 'n/a'}</div>
                    <div className="mt-3 font-mono text-[14px] tabular-nums">{s.pass1 ? pts(s.pass1.diff) : '—'}</div>
                    <div className="font-mono text-[12px] text-muted">CI {s.pass1 ? `[${pts(s.pass1.ci[0])}, ${pts(s.pass1.ci[1])}]` : '—'} · {s.pass1?.n_pairs ?? 0} paired cases</div>
                    <div className="mt-3 font-mono text-[12px] text-muted">{pct(s.base.pass1)} → <span className="text-ink">{pct(s.head.pass1)}</span></div>
                    {s.other_metrics.map((m) => <div key={m.metric} className="font-mono text-[11px] text-faint">{m.metric}: {pts(m.diff)} → {m.reading}</div>)}
                  </div>
                ))}
              </div>
              {(c.only_in_base.length > 0 || c.only_in_head.length > 0) && <p className="mt-3 font-mono text-[12px] text-muted">only in base: {c.only_in_base.join(', ') || '—'} · only in head: {c.only_in_head.join(', ') || '—'}</p>}
            </Section>
          )}
          {c.hygiene.length > 0 && <p className="mt-4 font-mono text-[12px] text-muted">Comparator hygiene (§5.5): {c.hygiene.join('; ')}</p>}

          <Section title={`Flipped cases (${c.flips.length})`} label={c.refused ? 'Only cases whose version is the same in both runs' : 'Click a case to see both trajectories'}>
            <div className="mb-3 flex flex-wrap gap-2">
              {(['pass→fail', 'fail→pass', 'new', 'removed', 'unscored'] as const).map((k) => <Badge key={k} tone={c.flip_counts[k] ? FLIP_TONE[k] : 'neutral'}>{k} {c.flip_counts[k]}</Badge>)}
            </div>
            {c.flips.length === 0 ? <p className="rounded-lg bg-tile px-5 py-4 text-[14px] text-muted">No case changed outcome between these runs.</p> : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[600px] text-[13px]">
                  <thead className="bg-tile font-mono text-[11px] tracking-[0.06em] text-muted uppercase">
                    <tr><th className="px-3 py-2 text-left font-medium">Change</th><th className="px-3 py-2 text-left font-medium">Case</th><th className="px-3 py-2 text-left font-medium">Surface</th><th className="px-3 py-2 text-left font-medium">Base</th><th className="px-3 py-2 text-left font-medium">Head</th><th className="px-3 py-2 text-left font-medium">Failing graders</th><th className="px-3 py-2 text-right font-medium">Path</th></tr>
                  </thead>
                  <tbody>
                    {c.flips.map((f) => {
                      const on = f.case_id === sel && f.surface === selSurface;
                      return (
                        <tr key={`${f.case_id}|${f.surface}`} className={cx('border-t border-line', on ? 'bg-hl' : 'hover:bg-tile/60')}>
                          <td className="px-3 py-2"><Badge tone={FLIP_TONE[f.kind]}>{f.kind}</Badge></td>
                          <td className="px-3 py-2"><button type="button" className="text-left font-mono font-medium underline-offset-2 hover:underline" onClick={() => set({ case: f.case_id, surface: f.surface })} aria-pressed={on}>{f.case_id}<span className="text-faint">@{f.case_version}</span></button></td>
                          <td className="px-3 py-2 font-mono">{f.surface}</td>
                          <td className="px-3 py-2"><CellMini c={f.base} /></td>
                          <td className="px-3 py-2"><CellMini c={f.head} /></td>
                          <td className="px-3 py-2 font-mono text-[12px] text-muted">{(f.head?.failing_graders.length ? f.head.failing_graders : f.base?.failing_graders ?? []).join(', ') || '—'}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">{f.base?.row_id && f.head?.row_id && a && b
                            ? <a className="inline-flex items-center gap-1 font-mono text-[12px] underline-offset-2 hover:underline" href={pathHref.compare({ runId: a, rowId: f.base.row_id, store: true }, { runId: b, rowId: f.head.row_id, store: true })}><IconArrowsDiff size={14} stroke={1.75} aria-hidden />path diff</a>
                            : f.case_id ? <a className="font-mono text-[12px] text-muted underline-offset-2 hover:underline" href={pathHref.case(f.case_id, f.surface)}>all paths</a> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {c.version_changed.length > 0 && <p className="mt-3 font-mono text-[12px] text-muted">Not compared (case version changed): {c.version_changed.map((v) => `${v.case_id} v${v.base_version}→v${v.head_version}`).join(', ')}</p>}
          </Section>

          <ComparePersonas a={a} b={b} />

          {flip && a && b && <SideBySide flip={flip} a={a} b={b} onClose={() => set({ case: null, surface: null })} />}

          <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Tile inner="p-5 sm:p-6">
              <div className="mono-label">Safety violations</div>
              <div className="mt-2 flex items-baseline gap-4">
                <span className={cx('text-[40px] leading-none font-semibold tracking-[-0.03em]', c.safety.new.length ? 'text-block' : 'text-ink')}>{c.safety.new.length}</span>
                <span className="font-mono text-[12px] text-muted">new · {c.safety.fixed.length} fixed · {c.safety.persisting.length} persisting · base {c.safety.base_violations}, head {c.safety.head_violations}</span>
              </div>
              <ul className="mt-3 flex flex-col gap-1 font-mono text-[12px] break-all">
                {c.safety.new.map((k) => <li key={k} className="text-block">NEW {k}</li>)}
                {c.safety.fixed.map((k) => <li key={k} className="text-pass">fixed {k}</li>)}
              </ul>
            </Tile>
            <Tile inner="p-5 sm:p-6">
              <div className="mono-label">Cost</div>
              <dl className="mt-3 grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 font-mono text-[12px] tabular-nums">
                <dt className="text-faint">&nbsp;</dt><dd className="text-faint">base</dd><dd className="text-faint">head</dd><dd className="text-faint">Δ</dd>
                <dt>harness USD</dt><dd>{usd(c.cost.base.actual_usd)}</dd><dd>{usd(c.cost.head.actual_usd)}</dd><dd>{usd(c.cost.delta.actual_usd)}</dd>
                <dt>agent USD</dt><dd>{usd(c.cost.base.agent_usd_reported)}</dd><dd>{usd(c.cost.head.agent_usd_reported)}</dd><dd>{usd(c.cost.delta.agent_usd_reported)}</dd>
                <dt>tokens</dt><dd>{c.cost.base.tokens}</dd><dd>{c.cost.head.tokens}</dd><dd>{c.cost.delta.tokens}</dd>
              </dl>
            </Tile>
          </div>
          {c.notes.length > 0 && <ul className="mt-4 flex flex-col gap-1 font-mono text-[12px] text-muted">{c.notes.map((x) => <li key={x}>note: {x}</li>)}</ul>}
        </>
      )}
    </>
  );
}

function CellMini({ c }: { c: CaseCell | null }) {
  if (!c) return <span className="font-mono text-[12px] text-faint">—</span>;
  return <span className="inline-flex items-center gap-2 font-mono text-[12px]"><TrialDot status={c.status} />{c.status} {c.c}/{c.n}</span>;
}

function SideBySide({ flip, a, b, onClose }: { flip: Flip; a: string; b: string; onClose: () => void }) {
  return (
    <section className="mt-8" aria-label={`Trajectories of ${flip.case_id} on ${flip.surface}`}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mono-label mb-1">Side by side · {flip.kind}</div>
          <h2 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] break-words">{flip.case_id} <span className="font-mono text-[14px] font-normal text-muted">on {flip.surface}</span></h2>
        </div>
        <div className="flex gap-2">
          <a href={storeHref.timeline(flip.case_id, flip.surface)} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-tile px-3 text-[14px] hover:bg-chip"><IconTimeline size={16} stroke={1.75} aria-hidden />Timeline</a>
          {flip.base?.row_id && flip.head?.row_id && <a href={pathHref.compare({ runId: a, rowId: flip.base.row_id, store: true }, { runId: b, rowId: flip.head.row_id, store: true })} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-tile px-3 text-[14px] hover:bg-chip"><IconArrowsDiff size={16} stroke={1.75} aria-hidden />Path diff</a>}
          <a href={pathHref.case(flip.case_id, flip.surface)} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-tile px-3 text-[14px] hover:bg-chip"><IconChartDots3 size={16} stroke={1.75} aria-hidden />All paths</a>
          <Button size="sm" className="h-9 bg-tile" onClick={onClose}>Close</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        {([['Base', a, flip.base], ['Head', b, flip.head]] as const).map(([lbl, run, cell]) => (
          <div key={lbl} className="min-w-0 rounded-lg border border-line bg-sheet shadow-card">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="mono-label !text-ink">{lbl}</span>
              {cell?.row_id && <a className="inline-flex items-center gap-1 font-mono text-[12px] underline-offset-2 hover:underline" href={storeHref.trial(run, cell.row_id)}>open trial<IconArrowRight size={14} stroke={1.75} aria-hidden /></a>}
            </div>
            <div className="min-w-0 rounded-lg bg-sheet p-4 sm:p-5">
              {cell?.row_id ? <TrialBody runId={run} rowId={cell.row_id} apiBase="/api/store/runs" /> : <p className="text-[14px] text-muted">{lbl === 'Base' ? 'The case is not in the base run.' : 'The case is not in the head run.'}</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================================================================================== Case timeline

export function CaseTimelinePage({ route }: { route: Route }) {
  const caseId = route.query.get('case');
  const variant = route.query.get('variant');
  const h = useApi<HistoryResult>(caseId ? `/api/history?case=${encodeURIComponent(caseId)}${variant ? `&variant=${encodeURIComponent(variant)}` : ''}` : null);
  const all = useApi<HistoryResult>(caseId && variant ? `/api/history?case=${encodeURIComponent(caseId)}` : null);
  const [q, setQ] = useState(caseId ?? '');
  const { cases } = useAppData();
  const surfacesAll = uniq((variant ? all.data : h.data)?.runs.flatMap((r) => r.cells.map((c) => c.surface)) ?? []).sort();
  return (
    <>
      <a href="#/history" className="mb-6 inline-flex items-center gap-2 text-[14px] text-muted hover:text-ink">← History</a>
      <PageHeader title={caseId ?? 'Case timeline'} actions={caseId ? <a href={pathHref.case(caseId, variant)} className="inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-[14px] font-medium shadow-[0_0_0_1px_var(--color-line)] hover:bg-shell"><IconChartDots3 size={16} stroke={1.75} aria-hidden />All paths graph</a> : undefined} sub={h.data ? `${h.data.runs.length} of ${h.data.runs_scanned} stored run(s) contain this case · case versions ${h.data.versions.map((v) => `v${v}`).join(', ') || '—'}` : 'One case across every stored run. Each dot is that run\'s outcome for the case; click it for the trial.'} />
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(storeHref.timeline(q.trim(), variant)); }} className="mb-5 flex max-w-xl flex-col gap-2 sm:flex-row">
        <label htmlFor="tl-q" className="sr-only">Case id</label>
        <input id="tl-q" list="tl-ids" value={q} onChange={(e) => setQ(e.target.value)} placeholder="case id" className="h-11 min-w-0 flex-1 rounded-md bg-tile px-4 font-mono text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-ink" />
        <datalist id="tl-ids">{(cases.data?.cases ?? []).map((c) => <option key={c.id} value={c.id} />)}</datalist>
        <Button variant="primary" className="h-11" type="submit">Show</Button>
      </form>
      {caseId && surfacesAll.length > 1 && (
        <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filter by surface">
          <Chip active={!variant} onClick={() => navigate(storeHref.timeline(caseId))}>All</Chip>
          {surfacesAll.map((s) => <Chip key={s} active={variant === s} onClick={() => navigate(storeHref.timeline(caseId, s))}>{s}</Chip>)}
        </div>
      )}
      {!caseId ? null : h.error ? <ErrorState title="Could not load the case history" error={h.error.message} onRetry={h.reload} /> : !h.data ? <Skeleton className="h-48 w-full" /> : !h.data.runs.length ? (
        <EmptyState title="No stored run contains this case" body={<>Checked {h.data.runs_scanned} run(s). Check the id, or push runs that include it.</>} />
      ) : <Timeline h={h.data} />}
    </>
  );
}

function Timeline({ h }: { h: HistoryResult }) {
  const surfaces = uniq(h.runs.flatMap((r) => r.cells.map((c) => c.surface))).sort();
  const COL = 34;
  return (
    <Tile inner="p-4 sm:p-6">
      <div className="overflow-x-auto pt-6 pb-2">
        <div className="inline-grid min-w-full gap-y-2" style={{ gridTemplateColumns: `minmax(120px, 180px) repeat(${h.runs.length}, auto)` }}>
          <div className="mono-label self-end pb-1">Surface \ run</div>
          {h.runs.map((r) => (
            <div key={r.run_id} className="flex items-end">
              {r.version_break && <BreakMark from={r.version_break.from} to={r.version_break.to} />}
              <div className="text-center font-mono text-[10px] leading-tight text-faint" style={{ width: COL }} title={`${r.run_id} · ${r.branch ?? ''}`}>#{r.seq}</div>
            </div>
          ))}
          {surfaces.map((s) => (
            <Row key={s} s={s} h={h} COL={COL} />
          ))}
          <div className="mono-label pt-1">Verdict</div>
          {h.runs.map((r) => (
            <div key={r.run_id} className="flex items-center">
              {r.version_break && <span className="w-3" aria-hidden />}
              <div className="flex justify-center" style={{ width: COL }}><VerdictDot verdict={normVerdict(r.verdict)} /></div>
            </div>
          ))}
        </div>
      </div>
      <ul className="mt-5 grid grid-cols-1 gap-x-6 gap-y-1 font-mono text-[12px] text-muted sm:grid-cols-2">
        {h.runs.map((r) => <li key={r.run_id} className="truncate"><span className="text-ink">#{r.seq}</span> {r.branch ?? '—'} · {short(r.sha).slice(0, 7)} · {r.verdict ?? '—'} · suite {r.suite_label ?? '—'} · case v{r.cells[0]?.case_version}</li>)}
      </ul>
      <p className="mt-4 flex flex-wrap items-center gap-4 font-mono text-[11px] text-muted"><span className="inline-flex items-center gap-1.5"><TrialDot status="pass" />pass</span><span className="inline-flex items-center gap-1.5"><TrialDot status="fail" />fail</span><span className="inline-flex items-center gap-1.5"><TrialDot status="invalid" />invalid</span><span className="inline-flex items-center gap-1.5"><TrialDot status="skip" />skip / not run</span><span>| = case version changed</span></p>
    </Tile>
  );
}

function BreakMark({ from, to }: { from: number; to: number }) {
  return <span className="relative mx-1 inline-block w-1 self-stretch border-l-2 border-dashed border-ink" title={`case changed v${from}→v${to}`}><span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-ink px-1 font-mono text-[9px] whitespace-nowrap text-white">v{from}→v{to}</span></span>;
}

function Row({ s, h, COL }: { s: string; h: HistoryResult; COL: number }) {
  return (
    <>
      <div className="truncate pr-3 font-mono text-[12px]" title={s}>{s}</div>
      {h.runs.map((r) => {
        const c = r.cells.find((x) => x.surface === s);
        return (
          <div key={r.run_id} className="flex items-center">
            {r.version_break && <span className="mx-1 inline-block w-1 self-stretch border-l-2 border-dashed border-ink" aria-hidden />}
            <div className="flex justify-center" style={{ width: COL }}>
              {c ? (
                <a href={c.row_id ? storeHref.trial(r.run_id, c.row_id) : undefined} aria-label={`${s} in run #${r.seq}: ${c.status} ${c.c}/${c.n}`} title={`#${r.seq} ${r.run_id}\n${c.status} ${c.c}/${c.n} · case v${c.case_version}${c.failing_graders.length ? `\nfailing: ${c.failing_graders.join(', ')}` : ''}`} className="flex size-7 items-center justify-center rounded-full hover:bg-tile">
                  <TrialDot status={c.status} className="size-3.5" />
                </a>
              ) : <span className="size-2 rounded-full bg-line" title="not run on this surface" />}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Persona × run for the compared pair; renders nothing unless a row of either run carries `persona`. */
function ComparePersonas({ a, b }: { a: string | null; b: string | null }) {
  const ra = useApi<RowsResponse>(a ? `/api/store/runs/${encodeURIComponent(a)}/rows` : null);
  const rb = useApi<RowsResponse>(b ? `/api/store/runs/${encodeURIComponent(b)}/rows` : null);
  const runOf = new Map<ResultRow, string>();
  for (const r of ra.data?.rows ?? []) runOf.set(r, a ?? '');
  for (const r of rb.data?.rows ?? []) runOf.set(r, b ?? '');
  const rows = [...runOf.keys()];
  if (!a || !b || !hasPersona(rows)) return null;
  const table = personaTable(rows, (r) => runOf.get(r) ?? '', [a, b]);
  return (
    <Section title="By persona" label="Advisory · base vs head">
      <PersonaTableView table={table} columnLabel="Run" columnTitle={(c) => `${c === a ? 'base' : 'head'} · ${c.replace(/^ves-/, '')}`} chatHref={(t, col) => href.chat(col, t.row_id, true)} />
      <p className="mt-2 text-[13px] text-muted">Click a person for their profile, or a numbered chip to read that chat.</p>
      <p className="mt-2 text-[13px] text-muted">Counted from each run's persona rows, all surfaces together. Goal met is the share of judged trials read as yes by the persona_outcome judge (yes / partly / no). Advisory, no significance test.</p>
    </Section>
  );
}
