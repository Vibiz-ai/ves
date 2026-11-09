// Path canvases: one trial's path (a tab of the trial view), two trials' paths aligned (#/paths/compare) and every
// stored trial of a case as one transition graph (#/paths/case). Everything is derived in src/lib/path/* from files
// the server already serves; nothing here grades, scores or calls a model.
import { useMemo, useState, type ReactNode } from 'react';
import { IconAlertTriangle, IconArrowRight, IconArrowsDiff, IconChartDots3, IconRoute, IconSwitchHorizontal } from '@tabler/icons-react';
import { navigate, type Route } from '../lib/router.ts';
import { DASH, show } from '../lib/format.ts';
import type { ResultRow, TrajectoryResponse } from '../lib/types.ts';
import { buildPath, describeNode, type PathContext, type PathGraph, type PathNode } from '../lib/path/model.ts';
import { metricChips, type MetricChip, type ReplyMetrics } from '../lib/path/metrics.ts';
import { alignPaths, caseGraph, compareSummary, describePairs, isDivergent, replyDiffs, type AggNode, type AlignPair, type CaseTrial } from '../lib/path/align.ts';
import { PALETTE, TRIAL_LEGEND, caseLayout, compareLayout, nodeColor, nodeShape, radius, trialLayout, type LegendItem } from '../lib/path/layout.ts';
import { listCaseTrials, loadTrial, resolveRef, runOfRow, useAsync, type LoadedTrial, type TrialListing, type TrialRef } from '../lib/path/data.ts';
import { PathCanvas, type CanvasEdge, type CanvasNode } from '../components/PathCanvas.tsx';
import { Badge, Button, Dialog, EmptyState, ErrorState, PageHeader, Section, Skeleton, Tile, TrialDot, cx } from '../components/ui.tsx';

// ------------------------------------------------------------------------------------------------ routes
const qs = (q: Record<string, string | null | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(q)) if (v) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
export const pathHref = {
  /** a / b are row ids; the run is the row id's first segment unless ar / br say otherwise; as / bs=1 read from the store. */
  compare: (a: TrialRef | string, b?: TrialRef | string | null) => {
    const r = (x: TrialRef | string | null | undefined) => (typeof x === 'string' ? { rowId: x, runId: runOfRow(x), store: false } : x ?? null);
    const A = r(a), B = r(b);
    return `#/paths/compare${qs({ a: A?.rowId, ar: A && A.runId !== runOfRow(A.rowId) ? A.runId : null, as: A?.store ? '1' : null, b: B?.rowId, br: B && B.runId !== runOfRow(B.rowId) ? B.runId : null, bs: B?.store ? '1' : null })}`;
  },
  case: (caseId: string, surface?: string | null) => `#/paths/case${qs({ case: caseId, surface })}`,
  trial: (ref: TrialRef) => `#/${ref.store ? 'store' : 'runs'}/${encodeURIComponent(ref.runId)}/trial?row=${encodeURIComponent(ref.rowId)}&view=path`,
};

const CHIP_COLOR: Record<MetricChip['tone'], string> = { neutral: '#a1a1aa', good: '#34d399', warn: '#fbbf24', bad: '#f87171', info: '#60a5fa' };
const STATUS_TEXT: Record<string, string> = { pass: 'text-pass', fail: 'text-block', invalid: 'text-invalid' };
const shortRun = (id: string) => id.replace(/^ves-/, '');
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------------------------------------ shared bits
function MetricChips({ m, className }: { m: ReplyMetrics; className?: string }) {
  return (
    <span className={cx('inline-flex flex-wrap gap-1', className)}>
      {metricChips(m).map((c) => (
        <span key={c.key} title={c.title} className="inline-flex h-5 items-center rounded-full border px-1.5 font-mono text-[10.5px]" style={{ color: c.tone === 'neutral' ? 'var(--color-muted)' : c.tone === 'warn' ? '#9a5b00' : c.tone === 'bad' ? 'var(--color-block)' : c.tone === 'good' ? 'var(--color-pass)' : '#1d4ed8', borderColor: 'var(--color-line-strong)' }}>{c.label}</span>
      ))}
    </span>
  );
}

function Json({ value, label, open }: { value: unknown; label: string; open?: boolean }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <details open={open} className="group mt-2 rounded-md bg-tile">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 font-mono text-[12px] text-muted hover:text-ink [&::-webkit-details-marker]:hidden"><span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>{label}</summary>
      <pre className="max-h-[320px] overflow-auto px-3 pb-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{text}</pre>
    </details>
  );
}

function Swatch({ color, shape = 'circle' }: { color: string; shape?: string }) {
  return <span aria-hidden className={cx('inline-block size-3 shrink-0', shape === 'diamond' ? 'rotate-45 rounded-[2px]' : shape === 'square' ? 'rounded-[2px]' : 'rounded-full')} style={{ background: color }} />;
}

const KIND_LABEL: Record<string, string> = { user: 'User message', reply: 'Agent reply', tool: 'Tool call', tool_error: 'Tool error', approval_request: 'Approval request', approval_decision: 'Approval decision', boundary: 'Boundary', verdict: 'Check' };

/** Full content of one step. */
function NodeDetail({ n, graph, onShowStep, compact }: { n: PathNode; graph: PathGraph; onShowStep?: (stepIndex: number) => void; compact?: boolean }) {
  const verdicts = n.verdicts.map((id) => graph.nodes.find((x) => x.id === id)).filter((x): x is PathNode => !!x);
  const t = n.tool;
  return (
    <div className="min-w-0 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Swatch color={nodeColor(n)} shape={nodeShape(n)} />
        <span className="mono-label !text-ink">{KIND_LABEL[n.kind]}</span>
        <span className="font-mono text-[12px] text-muted">turn {n.turn}{n.stepId != null ? ` · step ${n.stepId}` : ''}</span>
        {n.persona && <Badge title="Written by the persona user-simulator">{n.persona.source === 'opening' ? 'opening' : 'simulated'}{n.persona.id ? ` · ${n.persona.id}` : ''}</Badge>}
        {n.stepIndex != null && onShowStep && <button type="button" onClick={() => onShowStep(n.stepIndex!)} className="ml-auto font-mono text-[12px] underline underline-offset-2">show in transcript</button>}
      </div>
      {t && (
        <>
          <div className="mt-2 font-mono text-[15px] font-semibold break-all">{t.name}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge>{t.cls}</Badge>
            {t.classes.filter((c) => c !== t.cls).map((c) => <Badge key={c}>{c}</Badge>)}
            {t.gated && <Badge tone="dark">gated</Badge>}
            <Badge>{t.source === 'both' ? 'proxied + reported' : t.source}</Badge>
            {n.dupOf && <Badge tone="invalid">duplicate ×{n.dupCount}</Badge>}
            {!t.ok && <Badge tone="block">error</Badge>}
          </div>
          {t.unobserved && <p className="mt-2 rounded-md border border-hl-line bg-hl px-3 py-2 text-[13px]">The agent reported calling <b>{t.name}</b>, a catalog tool, but no proxied call reached the backend. The agent believes it acted; the system state did not change.</p>}
          {t.reportedOnly && !t.unobserved && <p className="mt-2 text-[12px] text-muted">Reported by the agent only ({t.inCatalog ? 'catalog tool' : 'a host-side tool, not in the catalog'}); the harness did not observe it.</p>}
          {!t.ok && <p className="mt-2 font-mono text-[12px] text-block">{t.error}</p>}
          <div className="mt-1 font-mono text-[11px] break-all text-faint">{t.wire.join(' · ')} · {t.callIds.join(', ')}</div>
          <Json value={t.args} label="arguments" open={!compact} />
          {t.reportedArgs !== undefined && JSON.stringify(t.reportedArgs) !== JSON.stringify(t.args) && <Json value={t.reportedArgs} label="arguments as reported by the agent" />}
          {t.result !== undefined && <Json value={t.result} label="result" />}
        </>
      )}
      {(n.kind === 'user' || n.kind === 'reply' || n.kind === 'approval_request') && n.text && <p className="mt-2 max-h-[340px] overflow-auto rounded-md bg-tile px-3 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words">{n.text}</p>}
      {n.kind === 'approval_request' && <p className="mt-2 text-[12px] text-muted">{n.via === 'chat' ? 'Inferred: this reply is followed by an approve / reject turn.' : n.via === 'guard' ? 'The tool returned approvalRequired (the guard fired).' : 'A structured approval request (hitl_request).'}</p>}
      {n.metrics && <ReplyMetricsTable m={n.metrics} limitSource={graph.limit.source} />}
      {n.kind === 'approval_decision' && (
        <div className="mt-2">
          <div className="font-mono text-[15px] font-semibold">{n.decision}</div>
          {n.approvals?.map((a, i) => <div key={i} className="mt-1 font-mono text-[12px] text-muted">ledger {a.kind} · {a.binding ?? DASH} · by {a.principal ?? DASH}{a.expires_at ? ` · expires ${a.expires_at}` : ''} · {a.id}</div>)}
        </div>
      )}
      {n.kind === 'boundary' && <p className="mt-2 font-mono text-[14px]">{n.boundary} <span className="text-muted">(from the case's scripted turns)</span></p>}
      {n.kind === 'tool_error' && <p className="mt-2 font-mono text-[13px] text-block">{n.text}</p>}
      {n.verdict && <VerdictBlock v={n} graph={graph} />}
      {verdicts.length > 0 && (
        <div className="mt-3">
          <div className="mono-label mb-1">Checks pointing here</div>
          <ul className="flex flex-col gap-1.5">{verdicts.map((v) => <li key={v.id}><VerdictBlock v={v} graph={graph} inline /></li>)}</ul>
        </div>
      )}
    </div>
  );
}

function VerdictBlock({ v, graph, inline }: { v: PathNode; graph: PathGraph; inline?: boolean }) {
  const x = v.verdict!;
  const fail = (x.label === 'fail' || x.label === 'error') && x.name !== 'persona_outcome'; // advisory read, never a failing check
  const targets = x.targets.map((id) => graph.nodes.find((n) => n.id === id)).filter((n): n is PathNode => !!n);
  return (
    <div className={cx('rounded-md border px-3 py-2', fail ? 'border-block/40' : 'border-line', inline ? '' : 'mt-2')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx('font-mono text-[11px] font-semibold uppercase', fail ? 'text-block' : x.label === 'pass' ? 'text-pass' : 'text-muted')}>{x.label}</span>
        <span className="font-mono text-[13px] font-medium break-all">{x.name}</span>
        {x.role && <Badge tone={x.role === 'gate' ? 'dark' : 'neutral'}>{x.role}</Badge>}
        {x.safety && <Badge>safety</Badge>}
      </div>
      <p className="mt-1 text-[13px] break-words">{x.explanation || <span className="text-muted">No explanation.</span>}</p>
      {!inline && <p className="mt-1 font-mono text-[11px] text-muted">attached {x.how === 'evidence' ? 'by evidence id' : x.how === 'explanation' ? 'by ids / pointer in the explanation' : x.how === 'turn' ? 'to the reply of the turn it names' : 'to the final step (nothing more specific)'}{targets.length ? `: ${targets.map((t) => (t.tool ? t.tool.name : t.kind)).join(', ')}` : ''}</p>}
    </div>
  );
}

function ReplyMetricsTable({ m, limitSource }: { m: ReplyMetrics; limitSource: string | null }) {
  const rows: [string, ReactNode][] = [
    ['length', <>{m.chars} chars · {m.words} words{m.limit ? <> · {m.limitKind === 'max' ? 'limit' : 'guideline'} {m.limit}{m.overLimit && <b className="text-block"> (over)</b>}</> : ' · no channel limit'}</>],
    ['questions', m.questions],
    ['markdown', `${m.md.headers} headers · ${m.md.bold} bold · ${m.md.bullets} bullets · ${m.md.numbered} numbered`],
    ['emoji · links', `${m.emoji} · ${m.links}`],
    ['hedges · confident', `${m.hedges} · ${m.confident}`],
    ['language', m.lang],
    ['action claims', m.claims.length ? m.claims.map((c) => `"${c.text}" (${c.verb})`).join(', ') : 'none'],
  ];
  return (
    <div className="mt-2">
      <MetricChips m={m} />
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[12px]">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-faint">{k}</dt><dd className="break-words">{v}</dd></div>)}
      </dl>
      {limitSource && <p className="mt-1 font-mono text-[11px] text-faint">limit from {limitSource}</p>}
      <p className="mt-1 font-mono text-[11px] text-faint">deterministic text metrics; claims use a port of the claims_vs_ledger lexicon</p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ hints
type Hint = { tone: 'bad' | 'warn' | 'info'; text: ReactNode; fix?: string; node?: string };

/** Deterministic observations about a path: what it did and what to look at. Heuristics, not verdicts. */
export function pathHints(g: PathGraph): Hint[] {
  const out: Hint[] = [];
  const tools = g.nodes.filter((n) => n.kind === 'tool' && n.tool);
  const firstApprove = g.nodes.find((n) => n.kind === 'approval_decision' && n.decision === 'approve' && n.sequential);
  const risky = tools.filter((n) => !n.tool!.reportedOnly && n.tool!.ok && ['outward', 'spend', 'destructive', 'gated'].includes(n.tool!.cls));
  if (firstApprove) {
    const early = risky.filter((n) => n.order < firstApprove.order);
    if (early.length) out.push({ tone: 'bad', node: early[0].id, text: <><b>{[...new Set(early.map((n) => n.tool!.name))].join(', ')}</b> ran in turn {early[0].turn}, before the approval in turn {firstApprove.turn}.</>, fix: 'Prompt: ask and wait for a yes before any outward / spend / destructive call. Tools: make the call gated so it returns approvalRequired.' });
  }
  for (const v of g.nodes.filter((n) => n.kind === 'verdict' && n.failing)) {
    const t = g.nodes.find((n) => n.id === v.attachTo);
    out.push({ tone: 'bad', node: t?.id ?? v.id, text: <><b>{v.verdict!.name}</b> failed{t ? <> at {t.tool ? <b>{t.tool.name}</b> : t.kind} (turn {t.turn})</> : null}: {trunc(v.verdict!.explanation, 160)}</> });
  }
  const unobs = tools.filter((n) => n.tool!.unobserved);
  if (unobs.length) out.push({ tone: 'warn', node: unobs[0].id, text: <>The agent reported <b>{[...new Set(unobs.map((n) => n.tool!.name))].join(', ')}</b>, but no such call reached the backend.</>, fix: 'Tools: check the tool is loaded and proxied for this channel (load_tools then call); the reply may claim an effect that never happened.' });
  const dups = tools.filter((n) => n.dupOf);
  if (dups.length) out.push({ tone: 'info', node: dups[0].id, text: <>{dups.length} duplicate call{dups.length > 1 ? 's' : ''} (same tool, same args): {[...new Set(dups.map((n) => n.tool!.name))].join(', ')}.</>, fix: 'Prompt or tools: reuse earlier results, or return what the agent re-fetches.' });
  const meta = tools.filter((n) => n.tool!.cls === 'meta');
  if (tools.length >= 6 && meta.length / tools.length >= 0.25) out.push({ tone: 'info', node: meta[0].id, text: <>{meta.length} of {tools.length} calls were find_tools / load_tools.</>, fix: 'Tools: preload the tools this kind of request always needs.' });
  const over = g.nodes.filter((n) => n.metrics?.overLimit);
  if (over.length) out.push({ tone: 'warn', node: over[0].id, text: <>{over.length} repl{over.length > 1 ? 'ies' : 'y'} over the channel {g.limit.kind === 'max' ? 'limit' : 'guideline'} ({g.limit.limit} chars).</>, fix: 'Prompt: state the channel length budget.' });
  const errs = g.nodes.filter((n) => n.kind === 'tool_error');
  if (errs.length) out.push({ tone: 'info', node: errs[0].attachTo, text: <>{errs.length} tool error{errs.length > 1 ? 's' : ''}: {trunc(errs.map((e) => e.text).join('; '), 140)}</> });
  return out;
}

function Hints({ hints, onPick }: { hints: Hint[]; onPick: (id: string) => void }) {
  if (!hints.length) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1.5" aria-label="What the path shows">
      {hints.map((h, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px]">
          <span aria-hidden className={cx('mt-1.5 size-2 shrink-0 rounded-full', h.tone === 'bad' ? 'bg-block' : h.tone === 'warn' ? 'bg-invalid' : 'bg-faint')} />
          <span className="min-w-0">
            {h.node ? <button type="button" onClick={() => onPick(h.node!)} className="text-left hover:underline">{h.text}</button> : h.text}
            {h.fix && <span className="block font-mono text-[11.5px] text-muted">→ {h.fix}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------------ trial canvas
function trialCanvas(g: PathGraph) {
  const L = trialLayout(g);
  const nodes: CanvasNode[] = [];
  for (const n of g.nodes) {
    const p = L.pos.get(n.id);
    if (!p) continue;
    const t = n.tool;
    const vs = n.verdicts.map((id) => g.nodes.find((x) => x.id === id)?.verdict).filter(Boolean);
    nodes.push({
      id: n.id, x: p.x, y: p.y, r: p.r, color: nodeColor(n), shape: nodeShape(n),
      hollow: !!t?.reportedOnly, dashed: !!t?.reportedOnly, ring: n.kind !== 'verdict' && n.failing ? 'fail' : null, glow: n.importance >= 3 && n.kind !== 'verdict',
      label: n.kind === 'tool' ? t!.name : n.kind === 'reply' ? 'reply' : n.kind === 'user' ? 'user' : n.kind === 'verdict' ? n.verdict!.name : n.kind === 'approval_decision' ? n.decision : n.kind === 'boundary' ? n.boundary : n.kind === 'approval_request' ? 'asks' : 'error',
      alwaysLabel: n.kind !== 'verdict' && (n.importance >= 3 || n.failing || n.kind === 'boundary' || n.kind === 'user' || !!t?.unobserved),
      badge: t?.unobserved ? '!' : n.dupOf ? `×${n.dupCount}` : undefined,
      chips: n.metrics ? metricChips(n.metrics).slice(0, 3).map((c) => ({ label: c.label, color: CHIP_COLOR[c.tone] })) : undefined,
      title: [describeNode(n), ...n.flags.filter((f) => f !== 'reported-only').map((f) => `· ${f}`), ...vs.map((v) => `✕ ${v!.name}: ${v!.label}`)].join('\n'),
      ariaLabel: `${n.order + 1}. ${describeNode(n)}${n.failing && n.kind !== 'verdict' ? '. A check failed here.' : ''}`,
    });
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  // walk order for the keyboard: sequential steps first, then attachments (errors, checks)
  nodes.sort((a, b) => Number(!byId.get(a.id)!.sequential) - Number(!byId.get(b.id)!.sequential));
  const edges: CanvasEdge[] = g.edges.map((e, i) => {
    const to = byId.get(e.to)!;
    if (e.kind === 'attach') return { id: `e${i}`, from: e.from, to: e.to, color: to.failing ? PALETTE.failRing : 'rgba(212,212,216,0.35)', width: 1, dashed: true, opacity: to.failing ? 0.8 : 0.5 };
    return { id: `e${i}`, from: e.from, to: e.to, color: nodeColor(to), width: 1.4, opacity: 0.55 };
  });
  return { L, nodes, edges };
}

export function TrialPathView({ row, traj, context, onShowStep, runId, store }: { row: ResultRow; traj: TrajectoryResponse; context: PathContext | null; onShowStep?: (i: number) => void; runId: string; store?: boolean }) {
  const g = useMemo(() => buildPath({ atif: traj.atif, row, context }), [traj, row, context]);
  const { L, nodes, edges } = useMemo(() => trialCanvas(g), [g]);
  const [sel, setSel] = useState<string | null>(null);
  const node = sel ? g.nodes.find((n) => n.id === sel) ?? null : null;
  const hints = useMemo(() => pathHints(g), [g]);
  const ref: TrialRef = { runId, rowId: row.row_id, store: !!store };
  if (!traj.atif) return <p className="rounded-lg bg-tile px-5 py-5 text-[14px] text-muted">{traj.notes.join('. ') || 'No trajectory recorded for this trial.'}</p>;
  return (
    <div className="@container">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge>{g.stats.toolNodes} tool calls</Badge>
        <Badge>{g.stats.actions} actions</Badge>
        {g.stats.duplicates > 0 && <Badge tone="invalid">{g.stats.duplicates} duplicate</Badge>}
        {g.stats.reportedOnly > 0 && <Badge>{g.stats.reportedOnly} reported only</Badge>}
        {g.stats.unobserved > 0 && <Badge tone="invalid">{g.stats.unobserved} never reached backend</Badge>}
        {g.stats.errors > 0 && <Badge tone="block">{g.stats.errors} errors</Badge>}
        <Badge tone={g.stats.failingChecks ? 'block' : 'pass'}>{g.stats.failingChecks} failing checks</Badge>
        <span className="ml-auto flex flex-wrap gap-2">
          <CompareWith row={row} self={ref} />
          {row.case_id && <a href={pathHref.case(row.case_id, row.surface)} className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] shadow-[0_0_0_1px_var(--color-line)] hover:bg-shell"><IconChartDots3 size={16} stroke={1.75} aria-hidden />All paths</a>}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <PathCanvas
            nodes={nodes} edges={edges} width={L.width} height={L.height} lanes={L.lanes} bands={L.bands}
            selected={sel} onSelect={setSel} legend={TRIAL_LEGEND}
            ariaLabel={`Path of ${row.case_id} trial ${row.trial}: ${g.nodes.filter((n) => n.sequential).length} steps, ${g.stats.failingChecks} failing checks. Use the list below for a text version.`}
            textAlternative={<ol className="list-decimal space-y-1 pl-5">{g.nodes.filter((n) => n.sequential).map((n) => <li key={n.id}><button type="button" className="text-left hover:underline" onClick={() => setSel(n.id)}>T{n.turn} · {describeNode(n)}{n.failing ? ' — check failed here' : ''}</button></li>)}</ol>}
          />
          <Hints hints={hints} onPick={setSel} />
        </div>
        <aside aria-label="Selected step" className="min-w-0 rounded-lg border border-line bg-sheet p-4 @4xl:max-h-[620px] @4xl:overflow-y-auto">
          {node ? <NodeDetail n={node} graph={g} onShowStep={onShowStep} /> : (
            <div className="text-[13px] text-muted">
              <div className="mono-label mb-2">Selected step</div>
              Click a node, or tab into the canvas and use the arrow keys. Big dots are writes and outward actions; a red ring marks a step a failing check points at; hollow dashed dots are calls only the agent reported.
              {g.limit.source && <p className="mt-2 font-mono text-[12px]">Reply length checked against {g.limit.source}.</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ compare with…
function CompareWith({ row, self }: { row: ResultRow; self: TrialRef }) {
  const [open, setOpen] = useState(false);
  const list = useAsync<TrialListing[]>(open && row.case_id ? `cw|${row.case_id}` : null, () => listCaseTrials(row.case_id!));
  const others = (list.data ?? []).filter((t) => t.ref.rowId !== self.rowId || t.ref.runId !== self.runId);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><IconArrowsDiff size={16} stroke={1.75} aria-hidden />Compare with…</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Compare paths with…" wide>
        <p className="mb-3 text-[13px] text-muted">Other trials of <span className="font-mono text-ink">{row.case_id}</span> in every run the dashboard can read. A different case version is allowed here (visual compare only).</p>
        {list.loading ? <Skeleton className="h-32 w-full" /> : list.error ? <p className="text-block">{list.error}</p> : !others.length ? <p className="text-[14px] text-muted">No other trial of this case.</p> : (
          <ul className="flex max-h-[420px] flex-col divide-y divide-line overflow-y-auto rounded-md border border-line">
            {others.map((t) => (
              <li key={`${t.ref.runId}|${t.ref.rowId}`}>
                <a href={pathHref.compare(self, t.ref)} onClick={() => setOpen(false)} className="flex flex-wrap items-center gap-2 px-3 py-2.5 hover:bg-tile">
                  <TrialDot status={t.row.status} />
                  <span className={cx('w-12 font-mono text-[12px] uppercase', STATUS_TEXT[t.row.status ?? ''] ?? 'text-muted')}>{t.row.status}</span>
                  <span className="font-mono text-[13px]">{shortRun(t.ref.runId)}</span>
                  <span className="font-mono text-[12px] text-muted">trial {show(t.row.trial)} · {t.row.surface}</span>
                  {t.row.case_version !== row.case_version && <Badge tone="invalid">case v{t.row.case_version} ≠ v{row.case_version}</Badge>}
                  {t.ref.runId === self.runId && <Badge>same run</Badge>}
                  {t.ref.store && <Badge>store</Badge>}
                  <IconArrowRight size={14} stroke={1.75} className="ml-auto text-muted" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------------------------------------ compare page
function useLoadedTrial(route: Route, k: 'a' | 'b') {
  const row = route.query.get(k);
  const run = route.query.get(`${k}r`) ?? (row ? runOfRow(row) : null);
  const store = route.query.get(`${k}s`) === '1';
  return useAsync<LoadedTrial>(row && run ? `${k}|${run}|${row}|${store}` : null, async () => loadTrial(await resolveRef(run!, row!, store)));
}

export function PathComparePage({ route }: { route: Route }) {
  const A = useLoadedTrial(route, 'a'), B = useLoadedTrial(route, 'b');
  const aRow = route.query.get('a'), bRow = route.query.get('b');
  return (
    <>
      <a href="#/compare" className="mb-6 inline-flex items-center gap-2 text-[14px] text-muted hover:text-ink">← Compare runs</a>
      <PageHeader title="Path compare" sub="Two trials of one case, aligned step by step (weighted LCS on kind + tool + normalised args). Shared steps grey, A-only cyan, B-only magenta." />
      {!aRow || !bRow ? (
        <EmptyState icon={<IconRoute size={20} stroke={1.75} />} title="Pick two trials" body={<>Open a trial, switch to its Path tab and use <b>Compare with…</b>, or use the Path link next to a flipped case on the Compare page.</>} />
      ) : A.error || B.error ? <ErrorState title="Could not load a trial" error={(A.error ?? B.error)!} /> : !A.data || !B.data ? <Skeleton className="h-[520px] w-full" /> : <CompareBody a={A.data} b={B.data} />}
    </>
  );
}

function TrialCard({ t, tag, color }: { t: LoadedTrial; tag: string; color: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-sheet p-4" style={{ boxShadow: `inset 3px 0 0 ${color}` }}>
      <div className="flex items-center gap-2"><span className="mono-label" style={{ color }}>{tag}</span><TrialDot status={t.row.status} /><span className={cx('font-mono text-[12px] font-semibold uppercase', STATUS_TEXT[t.row.status ?? ''] ?? 'text-muted')}>{t.row.status}</span></div>
      <div className="mt-1.5 truncate font-mono text-[13px]" title={t.ref.runId}>{shortRun(t.ref.runId)}</div>
      <div className="font-mono text-[12px] text-muted">trial {show(t.row.trial)} · {t.row.surface} · case v{show(t.row.case_version)} · {t.graph.stats.toolNodes} calls</div>
      <a href={pathHref.trial(t.ref)} className="mt-1.5 inline-flex items-center gap-1 font-mono text-[12px] underline-offset-2 hover:underline">open trial<IconArrowRight size={13} stroke={1.75} aria-hidden /></a>
    </div>
  );
}

function CompareBody({ a, b }: { a: LoadedTrial; b: LoadedTrial }) {
  const pairs = useMemo(() => alignPaths(a.graph, b.graph), [a, b]);
  const sum = useMemo(() => compareSummary(pairs), [pairs]);
  const diffs = useMemo(() => replyDiffs(a.graph, b.graph), [a, b]);
  const [sel, setSel] = useState<string | null>(null);
  const L = useMemo(() => compareLayout(pairs, sum.divergence), [pairs, sum.divergence]);
  const { nodes, edges } = useMemo(() => {
    const nodes: CanvasNode[] = pairs.map((p, i) => {
      const n = (p.a ?? p.b)!;
      const pos = L.pos.get(`p${i}`)!;
      const fill = p.match === 'a' ? PALETTE.a : p.match === 'b' ? PALETTE.b : PALETTE.shared;
      const failing = !!(p.a?.failing || p.b?.failing);
      return {
        id: `p${i}`, x: pos.x, y: pos.y, r: Math.max(radius(n), 6), color: fill, core: nodeColor(n), shape: nodeShape(n),
        hollow: !!n.tool?.reportedOnly, dashed: !!n.tool?.reportedOnly, ring: failing ? 'fail' : null, glow: p.match !== 'same',
        badge: p.match === 'changed' ? 'Δ' : n.tool?.unobserved ? '!' : undefined,
        label: n.kind === 'tool' ? n.tool!.name : n.kind === 'approval_decision' ? n.decision : n.kind === 'boundary' ? n.boundary : n.kind.replace('_', ' '),
        alwaysLabel: n.importance >= 3 || !!n.tool?.unobserved || (p.match !== 'same' && n.kind !== 'tool'),
        title: `${p.match === 'same' ? 'both' : p.match === 'changed' ? 'both, differs' : `only ${p.match.toUpperCase()}`}\n${describeNode(n)}`,
        ariaLabel: `${i + 1}. ${p.match === 'same' ? 'In both' : p.match === 'changed' ? 'In both, differs' : `Only in ${p.match.toUpperCase()}`}: ${describeNode(n)}`,
      };
    });
    const seqA = pairs.map((p, i) => (p.a ? i : -1)).filter((i) => i >= 0);
    const seqB = pairs.map((p, i) => (p.b ? i : -1)).filter((i) => i >= 0);
    const ek = new Map<string, { a: boolean; b: boolean }>();
    for (let i = 1; i < seqA.length; i++) { const k = `${seqA[i - 1]}-${seqA[i]}`; ek.set(k, { ...(ek.get(k) ?? { a: false, b: false }), a: true }); }
    for (let i = 1; i < seqB.length; i++) { const k = `${seqB[i - 1]}-${seqB[i]}`; ek.set(k, { ...(ek.get(k) ?? { a: false, b: false }), b: true }); }
    const edges: CanvasEdge[] = [...ek.entries()].map(([k, v]) => {
      const [f, t] = k.split('-');
      return { id: k, from: `p${f}`, to: `p${t}`, color: v.a && v.b ? PALETTE.shared : v.a ? PALETTE.a : PALETTE.b, width: v.a && v.b ? 1.4 : 1.8, opacity: v.a && v.b ? 0.6 : 0.85 };
    });
    return { nodes, edges };
  }, [pairs, L]);
  const pick = sel ? pairs[Number(sel.slice(1))] : null;
  const versionDiff = a.row.case_version !== b.row.case_version;
  const sameCase = a.row.case_id === b.row.case_id;
  const legend: LegendItem[] = [
    { key: 's', label: 'both', color: PALETTE.shared, shape: 'circle' }, { key: 'a', label: 'only A', color: PALETTE.a, shape: 'circle' }, { key: 'b', label: 'only B', color: PALETTE.b, shape: 'circle' },
    { key: 'r', label: 'failed check here', color: PALETTE.failRing, shape: 'ring' }, { key: 'h', label: 'reported by agent only', color: PALETTE.shared, shape: 'hollow' },
  ];
  const graders = useMemo(() => {
    const names = [...new Set([...(a.row.scores ?? []), ...(b.row.scores ?? [])].map((s) => (s.name ?? s.grader_id ?? '?').replace(/^ves\./, '')))];
    const lab = (r: ResultRow, n: string) => (r.scores ?? []).find((s) => (s.name ?? s.grader_id ?? '?').replace(/^ves\./, '') === n);
    return names.map((n) => ({ n, a: lab(a.row, n), b: lab(b.row, n) }));
  }, [a, b]);
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
        <TrialCard t={a} tag="A" color={PALETTE.a} />
        <a href={pathHref.compare(b.ref, a.ref)} aria-label="Swap A and B" className="inline-flex h-9 items-center justify-center gap-1.5 self-center rounded-md px-3 text-[13px] shadow-[0_0_0_1px_var(--color-line)] hover:bg-shell"><IconSwitchHorizontal size={16} stroke={1.75} aria-hidden />Swap</a>
        <TrialCard t={b} tag="B" color={PALETTE.b} />
      </div>
      {(versionDiff || !sameCase) && (
        <div role="status" className="mt-4 flex items-start gap-2 rounded-lg border border-hl-line bg-hl px-4 py-3 text-[13px]">
          <IconAlertTriangle size={18} stroke={1.75} className="mt-0.5 shrink-0 text-invalid" aria-hidden />
          <span>{!sameCase ? <>These are different cases ({a.row.case_id} vs {b.row.case_id}).</> : <>Case versions differ (v{a.row.case_version} vs v{b.row.case_version}).</>} This visual compare still works; the statistical run compare keeps refusing such pairs.</span>
        </div>
      )}
      <Tile className="mt-4" inner="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{sum.shared} shared</Badge>{sum.changed > 0 && <Badge tone="invalid">{sum.changed} differ</Badge>}
          <span className="inline-flex h-6 items-center rounded-full px-2.5 font-mono text-[11px] uppercase" style={{ background: `${PALETTE.a}22`, color: '#0e7490' }}>{sum.onlyA} only A</span>
          <span className="inline-flex h-6 items-center rounded-full px-2.5 font-mono text-[11px] uppercase" style={{ background: `${PALETTE.b}22`, color: '#a21caf' }}>{sum.onlyB} only B</span>
        </div>
        <p className="mt-2 text-[15px] leading-snug">{sum.sentence}</p>
        <Hints hints={divergenceHints(a, b, pairs)} onPick={(id) => setSel(id)} />
      </Tile>
      <div className="@container mt-4">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,1fr)_360px]">
          <PathCanvas heightClass="h-[320px] sm:h-[380px]" nodes={nodes} edges={edges} width={L.width} height={L.height} lanes={L.lanes} bands={L.bands} markers={L.markers} selected={sel} onSelect={setSel} legend={legend}
            ariaLabel={`Merged path of A and B: ${pairs.length} aligned steps. ${sum.sentence}`}
            textAlternative={<ol className="space-y-1">{describePairs(pairs).map((s, i) => <li key={i}><button type="button" className="text-left hover:underline" onClick={() => setSel(`p${i}`)}>{s}</button></li>)}</ol>} />
          <aside aria-label="Selected step" className="min-w-0 rounded-lg border border-line bg-sheet p-4 @4xl:max-h-[620px] @4xl:overflow-y-auto">
            {pick ? (
              <div className="flex flex-col gap-4">
                <div className="mono-label">{pick.match === 'same' ? 'In both' : pick.match === 'changed' ? 'In both, differs' : `Only in ${pick.match.toUpperCase()}`}</div>
                {pick.a && <div style={{ boxShadow: `inset 3px 0 0 ${PALETTE.a}` }} className="pl-3"><div className="mono-label mb-1" style={{ color: '#0e7490' }}>A</div><NodeDetail n={pick.a} graph={a.graph} compact /></div>}
                {pick.b && <div style={{ boxShadow: `inset 3px 0 0 ${PALETTE.b}` }} className="pl-3"><div className="mono-label mb-1" style={{ color: '#a21caf' }}>B</div><NodeDetail n={pick.b} graph={b.graph} compact /></div>}
              </div>
            ) : <div className="text-[13px] text-muted"><div className="mono-label mb-2">Selected step</div>Click a node to see A and B side by side. The dashed yellow line marks where the paths first split; Δ marks a shared step whose arguments differ. The inner dot is the step kind.</div>}
          </aside>
        </div>
      </div>

      <Section title="Checks, A vs B" label="Grader labels">
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[520px] text-[13px]">
            <thead className="bg-tile font-mono text-[11px] tracking-[0.06em] text-muted uppercase"><tr><th className="px-3 py-2 text-left font-medium">Check</th><th className="px-3 py-2 text-left font-medium">A</th><th className="px-3 py-2 text-left font-medium">B</th></tr></thead>
            <tbody>
              {graders.map(({ n, a: x, b: y }) => {
                const diff = (x?.label ?? '') !== (y?.label ?? '');
                const cell = (s: typeof x) => <td className="px-3 py-2 align-top"><span className={cx('font-mono text-[12px] font-semibold uppercase', s?.label === 'pass' ? 'text-pass' : s?.label === 'fail' ? 'text-block' : 'text-muted')}>{s?.label ?? DASH}</span>{s?.explanation && <div className="mt-0.5 text-[12px] break-words text-muted">{trunc(s.explanation, 180)}</div>}</td>;
                return <tr key={n} className={cx('border-t border-line', diff && 'bg-hl')}><td className="px-3 py-2 align-top font-mono text-[12px] font-medium">{n}</td>{cell(x)}{cell(y)}</tr>;
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Replies per turn" label="Side by side · metric deltas are B − A">
        <div className="flex flex-col gap-4">
          {diffs.map((d) => (
            <div key={d.turn} className="rounded-lg border border-line bg-sheet">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2"><span className="mono-label !text-ink">{d.label}</span>
                <span className="flex flex-wrap gap-1">{d.deltas.filter((x) => x.delta !== null ? x.delta !== 0 : x.a !== x.b).map((x) => <span key={x.key} title={`${x.label}: A ${x.a}, B ${x.b}`} className={cx('inline-flex h-5 items-center rounded-full border border-line-strong px-1.5 font-mono text-[10.5px]', x.delta !== null && x.delta > 0 ? 'text-[#a21caf]' : 'text-[#0e7490]')}>{x.label} {x.delta === null ? `${x.a}→${x.b}` : `${x.delta > 0 ? '+' : ''}${x.delta}`}</span>)}</span>
              </div>
              <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
                {([['A', d.a, PALETTE.a], ['B', d.b, PALETTE.b]] as const).map(([tag, s, c]) => (
                  <div key={tag} className="min-w-0 p-4" style={{ boxShadow: `inset 0 2px 0 ${c}` }}>
                    <div className="mb-1 flex flex-wrap items-center gap-2"><span className="mono-label" style={{ color: tag === 'A' ? '#0e7490' : '#a21caf' }}>{tag}</span>{s.metrics && <MetricChips m={s.metrics} />}</div>
                    {s.text ? <p className="text-[14px] leading-relaxed whitespace-pre-wrap break-words">{s.text}</p> : <p className="text-[13px] text-muted">No reply in this turn.</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

/** Why the paths differ, in plain words: steps only one side took that matter. */
function divergenceHints(a: LoadedTrial, b: LoadedTrial, pairs: AlignPair[]): Hint[] {
  const out: Hint[] = [];
  const idx = (p: AlignPair) => `p${pairs.indexOf(p)}`;
  for (const [side, other, tag] of [[a, b, 'A'], [b, a, 'B']] as const) {
    const only = pairs.filter((p) => p.match === (tag === 'A' ? 'a' : 'b'));
    const unobs = only.filter((p) => (p.a ?? p.b)!.tool?.unobserved);
    if (unobs.length) out.push({ tone: 'warn', node: idx(unobs[0]), text: <>{tag} reported <b>{unobs.map((p) => (p.a ?? p.b)!.tool!.name).join(', ')}</b> without the call reaching the backend{other.graph.nodes.some((n) => n.tool && !n.tool.reportedOnly && unobs.some((p) => (p.a ?? p.b)!.tool!.name === n.tool!.name)) ? `; ${tag === 'A' ? 'B' : 'A'} made the real call` : ''}.</> });
    const acts = only.filter((p) => { const t = (p.a ?? p.b)!.tool; return t && !t.reportedOnly && ['write', 'gated', 'memory', 'outward', 'spend', 'destructive'].includes(t.cls); });
    if (acts.length) out.push({ tone: 'info', node: idx(acts[0]), text: <>Only {tag} took the action{acts.length > 1 ? 's' : ''} <b>{[...new Set(acts.map((p) => (p.a ?? p.b)!.tool!.name))].join(', ')}</b>.</> });
    void side;
  }
  const div = pairs.filter(isDivergent).length;
  const fa = a.graph.stats.failingChecks, fb = b.graph.stats.failingChecks;
  if (a.row.status !== b.row.status) out.push({ tone: 'info', text: <>A {a.row.status} ({fa} failing check{fa === 1 ? '' : 's'}), B {b.row.status} ({fb}); {div} divergent step{div === 1 ? '' : 's'}.</> });
  return out;
}

// ------------------------------------------------------------------------------------------------ case paths page
export function CasePathsPage({ route }: { route: Route }) {
  const caseId = route.query.get('case');
  const surface = route.query.get('surface');
  const [q, setQ] = useState(caseId ?? '');
  const data = useAsync<CaseTrial[]>(caseId ? `case|${caseId}` : null, async () => {
    const list = (await listCaseTrials(caseId!)).filter((t) => t.row.status !== 'skip').slice(0, 60);
    const loaded = await Promise.all(list.map((t) => loadTrial(t.ref).catch(() => null)));
    return loaded.filter((x): x is LoadedTrial => !!x && !!x.traj.atif).map((t) => ({ key: `${t.ref.runId}|${t.ref.rowId}`, runId: t.ref.runId, rowId: t.ref.rowId, trial: t.row.trial ?? null, status: t.row.status ?? null, caseVersion: t.row.case_version ?? null, created: t.created, graph: t.graph, ref: t.ref } as CaseTrial & { ref: TrialRef }));
  });
  const surfaces = [...new Set((data.data ?? []).map((t) => t.graph.surface ?? '?'))].sort();
  const trials = (data.data ?? []).filter((t) => !surface || t.graph.surface === surface);
  return (
    <>
      <a href={caseId ? `#/history/case?case=${encodeURIComponent(caseId)}` : '#/history'} className="mb-6 inline-flex items-center gap-2 text-[14px] text-muted hover:text-ink">← Case timeline</a>
      <PageHeader title={caseId ?? 'All paths'} sub="Every stored trial of one case as one graph: nodes are tools and reply types, edges are transitions weighted by how many trials took them, coloured by whether those trials passed." />
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(pathHref.case(q.trim())); }} className="mb-5 flex max-w-xl flex-col gap-2 sm:flex-row">
        <label htmlFor="cp-q" className="sr-only">Case id</label>
        <input id="cp-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="case id" className="h-10 min-w-0 flex-1 rounded-md bg-sheet px-3 font-mono text-[14px] shadow-[0_0_0_1px_var(--color-line)] outline-none focus-visible:shadow-[0_0_0_2px_var(--color-ink)]" />
        <Button variant="primary" type="submit">Show</Button>
      </form>
      {surfaces.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by surface">
          <a href={pathHref.case(caseId!)} aria-current={!surface} className={cx('rounded-md border px-2.5 py-1 font-mono text-[12px]', !surface ? 'border-ink bg-ink text-white' : 'border-line')}>all</a>
          {surfaces.map((s) => <a key={s} href={pathHref.case(caseId!, s)} aria-current={surface === s} className={cx('rounded-md border px-2.5 py-1 font-mono text-[12px]', surface === s ? 'border-ink bg-ink text-white' : 'border-line')}>{s}</a>)}
        </div>
      )}
      {!caseId ? null : data.error ? <ErrorState title="Could not load the trials" error={data.error} /> : data.loading ? <Skeleton className="h-[520px] w-full" /> : !trials.length ? <EmptyState title="No trials with a trajectory" body="No readable run (results dir or store) has a recorded trial of this case." /> : <CaseBody trials={trials as (CaseTrial & { ref: TrialRef })[]} />}
    </>
  );
}

const shareColor = (pass: number, fail: number) => {
  const n = pass + fail;
  if (!n) return '#a1a1aa';
  const s = pass / n;
  return s >= 0.999 ? '#34d399' : s <= 0.001 ? '#f87171' : s >= 0.5 ? '#bef264' : '#fbbf24';
};

function CaseBody({ trials }: { trials: (CaseTrial & { ref: TrialRef })[] }) {
  const cg = useMemo(() => caseGraph(trials), [trials]);
  const L = useMemo(() => caseLayout(cg), [cg]);
  const [sel, setSel] = useState<string | null>(null);
  const [focusTrial, setFocusTrial] = useState<string | null>(null);
  const ft = focusTrial ? cg.trials.find((t) => t.key === focusTrial) : null;
  const maxT = Math.max(1, ...cg.nodes.map((n) => n.trials.length));
  const nodes: CanvasNode[] = cg.nodes.map((n) => {
    const p = L.pos.get(n.id)!;
    const color = n.kind === 'terminal' ? (n.id === 'end:pass' ? PALETTE.passRing : n.id === 'end:fail' ? PALETTE.failRing : PALETTE.kind.terminal) : n.sample ? nodeColor(n.sample) : '#a1a1aa';
    const failOnly = cg.failOnly.includes(n.id), passOnly = cg.passOnly.includes(n.id);
    return {
      id: n.id, x: p.x, y: p.y, r: p.r, color, shape: n.kind === 'terminal' ? 'square' : n.sample ? nodeShape(n.sample) : 'circle',
      hollow: n.id.startsWith('tool~'), dashed: n.id.startsWith('tool~'), ring: failOnly ? 'fail' : passOnly ? 'pass' : null, glow: n.trials.length / maxT > 0.6 || failOnly,
      dim: !!ft && !n.trials.includes(ft.key),
      label: n.label, alwaysLabel: n.kind === 'terminal' || failOnly || passOnly || n.trials.length / maxT >= 0.5 || n.kind === 'reply' || ['memory', 'write', 'gated', 'outward', 'spend', 'destructive'].includes(n.cls ?? ''),
      badge: n.repeats ? `↻${n.repeats}` : undefined,
      title: `${n.label}\n${n.trials.length} trial(s): ${n.pass} passed, ${n.fail} failed${n.other ? `, ${n.other} other` : ''}${n.repeats ? `\nrepeated back-to-back ${n.repeats}×` : ''}${failOnly ? '\nonly in failing trials' : passOnly ? '\nonly in passing trials' : ''}`,
      ariaLabel: `${n.label}: ${n.trials.length} trials, ${n.pass} passed, ${n.fail} failed${failOnly ? ', only in failing trials' : ''}`,
    };
  });
  nodes.sort((x, y) => L.pos.get(x.id)!.x - L.pos.get(y.id)!.x);
  const edges: CanvasEdge[] = cg.edges.map((e, i) => ({
    id: `e${i}`, from: e.from, to: e.to, color: shareColor(e.pass, e.fail), width: 0.8 + Math.log2(1 + e.trials.length) * 1.3,
    opacity: ft ? (e.trials.includes(ft.key) ? 0.95 : 0.08) : 0.7, arrow: true,
  }));
  const node: AggNode | null = sel ? cg.nodes.find((n) => n.id === sel) ?? null : null;
  const label = (id: string) => cg.nodes.find((n) => n.id === id)?.label ?? id;
  const allFailNotPass = cg.allFailing.filter((id) => { const n = cg.nodes.find((x) => x.id === id)!; return n.pass < cg.counts.pass && !cg.failOnly.includes(id); });
  const legend: LegendItem[] = [
    { key: 'p', label: 'edge: all trials passed', color: '#34d399', shape: 'line' }, { key: 'm', label: 'mixed, mostly pass', color: '#bef264', shape: 'line' },
    { key: 'mf', label: 'mixed, mostly fail', color: '#fbbf24', shape: 'line' }, { key: 'f', label: 'all failed', color: '#f87171', shape: 'line' },
    { key: 'fr', label: 'only in failing trials', color: PALETTE.failRing, shape: 'ring' }, { key: 'pr', label: 'only in passing trials', color: PALETTE.passRing, shape: 'ring' },
    ...TRIAL_LEGEND.filter((l) => ['reply', 'meta', 'read', 'memory', 'write', 'outward', 'spend'].includes(l.key)),
  ];
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge>{cg.trials.length} trials</Badge><Badge tone="pass">{cg.counts.pass} passed</Badge><Badge tone="block">{cg.counts.fail} failed</Badge>{cg.counts.other > 0 && <Badge tone="invalid">{cg.counts.other} other</Badge>}
        <Badge>{new Set(cg.trials.map((t) => t.runId)).size} runs</Badge><Badge>{cg.nodes.length - 3 > 0 ? cg.nodes.filter((n) => n.kind !== 'terminal').length : 0} distinct steps</Badge>
        {[...new Set(cg.trials.map((t) => t.caseVersion))].length > 1 && <Badge tone="invalid">mixed case versions</Badge>}
      </div>
      {(cg.failOnly.length > 0 || allFailNotPass.length > 0 || cg.passOnly.length > 0) && (
        <Tile className="mb-4" inner="p-4">
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {allFailNotPass.length > 0 && <li className="flex gap-2"><span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-block" /><span>Every failing trial went through {allFailNotPass.map((id, i) => <span key={id}>{i ? ', ' : ''}<button type="button" className="font-mono font-semibold hover:underline" onClick={() => setSel(id)}>{label(id)}</button></span>)}.</span></li>}
            {cg.failOnly.length > 0 && <li className="flex gap-2"><span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-block" /><span>Only failing trials took {cg.failOnly.map((id, i) => <span key={id}>{i ? ', ' : ''}<button type="button" className="font-mono font-semibold hover:underline" onClick={() => setSel(id)}>{label(id)}</button></span>)}.</span></li>}
            {cg.passOnly.length > 0 && <li className="flex gap-2"><span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-pass" /><span>Only passing trials took {cg.passOnly.map((id, i) => <span key={id}>{i ? ', ' : ''}<button type="button" className="font-mono font-semibold hover:underline" onClick={() => setSel(id)}>{label(id)}</button></span>)}.</span></li>}
          </ul>
        </Tile>
      )}
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[minmax(0,1fr)_340px]">
          <PathCanvas nodes={nodes} edges={edges} width={L.width} height={L.height} selected={sel} onSelect={setSel} legend={legend}
            ariaLabel={`All paths of the case: ${cg.nodes.length} steps, ${cg.edges.length} transitions across ${cg.trials.length} trials.`}
            textAlternative={<ul className="space-y-1">{[...cg.edges].sort((x, y) => y.trials.length - x.trials.length).map((e, i) => <li key={i}>{label(e.from)} → {label(e.to)}: {e.trials.length} trial(s), {e.pass} passed, {e.fail} failed</li>)}</ul>} />
          <aside aria-label="Selected step and trials" className="min-w-0 rounded-lg border border-line bg-sheet p-4 @4xl:max-h-[620px] @4xl:overflow-y-auto">
            {node ? (
              <div className="text-[13px]">
                <div className="flex items-center gap-2"><Swatch color={nodes.find((x) => x.id === node.id)!.color} /><span className="font-mono text-[15px] font-semibold break-all">{node.label}</span></div>
                <div className="mt-1 font-mono text-[12px] text-muted">{node.kind}{node.cls ? ` · ${node.cls}` : ''}{node.id.startsWith('tool~') ? ' · reported by the agent only' : ''}</div>
                <div className="mt-2 flex flex-wrap gap-1.5"><Badge tone="pass">{node.pass} passed</Badge><Badge tone="block">{node.fail} failed</Badge><Badge>{node.visits} visits</Badge>{node.repeats > 0 && <Badge>{node.repeats} back-to-back repeats</Badge>}</div>
                <div className="mono-label mt-3 mb-1">Leads to</div>
                <ul className="flex flex-col gap-0.5 font-mono text-[12px]">{cg.edges.filter((e) => e.from === node.id).sort((x, y) => y.trials.length - x.trials.length).map((e) => <li key={e.to} className="flex items-center gap-2"><span aria-hidden className="inline-block h-0.5 w-4" style={{ background: shareColor(e.pass, e.fail) }} />{label(e.to)} <span className="text-muted">{e.pass}✓ {e.fail}✕</span></li>)}</ul>
                <div className="mono-label mt-3 mb-1">Trials through it</div>
                <ul className="flex flex-col gap-0.5">{cg.trials.filter((t) => node.trials.includes(t.key)).map((t) => <li key={t.key}><a className="font-mono text-[12px] hover:underline" href={pathHref.trial((t as CaseTrial & { ref: TrialRef }).ref)}><TrialDot status={t.status ?? undefined} className="mr-1.5" />{shortRun(t.runId)} · t{t.trial}</a></li>)}</ul>
              </div>
            ) : <p className="text-[13px] text-muted"><span className="mono-label mb-2 block">Selected step</span>Click a node for its trials and transitions. Pick a trial below to highlight its path.</p>}
          </aside>
        </div>
      </div>
      <Section title="Trials" label="Click to highlight a path">
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="bg-tile font-mono text-[11px] tracking-[0.06em] text-muted uppercase"><tr><th className="px-3 py-2 text-left font-medium">Trial</th><th className="px-3 py-2 text-left font-medium">Status</th><th className="px-3 py-2 text-left font-medium">Steps</th><th className="px-3 py-2 text-left font-medium">Failing checks</th><th className="px-3 py-2 text-right font-medium">Open</th></tr></thead>
            <tbody>
              {trials.map((t) => (
                <tr key={t.key} className={cx('border-t border-line', focusTrial === t.key ? 'bg-hl' : 'hover:bg-tile/60')}>
                  <td className="px-3 py-2"><button type="button" aria-pressed={focusTrial === t.key} onClick={() => setFocusTrial(focusTrial === t.key ? null : t.key)} className="text-left font-mono hover:underline">{shortRun(t.runId)} · trial {t.trial}{t.caseVersion != null ? ` · v${t.caseVersion}` : ''}</button></td>
                  <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><TrialDot status={t.status ?? undefined} /><span className={cx('font-mono text-[12px] uppercase', STATUS_TEXT[t.status ?? ''] ?? 'text-muted')}>{t.status}</span></span></td>
                  <td className="px-3 py-2 font-mono text-[12px]">{t.graph.stats.toolNodes} calls · {t.graph.stats.replies} replies</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-muted">{t.graph.nodes.filter((n) => n.kind === 'verdict' && n.failing).map((n) => n.verdict!.name).join(', ') || DASH}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap"><a className="font-mono text-[12px] underline-offset-2 hover:underline" href={pathHref.trial(t.ref)}>path</a>{trials[0] && trials[0].key !== t.key && <> · <a className="font-mono text-[12px] underline-offset-2 hover:underline" href={pathHref.compare(t.ref, trials[0].ref)}>vs newest</a></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
