// Efficiency metrics (advisory, never gating). Per trial they are written into the result row (`usage.tool_calls`,
// `usage.duplicate_tool_calls`, `usage.turns`, `trace.host_reported_matched`); per variant they are aggregated into
// run-extra.json `efficiency` and the card's "Efficiency" section. Nothing here feeds the gate.
//
// Counting rule: each tool call counts once. A host-reported call (the agent's own `tool_event`) that describes a
// proxied call of the same turn (name modulo `tools.reported_prefixes` / `tools.reported_aliases`, args agreeing on
// every key both sides have, paired in order) is the same call, and the proxied/ledger record wins
// (src/graders/claims.ts dedupeCalls). Duplicates are calls with the
// same tool and the same canonical args as an earlier call in the trial.
import { percentile } from '../lib/stats.ts';
import { dedupeCalls, segmentTurns, type ReportedNames } from '../graders/claims.ts';
import type { AtifStep, ServerCall } from '../types.ts';

/** A variant is flagged when more than this share of its tool calls repeat an earlier call (same tool, same args). */
export const DUPLICATE_FLAG_RATE = 0.2;

export type TrialEfficiency = { tool_calls: number; duplicate_tool_calls: number; host_reported_matched: number; turns: number };

/** Per-trial counts from the trajectory steps (live: with the trial's ServerCalls; stored: from the ATIF alone). */
export function trialEfficiency(steps: AtifStep[], o: { serverCalls?: ServerCall[]; names?: ReportedNames } = {}): TrialEfficiency {
  const turns = segmentTurns(steps, o.serverCalls ? new Map(o.serverCalls.map((s) => [s.id, s])) : undefined);
  const d = dedupeCalls(turns, o.names ?? {});
  return { tool_calls: d.calls.length, duplicate_tool_calls: d.duplicates, host_reported_matched: d.matched, turns: turns.length - 1 };
}

type RowLike = { row_id: string; surface: string; status: string; usage: { tool_calls?: number; duplicate_tool_calls?: number; turns?: number; input_tokens?: number; output_tokens?: number; usd_list?: number; wall_ms: number } };
export type VariantEfficiency = {
  trials: number; passing: number;
  tool_calls: number; tool_calls_per_trial: number | null; duplicate_tool_calls: number; duplicate_rate: number | null;
  turns: number; turns_per_trial: number | null;
  /** Mean tool calls over PASSING trials. */
  tool_calls_per_success: number | null;
  /** Trials that reported token usage (the rest are unmeasured, not zero). */
  usage_reported_trials: number;
  /** Mean input+output tokens over trials with reported usage / over passing trials with reported usage. */
  tokens_per_trial: number | null; tokens_per_success: number | null;
  /** Total agent-reported USD over all trials divided by the number of passing trials (cost of one success). */
  usd_per_success: number | null;
  wall_ms_p50: number | null; wall_ms_p95: number | null;
  flags: string[];
};

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const tokensOf = (r: RowLike): number | null => (r.usage.input_tokens === undefined && r.usage.output_tokens === undefined ? null : (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0));

/** Aggregate per variant over evaluated trials (pass/fail; skips, INVALID rows, smoke retries and confirmations excluded). */
export function aggregateEfficiency(rows: RowLike[], variants: string[], retry: ReadonlySet<string> = new Set()): Record<string, VariantEfficiency> {
  const out: Record<string, VariantEfficiency> = {};
  for (const v of variants) {
    const rs = rows.filter((r) => r.surface === v && (r.status === 'pass' || r.status === 'fail') && !retry.has(r.row_id));
    const ok = rs.filter((r) => r.status === 'pass');
    const tc = rs.reduce((a, r) => a + (r.usage.tool_calls ?? 0), 0);
    const dup = rs.reduce((a, r) => a + (r.usage.duplicate_tool_calls ?? 0), 0);
    const turns = rs.reduce((a, r) => a + (r.usage.turns ?? 0), 0);
    const tok = rs.map(tokensOf).filter((x): x is number => x !== null);
    const tokOk = ok.map(tokensOf).filter((x): x is number => x !== null);
    const usdRows = rs.filter((r) => typeof r.usage.usd_list === 'number');
    const usd = usdRows.reduce((a, r) => a + (r.usage.usd_list ?? 0), 0);
    const wall = rs.map((r) => r.usage.wall_ms).filter((x) => typeof x === 'number');
    const rate = tc ? dup / tc : null;
    const flags: string[] = [];
    if (rate !== null && rate > DUPLICATE_FLAG_RATE) flags.push(`duplicate tool calls ${(rate * 100).toFixed(0)}% > ${DUPLICATE_FLAG_RATE * 100}% (same tool, same args)`);
    out[v] = {
      trials: rs.length, passing: ok.length,
      tool_calls: tc, tool_calls_per_trial: rs.length ? tc / rs.length : null, duplicate_tool_calls: dup, duplicate_rate: rate,
      turns, turns_per_trial: rs.length ? turns / rs.length : null,
      tool_calls_per_success: mean(ok.map((r) => r.usage.tool_calls ?? 0)),
      usage_reported_trials: tok.length, tokens_per_trial: mean(tok), tokens_per_success: mean(tokOk),
      usd_per_success: usdRows.length && ok.length ? usd / ok.length : null,
      wall_ms_p50: percentile(wall, 50) ?? null, wall_ms_p95: percentile(wall, 95) ?? null,
      flags,
    };
  }
  return out;
}

const n1 = (x: number | null) => (x === null ? 'n/a' : Number.isInteger(x) ? String(x) : x.toFixed(1));
/** Markdown section for card.md. */
export function renderEfficiency(eff: Record<string, VariantEfficiency>): string[] {
  const L = ['## Efficiency (advisory, never gating)', '',
    '| variant | trials (pass) | tool calls / trial | duplicates | turns / trial | tool calls / success | tokens / trial | tokens / success | USD / success | wall p50 / p95 ms |',
    '|---|---|---|---|---|---|---|---|---|---|'];
  for (const [v, e] of Object.entries(eff)) {
    L.push(`| ${v} | ${e.trials} (${e.passing}) | ${n1(e.tool_calls_per_trial)} | ${e.duplicate_tool_calls}${e.duplicate_rate !== null ? ` (${(e.duplicate_rate * 100).toFixed(0)}%)` : ''}${e.flags.length ? ' **FLAG**' : ''} | ${n1(e.turns_per_trial)} | ${n1(e.tool_calls_per_success)} | ${e.usage_reported_trials ? n1(e.tokens_per_trial) : 'not reported'} | ${e.usage_reported_trials ? n1(e.tokens_per_success) : 'not reported'} | ${e.usd_per_success === null ? 'n/a' : `$${e.usd_per_success.toFixed(4)}`} | ${n1(e.wall_ms_p50)} / ${n1(e.wall_ms_p95)} |`);
  }
  L.push('', `Each tool call counts once: a host-reported call that matches a proxied call in the same turn is not counted again. Duplicates repeat an earlier call (same tool, same canonical args); a variant is flagged above ${DUPLICATE_FLAG_RATE * 100}%. Tokens and USD are what the agent reported (\`usage\`); trials without a report are unmeasured, not zero.`);
  for (const [v, e] of Object.entries(eff)) for (const f of e.flags) L.push(`- **${v}**: ${f}`);
  L.push('');
  return L;
}
