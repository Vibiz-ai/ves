// Runtime error classes shared by core and the parallel packages (importable). Kept out of types.ts, which is type-only.
// Class field initialisers are erasable TypeScript; no parameter properties.

/** The model ledger refused a call past the budget cap (VES-1 §11.3). The infra classifier maps 402 to infra_rate_limit. */
export class SpendStopError extends Error { http_status = 402; name = 'SpendStopError'; }
/** A model credential was lost (ADC refresh failed three times). Classified INVALID infra_auth; the harness decides, never process.exit. */
export class AuthLostError extends Error { http_status = 401; name = 'AuthLostError'; }
/** A harness-side defect. A row that throws this is INVALID harness_bug, never an agent FAIL. */
export class HarnessError extends Error { harness = true; name = 'HarnessError'; }
/** The fixture (state file, plant, entity list) is missing or its sha256 does not match the case. */
export class FixtureError extends Error { fixtureUnavailable = true; name = 'FixtureError'; }
/** A usage or validation error (exit code 3). */
export class UsageError extends Error { usage = true; name = 'UsageError'; }
