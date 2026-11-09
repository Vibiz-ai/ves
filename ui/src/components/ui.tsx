import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { IconCheck, IconCopy, IconX, IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { Verdict, TrialStatus } from '../lib/types.ts';
import { verdictLabel } from '../lib/shape.ts';

export const ICON = { size: 20, stroke: 1.75 } as const;

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'md' | 'sm' };

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50',
        size === 'md' ? 'h-9 px-3.5 text-[14px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'rounded-md bg-primary text-white hover:bg-primary-hover',
        variant === 'secondary' && 'rounded-md bg-sheet text-ink shadow-[0_0_0_1px_var(--color-line)] hover:bg-shell',
        variant === 'ghost' && 'rounded-md text-ink hover:bg-black/5',
        className,
      )}
    />
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={cx('inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink transition-colors hover:bg-black/5', className)}>
      {children}
    </button>
  );
}

export const VERDICT_COLOR: Record<Verdict, string> = {
  PASS: 'text-pass',
  BLOCK: 'text-block',
  INVALID: 'text-invalid',
  REPORT_ONLY: 'text-report',
};
export const VERDICT_BG: Record<Verdict, string> = {
  PASS: 'bg-pass',
  BLOCK: 'bg-block',
  INVALID: 'bg-invalid',
  REPORT_ONLY: 'bg-report',
};

export function VerdictDot({ verdict, className }: { verdict: Verdict | null; className?: string }) {
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', verdict ? VERDICT_BG[verdict] : 'bg-skip', className)} />;
}

export function VerdictMark({ verdict, size = 'lg' }: { verdict: Verdict | null; size?: 'lg' | 'md' | 'sm' }) {
  return (
    <span
      className={cx(
        'font-semibold uppercase leading-none',
        verdict ? VERDICT_COLOR[verdict] : 'text-muted',
        size === 'lg' && 'font-display text-[40px] tracking-[-0.045em] sm:text-[48px]',
        size === 'md' && 'text-[28px] tracking-[-0.02em]',
        size === 'sm' && 'font-mono text-[12px] tracking-[0.12em]',
      )}
    >
      {verdictLabel(verdict)}
    </span>
  );
}

const STATUS_STYLE: Record<TrialStatus, string> = {
  pass: 'bg-pass',
  fail: 'bg-block',
  invalid: 'bg-invalid',
  skip: 'bg-transparent ring-1 ring-inset ring-faint',
};

export function TrialDot({ status, className }: { status: string | undefined; className?: string }) {
  const s = (['pass', 'fail', 'invalid', 'skip'] as const).find((x) => x === status);
  return <span aria-hidden className={cx('inline-block size-2.5 shrink-0 rounded-full', s ? STATUS_STYLE[s] : 'bg-line-strong', className)} />;
}

export function Chip({ active, children, count, onClick, label }: { active?: boolean; children: ReactNode; count?: number; onClick?: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-2 rounded-md border px-2.5 font-mono text-[12px] uppercase tracking-[0.08em] transition-colors',
        active ? 'border-ink bg-ink text-white' : 'border-line bg-sheet text-muted hover:border-line-strong hover:text-ink',
      )}
    >
      <span>[{children}]</span>
      {count !== undefined && <span className={active ? 'text-white/70' : 'text-faint'}>{count < 10 ? `0${count}` : count}</span>}
    </button>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx('inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-line-strong bg-sheet px-1.5 font-mono text-[11px] text-muted', className)}>{children}</kbd>;
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'dark' | 'pass' | 'block' | 'invalid'; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-mono text-[11px] uppercase tracking-[0.06em]',
        tone === 'neutral' && 'bg-tile text-muted',
        tone === 'dark' && 'bg-ink text-white',
        tone === 'pass' && 'bg-tile text-pass',
        tone === 'block' && 'bg-tile text-block',
        tone === 'invalid' && 'bg-tile text-invalid',
      )}
    >
      {children}
    </span>
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const t = useRef<number | undefined>(undefined);
  const copy = (text: string) => {
    const done = () => { setCopied(true); window.clearTimeout(t.current); t.current = window.setTimeout(() => setCopied(false), 1600); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) && done());
    else if (fallbackCopy(text)) done();
  };
  return [copied, copy];
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function CommandBlock({ command, label }: { command: string; label?: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className="flex items-start gap-2 rounded-lg border border-black bg-[#0a0a0a] p-1.5 pl-4 text-white">
      <pre className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-all">
        <span className="select-none text-white/50">$ </span>
        {command}
      </pre>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-label={copied ? 'Copied' : `Copy ${label ?? 'command'}`}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-3 font-mono text-[11px] uppercase tracking-[0.08em] text-white hover:bg-white/20 focus-visible:outline-white"
      >
        {copied ? <IconCheck size={16} stroke={1.75} /> : <IconCopy size={16} stroke={1.75} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function Dialog({ open, onClose, title, children, labelledBy, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; labelledBy?: string; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const id = labelledBy ?? `dlg-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cx('m-auto w-[calc(100%-32px)] rounded-xl bg-sheet p-0 text-ink shadow-pop backdrop:bg-black/20 backdrop:backdrop-blur-[2px]', wide ? 'max-w-2xl' : 'max-w-lg')}
    >
      {open && (
        <div className="p-5 sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 id={id} className="text-[20px] font-semibold leading-tight tracking-[-0.02em]">{title}</h2>
            <IconButton label="Close dialog" onClick={onClose} className="-mr-2 -mt-1"><IconX {...ICON} /></IconButton>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function EmptyState({ icon, title, body, command, children }: { icon?: ReactNode; title: string; body: ReactNode; command?: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-sheet shadow-card">
      <div className="flex flex-col items-start gap-5 rounded-lg bg-sheet px-6 py-10 sm:px-10 sm:py-14">
        {icon && <div className="flex size-10 items-center justify-center rounded-md border border-line bg-shell text-ink">{icon}</div>}
        <div className="max-w-xl">
          <h2 className="font-display text-[20px] font-semibold leading-tight tracking-[-0.02em]">{title}</h2>
          <div className="mt-2 text-[14px] text-muted">{body}</div>
        </div>
        {command && <div className="w-full max-w-xl"><CommandBlock command={command} /></div>}
        {children}
      </div>
    </div>
  );
}

export function ErrorState({ title, error, hint, onRetry }: { title: string; error: string; hint?: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-line bg-sheet shadow-card">
      <div className="flex flex-col items-start gap-4 rounded-lg bg-sheet px-6 py-8 sm:px-10">
        <div className="flex items-center gap-2 text-block"><IconAlertTriangle {...ICON} /><span className="mono-label !text-block">Error</span></div>
        <div>
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h2>
          <p className="mt-2 font-mono text-[13px] break-words text-ink">{error}</p>
          {hint && <div className="mt-3 text-[14px] text-muted">{hint}</div>}
        </div>
        {onRetry && <Button variant="primary" size="sm" onClick={onRetry}><IconRefresh size={16} stroke={1.75} />Try again</Button>}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton', className)} />;
}

export function PageHeader({ title, actions, sub }: { title: ReactNode; actions?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-[32px] leading-[1.1] font-semibold tracking-[-0.04em] break-words sm:text-[40px]">{title}</h1>
        {sub && <div className="mt-2 text-[14px] text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, label, children, actions, id }: { title: string; label?: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="mt-12 first:mt-0" aria-labelledby={id}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          {label && <div className="mono-label mb-1">{label}</div>}
          <h2 id={id} className="font-display text-[20px] font-semibold leading-tight tracking-[-0.02em]">{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Tile({ children, className, inner }: { children: ReactNode; className?: string; inner?: string }) {
  return (
    <div className={cx('rounded-lg border border-line bg-sheet shadow-card', className)}>
      <div className={cx('rounded-lg', inner ?? 'p-5')}>{children}</div>
    </div>
  );
}
