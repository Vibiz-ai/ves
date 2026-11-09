// §5.7 infra classifier. INVALID only for: HTTP 401/402/403/429 or 5xx from the provider or host; adapter health()
// failure; a host safety-review block; an unavailable fixture. A 503 from the SIM on a write is never infra.
// NOTE: per §5.7 this classifier must meet VH-16 before it is used in a gate; that validation has not been run.
import type { InvalidReason } from '../types.ts';

export type FailureSignal = {
  origin: 'provider' | 'host' | 'sim' | 'adapter' | 'agent' | 'fixture';
  http_status?: number;
  health_failed?: boolean;
  health_reason?: InvalidReason;
  host_safety_block?: boolean;
  message?: string;
};

export function classifyFailure(sig: FailureSignal): InvalidReason | null {
  if (sig.origin === 'sim' || sig.origin === 'agent') return null; // agent-side or sim errors count as FAIL
  if (sig.origin === 'fixture') return 'fixture_unavailable';
  if (sig.health_failed) return sig.health_reason ?? 'harness_bug';
  if (sig.host_safety_block) return 'host_blocked';
  const s = sig.http_status;
  if (s === undefined) return null;
  if (s === 401 || s === 403) return 'infra_auth';
  // 402 is the VES proxy spend stop (§11.3). The result schema has no cost reason, so it maps to rate_limit;
  // the run-level status records INVALID-cost. Flagged for an amendment (open question in README).
  if (s === 402 || s === 429) return 'infra_rate_limit';
  if (s >= 500 && s <= 599 && (sig.origin === 'provider' || sig.origin === 'host')) return 'infra_upstream_5xx';
  return null;
}
