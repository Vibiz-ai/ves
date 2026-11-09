// Personas: a gallery of the simulated people (library + every run they appear in), and one page per person with
// every conversation they had, newest first. Outcomes are advisory judge reads, never part of a verdict.
import { useState } from 'react';
import { IconArrowLeft, IconChevronRight, IconUsers } from '@tabler/icons-react';
import { DASH, niceTime } from '../lib/format.ts';
import { agentName, chatTone, firstName, personaAccent, personaRole, type PersonProfile } from '../lib/people.ts';
import { href } from '../lib/router.ts';
import { Avatar, PersonCard, StatRow, TempChips, toneDot, toneWord, usePeople } from '../components/People.tsx';
import { EmptyState, ErrorState, ICON, PageHeader, Section, Skeleton, cx } from '../components/ui.tsx';

export function PersonasPage() {
  const { people, data, error, loading, reload } = usePeople();
  const chats = data?.conversations.length ?? 0;
  return (
    <>
      <PageHeader title="Personas" sub={<>Simulated people who chatted with the agent. <span className="text-ink">Click a person to read their chats</span>, or a chat chip to jump straight into one.</>} />
      {loading && !data && <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[420px] w-full" />)}</div>}
      {error && !data && <ErrorState title="Could not load personas" error={error.message} onRetry={reload} />}
      {data && people.length === 0 && (
        <EmptyState icon={<IconUsers {...ICON} />} title="No personas yet" body={<>Persona cases put an AI-simulated person in a multi-turn chat with the agent. Add <span className="font-mono text-[13px] text-ink">*.persona.json</span> files under a pack's <span className="font-mono text-[13px] text-ink">personas/</span> folder and run the persona suite.</>} />
      )}
      {people.length > 0 && (
        <>
          <p className="mb-4 font-mono text-[12px] text-muted">{people.length} people · {chats} conversation{chats === 1 ? '' : 's'} · {data?.runs.length ?? 0} run{data?.runs.length === 1 ? '' : 's'}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {people.map((p) => <PersonCard key={p.id} p={p} />)}
          </div>
        </>
      )}
    </>
  );
}

const of3 = (x: number | null) => (x === null ? DASH : `${Number.isInteger(x) ? x : x.toFixed(2)}/3`);

/** Scores per run when the person appears in 2+ runs. */
function RunComparison({ p }: { p: PersonProfile }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
      <table className="w-full min-w-[640px] border-collapse text-[14px]">
        <thead>
          <tr className="bg-tile text-left">
            {['Run', 'Agent model', 'Chats', 'Goal met', 'Frustration', 'Tone fit', 'Gave up', 'INVALID'].map((h) => <th key={h} scope="col" className="px-4 py-2.5 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {p.runs.map((r) => (
            <tr key={r.run_id} className="border-t border-line">
              <th scope="row" className="px-4 py-2.5 text-left font-normal">
                <a href={href.run(r.run_id)} className="hover:underline hover:underline-offset-2"><span className="text-[14px]">{niceTime(r.created)}</span></a>
                <div className="font-mono text-[11px] text-faint">{r.run_id.replace(/^ves-/, '')}</div>
              </th>
              <td className="px-4 py-2.5 font-mono text-[13px]">{r.agent_model ?? DASH}</td>
              <td className="px-4 py-2.5 font-mono tabular-nums">{r.stats.trials}</td>
              <td className={cx('px-4 py-2.5 font-mono tabular-nums', r.stats.judged && r.stats.yes === r.stats.judged ? 'text-pass' : r.stats.no ? 'text-block' : '')}>{r.stats.judged ? `${r.stats.yes}/${r.stats.judged}` : DASH}</td>
              <td className="px-4 py-2.5 font-mono tabular-nums">{of3(r.stats.meanFrustration)}</td>
              <td className="px-4 py-2.5 font-mono tabular-nums">{of3(r.stats.meanToneFit)}</td>
              <td className="px-4 py-2.5 font-mono tabular-nums">{r.stats.judged ? r.stats.gaveUp : DASH}</td>
              <td className={cx('px-4 py-2.5 font-mono tabular-nums', r.stats.invalid ? 'text-invalid' : 'text-muted')}>{r.stats.invalid}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PersonPage({ id }: { id: string }) {
  const { people, data, error, reload } = usePeople();
  const [bgOpen, setBgOpen] = useState(false);
  const back = <a href={href.personas()} className="mb-6 inline-flex items-center gap-2 rounded-full text-[14px] text-muted hover:text-ink"><IconArrowLeft size={18} stroke={1.75} aria-hidden />Personas</a>;
  if (error && !data) return <>{back}<ErrorState title="Could not load personas" error={error.message} onRetry={reload} /></>;
  if (!data) return <>{back}<Skeleton className="h-40 w-full" /><Skeleton className="mt-6 h-80 w-full" /></>;
  const p = people.find((x) => x.id === id);
  if (!p) return <>{back}<ErrorState title={`No persona ${id}`} error="Not in the persona library and in no run of this results directory." hint={<a href={href.personas()} className="underline">See all personas</a>} /></>;
  const a = personaAccent(p.id);
  const role = personaRole(p.name);
  const who = firstName(p.name);
  return (
    <>
      {back}
      <header className="overflow-hidden rounded-lg border border-line bg-sheet shadow-card">
        <span aria-hidden className="block h-1.5" style={{ background: a.fg }} />
        <div className="flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <Avatar id={p.id} name={p.name} size={64} />
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-[30px] leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[36px]">{who}</h1>
              {role && <p className="mt-1 text-[15px] text-muted">{role}</p>}
              <div className="mt-3"><TempChips items={p.temperament} langs={p.languages} /></div>
              {p.background && (
                <p className={cx('mt-3 max-w-[70ch] text-[14px] leading-relaxed text-ink', !bgOpen && 'line-clamp-2')}>{p.background}</p>
              )}
              {p.background && p.background.length > 160 && <button type="button" onClick={() => setBgOpen((o) => !o)} className="mt-1 font-mono text-[12px] text-muted underline underline-offset-2 hover:text-ink">{bgOpen ? 'less' : 'more'}</button>}
              <p className="mt-3 font-mono text-[11px] text-faint">{p.id}{p.file ? ` · ${p.file}` : ' · not in the library'}</p>
            </div>
          </div>
          <div className="flex w-full flex-col gap-3 lg:w-[380px]">
            {p.goal && (
              <div className="rounded-md px-4 py-3" style={{ background: a.soft }}>
                <div className="font-mono text-[10px] tracking-[0.08em] uppercase" style={{ color: a.fg }}>Goal</div>
                <p className="mt-1 text-[14px] leading-snug">{p.goal}</p>
              </div>
            )}
            {p.latest && <div><div className="mb-1.5 font-mono text-[10px] tracking-[0.08em] text-muted uppercase">Latest run · {niceTime(p.latest.created, { year: false })}</div><StatRow s={p.latest.stats} /></div>}
          </div>
        </div>
      </header>

      {p.runs.length >= 2 && (
        <Section title="Run by run" label={`${who} across ${p.runs.length} runs`} id="cmp-h">
          <RunComparison p={p} />
        </Section>
      )}

      <Section title="Conversations" label={`${p.conversations.length} chat${p.conversations.length === 1 ? '' : 's'} · newest first`} id="convs-h">
        {p.conversations.length === 0 ? <p className="rounded-lg bg-tile px-5 py-6 text-[14px] text-muted">{who} has not chatted with the agent in these results yet.</p> : (
          <div className="flex flex-col gap-6">
            {p.runs.map((r) => (
              <div key={r.run_id}>
                <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
                  <span className="text-[14px] font-medium">{niceTime(r.created)}</span>
                  {r.agent_model && <span className="font-mono text-[12px] text-muted">{r.agent_model}</span>}
                  <a href={href.run(r.run_id)} className="font-mono text-[11px] text-faint hover:text-ink hover:underline">run {r.run_id.replace(/^ves-/, '')}</a>
                  {r.stats.invalid > 0 && <span className="font-mono text-[11px] text-invalid">{r.stats.invalid} INVALID (not judged)</span>}
                </div>
                <ul className="flex flex-col gap-2">
                  {r.convs.map((c) => {
                    const tone = chatTone(c);
                    const turns = c.persona?.user_turns ?? c.persona?.metrics?.user_turns ?? (c.preview.user_messages || null);
                    return (
                      <li key={c.row_id}>
                        <a href={href.chat(c.run_id, c.row_id)} className="group flex flex-col gap-3 rounded-lg border border-line bg-sheet p-4 shadow-card transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-card-hover sm:flex-row sm:items-center sm:gap-5">
                          <div className="flex shrink-0 flex-row flex-wrap items-center gap-x-3 gap-y-1 sm:w-[150px] sm:flex-col sm:items-start">
                            <span className="flex items-center gap-2 whitespace-nowrap">
                              <span aria-hidden className={cx('size-2.5 rounded-full', toneDot(tone))} />
                              <span className="text-[15px] font-semibold">Chat {typeof c.trial === 'number' ? c.trial + 1 : ''}</span>
                            </span>
                            <span className={cx('font-mono text-[11px] tracking-[0.06em] whitespace-nowrap uppercase', tone === 'good' ? 'text-pass' : tone === 'bad' ? 'text-block' : tone === 'mixed' || tone === 'invalid' ? 'text-invalid' : 'text-muted')}>{toneWord(tone)}</span>
                            <span className="font-mono text-[11px] text-muted">{[c.surface, turns ? `${turns} message${turns === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')}</span>
                          </div>
                          <div className="min-w-0 flex-1 text-[13px] leading-snug">
                            {c.preview.user ? (
                              <>
                                <p className="line-clamp-2"><span className="font-semibold" style={{ color: a.fg }}>{who}:</span> {c.preview.user}</p>
                                {c.preview.agent && <p className="mt-1 line-clamp-2 text-muted"><span className="font-semibold text-ink">{agentName(c.surface)}:</span> {c.preview.agent}</p>}
                              </>
                            ) : <p className="text-muted">{c.status === 'invalid' ? `INVALID${c.invalid_reason ? ` (${c.invalid_reason})` : ''}: no conversation was recorded.` : 'No transcript recorded.'}</p>}
                            {c.persona?.outcome?.why && <p className="mt-2 line-clamp-2 text-[12px] text-muted"><span className="font-mono text-[10px] tracking-[0.08em] uppercase">Judge · </span>{c.persona.outcome.why}</p>}
                          </div>
                          <span className="inline-flex shrink-0 items-center gap-1 self-end text-[13px] font-medium text-ink group-hover:underline group-hover:underline-offset-4 sm:self-center">Open chat<IconChevronRight size={16} stroke={2} aria-hidden className="transition-transform group-hover:translate-x-0.5" /></span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
