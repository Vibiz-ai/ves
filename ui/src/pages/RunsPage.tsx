import { useMemo } from 'react';
import { useApi } from '../lib/api.ts';
import { fromEntry, fromSummary, pass1Delta, prevComparable, pts } from '../lib/history.ts';
import { IconChevronRight, IconPlayerPlay, IconPlus } from '@tabler/icons-react';
import { useAppData } from '../lib/data.tsx';
import { normVerdict, verdictCounts, VERDICTS } from '../lib/shape.ts';
import { DASH, absTime, niceTime, pct, relativeTime, shortSha } from '../lib/format.ts';
import { runTitle } from '../lib/people.ts';
import { AvatarStack } from '../components/People.tsx';
import { href, navigate, type Route } from '../lib/router.ts';
import type { RunSummary, StoreRunsResponse, Verdict } from '../lib/types.ts';
import { Button, Chip, EmptyState, ErrorState, PageHeader, Skeleton, VerdictMark, cx, ICON } from '../components/ui.tsx';
import { openRunDialog } from '../components/Shell.tsx';

const CHIP_LABEL: Record<'ALL' | Verdict, string> = { ALL: 'All', PASS: 'Pass', BLOCK: 'Block', INVALID: 'Invalid', REPORT_ONLY: 'Report only' };

function SurfaceStrip({ run }: { run: RunSummary }) {
  const entries = run.surfaces.map((s) => [s, run.per_surface[s] ?? { pass: 0, fail: 0, invalid: 0, skip: 0 }] as const);
  if (!entries.length) return null;
  return (
    <div className="w-full">
      <div className="flex h-2 w-full gap-[3px]" role="img" aria-label={`Per-surface trial outcomes: ${entries.map(([s, c]) => `${s} ${c.pass} pass, ${c.fail} fail, ${c.invalid} invalid, ${c.skip} skip`).join('; ')}`}>
        {entries.map(([s, c]) => {
          const n = c.pass + c.fail + c.invalid + c.skip || 1;
          return (
            <span key={s} className="flex h-full min-w-0 flex-1 overflow-hidden rounded-[2px] bg-line" title={`${s}: ${c.pass} pass · ${c.fail} fail · ${c.invalid} invalid · ${c.skip} skip`}>
              <span className="h-full bg-pass" style={{ width: `${(c.pass / n) * 100}%` }} />
              <span className="h-full bg-block" style={{ width: `${(c.fail / n) * 100}%` }} />
              <span className="h-full bg-invalid" style={{ width: `${(c.invalid / n) * 100}%` }} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

type Delta = { prevId: string; prevInStore: boolean; top: { surface: string; diff: number } | null; per: { surface: string; diff: number }[] } | null;

/** Point delta vs the previous comparable run (same tier and suite_version); the CI lives on the Compare page. */
function DeltaLine({ run, delta, inStore }: { run: RunSummary; delta: Delta; inStore: boolean }) {
  if (!delta) return <p className="font-mono text-[12px] text-faint">no comparable previous run (same tier and suite)</p>;
  const all = delta.per.map((x) => `${x.surface} ${pts(x.diff)}`).join(' · ');
  const moved = delta.per.filter((x) => Math.abs(x.diff) > 1e-9).length;
  const body = (
    <>
      <span>vs prev comparable</span>
      <span className={cx('tabular-nums', delta.top && delta.top.diff < -1e-9 ? 'text-block' : delta.top && delta.top.diff > 1e-9 ? 'text-pass' : 'text-ink')}>{delta.top && Math.abs(delta.top.diff) > 1e-9 ? `${pts(delta.top.diff)} ${delta.top.surface}` : 'no change'}</span>
      {moved > 1 && <span className="text-faint">+{moved - 1} more</span>}
    </>
  );
  return delta.prevInStore && inStore
    ? <a href={`#/compare?a=${encodeURIComponent(delta.prevId)}&b=${encodeURIComponent(run.id)}`} title={`pass^1 point Δ per surface (no CI): ${all}. Open Compare for the paired bootstrap.`} className="relative z-10 flex flex-wrap items-baseline gap-x-2 font-mono text-[12px] text-muted underline-offset-2 hover:underline">{body}</a>
    : <p title={`pass^1 point Δ per surface (no CI): ${all}`} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[12px] text-muted">{body}</p>;
}

function RunCard({ run, delta, inStore }: { run: RunSummary; delta?: Delta; inStore?: boolean }) {
  const v = normVerdict(run.verdict);
  const to = `#/runs/${encodeURIComponent(run.id)}`;
  const people = run.personas ?? [];
  return (
    <article className="group relative flex flex-col rounded-lg border border-line bg-sheet shadow-card transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-card-hover">
      <div className="flex flex-col gap-2 border-b border-line px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 text-[16px] leading-tight font-semibold tracking-[-0.01em]">
            <a href={to} className="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none group-hover:underline group-hover:underline-offset-4 group-has-[a:focus-visible]:underline">
              {runTitle(run)}
            </a>
          </h2>
          <IconChevronRight size={18} stroke={1.75} aria-hidden className="mt-px shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
        </div>
        {people.length > 0 && (
          <a href={people.length === 1 ? href.person(people[0].id) : href.run(run.id)} className="relative z-10 inline-flex w-fit items-center gap-2 rounded-full border border-line bg-sheet py-0.5 pr-2.5 pl-1 hover:border-line-strong" title={`Persona run: ${people.map((p) => p.name ?? p.id).join(', ')}`}>
            <AvatarStack people={people} size={24} />
            <span className="font-mono text-[11px] tracking-[0.06em] text-ink uppercase">{people.length === 1 ? 'Persona' : 'Personas'}</span>
          </a>
        )}
        <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted">
          <span className="text-ink" title={absTime(run.created)}>{niceTime(run.created)}</span>
          <span className="text-faint">{relativeTime(run.created)}</span>
          {run.agent_models.length > 0 && <span className="truncate font-mono text-[12px]" title="Agent model">{run.agent_models.join(', ')}</span>}
        </p>
        <p className="truncate font-mono text-[11px] text-faint" title={`${run.id} · ${run.tier ?? ''} ${run.trigger ?? ''}`}>
          {run.id.replace(/^ves-/, '')} · {shortSha(run.sha)} · {run.tier ?? 'run'}/{run.trigger ?? DASH} · {run.surfaces.length} surface{run.surfaces.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-8 p-5">
        <div>
          <div className="flex items-start justify-between gap-3">
            <span className="mono-label">Verdict{run.decided_by ? ` · ${run.decided_by}` : ''}</span>
            {run.mock && <span className="mono-label" title="Every surface ran through a mock adapter: tests the harness, not the agent">Mock run</span>}
          </div>
          <div className="mt-3"><VerdictMark verdict={v} /></div>
          {run.would_be && normVerdict(run.would_be) !== v && <div className="mt-2 font-mono text-[12px] text-muted">would be {run.would_be}</div>}
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[12px] text-muted">trial pass rate (counted)</span>
            <span className="font-mono text-[18px] tabular-nums">{pct(run.trial_pass_rate)}</span>
          </div>
          <SurfaceStrip run={run} />
          {delta !== undefined && <DeltaLine run={run} delta={delta} inStore={!!inStore} />}
        </div>
      </div>
      {run.errors.length > 0 && <p className="border-t border-line px-5 py-3 font-mono text-[12px] text-block">{run.errors.join('; ')}</p>}
      <span className="pointer-events-none absolute inset-0 rounded-lg ring-ink group-has-[a:focus-visible]:ring-2" aria-hidden />
    </article>
  );
}

export function RunsPage({ route }: { route: Route }) {
  const { runs } = useAppData();
  const filterRaw = (route.query.get('verdict') ?? 'ALL').toUpperCase() as 'ALL' | Verdict;
  const filter = filterRaw === 'ALL' || (VERDICTS as string[]).includes(filterRaw) ? filterRaw : 'ALL';
  const list = runs.data?.runs ?? [];
  const counts = useMemo(() => verdictCounts(list), [list]);
  const shown = filter === 'ALL' ? list : list.filter((r) => normVerdict(r.verdict) === filter);
  const setFilter = (f: string) => navigate(f === 'ALL' ? '#/runs' : `#/runs?verdict=${f}`);
  const store = useApi<StoreRunsResponse>('/api/store/runs', 15000);
  const stored = useMemo(() => new Set((store.data?.entries ?? []).map((e) => e.run_id)), [store.data]);
  const deltas = useMemo(() => {
    const pool = new Map<string, ReturnType<typeof fromSummary>>();
    for (const e of store.data?.entries ?? []) pool.set(e.run_id, fromEntry(e));
    for (const r of list) pool.set(r.id, fromSummary(r));
    const out = new Map<string, Delta>();
    for (const r of list) {
      const cur = fromSummary(r);
      const prev = prevComparable(cur, [...pool.values()]);
      out.set(r.id, prev ? { prevId: prev.id, prevInStore: stored.has(prev.id), ...pass1Delta(cur, prev) } : null);
    }
    return out;
  }, [list, store.data, stored]);

  return (
    <>
      <PageHeader title="Runs" actions={<Button variant="primary" onClick={openRunDialog}><IconPlus size={16} stroke={2} aria-hidden />New run</Button>} />
      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filter by verdict">
        {(['ALL', ...VERDICTS] as const).map((k) => (
          <Chip key={k} active={filter === k} count={counts[k]} onClick={() => setFilter(k)}>{CHIP_LABEL[k]}</Chip>
        ))}
      </div>

      {runs.loading && !runs.data && (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2" aria-busy="true" aria-label="Loading runs">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border border-line bg-sheet shadow-card">
              <div className="border-b border-line px-5 py-4"><Skeleton className="h-5 w-40" /><Skeleton className="mt-2 h-3 w-56" /></div>
              <div className="h-[220px] p-5"><Skeleton className="h-full w-full" /></div>
            </div>
          ))}
        </div>
      )}
      {runs.error && !runs.data && (
        <ErrorState title="Could not load runs" error={runs.error.message} onRetry={runs.reload} hint={<>Start the UI with <code className="font-mono text-ink">npm run dev</code> (reads <code className="font-mono text-ink">../results</code>) or <code className="font-mono text-ink">node server/index.mjs --results &lt;dir&gt;</code>.</>} />
      )}
      {runs.data && !runs.data.exists && (
        <ErrorState title="No results directory" error={`No results directory at ${runs.data.results_dir}`} hint={<>Run <code className="font-mono text-ink">npx ves run --tier smoke --connection mock --out results</code> in your repo, or start the server with <code className="font-mono text-ink">--results &lt;dir&gt;</code> (dev: set <code className="font-mono text-ink">VES_RESULTS</code>).</>} onRetry={runs.reload} />
      )}
      {runs.data?.exists && list.length === 0 && (
        <EmptyState icon={<IconPlayerPlay {...ICON} />} title="No runs yet" body={<>Each run directory in <span className="font-mono text-[13px] text-ink">{runs.data.results_dir}</span> shows up here as a card with its gate verdict. Start with an offline smoke run:</>} command="npx ves run --tier smoke --connection mock --out results" />
      )}
      {list.length > 0 && shown.length === 0 && (
        <EmptyState title={`No ${CHIP_LABEL[filter].toLowerCase()} runs`} body={<>None of the {list.length} runs has this verdict. <button type="button" className="underline underline-offset-2" onClick={() => setFilter('ALL')}>Show all runs</button>.</>} />
      )}
      {shown.length > 0 && (
        <div className={cx('grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3')}>
          {shown.map((r) => <RunCard key={r.id} run={r} delta={deltas.get(r.id) ?? null} inStore={stored.has(r.id)} />)}
        </div>
      )}
    </>
  );
}
