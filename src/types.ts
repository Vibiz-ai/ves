// VES-1 core types. Shapes follow STANDARD.md §2.3 (case), §2.4 (result row), §2.5 (run manifest), §3.1 (adapter).
// Erasable TypeScript only (runs under Node's built-in type stripping; no build step, no dependencies).

export type SurfaceId = string; // '<connection>/<host-or-channel>', e.g. 'eve/slack'
export type CapabilityFlag =
  | 'views' | 'host_approval' | 'ask_mode' | 'multi_turn' | 'streaming' | 'file_upload'
  | 'card_render' | 'schedule_clock' | 'write_tools' | 'spend_tools';
export type InvalidReason =
  | 'infra_auth' | 'infra_rate_limit' | 'infra_upstream_5xx' | 'infra_timeout'
  | 'host_blocked' | 'harness_bug' | 'fixture_unavailable';
export type HostFamily = 'vibiz' | 'claude' | 'chatgpt' | 'codex' | 'other' | 'none';
export type Tier = 'smoke' | 'release' | 'research';
export type Verdict = 'PASS' | 'BLOCK' | 'INVALID' | 'REPORT_ONLY';
export type GraderId =
  | 'outcome_state' | 'side_effects' | 'call_match' | 'must_not_call' | 'schema_valid_args'
  | 'approval_invariant' | 'no_upstream_on_guard' | 'injection_noncompliance' | 'tenant_isolation'
  | 'answer_check' | 'forbid' | 'format_fit' | 'routing_rank' | 'credits_metering' | 'judge';
export type SideEffectKind =
  | 'draft_created' | 'approval_requested' | 'post_scheduled' | 'post_published' | 'email_sent'
  | 'dm_sent' | 'ad_launched' | 'budget_changed' | 'ad_paused' | 'deleted' | 'memory_written'
  | 'proposal_created' | 'credits_debited';
export type ApproveDecision =
  | 'yes' | 'no' | 'timeout' | 'tapback' | 'yes_other_thread' | 'yes_after_args_edit' | 'yes_non_owner';

export type SayTurn = { say: string; as?: 'owner' | 'teammate' | 'non_owner' };
export type ApprovalTurn = { approve: ApproveDecision };
export type ClockTurn = { advance_clock: string };
export type WakeTurn = { wake: string };
export type Turn = SayTurn | ApprovalTurn | ClockTurn | WakeTurn;

export type CallMatcher = { tool: string; args?: Record<string, unknown>; order?: number; min?: number; max?: number };
export type Expect = {
  calls?: CallMatcher[];
  must_not_call?: string[];
  gated?: { tool: string }[];
  side_effects?: { kind: SideEffectKind; match?: Record<string, unknown>; count?: { min?: number; max?: number } }[];
  no_outward_side_effects?: boolean;
  state?: { pointer: string; equals?: unknown; exists?: boolean }[];
  facts?: string[];
  forbid?: string[];
  format?: { max_chars?: number; max_parts?: number; no_cards?: boolean };
  judge?: { dimension: 'helpfulness' | 'grounding' | 'tone'; rubric_ref: string; reference: string }[];
};
export type OracleStep = { call: string; args: Record<string, unknown> } | { reply: string };
export type GraderSpec = { id: GraderId; role: 'gate' | 'advisory'; params?: Record<string, unknown> };

export type Fixture = {
  sim_org: string;
  fixture_sha256: string;
  seed: number;
  clock: string;
  tenants?: { sim_org: string; entities_file: string }[];
  plants?: { location: string; ref: string; canary: string }[];
};

export type Case = {
  schema_version: 'ves-case/1';
  id: string;
  version: number;
  capability: string;
  suite: 'smoke' | 'regression' | 'capability' | 'safety' | 'sealed';
  safety_suite?: 'rt-approval' | 'rt-client' | 'rt-injection' | 'rt-refusal' | 'rt-isolation' | 'rt-autopilot';
  tags?: string[];
  family: 'vibiz-agent' | 'tool-surface' | 'both';
  surfaces: string[];
  requires?: CapabilityFlag[];
  owner: string;
  provenance: { author: string; created: string; source: string; source_ref?: string; redacted?: boolean; blind_to?: string[] };
  fixture: Fixture;
  input: { turns: Turn[]; persona?: { id: string; temperament: string; max_user_turns?: number } };
  expect: Expect;
  graders: GraderSpec[];
  overrides?: Record<string, { expect?: Partial<Expect>; skip?: string }>;
  twin?: string;
  oracle: { kind: 'scripted' | 'refusal'; steps?: OracleStep[] };
  trials?: { k_min?: number };
  limits?: { timeout_s?: number; max_tool_calls?: number };
};

export type LoadedCase = Case & { __file: string; __sha256: string };

// ---- trace records (§3.1 collect) ----
export type ServerCall = {
  id: string;
  seq: number;
  canonical: string;
  tool: string; // surface-specific name
  args: Record<string, unknown>;
  args_hash: string;
  thread: string;
  at: string; // sim clock ISO
  call_source: 'server' | 'host-reported';
  result: { ok: boolean; error?: string; approval_token?: string; body?: unknown };
  guard_fired: boolean;
};
export type UpstreamWrite = {
  id: string;
  seq: number;
  invocation: string; // ServerCall.id that caused it
  canonical: string;
  class: string;
  args: Record<string, unknown>;
  args_hash: string;
  thread: string;
  at: string;
  approval_ref?: string;
};
export type ApprovalEvent = {
  id: string;
  seq: number;
  kind: 'token_minted' | 'token_redeemed' | 'ask_mode_yes' | 'chat_yes' | 'chat_no' | 'tapback' | 'timeout' | 'host_delegated';
  canonical?: string;
  args_hash?: string;
  thread: string;
  principal: 'owner' | 'teammate' | 'non_owner' | 'host' | 'none';
  at: string;
  expires_at?: string;
  token?: string;
};
export type SideEffect = { id: string; kind: SideEffectKind; args: Record<string, unknown>; invocation?: string; at: string };
export type Delivered = { channel: SurfaceId; parts: string[]; cards: number; raw: string };
export type Usage = {
  input_tokens?: number; output_tokens?: number; usd_list?: number; wall_ms: number; ttft_ms?: number;
  /** Tool calls, each counted once (v2: proxied + host-reported calls that match no proxied call). */
  tool_calls?: number; invalid_tool_calls?: number; format_failures?: number;
  /** v2, advisory: calls repeating an earlier call (same tool, same canonical args); user turns in the trial. */
  duplicate_tool_calls?: number; turns?: number;
  /** v2: some of usd_list was estimated from tokens (by the agent or the harness price table), not billed. */
  usd_estimated?: boolean;
};
export type HostInfo = { family: HostFamily; model?: string; protocolVersion?: string; toolset?: string; clientInfo?: string };

export type Collected = {
  atif: AtifTrajectory;
  otelTraceId?: string;
  serverCalls: ServerCall[];
  upstreamWrites: UpstreamWrite[];
  approvalEvents: ApprovalEvent[];
  sideEffects: SideEffect[];
  snapshot: unknown;
  delivered: Delivered[];
  usage: Usage;
  host: HostInfo;
  /** Harness-side context the graders need (canaries, foreign tenant entities); not agent output. */
  context?: { canaries: string[]; foreignEntities: string[]; routingRanks?: Record<string, number> };
};

export type AtifTrajectory = {
  schema_version: string;
  session_id: string;
  agent: { name: string; version: string; model_name?: string };
  steps: AtifStep[];
  final_metrics?: Record<string, unknown>;
  subagent_trajectories?: AtifTrajectory[];
  vibiz?: Record<string, unknown>;
};
export type AtifStep = {
  step_id: number;
  source: 'user' | 'agent' | 'system';
  message?: string;
  tool_calls?: { tool_call_id: string; function_name: string; arguments: Record<string, unknown>; vibiz: { call_source: 'server' | 'host-reported'; canonical_id: string } }[];
  observation?: { results: { source_call_id: string; content: unknown }[] };
  metrics?: Record<string, unknown>;
  vibiz?: Record<string, unknown>;
};

export type TrialCtx = { runId: string; caseId: string; caseVersion: number; surface: SurfaceId; trial: number; seed: number; salt: string; case: LoadedCase };
export type Session = { id: string; [k: string]: unknown };

/** STANDARD.md §3.1, verbatim shape. */
export interface SurfaceAdapter {
  id: SurfaceId;
  family: 'vibiz-agent' | 'tool-surface' | 'contract';
  version: string;
  capabilities(): ReadonlySet<CapabilityFlag>;
  diffsFromProd(): string[];
  routesHash(): Promise<string>;
  health(): Promise<{ ok: boolean; reason?: InvalidReason; detail?: string }>;
  open(f: Fixture, ctx: TrialCtx): Promise<Session>;
  send(s: Session, turn: SayTurn): Promise<void>;
  resolveApproval(s: Session, d: ApproveDecision): Promise<void>;
  advanceClock?(s: Session, iso8601Duration: string): Promise<void>;
  wake?(s: Session, scheduleId: string): Promise<void>;
  collect(s: Session): Promise<Collected>;
  close(s: Session): Promise<void>;
}

// ---- results ----
export type Score = {
  name: string; grader_id: string; grader_version: string; kind: 'code' | 'judge' | 'human';
  role: 'gate' | 'advisory'; value?: number | null; label: 'pass' | 'fail' | 'unknown' | 'error';
  explanation?: string; evidence?: string[];
  judge?: { model: string; prompt_sha256: string; admitted: boolean };
};
export type ResultRow = {
  schema_version: 'ves-result/1';
  row_id: string; run_id: string; case_id: string; case_version: number; suite_version: string;
  surface: string; trial: number; seed: number; status: 'pass' | 'fail' | 'skip' | 'invalid';
  skip_reason?: string; invalid_reason?: InvalidReason; scores: Score[];
  agent: { model: string; commit: string; prompt_sha256?: string; catalog_sha256?: string };
  host: { family: HostFamily; model?: string; protocol_version?: string; toolset?: string; client_info?: string };
  trace: { atif_uri: string; otel_trace_id?: string; server_calls: number; host_reported_calls?: number; host_reported_matched?: number; upstream_writes?: number; approval_events?: number; snapshot_uri?: string };
  usage: Usage; cache: { salt: string; hit_ratio: number };
  error?: { message?: string; http_status?: number };
  created_at: string;
};
