// Deterministic MOCK adapter. No model, no network. It replays the case's scripted oracle through the recording sim
// with the surface's profile (approval channel, formatter, capabilities). Behaviours:
//   oracle     — the scripted reference solution (also the `oracle` baseline, §3.2 last row)
//   trivial    — do-nothing: replies "Got it.", calls no tools (the `trivial` baseline)
//   always-act — the naive/always-act arm (§8.4): performs every forbidden or gated action at once, ignoring approval,
//                and copies planted canaries and foreign-tenant entities into its args and reply
// Faults (for tests and demos): flakyRate (seeded per trial), unsafeCases (behave always-act), breakCases (trivial).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sha256 } from '../lib/hash.ts';
import { mulberry32 } from '../lib/rng.ts';
import { durationMs } from '../lib/duration.ts';
import { type CanonicalMap, isGated } from '../lib/canonical.ts';
import { MAIN_THREAD, Sim } from '../sim/sim.ts';
import { profileOf, vibizFixtureRoot, type SurfaceProfile } from './profiles.ts';
import type { ApproveDecision, CapabilityFlag, Collected, Fixture, OracleStep, SayTurn, Session, SurfaceAdapter, TrialCtx } from '../types.ts';

export type MockBehaviour = 'oracle' | 'trivial' | 'always-act';
export type MockFaults = { flakyRate?: number; unsafeCases?: string[]; breakCases?: string[]; hostConfirmsWrites?: boolean };
export type MockOptions = { surface: string; behaviour?: MockBehaviour; faults?: MockFaults; repoRoot: string; canonical: CanonicalMap; fixtureRoot?: string };

type MockSession = Session & {
  sim: Sim; ctx: TrialCtx; behaviour: MockBehaviour; steps: OracleStep[]; ptr: number; sayLeft: number; startedAt: number;
};

const HERE = fileURLToPath(import.meta.url);

export class MockAdapter implements SurfaceAdapter {
  id: string;
  family: SurfaceProfile['family'];
  version = '1.0.0-mock';
  readonly o: MockOptions;
  readonly p: SurfaceProfile;
  constructor(o: MockOptions) {
    this.o = o;
    this.id = o.surface;
    this.p = profileOf(o.surface);
    this.family = this.p.family;
  }
  capabilities(): ReadonlySet<CapabilityFlag> { return new Set(this.p.caps); }
  diffsFromProd(): string[] {
    return [
      'MOCK adapter: no agent and no model in the loop; replays the case oracle (or a baseline behaviour) deterministically',
      'sim ledger stands in for the fake control plane / stub-upstream (writes recorded, never 503)',
      `formatter is a stand-in, not the real surface formatter (${this.p.routes.join(', ')})`,
      'verdicts from this adapter test the harness, graders and gate only; they are not evidence about Vibiz',
    ];
  }
  async routesHash(): Promise<string> {
    const self = readFileSync(HERE, 'utf8');
    const sim = readFileSync(join(HERE, '..', '..', 'sim', 'sim.ts'), 'utf8');
    return sha256(self + sim + JSON.stringify(this.p.routes));
  }
  async health() { return { ok: true }; }

  async open(_f: Fixture, ctx: TrialCtx): Promise<Session> {
    const k = ctx.case;
    const f = this.o.faults ?? {};
    let behaviour: MockBehaviour = this.o.behaviour ?? 'oracle';
    if (behaviour === 'oracle') {
      if (f.unsafeCases?.includes(k.id)) behaviour = 'always-act';
      else if (f.breakCases?.includes(k.id)) behaviour = 'trivial';
      else if (f.flakyRate && mulberry32(ctx.seed ^ 0x5eed)() < f.flakyRate) behaviour = 'trivial';
    }
    const sim = new Sim({
      repoRoot: this.o.repoRoot, fixtureRoot: this.o.fixtureRoot, case: k, surface: this.id, canonical: this.o.canonical, approvalMode: this.p.approval,
      hostFamily: this.p.host, clientInfo: this.p.clientInfo, views: this.p.views, hostConfirmsWrites: f.hostConfirmsWrites, seed: ctx.seed,
    });
    const s: MockSession = {
      id: `${ctx.runId}|${k.id}|${this.id}|${ctx.trial}`, sim, ctx, behaviour, steps: k.oracle.steps ?? [], ptr: 0,
      sayLeft: k.input.turns.filter((t) => 'say' in t || 'wake' in t).length, startedAt: Date.now(),
    };
    return s;
  }

  private reply(s: MockSession, text: string): void { s.sim.deliver(text, this.p.formatter); }

  /** Execute oracle steps up to and including the next reply (all remaining on the last user turn). Stops at a gate. */
  private advanceOracle(s: MockSession, last: boolean): void {
    while (s.ptr < s.steps.length) {
      const st = s.steps[s.ptr++];
      if ('reply' in st) { this.reply(s, st.reply); if (!last) return; continue; }
      if (isGated(this.o.canonical, st.call)) {
        if (this.p.approval === 'token') {
          const call = s.sim.callTool(st.call, st.args);
          if (call.guard_fired) { this.reply(s, 'This needs your approval first. I have opened the approval card.'); return; }
        } else {
          s.sim.requestApprovalInChat(st.call, st.args);
          this.reply(s, `Before I do this, please confirm: ${st.call} ${JSON.stringify(st.args)}. Reply yes to go ahead.`);
          return;
        }
      } else {
        s.sim.callTool(st.call, st.args);
      }
    }
  }

  private alwaysAct(s: MockSession): void {
    const k = s.ctx.case;
    const canaries = (k.fixture.plants ?? []).map((p) => p.canary);
    const foreign: string[] = [];
    for (const t of k.fixture.tenants ?? []) foreign.push(...JSON.parse(readFileSync(join(this.o.fixtureRoot ?? vibizFixtureRoot(this.o.repoRoot), t.entities_file), 'utf8')).entities);
    const oracleArgs = new Map<string, Record<string, unknown>>();
    for (const st of s.steps) if ('call' in st) oracleArgs.set(st.call, st.args);
    const targets = new Set<string>([...(k.expect.must_not_call ?? []), ...(k.expect.gated ?? []).map((g) => g.tool), ...[...oracleArgs.keys()].filter((c) => isGated(this.o.canonical, c))]);
    for (const t of targets) {
      const base = oracleArgs.get(t) ?? {};
      const args = canaries.length || foreign.length ? { ...base, text: [base.text, ...canaries, ...foreign].filter(Boolean).join(' ') } : base;
      s.sim.callTool(t, args); // no token, no approval: on token surfaces the guard records the attempt
    }
    for (const st of s.steps) if ('call' in st && !isGated(this.o.canonical, st.call)) s.sim.callTool(st.call, st.args);
    this.reply(s, ['Done, all of it.', ...canaries, ...foreign].join(' '));
  }

  async send(sess: Session, turn: SayTurn): Promise<void> {
    const s = sess as MockSession;
    s.sim.userStep(turn.say, turn.as ? { as: turn.as } : undefined);
    s.sayLeft -= 1;
    if (s.behaviour === 'trivial') return this.reply(s, 'Got it.');
    if (s.behaviour === 'always-act') { if (s.sayLeft === 0) this.alwaysAct(s); else this.reply(s, 'On it.'); return; }
    this.advanceOracle(s, s.sayLeft === 0);
  }

  async resolveApproval(sess: Session, d: ApproveDecision): Promise<void> {
    const s = sess as MockSession;
    const pending = s.sim.pending;
    const { valid } = s.sim.userApproval(d);
    if (s.behaviour !== 'oracle' || !pending) return;
    if (this.p.approval === 'token') {
      if (d === 'no' || d === 'tapback' || d === 'timeout') { this.reply(s, 'Okay, I have not done it.'); s.sim.pending = null; return; }
      // the oracle redeems the token it was handed; the server decides whether the approval is good
      const args = d === 'yes_after_args_edit' ? { ...pending.args, edited: true } : pending.args;
      const call = s.sim.callTool(pending.canonical, args, { token: pending.token, thread: pending.thread });
      s.sim.pending = null;
      if (call.guard_fired) { this.reply(s, 'That approval did not go through, so nothing was changed.'); return; }
    } else {
      s.sim.pending = null;
      if (!valid) { this.reply(s, 'I will hold off. Nothing was changed.'); return; }
      s.sim.callTool(pending.canonical, pending.args, { thread: MAIN_THREAD });
    }
    this.advanceOracle(s, s.sayLeft === 0);
  }

  async advanceClock(sess: Session, d: string): Promise<void> { (sess as MockSession).sim.advance(durationMs(d)); }
  async wake(sess: Session, scheduleId: string): Promise<void> {
    const s = sess as MockSession;
    s.sim.userStep(`[wake:${scheduleId}]`, { wake: scheduleId, human_present: false });
    s.sayLeft -= 1;
    if (s.behaviour === 'trivial') return;
    if (s.behaviour === 'always-act') return this.alwaysAct(s);
    this.advanceOracle(s, s.sayLeft === 0);
  }

  async collect(sess: Session): Promise<Collected> {
    const s = sess as MockSession;
    const sim = s.sim;
    const traceId = sha256(s.id).slice(0, 32);
    const ranks: Record<string, number> = {};
    for (const c of sim.serverCalls) ranks[c.canonical] ??= 1; // the mock always routes to the tool it calls
    return {
      atif: {
        schema_version: 'ATIF-v1.8', session_id: s.id,
        agent: { name: `mock:${s.behaviour}`, version: this.version, model_name: 'none' },
        steps: sim.steps,
        final_metrics: { total_steps: sim.steps.length, tool_calls: sim.serverCalls.length },
        subagent_trajectories: [],
        vibiz: { surface: this.id, approval_events: sim.approvalEvents, upstream_writes: sim.upstreamWrites.length },
      },
      otelTraceId: traceId,
      serverCalls: sim.serverCalls, upstreamWrites: sim.upstreamWrites, approvalEvents: sim.approvalEvents,
      sideEffects: sim.sideEffects, snapshot: sim.snapshot, delivered: sim.delivered,
      usage: { wall_ms: Date.now() - s.startedAt, input_tokens: 0, output_tokens: 0, usd_list: 0, tool_calls: sim.serverCalls.length, invalid_tool_calls: 0, format_failures: 0 },
      host: { family: this.p.host, clientInfo: this.p.clientInfo, model: 'none' },
      context: { canaries: (s.ctx.case.fixture.plants ?? []).map((p) => p.canary), foreignEntities: [], routingRanks: ranks },
    };
  }
  async close(): Promise<void> {}
}
