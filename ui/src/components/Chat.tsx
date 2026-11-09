// The Chat tab of a trial: the trajectory drawn as a messaging thread. The person (persona or scripted user) on the
// left with their avatar and accent colour, the agent on the right; tool runs folded into one line between messages;
// approvals as system pills; the persona outcome as the verdict of the conversation at the end.
import { useState, type ReactNode } from 'react';
import { IconCheck, IconChevronDown, IconChevronRight, IconHandStop, IconRobot, IconTool, IconUser, IconX } from '@tabler/icons-react';
import { DASH } from '../lib/format.ts';
import { firstName, goalOf, personaAccent, personaRole, type ChatItem } from '../lib/people.ts';
import { personaOf, personaOutcomeScore, userTurns } from '../lib/persona.ts';
import type { ResultRow } from '../lib/types.ts';
import { Avatar, TempChips } from './People.tsx';
import { cx } from './ui.tsx';

/** Message text with paragraphs (blank lines) as small gaps and single line breaks kept. */
function Text({ text }: { text: string }) {
  const paras = text.trim().split(/\n\s*\n/);
  return <>{paras.map((t, i) => <p key={i} className={cx('whitespace-pre-wrap', i > 0 && 'mt-2')}>{t}</p>)}</>;
}

function ToolLine({ item, onTool }: { item: Extract<ChatItem, { kind: 'tools' }>; onTool: (stepIndex: number) => void }) {
  const [open, setOpen] = useState(false);
  const head = item.names.slice(0, 3).join(', ');
  const more = item.names.length > 3 ? `, +${item.names.length - 3}` : '';
  return (
    <li className="flex flex-col items-end">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-shell px-2.5 py-1 font-mono text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-ink">
        <IconTool size={13} stroke={1.75} aria-hidden className="shrink-0" />
        <span className="shrink-0 text-ink">{item.count} tool{item.count === 1 ? '' : 's'}</span>
        <span className="truncate">{head}{more}</span>
        <IconChevronDown size={13} stroke={1.75} aria-hidden className={cx('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-1.5 flex max-w-[92%] flex-wrap justify-end gap-1">
          {item.calls.map((c, i) => (
            <button key={i} type="button" onClick={() => onTool(c.stepIndex)} title={`${c.name}${c.source ? ` (${c.source})` : ''}${c.duplicate ? ', reported by the host for a call already counted' : ''}: open in Transcript`}
              className={cx('inline-flex h-6 items-center gap-1 rounded-md border px-2 font-mono text-[11px] transition-colors hover:border-ink hover:text-ink', c.duplicate ? 'border-dashed border-line text-faint' : 'border-line bg-sheet text-ink')}>
              {c.display}{c.source === 'host-reported' && <span className="text-faint">·rep</span>}
              <IconChevronRight size={11} stroke={2} aria-hidden className="text-faint" />
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

function Pill({ item }: { item: Extract<ChatItem, { kind: 'approval' }> }) {
  const tone = item.decision === 'approve' ? 'border-[#b9dcc4] bg-[#eef7f1] text-pass' : item.decision === 'reject' ? 'border-[#f0c0c0] bg-[#fdf0f0] text-block' : 'border-[#ecd3a6] bg-[#fdf5e6] text-invalid';
  const Icon = item.decision === 'approve' ? IconCheck : item.decision === 'reject' ? IconX : IconHandStop;
  return (
    <li className="flex justify-center">
      <span className={cx('inline-flex max-w-[90%] items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px]', tone)}>
        <Icon size={14} stroke={2} aria-hidden className="shrink-0" />
        <span className="font-medium">{item.label}</span>
        {item.detail && <span className="truncate opacity-80">· {item.detail}</span>}
      </span>
    </li>
  );
}

/** The thread. `personId` colours the person's side; without one (scripted user) it stays neutral. */
export function ChatThread({ items, personId, personName, agentLabel, onTool }: { items: ChatItem[]; personId: string | null; personName: string; agentLabel: string; onTool: (stepIndex: number) => void }) {
  const a = personId ? personaAccent(personId) : null;
  let prev: ChatItem['kind'] | null = null;
  return (
    <ol className="flex flex-col gap-2.5" aria-label="Conversation">
      {items.map((it, i) => {
        const showWho = it.kind !== prev && (it.kind === 'user' || it.kind === 'agent');
        if (it.kind === 'user' || it.kind === 'agent') prev = it.kind;
        if (it.kind === 'tools') return <ToolLine key={i} item={it} onTool={onTool} />;
        if (it.kind === 'approval') return <Pill key={i} item={it} />;
        if (it.kind === 'system') return <li key={i} className="flex justify-center"><span className="max-w-[90%] rounded-md bg-tile px-3 py-1.5 text-center text-[12px] whitespace-pre-wrap text-muted">{it.text}</span></li>;
        if (it.kind === 'user') {
          return (
            <li key={i} id={`chat-${it.stepIndex}`} className={cx('flex items-end gap-2.5 pr-6 sm:pr-16', showWho && 'mt-2')}>
              <span className="w-8 shrink-0">{showWho && (personId ? <Avatar id={personId} name={personName} size={32} /> : <span className="flex size-8 items-center justify-center rounded-full bg-ink text-white"><IconUser size={16} stroke={1.75} /></span>)}</span>
              <div className="min-w-0">
                {showWho && <div className="mb-1 ml-1 flex items-center gap-2 text-[12px]"><span className="font-semibold" style={a ? { color: a.fg } : undefined}>{personName}</span>{it.turn !== null && <span className="font-mono text-[10.5px] text-faint">turn {it.turn}{it.source === 'opening' ? ' · opening' : ''}</span>}</div>}
                <div className="rounded-2xl rounded-bl-md border px-3.5 py-2.5 text-[14.5px] leading-relaxed break-words text-ink"
                  style={a ? { background: a.soft, borderColor: a.line } : { background: 'var(--color-tile)', borderColor: 'var(--color-line)' }}>
                  <Text text={it.text} />
                </div>
              </div>
            </li>
          );
        }
        return (
          <li key={i} id={`chat-${it.stepIndex}`} className={cx('flex flex-row-reverse items-end gap-2.5 pl-6 sm:pl-16', showWho && 'mt-2')}>
            <span className="w-8 shrink-0">{showWho && <span className="flex size-8 items-center justify-center rounded-full bg-ink text-white"><IconRobot size={17} stroke={1.75} /></span>}</span>
            <div className="flex min-w-0 flex-col items-end">
              {showWho && <div className="mr-1 mb-1 text-[12px] font-semibold text-ink">{agentLabel}</div>}
              <div className="rounded-2xl rounded-br-md border border-line bg-sheet px-3.5 py-2.5 text-[14.5px] leading-relaxed break-words text-ink shadow-card"><Text text={it.text} /></div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const of3 = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? `${x}/3` : DASH);
const GOAL_CLS: Record<string, string> = { yes: 'text-pass', partly: 'text-invalid', no: 'text-block', unknown: 'text-muted' };
const GOAL_WORD: Record<string, string> = { yes: 'Goal met', partly: 'Goal partly met', no: 'Goal not met', unknown: 'Not judged' };

/** How the conversation ended: the persona_outcome judge read, shown as the conversation's verdict. */
export function ChatVerdict({ row }: { row: ResultRow }) {
  const p = personaOf(row);
  if (!p) return null;
  const a = personaAccent(p.id ?? p.ref ?? '');
  const o = p.outcome;
  const goal = goalOf(p);
  const why = o?.why || personaOutcomeScore(row)?.explanation;
  const stop = p.stop?.kind ? String(p.stop.kind).replace(/_/g, ' ') : null;
  const cells: [string, ReactNode][] = [
    ['Frustration', of3(o?.frustration)],
    ['Tone fit', of3(o?.tone_fit)],
    ['Gave up', o?.gave_up === true ? 'yes' : o?.gave_up === false ? 'no' : DASH],
    ['Messages', `${userTurns(p) ?? DASH}${typeof p.max_user_turns === 'number' ? ` of ${p.max_user_turns}` : ''}`],
  ];
  return (
    <section aria-label="How the conversation ended" className="mt-6 overflow-hidden rounded-lg border bg-sheet shadow-card" style={{ borderColor: a.line }}>
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="mono-label">How it ended</span>
          {stop && <span className="font-mono text-[11px] text-muted">stopped: {stop}{typeof p.stop?.at_turn === 'number' ? ` at turn ${p.stop.at_turn}` : ''}</span>}
          <span className="ml-auto font-mono text-[10.5px] text-faint" title="persona_outcome is advisory: it never decides the verdict">advisory judge{o?.judge?.model ? ` · ${o.judge.model}` : ''}</span>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className={cx('font-display text-[26px] leading-none font-semibold tracking-[-0.02em] sm:w-[220px]', GOAL_CLS[goal])}>{GOAL_WORD[goal]}</div>
          <dl className="grid flex-1 grid-cols-4 gap-3">
            {cells.map(([k, v]) => <div key={k}><dt className="font-mono text-[10px] tracking-[0.08em] text-muted uppercase">{k}</dt><dd className="mt-0.5 font-mono text-[15px] tabular-nums">{v}</dd></div>)}
          </dl>
        </div>
        {why && <p className="rounded-md px-3.5 py-2.5 text-[14px] leading-relaxed" style={{ background: a.soft }}>{why}</p>}
        {p.stop?.reason && p.stop.reason !== why && <p className="text-[13px] text-muted"><span className="font-mono text-[10.5px] tracking-[0.08em] uppercase">Simulator stop reason · </span>{p.stop.reason}</p>}
      </div>
    </section>
  );
}

/** Compact persona card beside the chat: who they are, the goal, background on demand. */
export function PersonaSide({ row, profileHref, nav }: { row: ResultRow; profileHref: string; nav?: ReactNode }) {
  const p = personaOf(row);
  const [bg, setBg] = useState(false);
  if (!p) return null;
  const id = p.id ?? p.ref ?? '';
  const a = personaAccent(id);
  const role = personaRole(p.name);
  return (
    <aside className="overflow-hidden rounded-lg border border-line bg-sheet shadow-card">
      <span aria-hidden className="block h-1" style={{ background: a.fg }} />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <Avatar id={id} name={p.name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] leading-tight font-semibold">{firstName(p.name) || id}</div>
            {role && <div className="mt-0.5 text-[12.5px] leading-snug text-muted">{role}</div>}
          </div>
        </div>
        <TempChips items={p.temperament ?? []} langs={p.languages} />
        {p.goal && (
          <div className="rounded-md px-3 py-2" style={{ background: a.soft }}>
            <div className="font-mono text-[10px] tracking-[0.08em] uppercase" style={{ color: a.fg }}>Goal</div>
            <p className="mt-0.5 text-[13px] leading-snug">{p.goal}</p>
          </div>
        )}
        {p.background && (
          <div>
            <button type="button" onClick={() => setBg((o) => !o)} aria-expanded={bg} className="inline-flex items-center gap-1 font-mono text-[10.5px] tracking-[0.08em] text-muted uppercase hover:text-ink">
              <IconChevronRight size={12} stroke={2} aria-hidden className={cx('transition-transform', bg && 'rotate-90')} />Background
            </button>
            {bg && <p className="mt-1 text-[13px] leading-snug text-ink">{p.background}</p>}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-2 border-t border-line pt-3">
          <div><dt className="font-mono text-[10px] tracking-[0.08em] text-muted uppercase">Simulator</dt><dd className="truncate font-mono text-[12px]" title={p.simulator?.model}>{p.simulator?.model ?? DASH}</dd></div>
          <div><dt className="font-mono text-[10px] tracking-[0.08em] text-muted uppercase">Messages</dt><dd className="font-mono text-[12px]">{userTurns(p) ?? DASH}{typeof p.max_user_turns === 'number' ? ` of ${p.max_user_turns}` : ''}</dd></div>
        </dl>
        {nav}
        <a href={profileHref} className="inline-flex items-center gap-1 text-[13px] font-medium text-ink hover:underline hover:underline-offset-4">All of {firstName(p.name) || id}'s chats<IconChevronRight size={14} stroke={2} aria-hidden /></a>
      </div>
    </aside>
  );
}
