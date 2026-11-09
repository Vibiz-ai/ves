// Tiny dependency-free SVG trend chart: pass^1 per run with its Wilson CI band, verdict-coloured dots, and a BREAK
// marker wherever the suite_version changes (lines and bands never connect two suite versions).
import { useEffect, useId, useRef, useState } from 'react';
import { segments, short, type TrendBreak, type TrendPoint } from '../lib/history.ts';
import { pct } from '../lib/format.ts';
import { cx } from './ui.tsx';

const H = 236, L = 40, R = 14, T = 34, B = 38;
const DOT: Record<string, string> = { PASS: 'fill-pass', BLOCK: 'fill-block', INVALID: 'fill-invalid', REPORT_ONLY: 'fill-report' };

export function TrendChart({ points, breaks, title, onPick }: { points: TrendPoint[]; breaks: TrendBreak[]; title: string; onPick?: (p: TrendPoint) => void }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  // drawn at the container's real pixel width (no viewBox scaling), so 10px labels stay 10px on a phone
  const wrap = useRef<HTMLElement>(null);
  const [measured, setW] = useState<number | null>(null);
  const W = measured ?? 640;
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [points.length > 0]);
  if (!points.length) return <p className="rounded-lg bg-tile px-5 py-8 text-[14px] text-muted">No runs of this surface match the filters.</p>;
  const n = points.length;
  const x = (i: number) => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (1 - Math.max(0, Math.min(1, v))) * (H - T - B);
  const segs = segments(points.map((p, i) => ({ ...p, i })), breaks);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - L - R) / 64))));
  const hp = hover !== null ? points[hover] : null;
  const summary = `${title}: ${n} run(s); latest pass^1 ${pct(points[n - 1].pass1)} (n=${points[n - 1].n}); ${breaks.length} suite change(s).`;
  return (
    <figure ref={wrap} className="relative w-full min-w-0">
      {measured === null ? <div style={{ height: H }} aria-hidden /> : <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" role="img" aria-labelledby={`${id}-t`}>
        <title id={`${id}-t`}>{summary}</title>
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-line" strokeWidth={1} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-faint font-mono text-[10px]">{v * 100}%</text>
          </g>
        ))}
        {segs.map((sg, k) => (
          <g key={k}>
            {sg.length > 1 && (
              <path d={`M${sg.map((p) => `${x(p.i)},${y(p.hi)}`).join('L')}L${[...sg].reverse().map((p) => `${x(p.i)},${y(p.lo)}`).join('L')}Z`} className="fill-ink/[0.07]" />
            )}
            {sg.length === 1 && <line x1={x(sg[0].i)} x2={x(sg[0].i)} y1={y(sg[0].hi)} y2={y(sg[0].lo)} className="stroke-ink/20" strokeWidth={6} strokeLinecap="round" />}
            {sg.length > 1 && <polyline points={sg.map((p) => `${x(p.i)},${y(p.pass1)}`).join(' ')} fill="none" className="stroke-ink" strokeWidth={1.75} strokeLinejoin="round" />}
          </g>
        ))}
        {breaks.map((b) => {
          const bx = (x(b.index - 1) + x(b.index)) / 2;
          const label = `cases changed ${b.from}→${b.to}`;
          return (
            <g key={b.index}>
              <line x1={bx} x2={bx} y1={T - 8} y2={H - B} className="stroke-ink" strokeWidth={1} strokeDasharray="3 3" />
              <rect x={bx - 22} y={4} width={44} height={16} rx={4} className="fill-ink" />
              <text x={bx} y={15.5} textAnchor="middle" className="fill-white font-mono text-[9.5px] tracking-[0.08em]">BREAK</text>
              <text x={bx + (bx > W / 2 ? -27 : 27)} y={15.5} textAnchor={bx > W / 2 ? 'end' : 'start'} className="fill-muted font-mono text-[10px]">{label}</text>
            </g>
          );
        })}
        {points.map((p, i) => (
          <g key={p.run_id}>
            <circle
              cx={x(i)} cy={y(p.pass1)} r={hover === i ? 6 : 4.5}
              className={cx(DOT[p.verdict ?? ''] ?? 'fill-skip', 'stroke-sheet', onPick && 'cursor-pointer')} strokeWidth={2}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(p)}
            >
              <title>{`${p.run_id}\n${p.branch ?? 'no branch'} · ${short(p.sha)} · ${p.verdict ?? '—'}\npass^1 ${pct(p.pass1)} [${pct(p.lo)}, ${pct(p.hi)}] n=${p.n} · suite ${p.suite_label ?? short(p.suite_version)}`}</title>
            </circle>
            {(i === n - 1 || (i % every === 0 && n - 1 - i >= every)) && <text x={x(i)} y={H - B + 18} textAnchor="middle" className="fill-faint font-mono text-[10px]">{short(p.sha).slice(0, 7)}</text>}
          </g>
        ))}
        <text x={L} y={H - 6} className="fill-faint font-mono text-[10px]">oldest</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="fill-faint font-mono text-[10px]">newest</text>
      </svg>}
      <figcaption className="mt-2 flex min-h-5 flex-wrap items-baseline gap-x-3 font-mono text-[12px] text-muted" aria-live="polite">
        {hp ? (
          <>
            <span className="text-ink">{pct(hp.pass1)}</span>
            <span>[{pct(hp.lo)}, {pct(hp.hi)}] n={hp.n}</span>
            <span>{hp.branch ?? 'no branch'} · {short(hp.sha)}</span>
            <span>{hp.verdict ?? '—'}{hp.decided_by ? ` (${hp.decided_by})` : ''}</span>
            <span>suite {hp.suite_label ?? short(hp.suite_version)}</span>
          </>
        ) : (
          <span>pass^1 with 95% Wilson band · dot colour = gate verdict · hover a dot for its run</span>
        )}
      </figcaption>
      <div className="sr-only"><table>
        <caption>{title}</caption>
        <thead><tr><th>run</th><th>branch</th><th>pass^1</th><th>CI</th><th>n</th><th>verdict</th><th>suite</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.run_id}><td>{p.run_id}</td><td>{p.branch ?? '—'}</td><td>{pct(p.pass1)}</td><td>{pct(p.lo)}–{pct(p.hi)}</td><td>{p.n}</td><td>{p.verdict ?? '—'}</td><td>{p.suite_label ?? '—'}</td></tr>)}</tbody>
      </table></div>
    </figure>
  );
}
