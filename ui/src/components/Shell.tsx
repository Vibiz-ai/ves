import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  IconPlayerPlay, IconListCheck, IconPackage, IconDevices, IconShieldCheck, IconCpu, IconAdjustments,
  IconPlugConnected, IconBrandGithub, IconBook, IconMessage, IconSelector, IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand, IconSearch, IconTerminal2, IconMenu2, IconX, IconArrowUpRight, IconChartLine, IconArrowsDiff, IconUsers,
} from '@tabler/icons-react';
import { useAppData, projectName } from '../lib/data.tsx';
import { navigate, type Route } from '../lib/router.ts';
import { searchItems, totalSpend, type SearchItem, normVerdict, verdictLabel } from '../lib/shape.ts';
import { shortSha, relativeTime, usd } from '../lib/format.ts';
import { runTitle } from '../lib/people.ts';
import { Button, CommandBlock, Dialog, ICON, IconButton, Kbd, cx, VerdictDot } from './ui.tsx';

type NavItem = { href: string; label: string; icon: typeof IconPlayerPlay; match: (r: Route) => boolean };

const prefix = (p: string) => (r: Route) => r.path === p || r.path.startsWith(`${p}/`);

const NAV_MAIN: NavItem[] = [
  { href: '#/runs', label: 'Runs', icon: IconPlayerPlay, match: (r) => r.path === '/' || prefix('/runs')(r) },
  { href: '#/personas', label: 'Personas', icon: IconUsers, match: prefix('/personas') },
  { href: '#/history', label: 'History', icon: IconChartLine, match: (r) => prefix('/history')(r) || prefix('/store')(r) },
  { href: '#/compare', label: 'Compare', icon: IconArrowsDiff, match: prefix('/compare') },
  { href: '#/cases', label: 'Cases', icon: IconListCheck, match: prefix('/cases') },
  { href: '#/packs', label: 'Packs', icon: IconPackage, match: prefix('/packs') },
  { href: '#/surfaces', label: 'Surfaces', icon: IconDevices, match: prefix('/surfaces') },
];
const NAV_SETTINGS: NavItem[] = [
  { href: '#/settings/gate', label: 'Gate rules', icon: IconShieldCheck, match: prefix('/settings/gate') },
  { href: '#/settings/models', label: 'Models', icon: IconCpu, match: prefix('/settings/models') },
  { href: '#/settings/config', label: 'Config', icon: IconAdjustments, match: prefix('/settings/config') },
];
const NAV_CONNECT: NavItem[] = [
  { href: '#/connect/agents', label: 'Agents', icon: IconPlugConnected, match: prefix('/connect/agents') },
  { href: '#/connect/ci', label: 'CI', icon: IconBrandGithub, match: prefix('/connect/ci') },
];
export const ALL_NAV = [...NAV_MAIN, ...NAV_SETTINGS, ...NAV_CONNECT];

function NavLink({ item, active, joined, onNavigate }: { item: NavItem; active: boolean; joined: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <li className="relative">
      <a
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'relative flex h-9 items-center gap-2.5 rounded-md px-3 text-[14px] transition-colors',
          active ? 'bg-black/[0.06] font-medium text-ink' : 'text-muted hover:bg-black/[0.04] hover:text-ink',
        )}
      >
        <Icon size={18} stroke={1.75} aria-hidden className={active ? 'text-ink' : 'text-faint'} />
        <span>{item.label}</span>
        {active && joined && <span aria-hidden className="absolute top-2 bottom-2 -left-3 w-[2px] rounded-full bg-ink" />}
      </a>
    </li>
  );
}

function NavGroup({ label, items, route, joined, onNavigate }: { label?: string; items: NavItem[]; route: Route; joined: boolean; onNavigate?: () => void }) {
  return (
    <div className="mt-6 first:mt-0">
      {label && <div className="mono-label mb-1.5 pl-3 !text-[10px]">{label}</div>}
      <ul className="flex flex-col gap-0.5">
        {items.map((it) => <NavLink key={it.href} item={it} active={it.match(route)} joined={joined} onNavigate={onNavigate} />)}
      </ul>
    </div>
  );
}

export function SidebarNav({ route, joined, onNavigate, onFeedback }: { route: Route; joined: boolean; onNavigate?: () => void; onFeedback: () => void }) {
  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="pt-2">
        <NavGroup items={NAV_MAIN} route={route} joined={joined} onNavigate={onNavigate} />
        <NavGroup label="Settings" items={NAV_SETTINGS} route={route} joined={joined} onNavigate={onNavigate} />
        <NavGroup label="Connect" items={NAV_CONNECT} route={route} joined={joined} onNavigate={onNavigate} />
      </div>
      <ul className="mt-auto flex flex-col gap-0.5 pt-8 pb-2">
        <li>
          <a href="#/docs" onClick={onNavigate} aria-current={route.path === '/docs' ? 'page' : undefined} className={cx('flex h-9 items-center gap-2.5 rounded-md px-3 text-[14px] hover:bg-black/[0.04]', route.path === '/docs' ? 'text-ink' : 'text-muted hover:text-ink')}>
            <IconBook size={18} stroke={1.75} aria-hidden />Docs
          </a>
        </li>
        <li>
          <button type="button" onClick={() => { onNavigate?.(); onFeedback(); }} className="flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] text-muted hover:bg-black/[0.04] hover:text-ink">
            <IconMessage size={18} stroke={1.75} aria-hidden />Share feedback
          </button>
        </li>
      </ul>
    </nav>
  );
}

function SpendMeter() {
  const { runs } = useAppData();
  const list = runs.data?.runs ?? [];
  const { usd: spent, cap } = totalSpend(list);
  const segments = 8;
  const filled = cap && spent !== null ? Math.min(segments, Math.round((spent / cap) * segments)) : spent && spent > 0 ? segments : 0;
  const title = cap
    ? `Sum of usage.usd_list across ${list.length} run(s) against the sum of cost caps in run.json`
    : `Sum of usage.usd_list across ${list.length} run(s). No cost cap in run.json, so the bar shows spend only.`;
  return (
    <div className="hidden h-8 items-center gap-2.5 rounded-md border border-line bg-sheet px-3 xl:flex" title={title}>
      <span className="mono-label !text-ink">Spend</span>
      <span aria-hidden className="flex gap-[3px]">
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={cx('h-3.5 w-[4px] rounded-[1px]', i < filled ? 'bg-ink' : 'bg-line-strong')} />
        ))}
      </span>
      <span className="font-mono text-[13px] tabular-nums">
        {spent === null ? '—' : usd(spent)}
        {cap !== null && <span className="text-muted"> / {usd(cap)}</span>}
      </span>
      <span className="sr-only">{title}</span>
    </div>
  );
}

export function RunEvalsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Run evals" wide>
      <p className="mb-5 text-[14px] text-muted">
        This dashboard is read-only and never starts a run. Run one of these from the harness checkout (or with <span className="font-mono text-[13px] text-ink">npx ves</span> in your repo); the new run appears here within a few seconds.
      </p>
      <div className="flex flex-col gap-4">
        <div>
          <div className="mono-label mb-2">Smoke, offline mock (no model, $0)</div>
          <CommandBlock command="npx ves run --tier smoke --connection mock --out results" />
        </div>
        <div>
          <div className="mono-label mb-2">Smoke against your agent</div>
          <CommandBlock command="npx ves run --tier smoke --out results" />
        </div>
        <div>
          <div className="mono-label mb-2">Release tier</div>
          <CommandBlock command="npx ves run --tier release --out results" />
        </div>
        <div>
          <div className="mono-label mb-2">Then view a different results dir</div>
          <CommandBlock command="node ui/server/index.mjs --results ./results --port 4317" />
        </div>
      </div>
    </Dialog>
  );
}

export function FeedbackDialog({ open, onClose, route }: { open: boolean; onClose: () => void; route: Route }) {
  const [text, setText] = useState('');
  const note = `VES UI feedback\npage: #${route.path}${route.query.toString() ? `?${route.query}` : ''}\n\n${text}`;
  return (
    <Dialog open={open} onClose={onClose} title="Share feedback">
      <p className="mb-4 text-[14px] text-muted">Nothing is sent from here. Write your note, copy it, and paste it wherever your team tracks the eval harness.</p>
      <label htmlFor="fb" className="mono-label mb-2 block">Your note</label>
      <textarea id="fb" value={text} onChange={(e) => setText(e.target.value)} rows={5} className="w-full rounded-md border border-line bg-shell p-3 text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-ink" placeholder="What was confusing or missing?" />
      <div className="mt-4"><CommandBlock command={note} label="feedback note" /></div>
    </Dialog>
  );
}

function useSearchIndex(): SearchItem[] {
  const { runs, cases } = useAppData();
  return useMemo(() => {
    const items: SearchItem[] = [];
    const people = new Map<string, string | null>();
    for (const r of runs.data?.runs ?? []) {
      const v = normVerdict(r.verdict);
      for (const p of r.personas ?? []) if (!people.get(p.id)) people.set(p.id, p.name);
      const who = (r.personas ?? []).map((p) => p.name ?? p.id).join(', ');
      items.push({ kind: 'run', id: r.id, title: `${runTitle(r)} · ${verdictLabel(v)}`, subtitle: `${r.id} · ${shortSha(r.sha)} · ${relativeTime(r.created)}${who ? ` · ${who}` : ''}`, href: `#/runs/${encodeURIComponent(r.id)}` });
    }
    for (const [id, name] of people) items.push({ kind: 'page', id: `persona:${id}`, title: name ?? id, subtitle: `Persona · ${id}`, href: `#/personas/${encodeURIComponent(id)}` });
    for (const c of cases.data?.cases ?? []) {
      items.push({ kind: 'case', id: c.id, title: c.id, subtitle: [c.suite, c.capability, c.pack].filter(Boolean).join(' · '), href: `#/cases?q=${encodeURIComponent(c.id)}` });
    }
    for (const n of ALL_NAV) items.push({ kind: 'page', id: n.href, title: n.label, subtitle: 'Page', href: n.href });
    return items;
  }, [runs.data, cases.data]);
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const index = useSearchIndex();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchItems(index, q, 14), [index, q]);
  const { runs } = useAppData();
  const verdictOf = (id: string) => normVerdict(runs.data?.runs.find((r) => r.id === id)?.verdict);
  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => setSel(0), [q]);
  const go = (it: SearchItem | undefined) => { if (!it) return; onClose(); navigate(it.href); };
  return (
    <Dialog open={open} onClose={onClose} title="Search runs and cases" wide>
      <div className="flex h-11 items-center gap-3 rounded-md border border-line bg-shell px-3.5">
        <IconSearch size={20} stroke={1.75} className="text-muted" aria-hidden />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); go(results[sel]); }
          }}
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={results[sel] ? `pal-${sel}` : undefined}
          aria-label="Search runs, cases and pages"
          placeholder="Run id, sha, tier, case id…"
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint"
        />
      </div>
      <ul id="palette-list" role="listbox" aria-label="Results" className="mt-3 max-h-[50vh] overflow-y-auto">
        {results.length === 0 && <li className="px-3 py-6 text-[14px] text-muted">Nothing matches “{q}”.</li>}
        {results.map((it, i) => (
          <li key={`${it.kind}:${it.id}`} id={`pal-${i}`} role="option" aria-selected={i === sel}>
            <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(it)} tabIndex={-1} className={cx('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left', i === sel ? 'bg-black/[0.05]' : '')}>
              <span className="mono-label w-12 shrink-0">{it.kind}</span>
              {it.kind === 'run' && <VerdictDot verdict={verdictOf(it.id)} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{it.title}</span>
                <span className="block truncate font-mono text-[12px] text-muted">{it.subtitle}</span>
              </span>
              <IconArrowUpRight size={16} stroke={1.75} className="shrink-0 text-faint" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-4 font-mono text-[11px] text-muted"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span><span><Kbd>↵</Kbd> open</span><span><Kbd>esc</Kbd> close</span></div>
    </Dialog>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { runs } = useAppData();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('ves.sidebar') === 'collapsed'; } catch { return false; } });
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [runDlg, setRunDlg] = useState(false);
  const [feedback, setFeedback] = useState(false);

  useEffect(() => { try { localStorage.setItem('ves.sidebar', collapsed ? 'collapsed' : 'open'); } catch { /* private mode */ } }, [collapsed]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  useEffect(() => setDrawer(false), [route.path]);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const name = projectName(runs.data);

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-xl focus:bg-ink focus:px-4 focus:py-2 focus:text-white">Skip to content</a>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-sheet/90 px-3 backdrop-blur sm:gap-3 min-[900px]:px-4">
        <IconButton label="Open navigation" className="min-[900px]:hidden" onClick={() => setDrawer(true)}><IconMenu2 {...ICON} /></IconButton>
        <a href="#/runs" aria-label="VES home" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-ink text-white">
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden><path d="M9 10l7 12 7-12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </a>
        <svg aria-hidden viewBox="0 0 24 24" className="size-5 text-line-strong"><path d="M16.88 3.55 7.12 20.45" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
        <button type="button" className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 sm:px-2 text-[14px] font-medium hover:bg-black/5" aria-label={`Project: ${name}. Only one project is available locally.`} title="Project (from run.json target.repo, else local)">
          <span className="max-w-[7rem] min-w-[2.5rem] truncate sm:max-w-[12rem]">{name}</span>
          <IconSelector size={16} stroke={1.75} className="shrink-0 text-muted" aria-hidden />
        </button>
        <div className="hidden min-[900px]:block">
          <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed((c) => !c)} aria-pressed={collapsed}>
            {collapsed ? <IconLayoutSidebarLeftExpand {...ICON} /> : <IconLayoutSidebarLeftCollapse {...ICON} />}
          </IconButton>
        </div>

        <div className="flex min-w-0 flex-1 justify-center px-1 sm:px-4">
          <button type="button" onClick={() => setPalette(true)} className="hidden h-8 w-full max-w-[420px] items-center gap-2.5 rounded-md border border-line bg-shell px-3 text-left text-[13px] text-muted transition-colors hover:border-line-strong hover:text-ink md:flex" aria-label="Search runs and cases" aria-keyshortcuts="Meta+K Control+K">
            <IconSearch size={16} stroke={1.75} aria-hidden />
            <span className="flex-1 truncate">Search runs and cases</span>
            <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
          </button>
        </div>
        <IconButton label="Search runs and cases" className="size-8 rounded-md border border-line md:hidden" onClick={() => setPalette(true)}><IconSearch {...ICON} /></IconButton>

        <SpendMeter />
        <div className="hidden sm:block">
          <Button variant="primary" size="sm" onClick={() => setRunDlg(true)}>
            <IconTerminal2 size={16} stroke={1.75} aria-hidden />Run evals
          </Button>
        </div>
        <IconButton label="Run evals" className="size-8 rounded-md border border-line sm:hidden" onClick={() => setRunDlg(true)}><IconTerminal2 {...ICON} /></IconButton>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-shell text-[12px] font-semibold text-ink" title="Local user" aria-label="Local user">L</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {!collapsed && (
          <aside className="hidden w-[232px] shrink-0 border-r border-line bg-sheet px-3 pt-4 min-[900px]:block">
            <div className="sticky top-[72px] h-[calc(100dvh-88px)]">
              <SidebarNav route={route} joined onFeedback={() => setFeedback(true)} />
            </div>
          </aside>
        )}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 bg-shell px-4 py-7 outline-none sm:px-8 sm:py-10 min-[900px]:px-10">
          <div className="mx-auto max-w-[1280px]">{children}</div>
        </main>
      </div>

      {drawer && (
        <div className="fixed inset-0 z-40 min-[900px]:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-line bg-sheet p-3">
            <div className="mb-4 flex items-center justify-between pl-2">
              <span className="text-[14px] font-medium">{name}</span>
              <IconButton label="Close navigation" onClick={() => setDrawer(false)} autoFocus><IconX {...ICON} /></IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SidebarNav route={route} joined={false} onNavigate={() => setDrawer(false)} onFeedback={() => setFeedback(true)} />
            </div>
          </div>
        </div>
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <RunEvalsDialog open={runDlg} onClose={() => setRunDlg(false)} />
      <FeedbackDialog open={feedback} onClose={() => setFeedback(false)} route={route} />
      <ShellEvents onRun={() => setRunDlg(true)} />
    </div>
  );
}

/** Lets pages open the run dialog without prop drilling: window.dispatchEvent(new Event('ves:run')). */
function ShellEvents({ onRun }: { onRun: () => void }) {
  useEffect(() => {
    const on = () => onRun();
    window.addEventListener('ves:run', on);
    return () => window.removeEventListener('ves:run', on);
  }, [onRun]);
  return null;
}

export const openRunDialog = () => window.dispatchEvent(new Event('ves:run'));
