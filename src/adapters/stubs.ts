// STUB adapters for every §3.2 surface that is not implemented in this reference harness. Each one documents the
// headless method the standard prescribes and fails health() with a clear reason, so a run that selects it is
// INVALID (harness_bug), never a silent PASS. Nothing here makes a network or paid API call.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/hash.ts';
import { profileOf, VIBIZ_PROFILE, type SurfaceProfile } from './profiles.ts';
import type { ApproveDecision, CapabilityFlag, Collected, Fixture, InvalidReason, SayTurn, Session, SurfaceAdapter, TrialCtx } from '../types.ts';

/** Planned headless method per Vibiz surface (data in packs/vibiz/profile.json `stub_plans`). */
export const STUB_PLANS: Record<string, string> = VIBIZ_PROFILE.stub_plans;

const HERE = fileURLToPath(import.meta.url);

export class StubAdapter implements SurfaceAdapter {
  id: string; family: SurfaceProfile['family']; version = '0.0.0-stub'; p: SurfaceProfile;
  constructor(surface: string) { this.id = surface; this.p = profileOf(surface); this.family = this.p.family; }
  capabilities(): ReadonlySet<CapabilityFlag> { return new Set(this.p.caps); }
  diffsFromProd(): string[] { return [`STUB adapter: not implemented. Planned headless method: ${STUB_PLANS[this.id] ?? 'see STANDARD §3.2'}`]; }
  async routesHash(): Promise<string> { return sha256(readFileSync(HERE, 'utf8') + this.id); }
  async health(): Promise<{ ok: boolean; reason?: InvalidReason; detail?: string }> {
    return { ok: false, reason: 'harness_bug', detail: `adapter ${this.id} is a stub (${STUB_PLANS[this.id] ?? 'see §3.2'})` };
  }
  private no(): never { throw new Error(`adapter ${this.id} is a stub`); }
  async open(_f: Fixture, _c: TrialCtx): Promise<Session> { return this.no(); }
  async send(_s: Session, _t: SayTurn): Promise<void> { return this.no(); }
  async resolveApproval(_s: Session, _d: ApproveDecision): Promise<void> { return this.no(); }
  async collect(_s: Session): Promise<Collected> { return this.no(); }
  async close(): Promise<void> {}
}
