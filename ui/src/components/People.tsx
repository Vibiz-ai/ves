// People (personas) building blocks: avatar, avatar stack, chat chips (one per conversation, coloured by outcome),
// the gallery card and the compact per-run card. Colours come from personaAccent (stable per person id).
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { IconChevronRight, IconMessageCircle } from '@tabler/icons-react';
import { useApi } from '../lib/api.ts';
import { DASH, niceTime } from '../lib/format.ts';
import { buildPeople, chatTone, firstName, initials, personaAccent, personaRole, rowsByPerson, statsOf, type ChatTone, type PersonProfile, type PersonStats } from '../lib/people.ts';
import { personaOf as personaOfRow } from '../lib/persona.ts';
import { href } from '../lib/router.ts';
import type { Persona, PersonasResponse, ResultRow } from '../lib/types.ts';
import { cx } from './ui.tsx';

/** /api/personas, folded into one profile per person. */
export function usePeople() {
  const res = useApi<PersonasResponse>('/api/personas', 15000);
  const people = useMemo(() => buildPeople(res.data), [res.data]);
  return { ...res, people };
}

export function Avatar({ id, name, size = 36, className, ring }: { id: string; name?: string | null; size?: number; className?: string; ring?: boolean }) {
  const a = personaAccent(id);
  const txt = initials(name, id);
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white', ring && 'ring-2 ring-sheet', className)}
      style={{ width: size, height: size, background: a.fg, fontSize: Math.max(10, Math.round(size * (txt.length > 1 ? 0.36 : 0.44))), letterSpacing: '0.01em' }}>
      {txt}
    </span>
  );
}

export function AvatarStack({ people, max = 6, size = 24 }: { people: { id: string; name: string | null }[]; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  return (
    <span className="inline-flex items-center" title={people.map((p) => firstName(p.name) || p.id).join(', ')}>
      {shown.map((p, i) => <Avatar key={p.id} id={p.id} name={p.name} size={size} ring className={i ? '-ml-1.5' : ''} />)}
      {people.length > max && <span className="-ml-1.5 inline-flex items-center justify-center rounded-full bg-tile font-mono text-[10px] text-muted ring-2 ring-sheet" style={{ width: size, height: size }}>+{people.length - max}</span>}
    </span>
  );
}

const TONE: Record<ChatTone, { cls: string; dot: string; word: string }> = {
  good: { cls: 'border-[#b9dcc4] bg-[#eef7f1] text-pass hover:border-pass', dot: 'bg-pass', word: 'goal met' },
  mixed: { cls: 'border-[#ecd3a6] bg-[#fdf5e6] text-invalid hover:border-invalid', dot: 'bg-invalid', word: 'partly met' },
  bad: { cls: 'border-[#f0c0c0] bg-[#fdf0f0] text-block hover:border-block', dot: 'bg-block', word: 'goal not met' },
  invalid: { cls: 'border-dashed border-[#d9b779] bg-sheet text-invalid hover:border-invalid', dot: 'bg-invalid', word: 'invalid' },
  skip: { cls: 'border-line bg-tile text-muted hover:border-line-strong', dot: 'bg-skip', word: 'skipped' },
  unknown: { cls: 'border-line bg-tile text-muted hover:border-line-strong', dot: 'bg-line-strong', word: 'not judged' },
};
export const toneWord = (t: ChatTone) => TONE[t].word;
export const toneDot = (t: ChatTone) => TONE[t].dot;

/** A clickable pill that opens one conversation; coloured by its outcome. */
export function ChatChip({ to, tone, label, title, active, className }: { to: string; tone: ChatTone; label: ReactNode; title?: string; active?: boolean; className?: string }) {
  return (
    <a href={to} title={title ?? toneWord(tone)} aria-current={active ? 'page' : undefined}
      className={cx('relative z-10 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[12px] transition-colors', TONE[tone].cls, active && '!border-ink ring-1 ring-ink', className)}>
      <IconMessageCircle size={14} stroke={1.75} aria-hidden />
      <span>{label}</span>
    </a>
  );
}

type ChatLike = { row_id: string; run_id: string; trial: number | null; status: string | null; persona: Persona | null; surface?: string | null };
/** "Chat 1 · Chat 2 · Chat 3" for a run's trials of one person; numbers the trials from 1. */
export function ChatChips({ convs, multiSurface, store }: { convs: ChatLike[]; multiSurface?: boolean; store?: boolean }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {convs.map((c, i) => {
        const tone = chatTone(c);
        const n = typeof c.trial === 'number' ? c.trial + 1 : i + 1;
        return <ChatChip key={c.row_id} to={href.chat(c.run_id, c.row_id, store)} tone={tone} label={`Chat ${n}${multiSurface && c.surface ? ` · ${c.surface}` : ''}`} title={`Open chat ${n}${c.surface ? ` on ${c.surface}` : ''}: ${toneWord(tone)}`} />;
      })}
    </span>
  );
}

const of3 = (x: number | null) => (x === null ? DASH : `${Number.isInteger(x) ? x : x.toFixed(1)}/3`);

/** Goal met, frustration, tone fit, gave up: the four numbers of a person's latest results. */
export function StatRow({ s, compact }: { s: PersonStats; compact?: boolean }) {
  const goalCls = s.judged === 0 ? 'text-muted' : s.yes === s.judged ? 'text-pass' : s.no > 0 ? 'text-block' : 'text-invalid';
  const items: [string, ReactNode, string?][] = [
    ['Goal met', s.judged ? <span className={goalCls}>{s.yes}/{s.judged}</span> : <span className="text-muted">{DASH}</span>, `yes ${s.yes} · partly ${s.partly} · no ${s.no}${s.unknown ? ` · unknown ${s.unknown}` : ''}${s.invalid ? ` · INVALID ${s.invalid} (not judged)` : ''}`],
    ['Frustration', of3(s.meanFrustration), 'mean frustration, 0 = calm, 3 = very frustrated (judge read)'],
    ['Tone fit', of3(s.meanToneFit), 'mean tone fit, 0–3 (judge read)'],
    ['Gave up', s.judged ? String(s.gaveUp) : DASH, 'conversations where the person gave up'],
  ];
  return (
    <dl className={cx('grid grid-cols-[1fr_1.35fr_1fr_1fr] gap-2', compact ? '' : 'rounded-md bg-tile px-3 py-2.5')}>
      {items.map(([k, v, t]) => (
        <div key={k} className="min-w-0" title={t}>
          <dt className="truncate font-mono text-[10px] tracking-[0.04em] text-muted uppercase">{k}</dt>
          <dd className="mt-0.5 font-mono text-[14px] font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TempChips({ items, langs }: { items: string[]; langs?: string[] }) {
  if (!items.length && !langs?.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {items.map((t) => <span key={t} className="inline-flex h-5 items-center rounded-full bg-tile px-2 font-mono text-[10.5px] tracking-[0.04em] text-muted uppercase">{t.replace(/_/g, ' ')}</span>)}
      {langs?.length ? <span className="inline-flex h-5 items-center rounded-full border border-line px-2 font-mono text-[10.5px] tracking-[0.04em] text-muted uppercase" title="Languages">{langs.join(' · ')}</span> : null}
    </span>
  );
}

export const accentStyle = (id: string): CSSProperties => ({ ['--acc' as string]: personaAccent(id).fg, ['--acc-soft' as string]: personaAccent(id).soft, ['--acc-line' as string]: personaAccent(id).line });

/** Gallery card on the Personas page; the whole card opens the person, the chips open a chat. */
export function PersonCard({ p }: { p: PersonProfile }) {
  const a = personaAccent(p.id);
  const role = personaRole(p.name);
  const latest = p.latest;
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-lg border border-line bg-sheet shadow-card transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-line-strong hover:shadow-card-hover" style={accentStyle(p.id)}>
      <span aria-hidden className="h-1 w-full" style={{ background: a.fg }} />
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start gap-3">
          <Avatar id={p.id} name={p.name} size={44} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[18px] leading-tight font-semibold tracking-[-0.01em]">
              <a href={href.person(p.id)} className="after:absolute after:inset-0 focus-visible:outline-none group-hover:underline group-hover:underline-offset-4 group-has-[a:focus-visible]:underline">{firstName(p.name)}</a>
            </h2>
            {role && <p className="mt-0.5 truncate text-[13px] text-muted" title={role}>{role}</p>}
          </div>
          <IconChevronRight size={18} stroke={1.75} aria-hidden className="mt-1 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
        </div>
        {p.background && <p className="line-clamp-2 text-[13px] leading-snug text-muted" title={p.background}>{p.background}</p>}
        <TempChips items={p.temperament} langs={p.languages} />
        {p.goal && (
          <div className="rounded-md px-3 py-2" style={{ background: a.soft }}>
            <div className="font-mono text-[10px] tracking-[0.08em] uppercase" style={{ color: a.fg }}>Goal</div>
            <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-ink" title={p.goal}>{p.goal}</p>
          </div>
        )}
        <div className="mt-auto flex flex-col gap-3 pt-1">
          {latest ? (
            <>
              <div>
                <div className="mb-1.5 font-mono text-[10px] tracking-[0.08em] text-muted uppercase">Latest run · {niceTime(latest.created, { year: false })}</div>
                <StatRow s={latest.stats} />
              </div>
              <div>
                <div className="mb-1.5 font-mono text-[10px] tracking-[0.08em] text-muted uppercase">Read the chats</div>
                <ChatChips convs={latest.convs} multiSurface={new Set(latest.convs.map((c) => c.surface)).size > 1} />
              </div>
            </>
          ) : <p className="rounded-md bg-tile px-3 py-2.5 text-[13px] text-muted">In the library; no conversations in these results yet.</p>}
          <div className="flex items-center justify-between border-t border-line pt-3 text-[13px]">
            <span className="font-mono text-[12px] text-muted">{p.conversations.length} chat{p.conversations.length === 1 ? '' : 's'} · {p.runs.length} run{p.runs.length === 1 ? '' : 's'}</span>
            <span className="inline-flex items-center gap-1 font-medium text-ink group-hover:underline group-hover:underline-offset-4">See all runs<IconChevronRight size={14} stroke={2} aria-hidden /></span>
          </div>
        </div>
      </div>
    </article>
  );
}

/** Run detail: one card per person in the run, with their scores and a chip per conversation. */
export function RunPeople({ runId, rows, names }: { runId: string; rows: ResultRow[]; names: Map<string, string | null> }) {
  const groups = rowsByPerson(rows, names);
  const multiSurface = new Set(rows.map((r) => r.surface)).size > 1;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {groups.map((g) => {
        const a = personaAccent(g.id);
        const role = personaRole(g.name);
        const convs = g.rows.map((r) => ({ row_id: r.row_id, run_id: runId, trial: r.trial ?? null, status: r.status ?? null, persona: personaOfRow(r), surface: r.surface ?? null }));
        const s = statsOf(convs);
        const goal = g.rows.find((r) => r.persona?.goal)?.persona?.goal;
        return (
          <article key={g.id} className="group relative flex flex-col gap-3 overflow-hidden rounded-lg border border-line bg-sheet p-4 pl-5 shadow-card transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-card-hover">
            <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: a.fg }} />
            <div className="flex items-start gap-3">
              <Avatar id={g.id} name={g.name} size={38} />
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] leading-tight font-semibold">
                  <a href={href.person(g.id)} className="after:absolute after:inset-0 focus-visible:outline-none group-hover:underline group-hover:underline-offset-4">{firstName(g.name)}</a>
                </h3>
                {role && <p className="truncate text-[12px] text-muted" title={role}>{role}</p>}
              </div>
              <IconChevronRight size={16} stroke={1.75} aria-hidden className="mt-1 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
            </div>
            {goal && <p className="line-clamp-2 text-[12.5px] leading-snug text-muted" title={goal}><span className="font-mono text-[10px] tracking-[0.08em] uppercase" style={{ color: a.fg }}>Goal </span>{goal}</p>}
            {s.invalid === s.trials ? <p className="rounded-md border border-dashed border-[#d9b779] px-3 py-2 text-[12.5px] text-invalid">All {s.trials} trials INVALID: not judged{g.rows[0]?.invalid_reason ? ` (${g.rows[0].invalid_reason})` : ''}.</p> : <StatRow s={s} />}
            <ChatChips convs={convs} multiSurface={multiSurface} />
          </article>
        );
      })}
    </div>
  );
}
