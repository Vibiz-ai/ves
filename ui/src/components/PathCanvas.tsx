// A dark pan/zoom SVG canvas for path graphs (hand-rolled, no dependency). Drag to pan, pinch or ctrl/⌘ + wheel to
// zoom, horizontal wheel pans; the page keeps its vertical scroll. Nodes are keyboard reachable (one tab stop; arrow
// keys walk the path in order, Enter selects, + / - / 0 zoom). There is no animation, so prefers-reduced-motion
// has nothing to turn off; the global CSS rule covers the hover transitions.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconFocusCentered, IconMinus, IconPlus } from '@tabler/icons-react';
import { PALETTE, type Band, type Lane, type LegendItem } from '../lib/path/layout.ts';
import { cx } from './ui.tsx';

export type CanvasNode = {
  id: string; x: number; y: number; r: number; color: string;
  shape: 'circle' | 'diamond' | 'square' | 'triangle';
  hollow?: boolean; dashed?: boolean; ring?: 'fail' | 'pass' | null; glow?: boolean; dim?: boolean;
  /** Inner dot colour (the compare view fills nodes by A/B/shared and shows the step kind here). */
  core?: string;
  label?: string; alwaysLabel?: boolean; badge?: string; chips?: { label: string; color: string }[];
  title: string; ariaLabel: string;
};
export type CanvasEdge = { id: string; from: string; to: string; color: string; width: number; dashed?: boolean; opacity?: number; arrow?: boolean };
type View = { k: number; x: number; y: number };

const clampK = (k: number) => Math.max(0.15, Math.min(4, k));

function Shape({ n, k }: { n: CanvasNode; k: number }) {
  const fill = n.hollow ? PALETTE.bg : n.color;
  const stroke = n.hollow ? n.color : 'rgba(0,0,0,0.55)';
  const sw = n.hollow ? 2 : 1;
  const dash = n.dashed ? '3 2.5' : undefined;
  const r = n.r;
  const common = { fill, stroke, strokeWidth: sw / Math.max(k, 0.6), strokeDasharray: dash };
  if (n.shape === 'diamond') return <rect x={-r * 0.82} y={-r * 0.82} width={r * 1.64} height={r * 1.64} transform="rotate(45)" rx={2} {...common} />;
  if (n.shape === 'square') return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={2.5} {...common} />;
  if (n.shape === 'triangle') return <path d={`M0 ${-r * 1.15} L${r * 1.05} ${r * 0.75} L${-r * 1.05} ${r * 0.75} Z`} strokeLinejoin="round" {...common} />;
  return <circle r={r} {...common} />;
}

export function PathCanvas({
  nodes, edges, width, height, lanes = [], bands = [], markers = [], selected, onSelect, ariaLabel, legend, footer, textAlternative, className, heightClass,
}: {
  nodes: CanvasNode[]; edges: CanvasEdge[]; width: number; height: number; lanes?: Lane[]; bands?: Band[]; markers?: { x: number; label: string; color: string }[];
  selected: string | null; onSelect: (id: string | null) => void; ariaLabel: string; legend?: LegendItem[]; footer?: ReactNode; textAlternative?: ReactNode; className?: string; heightClass?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 460 });
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback((mode: 'auto' | 'all' = 'auto') => {
    const padX = lanes.length && size.w >= 640 ? 140 : 16, padY = 24;
    const kAll = Math.min((size.w - padX - 16) / width, (size.h - padY * 2) / height);
    const kH = Math.min((size.h - padY * 2) / height, 1.25);
    const k = clampK(mode === 'all' || kAll >= 0.5 ? Math.min(kAll, 1.3) : Math.max(kAll, Math.min(kH, 0.9)));
    const contentW = width * k;
    const x = contentW < size.w - padX ? padX + (size.w - padX - contentW) / 2 : padX;
    setView({ k, x, y: (size.h - height * k) / 2 });
  }, [size.w, size.h, width, height, lanes.length]);
  useEffect(() => { fit('auto'); }, [fit, nodes]);

  // ctrl/⌘ + wheel (and trackpad pinch) zooms at the cursor; a horizontal wheel pans; vertical wheel scrolls the page
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        setView((v) => { const k = clampK(v.k * Math.exp(-e.deltaY * 0.008)); return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }; });
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        setView((v) => ({ ...v, x: v.x - e.deltaX }));
      }
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, []);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; hit?: string | null; pinch?: { d: number; k: number; cx: number; cy: number } } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...pointers.current.values()];
    if (ps.length === 2) {
      const rect = svg.current!.getBoundingClientRect();
      drag.current = { x: 0, y: 0, vx: view.x, vy: view.y, moved: true, pinch: { d: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), k: view.k, cx: (ps[0].x + ps[1].x) / 2 - rect.left, cy: (ps[0].y + ps[1].y) / 2 - rect.top } };
    } else drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, hit: (e.target as Element).closest?.('[data-node]')?.getAttribute('data-node') ?? null };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (!d) return;
    const ps = [...pointers.current.values()];
    if (d.pinch && ps.length === 2) {
      const dist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      const k = clampK(d.pinch.k * (dist / d.pinch.d));
      const { cx, cy } = d.pinch;
      setView({ k, x: cx - ((cx - d.vx) * k) / d.pinch.k, y: cy - ((cy - d.vy) * k) / d.pinch.k });
      return;
    }
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (pointers.current.size === 0) {
      if (d && !d.moved) onSelect(d.hit ?? null);
      drag.current = null;
    }
  };

  const zoomBy = (f: number) => setView((v) => { const k = clampK(v.k * f); const cx = size.w / 2, cy = size.h / 2; return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }; });
  const ensureVisible = (id: string) => {
    const n = byId.get(id);
    if (!n) return;
    setView((v) => {
      const sx = v.x + n.x * v.k, sy = v.y + n.y * v.k;
      const m = 60;
      if (sx > m && sx < size.w - m && sy > m && sy < size.h - m) return v;
      return { ...v, x: size.w / 2 - n.x * v.k, y: size.h / 2 - n.y * v.k };
    });
  };
  const tabStop = focusId && byId.has(focusId) ? focusId : selected && byId.has(selected) ? selected : nodes[0]?.id ?? null;
  const onKey = (e: React.KeyboardEvent) => {
    const i = nodes.findIndex((n) => n.id === (focusId ?? tabStop));
    const go = (j: number) => {
      const n = nodes[Math.max(0, Math.min(nodes.length - 1, j))];
      if (!n) return;
      setFocusId(n.id);
      ensureVisible(n.id);
      requestAnimationFrame(() => (svg.current?.querySelector(`[data-node="${CSS.escape(n.id)}"]`) as SVGElement | null)?.focus());
    };
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(nodes.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (focusId ?? tabStop) onSelect(focusId ?? tabStop); }
    else if (e.key === 'Escape') onSelect(null);
    else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-') zoomBy(0.8);
    else if (e.key === '0') fit('all');
  };

  const { k } = view;
  const fs = Math.max(9, Math.min(16, 11 / k));
  const showAll = k >= 1.15;
  const h = hover ? byId.get(hover) : null;
  const edgePath = (a: CanvasNode, b: CanvasNode) => {
    const dx = b.x - a.x;
    if (Math.abs(b.y - a.y) < 0.5) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
    const c = Math.max(Math.abs(dx) * 0.5, 18);
    return `M${a.x} ${a.y} C${a.x + c} ${a.y} ${b.x - c} ${b.y} ${b.x} ${b.y}`;
  };

  return (
    <div className={cx('overflow-hidden rounded-lg border border-black/80 text-[#e4e4e7]', className)} style={{ background: PALETTE.bg }}>
      <div ref={box} className={cx('relative w-full', heightClass ?? 'h-[380px] sm:h-[500px]')}>
        <svg
          ref={svg}
          width={size.w}
          height={size.h}
          role="group"
          aria-label={ariaLabel}
          aria-roledescription="path canvas"
          className="block cursor-grab touch-none select-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKey}
        >
          <defs>
            <pattern id="pc-grid" width={24 * k} height={24 * k} patternUnits="userSpaceOnUse" x={view.x % (24 * k)} y={view.y % (24 * k)}>
              <circle cx={1} cy={1} r={1} fill={PALETTE.grid} />
            </pattern>
            <marker id="pc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="rgba(212,212,216,0.55)" /></marker>
          </defs>
          <rect width={size.w} height={size.h} fill="url(#pc-grid)" />
          <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
            {bands.map((b, i) => (
              <g key={i}>
                <rect x={b.x0} y={0} width={Math.max(0, b.x1 - b.x0)} height={height} rx={10} fill={i % 2 ? 'rgba(255,255,255,0.018)' : 'rgba(255,255,255,0.04)'} />
                <text x={b.x0 + 8} y={16} fontSize={fs} fill={PALETTE.faint} fontFamily="var(--font-mono)" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>{b.label}{b.sub ? ` · after ${b.sub}` : ''}</text>
              </g>
            ))}
            {lanes.map((l) => <line key={l.key} x1={-2000} x2={width + 2000} y1={l.y} y2={l.y} stroke="rgba(255,255,255,0.05)" strokeWidth={1 / k} />)}
            {markers.map((m, i) => (
              <g key={i}>
                <line x1={m.x} x2={m.x} y1={4} y2={height - 4} stroke={m.color} strokeWidth={1.5 / k} strokeDasharray={`${5 / k} ${4 / k}`} />
                <text x={m.x + 6} y={height - 8} fontSize={fs} fill={m.color} fontFamily="var(--font-mono)" fontWeight={600}>{m.label}</text>
              </g>
            ))}
            {edges.map((e) => {
              const a = byId.get(e.from), b = byId.get(e.to);
              if (!a || !b) return null;
              const on = selected && (e.from === selected || e.to === selected);
              return <path key={e.id} d={edgePath(a, b)} fill="none" stroke={e.color} strokeWidth={(on ? e.width + 1 : e.width) / Math.max(k, 0.7)} strokeOpacity={on ? 1 : e.opacity ?? 0.9} strokeDasharray={e.dashed ? `${3 / k} ${3 / k}` : undefined} markerEnd={e.arrow ? 'url(#pc-arrow)' : undefined} strokeLinecap="round" />;
            })}
            {nodes.map((n) => {
              const sel = n.id === selected;
              const label = n.label && (n.alwaysLabel || showAll || sel || n.id === hover || n.id === focusId);
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  transform={`translate(${n.x} ${n.y})`}
                  tabIndex={n.id === tabStop ? 0 : -1}
                  role="button"
                  aria-label={n.ariaLabel}
                  aria-pressed={sel}
                  className="cursor-pointer outline-none [&:focus-visible>.pc-focus]:opacity-100"
                  opacity={n.dim ? 0.32 : 1}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover((x) => (x === n.id ? null : x))}
                  onFocus={() => { setFocusId(n.id); ensureVisible(n.id); }}
                >
                  <circle className="pc-focus opacity-0" r={n.r + 7} fill="none" stroke="#fff" strokeWidth={2 / k} />
                  {(n.glow || sel) && <circle r={n.r + 5} fill={n.color} opacity={sel ? 0.35 : 0.16} />}
                  {n.ring && <circle r={n.r + 3.5} fill="none" stroke={n.ring === 'fail' ? PALETTE.failRing : PALETTE.passRing} strokeWidth={2.2 / Math.max(k, 0.7)} />}
                  <Shape n={n} k={k} />
                  {n.core && <circle r={Math.max(2.2, n.r * 0.42)} fill={n.core} stroke={PALETTE.bg} strokeWidth={0.8 / k} />}
                  {sel && <circle r={n.r + 8.5} fill="none" stroke="#fff" strokeWidth={1.4 / k} strokeDasharray={`${2 / k} ${2 / k}`} />}
                  {n.badge && <text x={n.r + 1} y={-n.r - 1} fontSize={fs * 0.82} fill="#fde68a" fontFamily="var(--font-mono)" fontWeight={700}>{n.badge}</text>}
                  {label && <text y={-n.r - 6} textAnchor="middle" fontSize={fs} fill={PALETTE.label} fontFamily="var(--font-mono)" paintOrder="stroke" stroke={PALETTE.bg} strokeWidth={3 / k}>{n.label}</text>}
                  {n.chips && (k >= 0.55 || sel) && n.chips.slice(0, 4).map((c, i) => {
                    const w = c.label.length * fs * 0.6 + 8;
                    return (
                      <g key={i} transform={`translate(${-w / 2} ${n.r + 5 + i * (fs + 5)})`}>
                        <rect width={w} height={fs + 3} rx={(fs + 3) / 2} fill={c.color} fillOpacity={0.18} stroke={c.color} strokeOpacity={0.7} strokeWidth={0.8 / k} />
                        <text x={w / 2} y={fs - 0.5} textAnchor="middle" fontSize={fs * 0.82} fill={c.color} fontFamily="var(--font-mono)">{c.label}</text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
          {lanes.map((l) => {
            const y = view.y + l.y * k;
            if (y < 8 || y > size.h - 8) return null;
            return (
              <g key={l.key} transform={`translate(8 ${y})`} pointerEvents="none">
                <rect x={0} y={-9} width={l.label.length * 6.4 + 12} height={18} rx={9} fill="rgba(11,11,16,0.85)" stroke="rgba(255,255,255,0.08)" />
                <text x={6} y={4} fontSize={10} fill={PALETTE.faint} fontFamily="var(--font-mono)" style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>{l.label}</text>
              </g>
            );
          })}
        </svg>
        {h && (
          <div role="tooltip" className="pointer-events-none absolute z-10 max-w-[300px] rounded-md border border-white/10 bg-[#16161d]/95 px-2.5 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap text-[#e4e4e7] shadow-lg"
            style={{ left: Math.min(size.w - 310, Math.max(4, view.x + h.x * k + 14)), top: Math.max(4, view.y + h.y * k + 14) }}>
            {h.title}
          </div>
        )}
        <div className="absolute top-2 right-2 flex gap-1">
          {([['Zoom in', () => zoomBy(1.25), <IconPlus key="p" size={16} stroke={1.75} />], ['Zoom out', () => zoomBy(0.8), <IconMinus key="m" size={16} stroke={1.75} />], ['Fit to view', () => fit('all'), <IconFocusCentered key="f" size={16} stroke={1.75} />]] as const).map(([label, on, icon]) => (
            <button key={label} type="button" onClick={on} aria-label={label} title={label} className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 bg-[#16161d]/90 text-[#d4d4d8] hover:bg-[#23232d] focus-visible:outline-white">{icon}</button>
          ))}
        </div>
        <p className="pointer-events-none absolute bottom-2 left-3 hidden font-mono text-[10px] text-[#8b8b96] sm:block">drag to pan · ctrl/⌘ + scroll or pinch to zoom · tab + arrows to walk the path</p>
      </div>
      {(legend?.length || footer) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/10 px-3 py-2.5">
          {legend?.map((l) => (
            <span key={l.key} className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[#b4b4bc]">
              <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden>
                {l.shape === 'line' ? <line x1={-6} x2={6} y1={0} y2={0} stroke={l.color} strokeWidth={2.5} strokeLinecap="round" />
                  : l.shape === 'ring' ? <circle r={4.5} fill="none" stroke={l.color} strokeWidth={2} />
                  : l.shape === 'hollow' ? <circle r={4.5} fill={PALETTE.bg} stroke={l.color} strokeWidth={1.8} strokeDasharray="2.5 2" />
                  : <Shape n={{ id: '', x: 0, y: 0, r: 4.6, color: l.color, shape: l.shape, title: '', ariaLabel: '' }} k={1} />}
              </svg>
              {l.label}
            </span>
          ))}
          {footer}
        </div>
      )}
      {textAlternative && (
        <details className="border-t border-white/10 px-3 py-2 text-[13px]">
          <summary className="cursor-pointer font-mono text-[11px] tracking-[0.06em] text-[#b4b4bc] uppercase">Steps as a list</summary>
          <div className="mt-2 max-h-[320px] overflow-y-auto pr-2 text-[#d4d4d8]">{textAlternative}</div>
        </details>
      )}
    </div>
  );
}
