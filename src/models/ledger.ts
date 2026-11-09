// Spend ledger with a hard cap (VES-1 §11.3). Before each upstream call the worst case (input estimate + max_tokens
// at list price) is reserved; if spent + reserved + worst would pass `usd_cap`, the call is refused with
// SpendStopError (HTTP 402 -> infra_rate_limit) and the ledger stays stopped: from then on only cache hits are
// served. After the call the reservation is replaced by the actual cost; a call that died mid-flight (network,
// abort, 5xx) is charged its worst case, an upper bound, never an undercount. Agent-reported usage can be charged
// into the same pool with chargeExternal(), so `budget_usd` caps harness models + agent together.
import { SpendStopError } from '../core/errors.ts';
import type { ModelLedgerSummary, ModelPurpose, Tier } from '../core/types.ts';

export type LedgerRow = {
  at: string; purpose: ModelPurpose | 'external'; provider: string; model: string; cached: boolean;
  status: 'ok' | 'error' | 'refused'; input_tokens: number; output_tokens: number; usage_estimated: boolean;
  usd_list: number; reserved_usd: number; price_verified: boolean; request_sha256: string; error?: string;
};
const PURPOSES: ModelPurpose[] = ['judge', 'user_simulator', 'host_sim', 'intent_writer'];
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export class SpendLedger {
  cap: number; pool: Tier | 'canary'; now: () => Date;
  spent = 0;
  reserved = 0;
  stopped = false;
  rows: LedgerRow[] = [];
  nextId = 1;
  open = new Map<number, number>();
  constructor(cap: number, pool: Tier | 'canary', now: () => Date) { this.cap = Number.isFinite(cap) ? cap : 0; this.pool = pool; this.now = now; }

  /** Reserve the worst case; throws SpendStopError past the cap (and on every later call). Returns a reservation id. */
  reserve(worstUsd: number, what: string): number {
    if (this.stopped) throw new SpendStopError(`model spend stopped (${this.pool} pool cap $${this.cap}); only cached answers are served`);
    if (this.spent + this.reserved + worstUsd > this.cap + 1e-12) {
      this.stopped = true;
      throw new SpendStopError(`model spend cap reached: $${r6(this.spent)} spent + $${r6(this.reserved)} reserved + $${r6(worstUsd)} worst case for ${what} > $${this.cap} (${this.pool} pool)`);
    }
    const id = this.nextId++;
    this.open.set(id, worstUsd);
    this.reserved += worstUsd;
    return id;
  }
  settle(id: number, usd: number, row: Omit<LedgerRow, 'at' | 'usd_list' | 'reserved_usd'>): LedgerRow {
    const res = this.open.get(id) ?? 0;
    this.open.delete(id);
    this.reserved = Math.max(0, this.reserved - res);
    this.spent += usd;
    if (this.spent > this.cap + 1e-12) this.stopped = true; // actual usage beat the estimate: stop before the next call
    const full: LedgerRow = { ...row, at: this.now().toISOString(), usd_list: r6(usd), reserved_usd: r6(res) };
    this.rows.push(full);
    return full;
  }
  cached(row: Omit<LedgerRow, 'at' | 'usd_list' | 'reserved_usd' | 'cached'>): LedgerRow {
    const full: LedgerRow = { ...row, cached: true, at: this.now().toISOString(), usd_list: 0, reserved_usd: 0 };
    this.rows.push(full);
    return full;
  }
  refused(row: Omit<LedgerRow, 'at' | 'usd_list' | 'reserved_usd' | 'status' | 'cached'>, error: string): void {
    this.rows.push({ ...row, cached: false, status: 'refused', error, at: this.now().toISOString(), usd_list: 0, reserved_usd: 0 });
  }
  /** Agent-reported (or any other) spend counted against the same cap. Past the cap the ledger stops. */
  chargeExternal(usd: number, label = 'agent'): void {
    this.spent += Math.max(0, usd);
    this.rows.push({ at: this.now().toISOString(), purpose: 'external', provider: label, model: label, cached: false, status: 'ok', input_tokens: 0, output_tokens: 0,
                     usage_estimated: false, usd_list: r6(Math.max(0, usd)), reserved_usd: 0, price_verified: false, request_sha256: '' });
    if (this.spent > this.cap + 1e-12) this.stopped = true;
  }
  summary(): ModelLedgerSummary {
    const calls = this.rows.filter((r) => r.purpose !== 'external' && r.status !== 'refused');
    const by = Object.fromEntries(PURPOSES.map((p) => [p, { calls: 0, usd_list: 0 }])) as ModelLedgerSummary['by_purpose'];
    for (const r of calls) { const b = by[r.purpose as ModelPurpose]; b.calls++; b.usd_list = r6(b.usd_list + r.usd_list); }
    const usd = calls.reduce((s, r) => s + r.usd_list, 0);
    return { calls: calls.length, usd_list: r6(usd), cache_hit_ratio: calls.length ? calls.filter((r) => r.cached).length / calls.length : 0, by_purpose: by, spend_stopped: this.stopped };
  }
}
