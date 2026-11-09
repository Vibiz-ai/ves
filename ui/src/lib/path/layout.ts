// Layouts for the path canvases. Pure: graph in, coordinates out (world units; the canvas pans and zooms them).
//  - trialLayout: time runs left to right; each node kind has a swim lane (conversation on top, then approvals, meta,
//    reads, memory, writes, risky actions, checks), turns are shaded columns. Tool calls branch down from the
//    conversation spine between the user message and the reply they lead to, so even 40-call turns stay readable.
//  - compareLayout: one merged row per aligned step; A-only above, B-only below, shared in the middle.
//  - caseLayout: a small deterministic force layout (Obsidian-like), with x pulled toward each step's mean position
//    in the trials so it still reads left to right.
import type { AlignPair } from './align.ts';
import type { CaseGraph } from './align.ts';
import type { PathGraph, PathNode, ToolCls } from './model.ts';

export const PALETTE = {
  bg: '#0b0b10',
  grid: 'rgba(255,255,255,0.055)',
  edge: 'rgba(212,212,216,0.30)',
  label: '#d4d4d8',
  faint: '#8b8b96',
  failRing: '#ff4d4f',
  passRing: '#34d399',
  a: '#22d3ee',
  b: '#e879f9',
  shared: '#8a8a96',
  changed: '#fde047',
  kind: {
    user: '#f4f4f5', reply: '#60a5fa', boundary: '#38bdf8', approval_request: '#facc15', approve: '#4ade80', reject: '#f87171', timeout: '#a1a1aa', other: '#d4d4d8',
    tool_error: '#ef4444', verdict_pass: '#22c55e', verdict_fail: '#ef4444', verdict_other: '#a1a1aa', terminal: '#e4e4e7',
  },
  tool: { meta: '#94a3b8', unknown: '#a8a29e', read: '#2dd4bf', memory: '#c084fc', write: '#fbbf24', gated: '#a3e635', outward: '#f472b6', spend: '#fb923c', destructive: '#f43f5e' } as Record<ToolCls, string>,
};

export function nodeColor(n: Pick<PathNode, 'kind' | 'tool' | 'decision' | 'verdict'>): string {
  switch (n.kind) {
    case 'tool': return PALETTE.tool[n.tool?.cls ?? 'unknown'];
    case 'approval_decision': return PALETTE.kind[n.decision ?? 'other'];
    case 'verdict': return n.verdict?.name === 'persona_outcome' ? PALETTE.kind.verdict_other : n.verdict?.label === 'pass' ? PALETTE.kind.verdict_pass : n.verdict?.label === 'fail' || n.verdict?.label === 'error' ? PALETTE.kind.verdict_fail : PALETTE.kind.verdict_other;
    default: return PALETTE.kind[n.kind as keyof typeof PALETTE.kind] ?? '#d4d4d8';
  }
}
export const nodeShape = (n: Pick<PathNode, 'kind'>): 'circle' | 'diamond' | 'square' | 'triangle' =>
  n.kind === 'approval_request' || n.kind === 'approval_decision' ? 'diamond' : n.kind === 'verdict' ? 'square' : n.kind === 'boundary' || n.kind === 'tool_error' ? 'triangle' : 'circle';
export const radius = (n: Pick<PathNode, 'importance' | 'kind'>) => (n.kind === 'verdict' ? 6 : n.kind === 'tool_error' ? 5.5 : 3.6 + n.importance * 2.3);

export type LegendItem = { key: string; label: string; color: string; shape: 'circle' | 'diamond' | 'square' | 'triangle' | 'line' | 'ring' | 'hollow' };
export const TRIAL_LEGEND: LegendItem[] = [
  { key: 'user', label: 'user', color: PALETTE.kind.user, shape: 'circle' },
  { key: 'reply', label: 'agent reply', color: PALETTE.kind.reply, shape: 'circle' },
  { key: 'meta', label: 'meta (find/load tools)', color: PALETTE.tool.meta, shape: 'circle' },
  { key: 'read', label: 'read', color: PALETTE.tool.read, shape: 'circle' },
  { key: 'memory', label: 'memory', color: PALETTE.tool.memory, shape: 'circle' },
  { key: 'write', label: 'write', color: PALETTE.tool.write, shape: 'circle' },
  { key: 'gated', label: 'gated write', color: PALETTE.tool.gated, shape: 'circle' },
  { key: 'outward', label: 'outward', color: PALETTE.tool.outward, shape: 'circle' },
  { key: 'spend', label: 'spend', color: PALETTE.tool.spend, shape: 'circle' },
  { key: 'destructive', label: 'destructive', color: PALETTE.tool.destructive, shape: 'circle' },
  { key: 'unknown', label: 'host tool (not in catalog)', color: PALETTE.tool.unknown, shape: 'circle' },
  { key: 'approval', label: 'approval ask / decision', color: PALETTE.kind.approval_request, shape: 'diamond' },
  { key: 'boundary', label: 'clock / session', color: PALETTE.kind.boundary, shape: 'triangle' },
  { key: 'error', label: 'tool error', color: PALETTE.kind.tool_error, shape: 'triangle' },
  { key: 'verdict', label: 'check pass / fail', color: PALETTE.kind.verdict_pass, shape: 'square' },
  { key: 'ring', label: 'failed check here', color: PALETTE.failRing, shape: 'ring' },
  { key: 'hollow', label: 'reported by agent only', color: PALETTE.tool.read, shape: 'hollow' },
];

export type Pos = { x: number; y: number; r: number };
export type Lane = { key: string; label: string; y: number };
export type Band = { x0: number; x1: number; label: string; sub?: string };
export type Layout = { pos: Map<string, Pos>; lanes: Lane[]; bands: Band[]; width: number; height: number; markers: { x: number; label: string; color: string }[] };

const LANES: { key: string; label: string }[] = [
  { key: 'conv', label: 'Conversation' }, { key: 'approval', label: 'Approvals' }, { key: 'meta', label: 'Meta · host' }, { key: 'read', label: 'Reads' },
  { key: 'memory', label: 'Memory' }, { key: 'write', label: 'Writes' }, { key: 'action', label: 'Outward · spend · destructive' }, { key: 'checks', label: 'Checks' },
];
export function laneOf(n: PathNode): string {
  switch (n.kind) {
    case 'user': case 'reply': case 'boundary': return 'conv';
    case 'approval_request': case 'approval_decision': return 'approval';
    case 'verdict': return 'checks';
    case 'tool_error': return 'err';
    case 'tool': {
      const c = n.tool!.cls;
      return c === 'meta' || c === 'unknown' ? 'meta' : c === 'read' ? 'read' : c === 'memory' ? 'memory' : c === 'write' || c === 'gated' ? 'write' : 'action';
    }
  }
}

const STEP = 46, TURN_GAP = 40, LANE_H = 58, TOP = 46, LEFT = 24;

export function trialLayout(g: PathGraph): Layout {
  const seq = g.nodes.filter((n) => n.sequential);
  const used = new Set(g.nodes.map(laneOf));
  const lanes: Lane[] = LANES.filter((l) => used.has(l.key)).map((l, i) => ({ ...l, y: TOP + i * LANE_H }));
  const laneY = new Map(lanes.map((l) => [l.key, l.y]));
  const pos = new Map<string, Pos>();
  let x = LEFT, prevTurn: number | null = null;
  const bands: Band[] = [];
  for (const n of seq) {
    if (prevTurn !== null && n.turn !== prevTurn) x += TURN_GAP;
    prevTurn = n.turn;
    pos.set(n.id, { x, y: laneY.get(laneOf(n)) ?? TOP, r: radius(n) });
    x += STEP;
  }
  for (const t of g.turns) {
    const xs = seq.filter((n) => n.turn === t.index).map((n) => pos.get(n.id)!.x);
    if (xs.length) bands.push({ x0: Math.min(...xs) - STEP / 2, x1: Math.max(...xs) + STEP / 2, label: t.label, sub: t.boundary });
  }
  // attachments: errors just below their call, verdicts in the checks lane under their target (spread when stacked)
  const stack = new Map<number, number>();
  for (const n of g.nodes.filter((m) => !m.sequential)) {
    const t = n.attachTo ? pos.get(n.attachTo) : undefined;
    if (!t) continue;
    if (n.kind === 'tool_error') { pos.set(n.id, { x: t.x + 14, y: t.y + 20, r: radius(n) }); continue; }
    const k = stack.get(t.x) ?? 0;
    stack.set(t.x, k + 1);
    const cy = laneY.get('checks') ?? t.y + LANE_H;
    pos.set(n.id, { x: t.x + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 15, y: cy + (k > 4 ? 14 : 0), r: radius(n) });
  }
  const width = x + LEFT;
  const height = TOP + lanes.length * LANE_H;
  return { pos, lanes, bands, width, height, markers: [] };
}

export function compareLayout(pairs: AlignPair[], divergence: number): Layout {
  const pos = new Map<string, Pos>();
  const ROW = 70, MID = 110, STEP = 64;
  let x = LEFT, prevTurn: number | null = null;
  const bands: Band[] = [];
  let bandStart = x, bandTurn: number | null = null;
  const markers: Layout['markers'] = [];
  pairs.forEach((p, i) => {
    const n = (p.a ?? p.b)!;
    if (prevTurn !== null && n.turn !== prevTurn) {
      bands.push({ x0: bandStart - STEP / 2, x1: x - STEP / 2, label: `Turn ${bandTurn}` });
      x += TURN_GAP; bandStart = x;
    }
    prevTurn = n.turn; bandTurn = n.turn;
    if (i === divergence) markers.push({ x: x - STEP / 2 + 4, label: 'diverges here', color: PALETTE.changed });
    const y = p.match === 'a' ? MID - ROW : p.match === 'b' ? MID + ROW : MID;
    pos.set(`p${i}`, { x, y, r: radius(n) });
    x += STEP;
  });
  if (pairs.length) bands.push({ x0: bandStart - STEP / 2, x1: x - STEP / 2, label: `Turn ${bandTurn}` });
  return {
    pos, bands, markers, width: x + LEFT, height: MID + ROW + 44,
    lanes: [{ key: 'a', label: 'only A', y: MID - ROW }, { key: 'both', label: 'both', y: MID }, { key: 'b', label: 'only B', y: MID + ROW }],
  };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function caseLayout(cg: CaseGraph, opts: { width?: number; height?: number; iterations?: number } = {}): Layout {
  const n = cg.nodes.length;
  const W = opts.width ?? Math.max(900, n * 34), H = opts.height ?? Math.max(460, Math.min(900, n * 16));
  const rand = rng(7);
  const maxVisits = Math.max(1, ...cg.nodes.map((x) => x.trials.length));
  const P = cg.nodes.map((x) => ({ id: x.id, x: 40 + x.meanPos * (W - 80), y: H / 2 + (rand() - 0.5) * H * 0.7, vx: 0, vy: 0, r: x.kind === 'terminal' ? 11 : 5 + 9 * Math.sqrt(x.trials.length / maxVisits) }));
  const idx = new Map(P.map((p, i) => [p.id, i]));
  const pinned = (id: string) => id === 'start' || id.startsWith('end:');
  for (const p of P) if (pinned(p.id)) { p.y = p.id === 'start' ? H / 2 : p.id === 'end:pass' ? H * 0.3 : p.id === 'end:fail' ? H * 0.7 : H * 0.5; }
  const L = Math.max(40, Math.min(90, W / Math.max(4, n)));
  const iters = opts.iterations ?? 360;
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = P[i], b = P[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = rand() - 0.5; dy = rand() - 0.5; d2 = 0.25; }
      const minD = a.r + b.r + 18;
      const f = (L * L) / d2 * (d2 < minD * minD ? 3 : 1);
      a.vx += dx * f * 0.02; a.vy += dy * f * 0.02; b.vx -= dx * f * 0.02; b.vy -= dy * f * 0.02;
    }
    for (const e of cg.edges) {
      const a = P[idx.get(e.from)!], b = P[idx.get(e.to)!];
      if (!a || !b || a === b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - L) / d * 0.04 * Math.min(3, 1 + Math.log(e.count));
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    cg.nodes.forEach((x, i) => {
      const p = P[i];
      p.vx += (40 + x.meanPos * (W - 80) - p.x) * 0.06; // time flows left to right
      p.vy += (H / 2 - p.y) * 0.004;
      if (pinned(p.id)) { p.vx = (40 + x.meanPos * (W - 80) - p.x) * 0.5; p.vy = 0; }
      const lim = 30 * cool + 1;
      p.x += Math.max(-lim, Math.min(lim, p.vx)); p.y += Math.max(-lim, Math.min(lim, p.vy));
      p.vx *= 0.5; p.vy *= 0.5;
      p.y = Math.max(20, Math.min(H - 20, p.y));
    });
  }
  const pos = new Map(P.map((p) => [p.id, { x: p.x, y: p.y, r: p.r }]));
  return { pos, lanes: [], bands: [], markers: [], width: W, height: H };
}
