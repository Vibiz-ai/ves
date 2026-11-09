// Persona cases in the dashboard: who the simulated person was and how the conversation ended (trial view), and the
// by-persona table (persona × variant on a run, persona × run on compare). The outcome is an advisory judge read:
// shown in neutral tones next to the verdict, never as a gating failure.
import { useState, type ReactNode } from 'react';
import { IconUserCircle } from '@tabler/icons-react';
import { DASH, pct, show } from '../lib/format.ts';
import { goalMet, personaOf, personaOutcomeScore, personaLabel, userTurns, type PersonaCell, type PersonaTable } from '../lib/persona.ts';
import type { ResultRow } from '../lib/types.ts';
import { Badge, cx } from './ui.tsx';
import { Avatar, ChatChip, toneWord } from './People.tsx';
import { firstName } from '../lib/people.ts';
import { href } from '../lib/router.ts';

const STOP_TONE: Record<string, 'pass' | 'block' | 'invalid' | 'neutral'> = { goal_met: 'pass', gave_up: 'block', max_turns: 'invalid', other: 'neutral' };
const GOAL_STYLE: Record<string, string> = { yes: 'text-pass', partly: 'text-invalid', no: 'text-block', unknown: 'text-muted' };
const BG_LIMIT = 220;

const n1 = (x: number | null | undefined, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : x.toFixed(d)) : DASH);
const of3 = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? `${n1(x)}/3` : DASH);
const yesNo = (x: boolean | null | undefined) => (x === true ? 'yes' : x === false ? 'no' : DASH);

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div className={cx('min-w-0', wide && 'col-span-2 sm:col-span-4')}><dt className="mono-label">{label}</dt><dd className="mt-0.5 font-mono text-[13px] break-words">{children}</dd></div>;
}

function Background({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > BG_LIMIT;
  return (
    <p className="text-[14px] leading-relaxed text-ink">
      {long && !open ? `${text.slice(0, BG_LIMIT - 1).trimEnd()}…` : text}
      {long && <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="ml-2 font-mono text-[12px] text-muted underline underline-offset-2 hover:text-ink">{open ? 'less' : 'more'}</button>}
    </p>
  );
}

/** Who the simulated person is, why the conversation stopped, the advisory outcome and the deterministic metrics. */
export function PersonaCard({ row }: { row: ResultRow }) {
  const p = personaOf(row);
  if (!p) return null;
  const score = personaOutcomeScore(row);
  const o = p.outcome;
  const goal = goalMet(row);
  const m = p.metrics ?? {};
  const stopKind = p.stop?.kind ?? null;
  const perTurn = Array.isArray(m.reply_chars_per_turn) ? m.reply_chars_per_turn : [];
  const why = o?.why || score?.explanation;
  const judge = o?.judge?.model ?? score?.judge?.model;
  return (
    <section aria-labelledby="persona-h" className="mt-5 rounded-lg border border-line bg-sheet shadow-card">
      <div className="rounded-lg bg-sheet p-4 sm:p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-tile text-ink"><IconUserCircle size={20} stroke={1.75} /></span>
          <div className="min-w-0 flex-1">
            <div className="mono-label">Persona · simulated user</div>
            <h2 id="persona-h" className="text-[18px] leading-tight font-semibold tracking-[-0.01em] break-words">{personaLabel(p)}</h2>
            {(p.name && p.id) || p.ref ? <p className="mt-0.5 font-mono text-[12px] text-muted">{[p.name && p.id ? p.id : null, p.ref ? `ref ${p.ref}` : null].filter(Boolean).join(' · ')}</p> : null}
          </div>
          {(p.temperament ?? []).length > 0 && <div className="flex flex-wrap gap-1.5">{p.temperament!.map((t) => <Badge key={t}>{t.replace(/_/g, ' ')}</Badge>)}</div>}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
          <Fact label="Goal" wide><span className="font-sans text-[14px]">{show(p.goal)}</span></Fact>
          <Fact label="Languages">{p.languages?.length ? p.languages.join(', ') : DASH}</Fact>
          <Fact label="Simulator">{show(p.simulator?.model)}</Fact>
          <Fact label="User turns">{show(userTurns(p))} of {show(p.max_user_turns)}</Fact>
          <Fact label="Stop">
            <span className="flex flex-wrap items-center gap-1.5">
              {stopKind ? <Badge tone={STOP_TONE[stopKind] ?? 'neutral'}>{String(stopKind).replace(/_/g, ' ')}</Badge> : DASH}
              {typeof p.stop?.at_turn === 'number' && <span className="text-muted">at turn {p.stop.at_turn}{typeof p.max_user_turns === 'number' ? ` of ${p.max_user_turns}` : ''}</span>}
            </span>
          </Fact>
          {p.stop?.reason && <Fact label="Stop reason" wide><span className="font-sans text-[14px]">{p.stop.reason}</span></Fact>}
        </dl>
        {p.background && <div className="mt-3"><div className="mono-label mb-0.5">Background</div><Background text={p.background} /></div>}

        <div className="mt-4 rounded-lg bg-tile p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono-label !text-ink">Outcome</span>
            <Badge title="persona_outcome is advisory: it never decides the verdict">advisory</Badge>
            {judge && <span className="font-mono text-[11px] text-muted">judge {judge}</span>}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
            <Fact label="Goal met"><span className={cx('font-semibold uppercase', GOAL_STYLE[goal])}>{goal}</span></Fact>
            <Fact label="Gave up">{yesNo(o?.gave_up)}</Fact>
            <Fact label="Frustration">{of3(o?.frustration)}</Fact>
            <Fact label="Tone fit">{of3(o?.tone_fit)}</Fact>
          </dl>
          {why && <p className="mt-3 text-[14px] break-words">{why}</p>}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
          <Fact label="Turns to goal">{show(m.turns_to_goal)}</Fact>
          <Fact label="Mean reply chars">{n1(m.mean_reply_chars, 0)}</Fact>
          <Fact label="Language match">{yesNo(m.language_match)}{m.language_match === null ? <span className="text-faint"> (not checked)</span> : null}</Fact>
          <Fact label="Reply chars / turn">{perTurn.length ? perTurn.join(' · ') : DASH}</Fact>
        </dl>
      </div>
    </section>
  );
}

function GoalCell({ c }: { c: PersonaCell }) {
  return (
    <span title={`yes ${c.yes} · partly ${c.partly} · no ${c.no} · unknown ${c.unknown}`}>
      <span className="text-ink">{pct(c.goalShare, 0)}</span>
      <span className="ml-2 text-[12px] text-muted"><span className="text-pass">{c.yes}</span>/<span className="text-invalid">{c.partly}</span>/<span className={c.no ? 'text-block' : ''}>{c.no}</span>{c.unknown ? ` ·${c.unknown}?` : ''}</span>
    </span>
  );
}

/** Persona × column table. `columnLabel` names the column dimension (Variant, Run). */
export function PersonaTableView({ table, columnLabel, columnTitle, chatHref }: { table: PersonaTable; columnLabel: string; columnTitle?: (c: string) => string; chatHref?: (row: { row_id: string; run_id?: string }, col: string) => string }) {
  if (!table.rows.length) return null;
  const heads = [columnLabel, 'Trials', 'Goal met (yes / partly / no)', 'Mean user turns', 'Mean frustration', 'Mean tone fit', ...(chatHref ? ['Chats'] : [])];
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[760px] border-collapse text-[14px]">
        <thead>
          <tr className="bg-tile text-left">
            <th scope="col" className="px-4 py-3 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">Persona</th>
            {heads.map((h) => <th key={h} scope="col" className="px-4 py-3 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => {
            const cols = table.columns.filter((c) => r.cells[c]);
            return cols.map((col, i) => {
              const c = r.cells[col];
              return (
                <tr key={`${r.key}|${col}`} className={cx('border-line', i === 0 ? 'border-t' : 'border-t border-dashed')}>
                  {i === 0 && (
                    <th scope="row" rowSpan={cols.length} className="max-w-[260px] px-4 py-3 text-left align-top">
                      <a href={href.person(r.key)} className="group flex items-center gap-2.5" title={`${r.label}: open their profile and chats`}>
                        <Avatar id={r.key} name={r.label} size={28} />
                        <span className="min-w-0"><span className="block truncate text-[14px] font-medium group-hover:underline group-hover:underline-offset-4">{firstName(r.label)}</span>{r.label !== r.key && <span className="block truncate font-mono text-[11px] font-normal text-muted">{r.key}</span>}</span>
                      </a>
                    </th>
                  )}
                  <td className="px-4 py-3 font-mono text-[13px] break-all" title={columnTitle?.(col) ?? col}>{columnTitle?.(col) ?? col}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{c.trials}</td>
                  <td className="px-4 py-3 font-mono tabular-nums"><GoalCell c={c} /></td>
                  <td className="px-4 py-3 font-mono tabular-nums">{n1(c.meanUserTurns)}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{c.meanFrustration === null ? DASH : `${n1(c.meanFrustration, 2)}/3`}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{c.meanToneFit === null ? DASH : `${n1(c.meanToneFit, 2)}/3`}</td>
                  {chatHref && (
                    <td className="px-4 py-3">
                      <span className="flex gap-1">
                        {c.rows.map((t, j) => {
                          const tone = t.status === 'invalid' ? 'invalid' : t.status === 'skip' ? 'skip' : t.goal === 'no' || t.status === 'fail' ? 'bad' : t.goal === 'partly' ? 'mixed' : t.goal === 'yes' || t.status === 'pass' ? 'good' : 'unknown';
                          return <ChatChip key={t.row_id} to={chatHref(t, col)} tone={tone} label={`${typeof t.trial === 'number' ? t.trial + 1 : j + 1}`} title={`Open chat ${typeof t.trial === 'number' ? t.trial + 1 : j + 1}: ${toneWord(tone)}`} />;
                        })}
                      </span>
                    </td>
                  )}
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}
