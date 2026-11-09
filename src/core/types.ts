// VES core contract types (DESIGN-agnostic §1.2, §2, §3, §7.2-§7.5). TYPES ONLY: this file has no runtime code, so it
// is erasable TypeScript (no enums, no namespaces, no parameter properties). Builders of the parallel packages
// (connectors, packs, ci, models) import from here and from the "importable" core modules listed in DESIGN §7.1.
// Runtime error classes live in src/core/errors.ts.
import type {
  ApprovalEvent, Collected, InvalidReason, LoadedCase, ResultRow, Score, SideEffect, Tier, Verdict,
} from '../types.ts';
import type { RuleStatus } from '../gate/gate.ts';
import type { GradeCtx } from '../graders/index.ts';
import type { ClaimsConfig, ReportedNames } from '../graders/claims.ts';
import type { VariantEfficiency } from '../report/efficiency.ts';

export type * from '../types.ts';
export type { RuleStatus } from '../gate/gate.ts';

// ======================================================================================================== JSON
export type JsonSchema = Record<string, unknown> | boolean;

// ======================================================================================== §2.3 tool catalog
export type ToolClass = 'read' | 'write' | 'spend' | 'outward' | 'destructive' | 'gated';
/** In-memory backend spec for one tool (§1.6). Templated strings use `{{args.x}}`, `{{id}}`, `{{now}}`, `{{principal.tenant}}`. */
export type SimSpec = {
  read?: string; where?: Record<string, unknown>; tenant_key?: string;
  append?: string; set?: string; value?: unknown; delete?: string;
  returns?: unknown;
  fail_first?: { error: string; times: number; details?: unknown };
  fail_always?: { error: string; details?: unknown };
};
/** One `tools.catalog[]` entry as written in ves.config.json. */
export type CatalogEntry = {
  name: string; classes: ToolClass[]; title?: string; description?: string;
  input_schema?: JsonSchema; output_schema?: JsonSchema; gated?: boolean;
  normalise?: Record<string, 'lower' | 'upper' | 'trim'>; ignore_args?: string[];
  aliases?: Record<string, string>; effect?: string; sim?: SimSpec;
  examples?: { say: string; args: Record<string, unknown> }[];
  review?: 'suggested' | 'confirmed';
  /** MCP annotations seen at import (advisory only, never decide gating; VES-1 §8.2 G6). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};
/** A resolved catalog tool: implied `write` added, `gated` decided, schema hash computed. */
export type CatalogTool = Omit<CatalogEntry, 'classes' | 'gated'> & {
  classes: ToolClass[];                // never contains 'gated' (that is the `gated` flag); read is exclusive
  gated: boolean;
  gated_reason: 'explicit' | 'class' | 'unreviewed' | 'none' | 'explicit-false';
  input_schema: JsonSchema;
  schema_sha256: string;               // sha256(canonicalJson(input_schema))
  risk: number;                        // destructive 4 > spend 3 > outward 2 > write 1 > read 0
};
export type Catalog = {
  tools: CatalogTool[];                // stable order: risk desc, then name
  byName: Record<string, CatalogTool>;
  gate_classes: ToolClass[];
  sha256: string;                      // catalog_sha256 in the run manifest
  loosened: string[];                  // e.g. "tools.issue_refund.gated=false"
  warnings: string[];
};

// ============================================================================================ §1.2 ves-agent/1
export type PrincipalRole = 'owner' | 'member' | 'outsider' | 'system';
export type HitlDecisionKind = 'approve' | 'reject' | 'timeout' | 'ambiguous';
export type ToolSpec = { name: string; title?: string; description?: string; input_schema: JsonSchema; output_schema?: JsonSchema;
                         classes: ToolClass[]; gated: boolean };
export type ToolTransport = {
  pipe: true;
  mcp?: { url: string; headers?: Record<string, string> };
  mcp_stdio?: { command: string; args: string[]; env?: Record<string, string> };
  http?: { url: string; headers?: Record<string, string> };
};
export type HarnessToAgent =
  | { type: 'session.open'; v: 1; session_id: string; case_id: string; trial: number; seed: number;
      clock: string; variant: string;
      principal: { role: PrincipalRole; tenant?: string; id: string };
      tools: ToolSpec[]; tool_transport: ToolTransport;
      context?: Record<string, unknown>; system?: string }
  | { type: 'turn'; session_id: string; turn_id: string; text: string; as: PrincipalRole; thread: string }
  | { type: 'hitl.decision'; session_id: string; request_id: string; decision: HitlDecisionKind;
      as: PrincipalRole; thread: string; text?: string;
      /** The human approved but changed the details: the approval is VOID (for the requested args and for these). */
      args_edited?: Record<string, unknown> }
  | { type: 'tool_result'; session_id: string; call_id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'clock.advance'; session_id: string; duration: string; now: string }
  | { type: 'wake'; session_id: string; schedule_id: string }
  | { type: 'session.close'; session_id: string }
  | { type: 'shutdown' };
export type AgentToHarness =
  | { type: 'ready'; protocol: 'ves-agent/1';
      agent: { name: string; version?: string; framework?: string; model?: string };
      capabilities?: string[];
      tools?: { name: string; description?: string; input_schema?: JsonSchema }[] }
  | { type: 'session.opened'; session_id: string }
  | { type: 'message'; session_id: string; turn_id?: string; text: string; parts?: string[]; cards?: number }
  | { type: 'tool_call'; session_id: string; call_id: string; name: string; args: Record<string, unknown> }
  | { type: 'hitl.request'; session_id: string; request_id: string; tool: string; args: Record<string, unknown>; prompt?: string }
  | { type: 'tool_event'; session_id: string; call_id: string; name: string; args: Record<string, unknown>; ok?: boolean; result?: unknown }
  | { type: 'effect'; session_id: string; kind: string; args?: Record<string, unknown> }
  | ({ type: 'usage'; session_id: string } & TurnUsage)
  /** `usage`: the turn's total agent usage. When present it supersedes every `usage` message of that turn. */
  | { type: 'turn.end'; session_id: string; turn_id: string; reason: 'done' | 'awaiting_hitl' | 'error'; error?: string; http_status?: number; usage?: TurnUsage }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string }
  | { type: 'error'; session_id?: string; message: string; fatal?: boolean; http_status?: number };

/** Agent-reported usage (ves-agent/1): on `turn.end.usage` (preferred, the turn's total) or a `usage` message.
 * `usd_estimated: true` says the agent computed `usd` from tokens and a price table rather than from a bill. */
export type TurnUsage = { model?: string; input_tokens?: number; output_tokens?: number; usd?: number; usd_estimated?: boolean };

// ================================================================================ §1.1 observation levels
export type ObservationLevel = 'ledger' | 'proxied' | 'traced' | 'reported';

// ========================================================================================= §2 ves.config.json
export type ConnectionKind = 'command' | 'http' | 'openai-chat' | 'mcp' | 'trace' | 'mock';
export type ConnectionConfig = { type: ConnectionKind; [k: string]: unknown };
export type VariantRole = 'agent' | 'host-sim' | 'contract';
export type VariantFormat = { max_chars?: number; max_parts?: number; split?: 'paragraph' | 'none'; split_at?: number };
export type HitlConfig = {
  mode: 'auto' | 'structured' | 'chat'; binding: 'args' | 'thread'; ttl_s: number; authorized: PrincipalRole[];
  chat_phrases: Record<'approve' | 'reject' | 'ambiguous', string>;
};
export type VariantConfig = {
  connection?: Partial<ConnectionConfig>; role?: VariantRole; capabilities?: string[]; format?: VariantFormat;
  hitl?: Partial<HitlConfig>; tools?: { include?: string[]; exclude?: string[] }; host?: { family: string; model?: string };
  explicit_only?: boolean;
};
export type TierConfig = { k?: number; k_safety?: number; variants?: string[]; max_trials?: number; budget_usd?: number; timeout_min?: number; packs?: string[] };
export type GateConfig = {
  delta: number; invalid_share_max: number; trivial_max: number; oracle_hit_min: number; over_refusal_points: number;
  safety_observation: 'proxied' | 'ledger'; auto_class3: boolean;
  expected_failures?: string; accepted_risks?: string;
  require_commit_sha?: boolean;
};
/** `fake` is the offline deterministic provider (tests, demos; src/models/fake.ts), never billed. */
export type ModelRef = { provider: 'vertex' | 'openai-compatible' | 'fake'; model: string; project?: string; location?: string;
                         base_url?: string; api_key_env?: string; params?: Record<string, unknown>; rpm?: number };
export type ModelsConfig = {
  default?: ModelRef; judge?: string | ModelRef; user_simulator?: string | ModelRef; host_sim?: string | ModelRef; intent_writer?: string | ModelRef;
  named?: Record<string, ModelRef>;
};
export type PackRef = { id: string; version?: string; options?: Record<string, unknown> };
export type ForwardBackendConfig =
  | { type: 'mcp'; url?: string; command?: string[]; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'command'; command: string[] }
  | { type: 'bridge' };
export type ToolsConfig = {
  backend: { type: 'sim' } | ({ type: 'forward'; guard_signal?: { pointer: string; equals: unknown } } & { target: ForwardBackendConfig });
  gate_classes: ToolClass[];
  catalog: CatalogEntry[];
  schemas_from?: 'bridge' | 'mcp' | 'inline' | string;
  /** Upstream ledger (§1.6): GET url -> `[{tool,args,invocation?}]`, or `{rows, state?}` where `state` is the backend's
   *  own state snapshot (graded by expect.state on a forward backend). */
  ledger?: { url?: string; command?: string[] };
  /** Namespace prefixes the agent's own (host-reported) tool events carry, e.g. ["eve."]. Stripped only to match a
   *  self-report to the proxied call it describes (tool-call dedupe, claim explanations); never used for grading. */
  reported_prefixes?: string[];
  /** Host-reported name (after the prefix) -> catalog tool name, when several host tools share one proxied route,
   *  e.g. {"ads_campaigns_list": "ads_read"}. Same scope as reported_prefixes. */
  reported_aliases?: Record<string, string>;
};
export type FixturesConfig = {
  state?: string | Record<string, unknown>;
  principal: { role: PrincipalRole; tenant?: string; id: string };
  context?: Record<string, unknown>;
  tenants?: { id: string; state?: string; entities?: string[]; entities_file?: string }[];
};
/** ves.config.json as written (after JSON.parse). */
export type VesConfig = {
  $schema?: string; schema_version: 'ves-config/1'; project: string;
  agent: { name: string; framework?: string; model?: string; connection: ConnectionConfig };
  tools: Partial<ToolsConfig> & { catalog: CatalogEntry[] };
  hitl?: Partial<HitlConfig>; fixtures?: Partial<FixturesConfig>; variants?: Record<string, VariantConfig>;
  packs?: (string | PackRef)[]; suites?: string[]; tiers?: Partial<Record<Tier, TierConfig>>;
  change_classes?: Partial<Record<'0' | '1' | '2', string[]>>; gate?: Partial<GateConfig>; models?: ModelsConfig;
  results?: { dir?: string }; profile?: string;
  /** Grader settings: `claims` (claims_vs_ledger / silent_actions lexicon and map, src/graders/claims.ts). */
  graders?: { claims?: ClaimsConfig };
  /** Run history store; excluded from config_sha256 (README "History & comparisons"). */
  store?: { url?: string; project?: string; auto_push?: boolean };
};
export type ResolvedVariant = {
  name: string; role: VariantRole; connection: ConnectionConfig; capabilities: string[]; format: VariantFormat;
  hitl: HitlConfig; tools: { include?: string[]; exclude?: string[] }; host: { family: string; model?: string }; explicit_only: boolean;
};
export type ResolvedConfig = {
  path: string | null; dir: string; sha256: string;
  /** The unresolved template (`${VAR}` kept); this is what config.snapshot.json stores. */
  snapshot: VesConfig;
  project: string;
  agent: { name: string; framework?: string; model?: string; connection: ConnectionConfig };
  tools: ToolsConfig;
  hitl: HitlConfig;
  fixtures: FixturesConfig;
  variants: Record<string, ResolvedVariant>;
  packs: PackRef[];
  suites: string[];                     // absolute dirs
  tiers: Record<Tier, Required<Pick<TierConfig, 'k' | 'k_safety' | 'budget_usd' | 'timeout_min'>> & TierConfig>;
  change_classes: Partial<Record<'0' | '1' | '2', string[]>>;
  gate: GateConfig;
  models: ModelsConfig;
  results: { dir: string };
  graders: { claims: ClaimsConfig };
  intents_path: string;
  conformance: 'VES-1' | 'custom';
  loosened: string[];
  notes: string[];                      // non-conformance notes for the card, e.g. "approval binding: thread (weaker)"
  profile?: string;
};

// ============================================================================================== §3 case v2
export type ToolRef = string;          // a catalog tool name or 'class:<c>'
export type CallMatcher2 = { tool?: string; class?: ToolClass; args?: Record<string, unknown>; order?: number; min?: number; max?: number };
export type EffectMatcher = { tool?: string; class?: ToolClass; alias?: string; match?: Record<string, unknown>; count?: { min?: number; max?: number } };
export type Expect2 = {
  calls?: CallMatcher2[]; must_not_call?: ToolRef[]; gated?: { tool: string }[];
  effects?: EffectMatcher[]; no_outward_side_effects?: boolean;
  hitl?: { requested?: { min?: number; max?: number }; before?: string };
  state?: { pointer: string; equals?: unknown; exists?: boolean }[];
  facts?: string[]; forbid?: string[];
  format?: { max_chars?: number; max_parts?: number; no_cards?: boolean };
  judge?: { dimension: string; rubric_ref: string; reference: string }[];
};
export type Turn2 =
  | { say: string; as?: PrincipalRole; thread?: 'main' | 'other' }
  | { hitl: HitlDecisionKind; as?: PrincipalRole; thread?: 'main' | 'other'; args_edited?: Record<string, unknown>; text?: string }
  | { advance_clock: string }
  | { wake: string }
  | { rpc: { method: string; params?: Record<string, unknown> } };
export type OracleStep2 =
  | { call: string; args: Record<string, unknown> }
  | { ask: { tool: string; args: Record<string, unknown>; prompt?: string } }
  | { reply: string };
export type Plant2 = { at: { tool: string; path?: string } | { location: string }; ref?: string; text?: string; canary: string };
export type Fixture2 = {
  state?: string | Record<string, unknown>; state_sha256?: string; seed: number; clock: string;
  principal?: { role?: PrincipalRole; tenant?: string; id?: string }; context?: Record<string, unknown>;
  tenants?: { id: string; state?: string; entities_file?: string; entities?: string[] }[];
  plants?: Plant2[]; tool_overrides?: Record<string, SimSpec>;
};
// ---- persona cases (VES-1 §2 persona input; scores from simulated users are advisory, §12)
export type PersonaTemperament = 'eager' | 'busy' | 'cold' | 'sceptical' | 'irritable' | 'vague' | 'goal_changing';
/** How the person types. Every field optional; rendered into the user-simulator prompt. */
export type PersonaStyle = {
  length?: 'terse' | 'short' | 'medium' | 'long'; typos?: 'none' | 'some' | 'many'; emoji?: 'none' | 'some' | 'many';
  impatience?: 0 | 1 | 2 | 3; formality?: 'casual' | 'neutral' | 'formal'; notes?: string;
};
/** The person fields shared by a library file (`personas/<id>.persona.json`) and an inline case persona. */
export type PersonaFields = {
  name?: string; background?: string; languages?: string[]; style?: PersonaStyle; opening?: string;
  temperament?: PersonaTemperament | PersonaTemperament[]; goal?: string; max_user_turns?: number;
};
/** `ves-persona/1`: one reusable person. `id` equals the file stem. */
export type PersonaFile = PersonaFields & { schema_version: 'ves-persona/1'; id: string; notes?: string };
/** `case.input.persona`: inline (`id` + `temperament` + `goal`) or a library reference (`ref`) with per-case overrides. */
export type CasePersona = PersonaFields & { id?: string; ref?: string };
/** A persona after library resolution: what the simulator, the graders and the result row see. */
export type ResolvedPersona = {
  id: string; ref?: string; name?: string; background?: string; languages?: string[]; style?: PersonaStyle; opening?: string;
  temperament: PersonaTemperament[]; goal: string; max_user_turns: number;
};
export type PersonaStopKind = 'goal_met' | 'gave_up' | 'max_turns' | 'other';
export type PersonaOutcome = {
  goal_met: 'yes' | 'partly' | 'no' | 'unknown'; gave_up: boolean | null; frustration: number | null; tone_fit: number | null; why: string;
  judge?: { model: string; prompt_sha256: string }; parse_error?: string;
};
/** What one persona conversation produced (Collected2.persona, ResultRow2.persona). */
export type PersonaRecord = Pick<ResolvedPersona, 'id' | 'ref' | 'name' | 'temperament' | 'goal' | 'background' | 'languages' | 'max_user_turns'> & {
  user_turns: number;
  stop: { kind: PersonaStopKind; reason: string; at_turn: number };
  simulator: { model: string; prompt_sha256: string };
  metrics: { user_turns: number; turns_to_goal: number | null; reply_chars_per_turn: number[]; mean_reply_chars: number | null; language_match: boolean | null; reply_languages?: (string | null)[] };
  outcome?: PersonaOutcome;
};
export type GraderSpec2 = { id: string; role: 'gate' | 'advisory'; params?: Record<string, unknown> };
export type PackProvenance = { id: string; version: string; template: string; bindings?: Record<string, string> };
export type Case2 = {
  schema_version: 'ves-case/2'; id: string; version: number; capability?: string;
  suite: 'smoke' | 'regression' | 'capability' | 'safety' | 'sealed'; safety?: string; tags?: string[];
  variants?: string[]; requires?: string[]; owner: string;
  provenance: { author: string; created: string; source: 'hand' | 'production-failure' | 'red-team' | 'generated' | 'migrated';
                source_ref?: string; redacted?: boolean; blind_to?: string[]; pack?: PackProvenance;
                /** `ves cases from-trace`: the run and row the case was captured from, and when. */
                run_id?: string; row_id?: string; captured_at?: string };
  fixture: Fixture2;
  input: { turns?: Turn2[]; persona?: CasePersona; trace?: { file: string; format: 'otel-genai' | 'atif' | 'openai-agents' } };
  expect: Expect2; graders?: GraderSpec2[];
  overrides?: Record<string, { expect?: Partial<Expect2>; skip?: string }>;
  twin?: string;
  oracle: { kind: 'scripted' | 'refusal'; steps?: OracleStep2[] };
  trials?: { k_min?: number }; limits?: { timeout_s?: number; max_tool_calls?: number };
};
export type LoadedCase2 = Case2 & {
  __file: string; __sha256: string;
  /** Directory relative fixture paths resolve against first (the case file's dir, or the pack dir for expansions). */
  __dir: string;
  /** Fallback dirs for fixture paths (pack dir, then config fixtures dir). */
  __fixture_dirs: string[];
  /** Templates tagged with tiers ([] = all tiers). */
  __tiers?: Tier[];
  /** True when added or changed in the PR under test (forced advisory, §6.4). */
  __new?: boolean;
  /** Loaded from --extra-cases (the PR head's added/changed case files when the suite comes from the base). */
  __extra?: boolean;
  /** A persona case after library resolution (src/cases/personas.ts). */
  __persona?: ResolvedPersona;
};
export type AnyLoadedCase = LoadedCase | LoadedCase2;

// ======================================================================================= §3.4 HITL events
export type ApprovalEventV2 = Omit<ApprovalEvent, 'kind' | 'principal'> & {
  /** `*_edited`: an approve whose details the human changed. G1 never accepts it (the edit voids the approval). */
  kind: ApprovalEvent['kind'] | 'hitl_approve' | 'hitl_reject' | 'hitl_ambiguous' | 'hitl_approve_edited' | 'chat_yes_edited';
  binding: 'args' | 'thread';
  principal: 'owner' | 'member' | 'outsider' | 'host' | 'none' | 'system';
  request_id?: string;
};
/** v2 side effect: kind is free ('tool:<name>', 'class:<c>', an alias, 'hitl_requested'); observation says who saw it. */
export type SideEffect2 = Omit<SideEffect, 'kind'> & { kind: string; tool?: string; classes?: ToolClass[]; observation: ObservationLevel };
/** Collected (v1 shape) widened for v2 records. */
export type Collected2 = Omit<Collected, 'sideEffects' | 'approvalEvents'> & {
  sideEffects: SideEffect2[]; approvalEvents: ApprovalEventV2[]; observation: ObservationLevel;
  hitlRequests: { request_id: string; tool: string; args: Record<string, unknown>; args_hash: string; thread: string; seq: number; at: string; prompt?: string; by: 'agent' | 'host-sim' | 'mock' }[];
  /** Calls the proxy rejected as unknown_tool or invalid_args. */
  invalidToolCalls: number;
  /** Tools the agent declared (ready.tools) that the proxy does not serve (recorder coverage, §1.1). */
  unproxied: string[];
  /** Where tool calls executed: the harness sim (state observable) or a forward backend (the team's server). */
  backend?: 'sim' | 'forward';
  /** Where `snapshot` came from: the harness sim, or the upstream ledger's `state` (a forward backend's own state). */
  stateSource?: 'harness' | 'upstream';
  /** Host-reported calls that described a proxied call of the same turn (counted once; src/report/efficiency.ts). */
  hostReportedMatched?: number;
  /** A persona case: the simulated conversation's record (src/runner/persona-loop.ts). */
  persona?: PersonaRecord;
};

// =================================================================================== §3.7 result-2 / run-2
export type Score2 = Score & { implicit?: boolean; safety?: boolean };
export type ResultRow2 = Omit<ResultRow, 'schema_version' | 'scores' | 'host' | 'trace' | 'agent'> & {
  schema_version: 'ves-result/2'; scores: Score2[];
  agent: { model: string; commit: string; prompt_sha256?: string; catalog_sha256?: string };
  host: { family: string; model?: string; protocol_version?: string; toolset?: string; client_info?: string };
  trace: ResultRow['trace'] & { observation?: ObservationLevel };
  pack?: { id: string; version: string; template: string };
  persona?: PersonaRecord;
};

// ====================================================================== §7.2 core <-> connectors interfaces
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string>; body?: ReadableStream<Uint8Array> | null }>;
export type SpawnLike = (cmd: string, args: string[], o: { cwd: string; env: Record<string, string> }) => ChildLike;
export type ChildLike = { stdin: { write(s: string): boolean; end(): void }; stdout: AsyncIterable<string>; stderr: AsyncIterable<string>;
                          kill(sig?: string): void; exited: Promise<{ code: number | null; signal: string | null }> };
export type Health = { ok: boolean; reason?: InvalidReason; detail?: string };
export type AgentInfo = { name: string; version?: string; framework?: string; model?: string; protocol?: string;
                          declaredTools?: { name: string; description?: string; input_schema?: unknown }[];
                          capabilities: string[]; diffsFromProd: string[] };
export type ConnectorDeps = {
  fetch: FetchLike; spawn: SpawnLike; env: Record<string, string | undefined>; now: () => Date;
  models: ModelsApi; log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  repoRoot: string; configDir: string; variant: string; catalog: Catalog;
};
export interface ConnectorFactory { kind: ConnectionKind; version: string; create(cfg: ConnectionConfig, deps: ConnectorDeps): Connector }
export type SessionOpen = Extract<HarnessToAgent, { type: 'session.open' }>;
export type ConnSession = { id: string; [k: string]: unknown };
export type TurnOutcome = { status: 'done' | 'awaiting_hitl' | 'error'; error?: { message: string; http_status?: number; origin: 'agent' | 'provider' | 'host' } };
export type UserTurn = { text: string; as: PrincipalRole; thread: string; turn_id: string };
export type HitlDecision = { request_id: string | null; decision: HitlDecisionKind; as: PrincipalRole; thread: string; text?: string; args_edited?: Record<string, unknown> };
export interface HarnessIO {
  /** The ONLY way to produce proxied tool records. Connectors that receive tool_call (pipe, openai-chat, host-sim) MUST use it. */
  callTool(c: { call_id: string; name: string; args: Record<string, unknown>; thread?: string; transport: 'pipe' | 'mcp' | 'http' | 'loop' })
    : Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** Everything else the agent emits: message, hitl.request, tool_event/effect (self-reported), usage, log. */
  report(ev: AgentToHarness, level?: 'traced' | 'reported'): void;
  /** Endpoints to put in session.open.tool_transport (already started by core for this trial). */
  toolTransport(): ToolTransport;
}
export interface Connector {
  readonly kind: ConnectionKind; readonly version: string;
  health(): Promise<Health>;
  info(): Promise<AgentInfo>;
  capabilities(): ReadonlySet<string>;
  routesHash(): Promise<string>;
  open(o: SessionOpen, io: HarnessIO): Promise<ConnSession>;
  turn(s: ConnSession, t: UserTurn): Promise<TurnOutcome>;
  decide(s: ConnSession, d: HitlDecision): Promise<TurnOutcome>;
  rpc?(s: ConnSession, r: { method: string; params?: Record<string, unknown> }): Promise<TurnOutcome>;
  advanceClock?(s: ConnSession, duration: string, now: string): Promise<TurnOutcome>;
  wake?(s: ConnSession, scheduleId: string): Promise<TurnOutcome>;
  close(s: ConnSession): Promise<void>;
  dispose?(): Promise<void>;
}
/** Trace connector extra: core calls this instead of turns when case.input.trace is set. */
export interface TraceConnector extends Connector { ingest(s: ConnSession, trace: { file: string; format: string }): Promise<TurnOutcome> }
/** MCP contract/host-sim extra: the upstream ledger, when configured. */
export interface LedgerSource { readLedger(s: ConnSession): Promise<{ tool: string; args: Record<string, unknown>; invocation?: string }[]> }

// ============================================================================ §7.3 core <-> packs interfaces
export type ToolSelector = { classes_any?: ToolClass[]; classes_all?: ToolClass[]; classes_none?: ToolClass[]; gated?: boolean;
                             returns_text?: boolean; has_required_args?: boolean; distinct_from?: string; name_matches?: string };
export type PackManifest = {
  schema_version: 'ves-pack/1'; id: string; version: string; released: string; title: string; purpose: string;
  suite?: Case2['suite']; safety?: string; tags?: string[];
  requires?: { tools?: (ToolSelector & { min?: number })[]; capabilities_any?: string[]; variant_roles_any?: VariantRole[]; profile?: string };
  defaults?: { limit?: number; state?: string; foreign_tenant?: string; [k: string]: unknown };
  options?: Record<string, JsonSchema>;
  /** Static case directories shipped with the pack (relative to the pack dir), e.g. the Vibiz v1 cases. */
  cases?: string[];
  /** For a profile pack (vibiz): the profile file. */
  profile?: string;
};
export type PackTemplate = {
  template: string; version: number; tiers?: Tier[];
  for_each?: Record<string, ToolSelector | number | string> & { limit?: number | string };
  twin_of?: string | null;
  case: Record<string, unknown>;
};
export type IntentsLock = { schema_version: 'ves-intents/1'; entries: Record<string, { say: string; args: Record<string, unknown> }[]> };
export type ExpandCtx = { pack: PackManifest; options: Record<string, unknown>; catalog: Catalog; config: ResolvedConfig;
                          intents: IntentsLock; seedOf(parts: string[]): number; synthArgs(schema: unknown, seed: number): Record<string, unknown> | null;
                          canary(seed: number, n: number): string; select(sel: ToolSelector, limit: number): CatalogTool[] };
export type GraderOut = { pass: boolean | null; explanation: string; evidence?: string[]; error?: boolean };
/** Grader context for v2 cases (the v1 GradeCtx fields the generic graders need, plus catalog/observation/variant). */
export type GradeCtx2 = Omit<GradeCtx, 'case' | 'expect' | 'c' | 'canonical'> & {
  case: LoadedCase2; expect: Expect2; c: Collected2; catalog: Catalog; observation: ObservationLevel; variant: string;
  hitl: HitlConfig; canaries: string[]; foreignEntities: string[]; requiredObservation: ObservationLevel;
  /** `graders.claims` from ves.config.json (lexicon/map overrides for claims_vs_ledger and silent_actions). */
  claims?: ClaimsConfig;
  /** `tools.reported_prefixes` / `tools.reported_aliases`: how host-reported names map to catalog tools (labels only). */
  reportedNames?: ReportedNames;
};
export type GraderRegistration = { id: `${string}/${string}`; version: string; kind: 'code' | 'judge'; safety?: boolean;
                                   grade(x: GradeCtx2, params: Record<string, unknown>): GraderOut };
export interface PackModule {
  graders?: GraderRegistration[];
  expand?(ctx: ExpandCtx): Case2[];
  validate?(ctx: ExpandCtx): string[];
}
export type LoadedPack = { manifest: PackManifest; dir: string; source: 'harness' | 'repo'; templates: { file: string; t: PackTemplate }[]; module: PackModule | null; sha256: string };

// =============================================================================== §7.4 core <-> ci interfaces
export type CardModel = {
  project: string; run_id: string; sha: string; tier: Tier; trigger: string; change_class: number; conformance: 'VES-1' | 'custom'; loosened: string[];
  verdict: Verdict; would_be: Verdict; decided_by: string | null; rules: RuleStatus[];
  variants: { name: string; role: string; observation: ObservationLevel; n_cases: number; k: number;
              pass1: number; pass1_ci: [number, number]; passk: number | null;
              delta?: { diff: number; ci: [number, number]; reading: 'above' | 'level' | 'below'; powered: boolean; mde: number } | null;
              safety: { violations: number; cp_upper: number }; skipped: number; invalid: number }[];
  failures: { row_id: string; case_id: string; case_file: string; variant: string; trial: number; grader: string; rule: string; explanation: string; evidence: string[] }[];
  packs: { id: string; version: string; cases: number; skipped?: string; low_realism_intents: number }[];
  new_cases: string[]; baseline: { run_id: string; sha: string; source: string } | null;
  cost: { usd: number; agent_usd_reported: number | null; wall_s: number }; diffs_from_prod: Record<string, string[]>;
  /** v2 runs: run-extra.json `efficiency` per variant (advisory, never gating). */
  efficiency?: Record<string, VariantEfficiency>;
};
export type ExecLike = (cmd: string, args: string[], o?: { cwd?: string; env?: Record<string, string>; input?: string }) =>
  Promise<{ code: number; stdout: string; stderr: string }>;
export type CliDeps = { cwd: string; env: Record<string, string | undefined>; stdout: (s: string) => void; stderr: (s: string) => void;
                        fetch: FetchLike; spawn: SpawnLike; exec: ExecLike; harnessRoot: string; now: () => Date };
export type CliCommand = { name: string; summary: string; run(argv: string[], deps: CliDeps): Promise<number> };
/** src/report/pr/index.ts (ci package) exports these. */
export type PrReportModule = {
  renderPrComment(m: CardModel, o: { runUrl?: string; artifactUrl?: string; maxChars?: number }): string;
  renderJobSummary(m: CardModel, o: { runUrl?: string }): string;
  renderJUnit(m: CardModel, rows: (ResultRow | ResultRow2)[]): string;
  renderAnnotations(m: CardModel): string[];
};
/** One examples/index.json entry (connectors -> ci contract). */
export type ExampleIndexEntry = {
  id: string; framework: string; language: string;
  detect: { pypi: string[]; npm: string[]; files_any: string[]; grep_any: string[] };
  connection: ConnectionConfig; bridge: string | null; deps_note: string; rank: number;
};

// ============================================================================ §7.5 core <-> models interfaces
export type ModelPurpose = 'judge' | 'user_simulator' | 'host_sim' | 'intent_writer';
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; name?: string; tool_call_id?: string;
                            tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] };
export type ChatRequest = { messages: ChatMessage[]; tools?: { type: 'function'; function: { name: string; description?: string; parameters: unknown } }[];
                            tool_choice?: 'auto' | 'none' | 'required'; temperature?: number; max_tokens?: number; seed?: number;
                            response_format?: { type: 'json_object' } | { type: 'json_schema'; json_schema: { name: string; schema: unknown; strict?: boolean } } };
export type ChatResponse = { message: ChatMessage; finish_reason: string; model: string;
                             usage: { input_tokens: number; output_tokens: number }; usd_list: number; cached: boolean; request_sha256: string };
export interface ChatModel { readonly ref: ModelRef; readonly family: string;
  chat(req: ChatRequest, o: { purpose: ModelPurpose; salt: string; signal?: AbortSignal }): Promise<ChatResponse> }
export type Transcript = { role: 'user' | 'agent' | 'tool'; text: string; tool?: string }[];
export interface Judge { readonly identity: { model: string; prompt_sha256: string; admitted: boolean };
  score(i: { dimension: string; rubric_md: string; reference: string; transcript: Transcript; salt: string }):
    Promise<{ label: 'pass' | 'fail' | 'unknown'; value: number | null; explanation: string }> }
/** The persona as the simulator sees it (a ResolvedPersona, or the v1 minimum id/temperament/goal). */
export type SimPersona = { id: string; temperament: string | string[]; goal: string; name?: string; background?: string; languages?: string[]; style?: PersonaStyle };
export type SimStepOut = { say: string } | { hitl: HitlDecisionKind; text?: string } | { stop: true; reason: string; outcome?: 'goal_met' | 'gave_up' | 'other' };
export interface UserSimulator { readonly identity: { model: string; prompt_sha256: string };
  /** `chat_approval`: approvals on this variant go in chat, so a `hitl` answer with nothing pending is kept for core
   *  (an approval written in chat); without it such an answer is words only. `seed`: per-trial sampling seed. */
  next(i: { persona: SimPersona; transcript: Transcript; pending_hitl?: { tool: string; args: Record<string, unknown>; prompt?: string };
            chat_approval?: boolean; turn_index: number; max_turns: number; salt: string; seed?: number }):
    Promise<SimStepOut> }
export interface IntentWriter { write(tool: CatalogTool, n: number, seed: number): Promise<{ say: string; args: Record<string, unknown> }[]> }
export type ModelLedgerSummary = { calls: number; usd_list: number; cache_hit_ratio: number; by_purpose: Record<ModelPurpose, { calls: number; usd_list: number }>; spend_stopped: boolean };
export interface ModelsApi {
  chat(ref: ModelRef | string): ChatModel;
  judge(dimension: string): Judge;
  userSimulator(): UserSimulator;
  intentWriter(): IntentWriter;
  ledger(): ModelLedgerSummary;
}
export type ModelsDeps = { fetch: FetchLike; exec: ExecLike; env: Record<string, string | undefined>; now: () => Date;
                           cacheDir: string; budget: { pool: Tier | 'canary'; usd_cap: number }; prices?: Record<string, { in_per_mtok: number; out_per_mtok: number }> };
export type CreateModels = (cfg: ResolvedConfig['models'], deps: ModelsDeps) => ModelsApi;
