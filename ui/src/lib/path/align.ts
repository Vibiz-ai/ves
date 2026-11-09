// Aligning two trial paths, and aggregating every trial of one case into a transition graph. Pure functions.
import { describeNode, type PathGraph, type PathNode } from './model.ts';
import { metricDeltas, type MetricDelta, type ReplyMetrics } from './metrics.ts';

export type Match = 'same' | 'changed' | 'a' | 'b';
export type AlignPair = { a: PathNode | null; b: PathNode | null; match: Match };

const seqOnly = (g: PathGraph | PathNode[]) => (Array.isArray(g) ? g : g.nodes).filter((n) => n.sequential);

/**
 * Weighted LCS over node signatures. An exact signature match (kind + tool + normalised-args hash) scores 3, a coarse
 * one (same kind + tool, other args; or two replies) scores 1, anything else cannot pair. Gaps cost nothing, so the
 * result is the alignment with the most (and most exact) shared steps; ties prefer pairing early. O(n·m).
 */
export function alignPaths(aIn: PathGraph | PathNode[], bIn: PathGraph | PathNode[]): AlignPair[] {
  const a = seqOnly(aIn), b = seqOnly(bIn);
  const n = a.length, m = b.length;
  const score = (x: PathNode, y: PathNode) => (x.signature === y.signature ? 3 : x.coarse === y.coarse ? 1 : -1);
  const dp: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const s = score(a[i], b[j]);
    // a tiny bonus for pairing inside the same turn keeps steps of different turns apart
    const pair = s > 0 ? s + (a[i].turn === b[j].turn ? 0.01 : 0) + dp[i + 1][j + 1] : -Infinity;
    dp[i][j] = Math.max(pair, dp[i + 1][j], dp[i][j + 1]);
  }
  const out: AlignPair[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = score(a[i], b[j]);
      if (s > 0 && Math.abs(dp[i][j] - (s + (a[i].turn === b[j].turn ? 0.01 : 0) + dp[i + 1][j + 1])) < 1e-9) {
        const same = s === 3 && (a[i].kind !== 'reply' || (a[i].text ?? '') === (b[j].text ?? ''));
        out.push({ a: a[i], b: b[j], match: same ? 'same' : 'changed' }); i++; j++; continue;
      }
      if (dp[i][j] === dp[i + 1][j]) { out.push({ a: a[i], b: null, match: 'a' }); i++; continue; }
      out.push({ a: null, b: b[j], match: 'b' }); j++; continue;
    }
    if (i < n) { out.push({ a: a[i++], b: null, match: 'a' }); continue; }
    out.push({ a: null, b: b[j++], match: 'b' });
  }
  return out;
}

/** Structural divergence: a step only one path took, or the same tool with other args. Reply wording alone is not one. */
export const isDivergent = (p: AlignPair) => p.match === 'a' || p.match === 'b' || (p.match === 'changed' && p.a?.kind !== 'reply');

export type CompareSummary = { shared: number; changed: number; onlyA: number; onlyB: number; divergence: number; sentence: string; firstA: PathNode[]; firstB: PathNode[]; after: PathNode | null };

const name = (n: PathNode) => (n.kind === 'tool' ? `${n.tool!.name}${n.tool!.reportedOnly ? ' (reported only)' : ''}` : n.kind === 'approval_decision' ? `${n.decision}` : n.kind === 'boundary' ? n.boundary! : n.kind.replace('_', ' '));

export function compareSummary(pairs: AlignPair[]): CompareSummary {
  const d = pairs.findIndex(isDivergent);
  const run: AlignPair[] = [];
  if (d >= 0) for (let k = d; k < pairs.length && isDivergent(pairs[k]); k++) run.push(pairs[k]);
  const firstA = run.map((p) => p.a).filter((x): x is PathNode => !!x);
  const firstB = run.map((p) => p.b).filter((x): x is PathNode => !!x);
  const changed = new Set(run.filter((p) => p.match === 'changed').flatMap((p) => [p.a, p.b]));
  const after = d > 0 ? (pairs[d - 1].a ?? pairs[d - 1].b) : null;
  const list = (xs: PathNode[]) => (xs.length ? xs.slice(0, 4).map((x) => `${name(x)}${changed.has(x) ? ' with other args' : ''}`).join(' → ') + (xs.length > 4 ? ` → … (+${xs.length - 4})` : '') : 'nothing');
  const sentence = d < 0
    ? 'The two paths take the same steps (reply wording may still differ).'
    : `Paths split ${after ? `after ${name(after)} in turn ${after.turn}` : 'at the first step'}: A → ${list(firstA)}; B → ${list(firstB)}.`;
  return {
    shared: pairs.filter((p) => p.match === 'same').length, changed: pairs.filter((p) => p.match === 'changed').length,
    onlyA: pairs.filter((p) => p.match === 'a').length, onlyB: pairs.filter((p) => p.match === 'b').length,
    divergence: d, sentence, firstA, firstB, after,
  };
}

export type ReplyDiffRow = { turn: number; label: string; a: { text: string; metrics: ReplyMetrics | null; nodes: PathNode[] }; b: { text: string; metrics: ReplyMetrics | null; nodes: PathNode[] }; deltas: MetricDelta[] };

/** Replies per turn, side by side, with metric deltas (B minus A). The final reply of a turn carries its metrics. */
export function replyDiffs(a: PathGraph, b: PathGraph): ReplyDiffRow[] {
  const turns = [...new Set([...a.turns, ...b.turns].map((t) => t.index))].sort((x, y) => x - y);
  const side = (g: PathGraph, t: number) => {
    const rs = g.nodes.filter((n) => n.kind === 'reply' && n.turn === t);
    return { text: rs.map((r) => r.text ?? '').join('\n\n'), metrics: rs.length ? rs[rs.length - 1].metrics ?? null : null, nodes: rs };
  };
  return turns.map((t) => {
    const ta = a.turns.find((x) => x.index === t), tb = b.turns.find((x) => x.index === t);
    const sa = side(a, t), sb = side(b, t);
    return { turn: t, label: (ta ?? tb)?.label ?? `Turn ${t}`, a: sa, b: sb, deltas: metricDeltas(sa.metrics, sb.metrics) };
  }).filter((r) => r.a.nodes.length || r.b.nodes.length);
}

/** Per-step lines of an alignment, for the text alternative. */
export function describePairs(pairs: AlignPair[]): string[] {
  return pairs.map((p, i) => {
    const tag = p.match === 'same' ? 'both' : p.match === 'changed' ? 'both, differs' : p.match === 'a' ? 'only A' : 'only B';
    return `${i + 1}. [${tag}] ${describeNode((p.a ?? p.b)!)}`;
  });
}

// ------------------------------------------------------------------------------------------- case aggregate
export type CaseTrial = { key: string; runId: string; rowId: string; trial: number | null; status: string | null; caseVersion: number | null; created: string | null; graph: PathGraph };
export type AggNode = { id: string; kind: string; cls: string | null; label: string; visits: number; trials: string[]; pass: number; fail: number; other: number; meanPos: number; repeats: number; sample: PathNode | null };
export type AggEdge = { from: string; to: string; count: number; trials: string[]; pass: number; fail: number; other: number };
export type CaseGraph = { nodes: AggNode[]; edges: AggEdge[]; trials: CaseTrial[]; failOnly: string[]; passOnly: string[]; allFailing: string[]; counts: { pass: number; fail: number; other: number } };

/** The id a step takes in the case graph: tools by name, replies by type, user turns by index. */
export function aggId(n: PathNode): string | null {
  switch (n.kind) {
    case 'tool': return `${n.tool!.reportedOnly ? 'tool~' : 'tool'}:${n.tool!.name}`;
    case 'reply': return `reply:${replyType(n)}`;
    case 'user': return `user:${n.turn}`;
    case 'approval_decision': return `decision:${n.decision}`;
    case 'approval_request': return 'approval_request';
    case 'boundary': return `boundary:${n.boundary}`;
    default: return null;
  }
}
export function replyType(n: PathNode): 'ask' | 'claim' | 'long' | 'answer' {
  const m = n.metrics;
  if (!m) return 'answer';
  if (m.overLimit) return 'long';
  if (m.questions) return 'ask';
  if (m.claims.length) return 'claim';
  return 'answer';
}
const outcome = (s: string | null) => (s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'other') as 'pass' | 'fail' | 'other';

export function caseGraph(trials: CaseTrial[]): CaseGraph {
  const nodes = new Map<string, AggNode & { posSum: number; trialSet: Set<string> }>();
  const edges = new Map<string, AggEdge & { trialSet: Set<string> }>();
  const counts = { pass: 0, fail: 0, other: 0 };
  const touch = (id: string, kind: string, cls: string | null, label: string, pos: number, t: CaseTrial, sample: PathNode | null) => {
    let x = nodes.get(id);
    if (!x) { x = { id, kind, cls, label, visits: 0, trials: [], pass: 0, fail: 0, other: 0, meanPos: 0, repeats: 0, sample, posSum: 0, trialSet: new Set() }; nodes.set(id, x); }
    x.visits++; x.posSum += pos;
    if (!x.trialSet.has(t.key)) { x.trialSet.add(t.key); x[outcome(t.status)]++; }
    return x;
  };
  for (const t of trials) {
    counts[outcome(t.status)]++;
    const seq = t.graph.nodes.filter((n) => n.sequential);
    const ids: { id: string; n: PathNode | null }[] = [{ id: 'start', n: null }];
    for (const n of seq) { const id = aggId(n); if (id) ids.push({ id, n }); }
    ids.push({ id: `end:${outcome(t.status)}`, n: null });
    let prev: string | null = null;
    ids.forEach(({ id, n }, i) => {
      const pos = ids.length > 1 ? i / (ids.length - 1) : 0;
      const kind = id === 'start' || id.startsWith('end:') ? 'terminal' : n!.kind;
      const label = id === 'start' ? 'start' : id.startsWith('end:') ? (id === 'end:pass' ? 'passed' : id === 'end:fail' ? 'failed' : 'other') : n!.kind === 'tool' ? `${n!.tool!.name}${n!.tool!.reportedOnly ? ' (reported)' : ''}` : n!.kind === 'reply' ? `reply: ${replyType(n!)}` : n!.kind === 'user' ? `user turn ${n!.turn}` : n!.kind === 'approval_decision' ? `${n!.decision}` : n!.kind === 'boundary' ? n!.boundary! : 'asks approval';
      if (id === prev) { nodes.get(id)!.repeats++; return; }
      touch(id, kind, n?.tool?.cls ?? null, label, pos, t, n);
      if (prev) {
        const k = `${prev}→${id}`;
        let e = edges.get(k);
        if (!e) { e = { from: prev, to: id, count: 0, trials: [], pass: 0, fail: 0, other: 0, trialSet: new Set() }; edges.set(k, e); }
        e.count++;
        if (!e.trialSet.has(t.key)) { e.trialSet.add(t.key); e[outcome(t.status)]++; }
      }
      prev = id;
    });
  }
  const outN: AggNode[] = [...nodes.values()].map(({ posSum, trialSet, ...x }) => ({ ...x, meanPos: posSum / x.visits, trials: [...trialSet] }));
  const outE: AggEdge[] = [...edges.values()].map(({ trialSet, ...e }) => ({ ...e, trials: [...trialSet] }));
  const steps = outN.filter((x) => x.kind !== 'terminal');
  return {
    nodes: outN, edges: outE, trials, counts,
    failOnly: counts.pass ? steps.filter((x) => x.fail > 0 && x.pass === 0).map((x) => x.id) : [],
    passOnly: counts.fail ? steps.filter((x) => x.pass > 0 && x.fail === 0).map((x) => x.id) : [],
    allFailing: counts.fail ? steps.filter((x) => x.fail === counts.fail).map((x) => x.id) : [],
  };
}
