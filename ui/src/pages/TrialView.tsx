import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconArrowLeft, IconArrowsMaximize, IconChevronLeft, IconChevronRight, IconRobot, IconTool, IconUser, IconX, IconHandStop, IconDatabase, IconSettings } from '@tabler/icons-react';
import { useApi } from '../lib/api.ts';
import { useAppData } from '../lib/data.tsx';
import { evidenceSteps, isFailingScore, isSafetyScore, messageText, toolClasses } from '../lib/shape.ts';
import { DASH, show } from '../lib/format.ts';
import { href, navigate } from '../lib/router.ts';
import type { AtifStep, Persona, ResultRow, RowsResponse, Score, TrajectoryResponse } from '../lib/types.ts';
import { isPersonaOutcomeScore, personaOf, simulatedTag, stepPersona } from '../lib/persona.ts';
import { PersonaCard } from '../components/Persona.tsx';
import { agentName, chatItems, chatTone, firstName, hasChat, personaIdOf, siblingTrials } from '../lib/people.ts';
import { Avatar, ChatChip } from '../components/People.tsx';
import { ChatThread, ChatVerdict, PersonaSide } from '../components/Chat.tsx';
import { Badge, ErrorState, ICON, IconButton, Skeleton, TrialDot, cx } from '../components/ui.tsx';
import { TrialPathView } from './PathViews.tsx';
import type { PathContext } from '../lib/path/model.ts';

type ApprovalEvent = { id?: string; seq?: number; kind?: string; canonical?: string; principal?: string; thread?: string; at?: string; args_hash?: string };

function JsonBlock({ value, summary }: { value: unknown; summary: string }) {
  const text = useMemo(() => (typeof value === 'string' ? value : JSON.stringify(value, null, 2)), [value]);
  return (
    <details className="group mt-2 rounded-xl bg-tile">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 font-mono text-[12px] text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>{summary}
      </summary>
      <pre className="overflow-x-auto px-3 pb-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-ink">{text}</pre>
    </details>
  );
}

function ext(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['vibiz', 'ves', 'extra', 'metadata']) if (o[k] && typeof o[k] === 'object') Object.assign(out, o[k]);
  return out;
}

function StepCard({ step, index, hit, approvals, catalog, persona }: { step: AtifStep; index: number; hit?: { ids: string[]; how: string }; approvals: ApprovalEvent[]; catalog: Parameters<typeof toolClasses>[1]; persona?: Persona | null }) {
  const src = String(step.source ?? 'unknown');
  const x = ext(step as Record<string, unknown>);
  const msg = messageText(step.message);
  const Icon = src === 'user' ? IconUser : src === 'agent' ? IconRobot : IconSettings;
  const approvalTurn = x.approval_turn as string | undefined;
  const sim = src === 'user' ? stepPersona(step) : null;
  return (
    <li id={`step-${index}`} className="relative pl-12 scroll-mt-24">
      <span aria-hidden className={cx('absolute top-0 left-0 flex size-9 items-center justify-center rounded-full', src === 'user' ? 'bg-ink text-white' : 'bg-tile text-ink')}>
        <Icon size={18} stroke={1.75} />
      </span>
      <div className={cx('rounded-lg border p-4', hit ? 'border-hl-line bg-hl' : 'border-line bg-sheet')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono-label !text-ink">{src}</span>
          <span className="font-mono text-[12px] text-muted">step {show(step.step_id)}</span>
          {sim && <Badge title={`Written by the user simulator${typeof sim.turn === 'number' ? `, persona turn ${sim.turn}` : ''}`}>{simulatedTag(sim, persona)}{typeof sim.turn === 'number' ? ` · t${sim.turn}` : ''}</Badge>}
          {approvalTurn && <Badge>approval turn: {approvalTurn}</Badge>}
          {hit && <Badge tone="dark" title={hit.how === 'sequence' ? 'Matched by ledger sequence number (fx_000N ↔ call_000N)' : 'Evidence id appears in this step'}>evidence {hit.ids.join(', ')}{hit.how === 'sequence' ? ' · by seq' : ''}</Badge>}
        </div>
        {msg && <p className="mt-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words">{msg}</p>}
        {(step.tool_calls ?? []).map((c, i) => {
          const cls = toolClasses(c, catalog);
          const cx2 = ext(c as Record<string, unknown>);
          const result = step.observation?.results?.find((r) => r.source_call_id && r.source_call_id === c.tool_call_id) ?? (step.tool_calls!.length === 1 ? step.observation?.results?.[0] : undefined);
          return (
            <div key={i} className="mt-3 rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <IconTool size={16} stroke={1.75} aria-hidden />
                <span className="font-mono text-[13px] font-semibold break-all">{c.function_name ?? '(unnamed tool)'}</span>
                {cls.canonical && cls.canonical !== c.function_name && <span className="font-mono text-[12px] text-muted">{cls.canonical}</span>}
                {cls.classes.map((k) => <Badge key={k}>{k}</Badge>)}
                {cls.gated && <Badge tone="dark">gated</Badge>}
                {typeof cx2.call_source === 'string' && <span className="font-mono text-[11px] text-muted">{cx2.call_source}</span>}
              </div>
              {c.tool_call_id && <div className="mt-1 font-mono text-[11px] text-faint">{c.tool_call_id}</div>}
              <JsonBlock value={c.arguments ?? {}} summary="arguments" />
              {result && <JsonBlock value={result.content} summary="observation" />}
            </div>
          );
        })}
        {!step.tool_calls?.length && step.observation?.results?.length ? <JsonBlock value={step.observation.results} summary="observation" /> : null}
        {approvals.map((a, i) => (
          <div key={i} className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-tile px-3 py-2">
            <IconHandStop size={16} stroke={1.75} aria-hidden />
            <span className="mono-label !text-ink">Approval event</span>
            <span className="font-mono text-[12px]">{a.kind ?? DASH}</span>
            {a.canonical && <span className="font-mono text-[12px] text-muted">{a.canonical}</span>}
            {a.principal && <span className="font-mono text-[12px] text-muted">by {a.principal}</span>}
            {a.thread && <span className="font-mono text-[12px] text-muted">{a.thread}</span>}
            {a.id && <span className="font-mono text-[11px] text-faint">{a.id}</span>}
          </div>
        ))}
      </div>
    </li>
  );
}

function ScoreRow({ s, onJump, matched }: { s: Score; onJump: (id: string) => void; matched: Set<string> }) {
  // persona_outcome is advisory: a "no" is a reading of the conversation, not a failing check
  const advisory = isPersonaOutcomeScore(s);
  const failing = isFailingScore(s) && !advisory;
  return (
    <li className={cx('rounded-lg border p-4', failing ? 'border-block/40' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx('font-mono text-[12px] font-semibold tracking-[0.08em] uppercase', s.label === 'pass' ? 'text-pass' : failing ? 'text-block' : 'text-muted')}>{s.label ?? DASH}</span>
        <span className="font-mono text-[13px] font-medium break-all">{s.name ?? s.grader_id ?? DASH}</span>
        <Badge tone={s.role === 'gate' ? 'dark' : 'neutral'}>{s.role ?? 'role —'}</Badge>
        {s.kind && <Badge>{s.kind}</Badge>}
        {isSafetyScore(s) && <Badge>safety</Badge>}
        {s.implicit && <Badge>implicit</Badge>}
        <span className="ml-auto font-mono text-[12px] text-muted">value {show(s.value)}{s.grader_version ? ` · v${s.grader_version}` : ''}</span>
      </div>
      <p className="mt-2 text-[14px] break-words">{s.explanation ?? <span className="text-muted">No explanation recorded.</span>}</p>
      {s.judge && <p className="mt-1 font-mono text-[12px] text-muted">judge {s.judge.model ?? DASH} · {s.judge.admitted ? 'admitted' : 'not admitted'}</p>}
      {s.evidence?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="mono-label">Evidence</span>
          {s.evidence.map((id) => matched.has(id) ? (
            <button key={id} type="button" onClick={() => onJump(id)} className="rounded-lg bg-tile px-2 py-1 font-mono text-[12px] underline-offset-2 hover:underline">{id}</button>
          ) : (
            <span key={id} className="rounded-lg px-2 py-1 font-mono text-[12px] text-muted" title="Not found in the trajectory; may refer to the snapshot ledger">{id}</span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="mono-label">{label}</dt><dd className="mt-0.5 truncate font-mono text-[13px]">{children}</dd></div>;
}

/** `apiBase` is /api/runs (the results dir) or /api/store/runs (the run store); both serve the same row/trajectory shapes. */
export type TrialTab = 'chat' | 'transcript' | 'path';
export const asTab = (v: string | null | undefined): TrialTab | null => (v === 'chat' || v === 'transcript' || v === 'path' ? v : null);

/** Chat / Transcript / Path segmented control (Chat only when the trial is a conversation). */
function TabBar({ view, onView, chat }: { view: TrialTab; onView: (v: TrialTab) => void; chat: boolean }) {
  return (
    <div role="tablist" aria-label="Trajectory view" className="inline-flex rounded-md p-0.5 shadow-[0_0_0_1px_var(--color-line)]">
      {(chat ? ['chat', 'transcript', 'path'] as const : ['transcript', 'path'] as const).map((v) => (
        <button key={v} type="button" role="tab" aria-selected={view === v} aria-controls={`trial-${v}`} id={`tab-${v}`} onClick={() => onView(v)}
          className={cx('h-8 rounded-[5px] px-3 font-mono text-[12px] tracking-[0.06em] uppercase transition-colors', view === v ? 'bg-ink text-white' : 'text-muted hover:text-ink')}>{v}</button>
      ))}
    </div>
  );
}

export function TrialBody({ runId, rowId, standalone, apiBase = '/api/runs', view: viewProp, onView }: { runId: string; rowId: string; standalone?: boolean; apiBase?: string; view?: TrialTab | null; onView?: (v: TrialTab) => void }) {
  const [viewLocal, setViewLocal] = useState<TrialTab | null>(null);
  const setView = (v: TrialTab) => { setViewLocal(v); onView?.(v); };
  const rows = useApi<RowsResponse>(`${apiBase}/${encodeURIComponent(runId)}/rows`);
  const traj = useApi<TrajectoryResponse>(`${apiBase}/${encodeURIComponent(runId)}/trajectory?row=${encodeURIComponent(rowId)}`);
  const rowCase = rows.data?.rows.find((r) => r.row_id === rowId)?.case_id;
  const steps = traj.data?.atif?.steps ?? [];
  const rowP = rows.data?.rows.find((r) => r.row_id === rowId);
  const chatAvail = !!personaOf(rowP) || hasChat(steps);
  // Chat leads for persona trials and for other conversations that did not fail; a failing scripted trial opens on the
  // transcript, where the failing graders' evidence is highlighted.
  const autoChat = !!personaOf(rowP) || (hasChat(steps) && rowP?.status !== 'fail');
  const view: TrialTab = (() => { const v = viewProp ?? viewLocal; if (v === 'chat' && !chatAvail && traj.data) return 'transcript'; return v ?? (autoChat ? 'chat' : 'transcript'); })();
  const ctx = useApi<PathContext>(view === 'path' && rowCase ? `${apiBase}/${encodeURIComponent(runId)}/context?case=${encodeURIComponent(rowCase)}` : null);
  const { config } = useAppData();
  const catalog = config.data?.profiles.find((p) => p.catalog)?.catalog ?? null;
  const row: ResultRow | undefined = rowP;
  const atifExt = traj.data?.atif ? ext(traj.data.atif as Record<string, unknown>) : {};
  const approvals = (Array.isArray(atifExt.approval_events) ? atifExt.approval_events : []) as ApprovalEvent[];
  const scores = row?.scores ?? [];
  const [focusScore, setFocusScore] = useState<string | null>(null);

  // Highlight evidence of failing graders by default, or of the grader the user picked.
  const highlightEvidence = useMemo(() => {
    const pick = focusScore ? scores.filter((s) => (s.name ?? s.grader_id) === focusScore) : scores.filter((s) => isFailingScore(s) && !isPersonaOutcomeScore(s));
    return pick.flatMap((s) => s.evidence ?? []);
  }, [scores, focusScore]);
  const hits = useMemo(() => evidenceSteps(steps, highlightEvidence, approvals), [steps, highlightEvidence, approvals]);
  const allHits = useMemo(() => evidenceSteps(steps, scores.flatMap((s) => s.evidence ?? []), approvals), [steps, scores, approvals]);
  const matched = useMemo(() => new Set([...allHits.values()].flatMap((h) => h.ids)), [allHits]);

  const placed = new Set<number>();
  const approvalsFor = (step: AtifStep) => approvals.filter((a, i) => { if (typeof a.seq === 'number' && Number(step.step_id) === a.seq && !placed.has(i)) { placed.add(i); return true; } return false; });
  const items = useMemo(() => chatItems(steps, approvals), [steps, approvals]);
  const showStep = (i: number) => { setView('transcript'); requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`step-${i}`)?.scrollIntoView({ block: 'center' }))); };
  const jump = (id: string) => {
    const owner = scores.find((s) => s.evidence?.includes(id));
    setFocusScore(owner ? (owner.name ?? owner.grader_id ?? null) : null);
    const idx = [...allHits.entries()].find(([, h]) => h.ids.includes(id))?.[0];
    if (idx !== undefined) document.getElementById(`step-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (rows.error) return <ErrorState title="Could not load the trial row" error={rows.error.message} onRetry={rows.reload} />;
  if (!rows.data) return <div aria-busy="true"><Skeleton className="h-10 w-2/3" /><Skeleton className="mt-4 h-24 w-full" /><Skeleton className="mt-4 h-64 w-full" /></div>;
  if (!row) return <ErrorState title="Trial not found" error={`No row ${rowId} in ${runId}/results.jsonl`} hint="The run may have been re-written. Open the run again to pick a trial." />;

  const sim = traj.data?.snapshot_sim;
  const writes = Array.isArray(sim?.writes) ? sim!.writes : [];
  const unplaced = () => approvals.filter((_, i) => !placed.has(i));

  const persona = personaOf(row);
  const pid = persona ? (persona.id ?? persona.ref ?? null) : personaIdOf(row);
  const who = persona ? firstName(persona.name) || pid || 'User' : pid ? pid.replace(/[-_]+/g, ' ') : 'User';
  const store = apiBase.includes('/store/');
  const sib = siblingTrials(rows.data.rows, rowId);
  const linkTo = (r: ResultRow) => (standalone ? `${href.chat(runId, r.row_id, store)}${view !== 'chat' ? `&view=${view}` : ''}` : href.trial(runId, r.row_id));
  const profileHref = pid ? href.person(pid) : '';
  const facts = (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg bg-tile p-4 sm:grid-cols-4">
      <Fact label="Agent model">{show(row.agent?.model)}</Fact>
      <Fact label="Host">{show(row.host?.family)}{row.host?.model ? ` / ${row.host.model}` : ''}</Fact>
      <Fact label="Wall">{row.usage?.wall_ms !== undefined ? `${row.usage.wall_ms} ms` : DASH}</Fact>
      <Fact label="Spend">{typeof row.usage?.usd_list === 'number' ? `$${row.usage.usd_list.toFixed(4)}` : DASH}</Fact>
      <Fact label="Server calls">{show(row.trace?.server_calls)}</Fact>
      <Fact label="Upstream writes">{show(row.trace?.upstream_writes)}</Fact>
      <Fact label="Approval events">{show(row.trace?.approval_events)}</Fact>
      <Fact label="Seed">{show(row.seed)}</Fact>
    </dl>
  );
  const trialNo = typeof row.trial === 'number' ? row.trial + 1 : null;
  const prevRow = sib.index > 0 ? sib.list[sib.index - 1] : null;
  const nextRow = sib.index >= 0 && sib.index < sib.list.length - 1 ? sib.list[sib.index + 1] : null;
  const nav = pid && sib.list.length > 1 ? (
    <nav aria-label={`Chats with ${who}`} className="flex flex-wrap items-center gap-2">
      {prevRow ? <a href={linkTo(prevRow)} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted hover:bg-tile hover:text-ink"><IconChevronLeft size={15} stroke={2} aria-hidden />Prev</a> : null}
      <span className="flex flex-wrap gap-1.5">
        {sib.list.map((r, i) => <ChatChip key={r.row_id} to={linkTo(r)} tone={chatTone({ status: r.status, persona: personaOf(r) })} label={`Chat ${typeof r.trial === 'number' ? r.trial + 1 : i + 1}`} active={r.row_id === rowId} />)}
      </span>
      {nextRow ? <a href={linkTo(nextRow)} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-ink hover:bg-tile">Next: Chat {typeof nextRow.trial === 'number' ? nextRow.trial + 1 : sib.index + 2}<IconChevronRight size={15} stroke={2} aria-hidden /></a> : <span className="px-2 font-mono text-[12px] text-faint">{sib.index + 1} of {sib.list.length}</span>}
    </nav>
  ) : null;
  const isChat = view === 'chat';

  return (
    <div>
      {pid && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-line bg-sheet px-3 py-2">
          <a href={profileHref} className="inline-flex items-center gap-2 rounded-md py-0.5 pr-2 text-[13px] font-medium hover:underline hover:underline-offset-4">
            <Avatar id={pid} name={persona?.name} size={24} />{who}<span className="font-normal text-muted">· all chats</span>
          </a>
          {nav}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <TrialDot status={row.status} className="size-3" />
        <span className={cx('font-mono text-[12px] font-semibold tracking-[0.1em] uppercase', row.status === 'pass' ? 'text-pass' : row.status === 'fail' ? 'text-block' : row.status === 'invalid' ? 'text-invalid' : 'text-muted')}>{row.status ?? DASH}</span>
        {row.skip_reason && <span className="font-mono text-[12px] text-muted">{row.skip_reason}</span>}
        {row.invalid_reason && <span className="font-mono text-[12px] text-invalid">{row.invalid_reason}</span>}
      </div>
      <h1 className={cx('mt-2 font-semibold tracking-[-0.02em] break-words', standalone ? 'font-display text-[30px] leading-[1.1] sm:text-[36px]' : 'text-[28px] leading-tight')}>{pid ? `Chat ${trialNo ?? ''} with ${who}` : row.case_id ?? DASH}</h1>
      <p className="mt-2 font-mono text-[13px] break-words text-muted">{pid ? `${row.case_id} · ` : ''}{row.surface ?? DASH} · trial {show(row.trial)} · case v{show(row.case_version)}{pid && row.agent?.model ? ` · ${row.agent.model}` : ''}</p>

      {!isChat && <div className="mt-5">{facts}</div>}
      {!isChat && <PersonaCard row={row} />}
      {row.error?.message && <p className="mt-3 rounded-lg border border-block/40 px-4 py-3 font-mono text-[13px] text-block">{row.error.message}{row.error.http_status ? ` (HTTP ${row.error.http_status})` : ''}</p>}

      <div className={cx('mb-4 flex flex-wrap items-center justify-between gap-3', isChat ? 'mt-6' : 'mt-8')}>
        <h2 className="text-[22px] font-semibold tracking-[-0.01em]">{isChat ? 'Conversation' : 'Trajectory'}</h2>
        <TabBar view={view} onView={setView} chat={chatAvail} />
      </div>
      {isChat ? (
        <div role="tabpanel" id="trial-chat" aria-labelledby="tab-chat" className="@container">
          <div className={cx('grid grid-cols-[minmax(0,1fr)] gap-5', persona ? '@4xl:grid-cols-[minmax(0,1fr)_300px]' : 'max-w-[900px]')}>
            <div className="order-2 min-w-0 @4xl:order-1">
              {traj.error ? <ErrorState title="Could not read the trajectory" error={traj.error.message} /> : !traj.data ? <Skeleton className="h-96 w-full" /> : !traj.data.atif ? (
                <p className="rounded-lg bg-tile px-5 py-5 text-[14px] text-muted">{traj.data.notes.join('. ') || 'No trajectory recorded for this trial.'}{row.invalid_reason ? ` INVALID: ${row.invalid_reason}.` : ''}</p>
              ) : (
                <div className="rounded-lg border border-line bg-shell p-3 sm:p-5">
                  <ChatThread items={items} personId={pid} personName={who} agentLabel={agentName(row.surface)} onTool={showStep} />
                  <p className="mt-4 text-center font-mono text-[11px] text-faint">Tool lines expand; click a tool to open it in the Transcript.</p>
                </div>
              )}
              <ChatVerdict row={row} />
              {pid && nextRow && <div className="mt-4 flex justify-end"><a href={linkTo(nextRow)} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-ink px-3.5 text-[14px] font-medium text-white hover:bg-primary-hover">Next: Chat {typeof nextRow.trial === 'number' ? nextRow.trial + 1 : sib.index + 2} of {sib.list.length}<IconChevronRight size={16} stroke={2} aria-hidden /></a></div>}
            </div>
            {persona && <div className="order-1 @4xl:order-2"><div className="@4xl:sticky @4xl:top-20"><PersonaSide row={row} profileHref={profileHref} /></div></div>}
          </div>
          <h3 className="mono-label mt-8 mb-3">Trial facts</h3>
          {facts}
        </div>
      ) :       view === 'path' ? (
        <div role="tabpanel" id="trial-path" aria-labelledby="tab-path">
          {traj.error ? <ErrorState title="Could not read the trajectory" error={traj.error.message} /> : !traj.data || (ctx.loading && !ctx.data) ? <Skeleton className="h-[500px] w-full" /> : (
            <TrialPathView row={row} traj={traj.data} context={ctx.data} runId={runId} store={apiBase.includes('/store/')}
              onShowStep={showStep} />
          )}
        </div>
      ) : traj.error ? <ErrorState title="Could not read the trajectory" error={traj.error.message} /> : !traj.data ? <Skeleton className="h-64 w-full" /> : !traj.data.atif ? (
        <p className="rounded-lg bg-tile px-5 py-5 text-[14px] text-muted">{traj.data.notes.join('. ') || 'No trajectory recorded for this trial.'}</p>
      ) : (
        <>
          <p className="mb-4 font-mono text-[12px] break-all text-muted">{traj.data.atif.schema_version ?? 'ATIF'} · {traj.data.atif_uri} · agent {traj.data.atif.agent?.name ?? DASH}</p>
          <ol className="relative flex flex-col gap-4 before:absolute before:top-2 before:bottom-2 before:left-[17px] before:w-px before:bg-line">
            {steps.map((s, i) => <StepCard key={i} step={s} index={i} hit={hits.get(i)} approvals={approvalsFor(s)} catalog={catalog} persona={personaOf(row)} />)}
          </ol>
          {unplaced().length > 0 && (
            <ul className="mt-4 flex flex-col gap-2">
              {unplaced().map((a, i) => <li key={i} className="rounded-xl bg-tile px-3 py-2 font-mono text-[12px]">approval event {a.kind} {a.canonical} {a.principal} {a.id}</li>)}
            </ul>
          )}
        </>
      )}

      <h2 className="mt-8 mb-4 flex items-center gap-2 text-[22px] font-semibold tracking-[-0.01em]"><IconDatabase size={20} stroke={1.75} aria-hidden />Side effects</h2>
      {!traj.data ? <Skeleton className="h-16 w-full" /> : writes.length === 0 && !sim?.effects ? (
        <p className="rounded-lg bg-tile px-5 py-4 text-[14px] text-muted">No upstream writes recorded{typeof atifExt.upstream_writes === 'number' ? ` (ATIF upstream_writes: ${atifExt.upstream_writes})` : ''}.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {writes.map((w, i) => {
            const ww = w as { canonical?: string; tool?: string; args?: unknown };
            return (
              <div key={i} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2"><span className="mono-label !text-ink">Upstream write</span><span className="font-mono text-[13px] font-semibold">{ww.canonical ?? ww.tool ?? DASH}</span></div>
                <JsonBlock value={ww.args ?? w} summary="args" />
              </div>
            );
          })}
          {sim?.effects && <JsonBlock value={sim.effects} summary={`effects (${Object.keys(sim.effects).length})`} />}
          <p className="font-mono text-[11px] text-faint">from {traj.data.snapshot_uri}</p>
        </div>
      )}

      <h2 className="mt-8 mb-4 text-[22px] font-semibold tracking-[-0.01em]">Graders ({scores.length})</h2>
      {focusScore && <button type="button" onClick={() => setFocusScore(null)} className="mb-3 font-mono text-[12px] underline underline-offset-2">Highlighting {focusScore}; reset to failing graders</button>}
      {scores.length === 0 ? <p className="rounded-lg bg-tile px-5 py-4 text-[14px] text-muted">No grader scores on this row{row.status === 'skip' ? ' (skipped trials are not graded)' : ''}.</p> : (
        <ul className="flex flex-col gap-3">{scores.map((s, i) => <ScoreRow key={i} s={s} onJump={jump} matched={matched} />)}</ul>
      )}
    </div>
  );
}

export function TrialDrawer({ runId, rowId }: { runId: string; rowId: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = () => navigate(href.run(runId));
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', on);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', on); document.body.style.overflow = ''; prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId]);
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Trial">
      <button type="button" aria-label="Close trial" className="absolute inset-0 bg-black/30" onClick={close} tabIndex={-1} />
      <div ref={panel} tabIndex={-1} className="absolute inset-y-0 right-0 flex w-full max-w-[760px] flex-col bg-sheet outline-none sm:inset-y-2 sm:right-2 sm:rounded-lg">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-6">
          <span className="mono-label">Trial</span>
          <div className="flex items-center gap-1">
            <a href={href.trialPage(runId, rowId)} className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[14px] hover:bg-tile"><IconArrowsMaximize size={16} stroke={1.75} aria-hidden />Open as page</a>
            <IconButton label="Close trial" onClick={close}><IconX {...ICON} /></IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <TrialBody runId={runId} rowId={rowId} />
        </div>
      </div>
    </div>
  );
}

export function TrialPage({ runId, rowId, store, view }: { runId: string; rowId: string | null; store?: boolean; view?: string | null }) {
  const tab = asTab(view);
  const onView = (v: TrialTab) => {
    // keep the tab in the address (shareable) without adding a history entry per click
    const base = `#/${store ? 'store' : 'runs'}/${encodeURIComponent(runId)}/trial?row=${encodeURIComponent(rowId ?? '')}&view=${v}`;
    window.history.replaceState(null, '', base);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  return (
    <>
      {store
        ? <a href="#/history" className="mb-6 inline-flex items-center gap-2 rounded-full text-[14px] text-muted hover:text-ink"><IconArrowLeft size={18} stroke={1.75} aria-hidden />History · stored run {runId.replace(/^ves-/, '')}</a>
        : <a href={href.run(runId)} className="mb-6 inline-flex items-center gap-2 rounded-full text-[14px] text-muted hover:text-ink"><IconArrowLeft size={18} stroke={1.75} aria-hidden />Run {runId.replace(/^ves-/, '')}</a>}
      {rowId ? <div className={tab === 'path' ? 'max-w-[1280px]' : tab === 'transcript' ? 'max-w-[900px]' : 'max-w-[1180px]'}><TrialBody runId={runId} rowId={rowId} standalone apiBase={store ? '/api/store/runs' : '/api/runs'} view={tab} onView={onView} /></div> : <ErrorState title="No trial selected" error="Missing ?row=<row_id> in the address" hint="Open a run and pick a trial dot in the case × surface matrix." />}
    </>
  );
}
