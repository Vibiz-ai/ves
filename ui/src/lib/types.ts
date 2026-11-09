// Loose, defensive shapes for VES files (result v1/v2, run v1/v2, gate v1). Every field is optional:
// the UI shows "—" for anything missing and ignores fields it does not know.

export type Verdict = 'PASS' | 'BLOCK' | 'INVALID' | 'REPORT_ONLY';
export type TrialStatus = 'pass' | 'fail' | 'skip' | 'invalid';

export type Score = {
  name?: string;
  grader_id?: string;
  grader_version?: string;
  kind?: string;
  role?: string;
  value?: number | null;
  label?: string;
  explanation?: string;
  evidence?: string[];
  implicit?: boolean;
  safety?: boolean;
  judge?: { model?: string; prompt_sha256?: string; admitted?: boolean };
};

export type ResultRow = {
  schema_version?: string;
  row_id: string;
  run_id?: string;
  case_id?: string;
  case_version?: number;
  surface?: string;
  trial?: number;
  seed?: number;
  status?: string;
  skip_reason?: string;
  invalid_reason?: string;
  scores?: Score[];
  agent?: { model?: string; commit?: string };
  host?: { family?: string; model?: string };
  trace?: {
    atif_uri?: string; otel_trace_id?: string; server_calls?: number; host_reported_calls?: number;
    upstream_writes?: number; approval_events?: number; snapshot_uri?: string; observation?: string;
  };
  usage?: { wall_ms?: number; input_tokens?: number; output_tokens?: number; usd_list?: number; tool_calls?: number; invalid_tool_calls?: number; format_failures?: number; ttft_ms?: number };
  cache?: { salt?: string; hit_ratio?: number };
  error?: { message?: string; http_status?: number };
  pack?: { id?: string; version?: string; template?: string };
  /** Persona cases only: the synthetic person an AI user-simulator played against the agent (src/lib/persona.ts). */
  persona?: Persona;
  created_at?: string;
};

export type PersonaGoalMet = 'yes' | 'partly' | 'no' | 'unknown';
export type PersonaStopKind = 'goal_met' | 'gave_up' | 'max_turns' | 'other';
export type Persona = {
  id?: string;
  ref?: string;
  name?: string;
  temperament?: string[];
  goal?: string;
  background?: string;
  languages?: string[];
  max_user_turns?: number;
  user_turns?: number;
  stop?: { kind?: PersonaStopKind | string; reason?: string; at_turn?: number };
  simulator?: { model?: string; prompt_sha256?: string };
  metrics?: {
    user_turns?: number; turns_to_goal?: number | null; reply_chars_per_turn?: number[];
    mean_reply_chars?: number | null; language_match?: boolean | null;
  };
  /** Advisory judge read (persona_outcome grader). Never gating. */
  outcome?: {
    goal_met?: PersonaGoalMet | string; gave_up?: boolean | null; frustration?: number | null; tone_fit?: number | null;
    why?: string; judge?: { model?: string; prompt_sha256?: string };
  };
};
/** ATIF step extension on simulator-written user steps (`step.vibiz.persona`). */
export type StepPersona = { id?: string; turn?: number; source?: 'simulator' | 'opening' | string };

export type GateRule = { rule?: string; status?: string; detail?: string; evidence?: string[] };
export type Gate = {
  schema_version?: string; sha?: string; change_class?: number; deploy_targets?: string[];
  verdict?: string; would_be?: string; decided_by?: string | null; rules?: GateRule[];
  run_ids?: string[]; accepted_risks?: unknown[]; override?: unknown;
};

export type RunManifest = {
  schema_version?: string; run_id?: string; ves_version?: string; tier?: string; trigger?: string;
  target?: { sha?: string; branch?: string; repo?: string; deploy_targets?: string[]; change_class?: number };
  harness?: Record<string, unknown>;
  suite?: { ids?: string[]; version?: string; case_count?: number };
  surfaces?: string[];
  adapters?: { surface?: string; version?: string; diffs_from_prod?: string[] }[];
  judge_config?: { model?: string | null; prompts?: Record<string, string> };
  user_simulator?: { model?: string } | null;
  k?: Record<string, number>;
  cost?: { pool?: string; estimate_point_usd?: number; estimate_high_usd?: number; actual_usd?: number; wall_s?: number; cap_usd?: number };
  status?: string; invalid_row_share?: number; verdict?: string;
  connections?: Record<string, { kind?: string; version?: string; agent?: { name?: string; framework?: string; model?: string } }>;
  packs?: { id?: string; version?: string; cases?: number }[];
  [k: string]: unknown;
};

export type Comparison = {
  surface?: string; metric?: string; n_cases?: number; diff?: number; ci?: [number, number];
  p?: number; p_holm?: number; reading?: string; non_inferior?: boolean; powered?: boolean; delta?: number;
};

export type RunExtra = {
  retry_row_ids?: string[];
  baselines?: Record<string, { oracle_pass?: number; oracle_n?: number; trivial_unit_pass?: number; trivial_units?: number; trivial_cp_upper?: number }>;
  safety_validity?: { safety_suite?: string; surface?: string; ok?: boolean; reasons?: string[]; oracle_hit_rate?: number }[];
  comparisons?: Comparison[] | null;
  anchor?: Comparison[] | null;
  over_refusal?: unknown[] | null;
  hard_regressions?: unknown[];
  /** Per-variant efficiency (advisory, never gating; src/report/efficiency.ts in the harness). */
  efficiency?: Record<string, VariantEfficiency>;
  [k: string]: unknown;
};
export type VariantEfficiency = {
  trials?: number; passing?: number; tool_calls?: number; tool_calls_per_trial?: number | null; duplicate_tool_calls?: number; duplicate_rate?: number | null;
  turns?: number; turns_per_trial?: number | null; tool_calls_per_success?: number | null; usage_reported_trials?: number;
  tokens_per_trial?: number | null; tokens_per_success?: number | null; usd_per_success?: number | null;
  wall_ms_p50?: number | null; wall_ms_p95?: number | null; flags?: string[];
};

export type RunSummary = {
  id: string;
  schema_version: string | null;
  tier: string | null;
  trigger: string | null;
  status: string | null;
  sha: string | null;
  branch: string | null;
  repo: string | null;
  change_class: number | null;
  created: string | null;
  verdict: string | null;
  would_be: string | null;
  decided_by: string | null;
  surfaces: string[];
  case_count: number | null;
  suite_version?: string | null;
  pass1?: Record<string, { pass1: number; n_cases: number } | null>;
  row_count: number;
  counts: { pass: number; fail: number; invalid: number; skip: number; other: number };
  per_surface: Record<string, { pass: number; fail: number; invalid: number; skip: number }>;
  trial_pass_rate: number | null;
  usd_rows: number | null;
  usd_actual: number | null;
  usd_cap: number | null;
  judge_model: string | null;
  user_sim_model: string | null;
  agent_models: string[];
  mock: boolean;
  /** Distinct case ids in results.jsonl (server-derived; absent on older servers). */
  case_ids?: string[];
  /** People a user-simulator played in this run: persona rows, or `<pack>.persona.<id>` cases. */
  personas?: { id: string; name: string | null }[];
  errors: string[];
};

export type RunsResponse = { results_dir: string; exists: boolean; version: number; runs: RunSummary[] };
export type RunDetail = {
  id: string; run: RunManifest | null; gate: Gate | null; extra: RunExtra | null; card: string | null;
  files: string[]; summary: RunSummary | null; errors: string[];
};
export type RowsResponse = { id: string; rows: ResultRow[]; parse_errors: number; missing: boolean };

export type AtifToolCall = { tool_call_id?: string; function_name?: string; arguments?: unknown; [ext: string]: unknown };
export type AtifStep = {
  step_id?: number | string;
  source?: string;
  message?: unknown;
  timestamp?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results?: { source_call_id?: string; content?: unknown }[] };
  [ext: string]: unknown;
};
export type Atif = {
  schema_version?: string; session_id?: string;
  agent?: { name?: string; version?: string; model_name?: string };
  steps?: AtifStep[];
  final_metrics?: Record<string, unknown>;
  [ext: string]: unknown;
};
export type TrajectoryResponse = {
  row_id: string; atif_uri: string | null; atif: Atif | null; snapshot_uri: string | null;
  snapshot_sim: { writes?: unknown[]; effects?: Record<string, unknown>; [k: string]: unknown } | null; notes: string[];
};

export type CaseInfo = {
  id: string; version: number | null; schema_version: string | null; suite: string | null; safety_suite: string | null;
  capability: string | null; tags: string[]; surfaces: string[]; requires: string[];
  graders: { id: string; role?: string | null }[];
  provenance: { source?: string; source_ref?: string; author?: string; created?: string } | null;
  owner: string | null; pack: string | null; file: string;
};
export type PackInfo = {
  id: string; dir: string; schema_version: string | null; version: string | null; description: string | null;
  suites: Record<string, string[]> | null; variants: string[]; case_count: number;
};
export type CasesResponse = { repo_dir: string; roots_checked: string[]; packs: PackInfo[]; cases: CaseInfo[]; errors: string[] };

export type CatalogEntry = { class: string | null; classes: string[] | null; gated: boolean | null };
export type Profile = {
  pack: string; id: string;
  variants: Record<string, { family?: string; caps?: string[]; approval?: string; host?: string; formatter?: string; modelInLoop?: boolean; routes?: string[] }>;
  class_map: Record<string, { classes?: string[]; gated?: boolean }>;
  deploy_targets: string[]; suites: Record<string, string[]>;
  catalog: { schema_version: string | null; gated_classes: string[]; ids: Record<string, CatalogEntry> } | null;
};
export type ConfigResponse = { repo_dir: string; config_path: string; config: Record<string, any> | null; config_error: string | null; profiles: Profile[] };

// ---------------------------------------------------------------------------------------------- run store (history)

export type StoreSurface = { pass1: number; ci: [number, number]; n_cases: number; k: number; violations: number; invalid: number; skipped: number };
export type StoreEntry = {
  run_id: string; seq: number; created: string | null; pushed_at?: string; project?: string | null;
  tier: string | null; trigger: string | null; status?: string | null; verdict: string | null; would_be?: string | null; decided_by: string | null;
  target: { sha: string | null; branch: string | null; change_class: number | null };
  suite_version: string | null; suite_label: string | null; case_count: number | null;
  agent_models?: string[]; host_families?: string[]; variants: string[];
  surfaces: Record<string, StoreSurface>;
  cost?: { actual_usd: number | null; agent_usd_reported: number | null; tokens: number; wall_s: number | null };
};
export type StoreRunsResponse = { configured: boolean; url: string | null; kind: 'local' | 'gcs' | null; exists: boolean; current_branch: string | null; entries: StoreEntry[]; problems: string[] };

export type RunInfo = { run_id: string; created: string | null; sha: string | null; branch: string | null; tier: string | null; trigger: string | null; suite_version: string | null; suite_label: string | null; verdict: string | null; decided_by: string | null; source: string };
export type CaseCell = { case_id: string; case_version: number; surface: string; status: 'pass' | 'fail' | 'invalid' | 'skip'; c: number; n: number; row_ids: string[]; row_id: string | null; failing_graders: string[] };
export type FlipKind = 'pass→fail' | 'fail→pass' | 'new' | 'removed' | 'unscored';
export type Flip = { kind: FlipKind; case_id: string; case_version: number; surface: string; base: CaseCell | null; head: CaseCell | null };
export type SurfaceCompare = {
  surface: string;
  base: { pass1: number; ci: [number, number]; n_cases: number; k: number };
  head: { pass1: number; ci: [number, number]; n_cases: number; k: number };
  pass1: { diff: number; ci: [number, number]; holm_alpha: number; p: number; p_holm: number; reading: 'above' | 'level' | 'below'; non_inferior: boolean; powered: boolean; mde: number; delta: number; n_pairs: number } | null;
  other_metrics: Comparison[];
};
export type CompareResult = {
  schema_version: string; base: RunInfo; head: RunInfo; comparable: boolean; refused: null | { reason: string; detail: string[] }; hygiene: string[];
  surfaces: SurfaceCompare[]; only_in_base: string[]; only_in_head: string[]; flips: Flip[]; flip_counts: Record<FlipKind, number>;
  version_changed: { case_id: string; base_version: number; head_version: number; surfaces: string[] }[];
  safety: { base_violations: number; head_violations: number; new: string[]; fixed: string[]; persisting: string[] };
  cost: { base: CostInfo; head: CostInfo; delta: { actual_usd: number | null; agent_usd_reported: number | null; tokens: number; tokens_per_case: number | null } };
  notes: string[];
};
export type CostInfo = { actual_usd: number | null; agent_usd_reported: number | null; tokens: number; tokens_per_case: number | null; wall_s: number | null };
export type HistoryPoint = RunInfo & { seq: number; cells: CaseCell[]; version_break: { from: number; to: number } | null };
export type HistoryResult = { schema_version: string; case_id: string; variant: string | null; runs: HistoryPoint[]; versions: number[]; runs_scanned: number };

/** /api/personas: the persona library and every persona conversation across the results dir. */
export type PersonaLibraryEntry = {
  id: string; name: string | null; background: string | null; languages: string[]; temperament: string[];
  style: Record<string, unknown> | null; opening: string | null; max_user_turns: number | null; notes: string | null; file: string;
};
export type PersonaConversation = {
  run_id: string; run_created: string | null; created_at: string | null; row_id: string; case_id: string | null; surface: string | null;
  trial: number | null; status: string | null; invalid_reason: string | null; skip_reason: string | null; agent_model: string | null;
  persona_id: string; persona: Persona | null; preview: { user: string | null; agent: string | null; user_messages: number };
};
export type PersonasResponse = {
  library: PersonaLibraryEntry[];
  runs: { id: string; created: string | null; verdict: string | null; status: string | null; agent_models: string[]; surfaces: string[] }[];
  conversations: PersonaConversation[];
};
