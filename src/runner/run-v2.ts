// Generic, config-driven runner (DESIGN-agnostic §2, §3, §5.2): ves.config.json -> catalog -> packs expanded +
// suites loaded -> trials on variants through any Connector (or MockAgent) and the tool proxy -> graders (listed,
// derived, implicit safety, pack) -> rows (result-2), manifest (run-2), card, gate.json. The statistics, validity
// controls and gate are the VES-1 code paths from run.ts / stats.ts / gate.ts, unchanged.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, unitSeed } from '../lib/hash.ts';
import { canonicalJson } from '../lib/canonicalise.ts';
import { validate } from '../lib/jsonschema.ts';
import { classifyFailure } from '../lib/classify.ts';
import { BOOTSTRAP_SEED, clopperPearsonUpper, type Comparison, mcnemarExact, passAtK, passHat1, passHatK } from '../lib/stats.ts';
import { buildCatalog, variantMatches } from '../catalog/catalog.ts';
import { suggestClasses } from '../catalog/suggest.ts';
import { loadCaseDirs, schema, suiteVersionAny, inTier } from '../cases/load.ts';
import { expandPack, type ExpandResult, resolveFixturePath } from '../cases/expand.ts';
import { loadIntents } from '../cases/intents.ts';
import { gradersFor, grade2, implicitFactsV2, isSafetyGraderId, knownGraderId } from '../graders/generic.ts';
import { isSafetyScore, trialStatus } from '../graders/index.ts';
import { ConnectorAdapter, naiveHit2, resolveFixture, type ServeTools, type TrialCtx2 } from '../core/connector-adapter.ts';
import { MockAgent, type MockBehaviour, type MockFaults2 } from '../core/mock-agent.ts';
import { HarnessError, UsageError } from '../core/errors.ts';
import { personaOf, resolveCasePersonas, loadPersonaLibrary } from '../cases/personas.ts';
import { runPersona, scriptedUserSimulator, visibleTranscript } from './persona-loop.ts';
import type { PersonaJudge } from '../models/persona-judge.ts';
import { VIBIZ_PROFILE } from '../adapters/profiles.ts';
import { loadConnectors, createConnector, type ConnectorRegistry } from '../registry/connectors.ts';
import { loadPacks } from '../registry/packs.ts';
import { createModelsApi, NO_MODELS } from '../registry/models.ts';
import { ForwardBackend, type ToolBackend } from '../proxy/forward-backend.ts';
import { resolveFixturePath as resolvePath } from '../cases/expand.ts';
import { evaluateGate, type AcceptedRisk, type GateResult, type HardRegression, type OverRefusal, type SafetyValidity } from '../gate/gate.ts';
import { renderCard } from '../report/card.ts';
import { buildCardModel } from '../report/model.ts';
import { aggregateEfficiency } from '../report/efficiency.ts';
import { caseCounts, comparatorHygiene, comparisonsVs, isoCompact, loadRun, safetyViolationsOf, slug, treeHash, VES_VERSION } from './run.ts';
import type { InvalidReason, Tier } from '../types.ts';
import type {
  CardModel, Catalog, Collected2, Connector, ExecLike, Expect2, FetchLike, GradeCtx2, LoadedCase2, ModelsApi, ObservationLevel, PersonaRecord, ResolvedConfig, ResolvedVariant,
  ResultRow2, SpawnLike, UserSimulator,
} from '../core/types.ts';

/** The models package API plus the optional extras core uses when present (src/models/index.ts ModelsApiExt). */
type ModelsLike = ModelsApi & { chargeExternal?(usd: number, label?: string): void; identities?(): Record<string, unknown>; warnings?(): string[]; personaJudge?(): PersonaJudge };

export type Trigger2 = 'manual' | 'pr' | 'deploy' | 'pre_release' | 'nightly' | 'canary' | 'research';
export const GATING_TRIGGERS: readonly string[] = ['deploy', 'pre_release', 'nightly', 'research', 'pr'];

export type RunConfigOptions = {
  harnessRoot: string; config: ResolvedConfig; tier: Tier; trigger: Trigger2;
  variants?: string[] | 'auto'; packs?: string[]; caseFilter?: string;
  /** `ves run --persona <glob>`: only persona cases whose persona id or library ref matches. */
  personaFilter?: string;
  /** `--connection mock`: every variant runs on MockAgent (oracle replay); never gates (G-1). */
  connection?: 'mock'; mockBehaviour?: MockBehaviour; faults?: MockFaults2;
  target: { sha: string; branch?: string; change_class: 0 | 1 | 2 | 3; deploy_targets?: string[] };
  outDir: string; baseline?: string; anchor?: string; differsIn?: string[];
  override?: { by: string; reason: string } | null; reportOnly?: boolean;
  env?: Record<string, string | undefined>; fetch?: FetchLike; spawn?: SpawnLike; now?: () => Date;
  bootstrapN?: number; aaHalfWidth?: Record<string, number>; invalidTwice?: boolean; carriedViolations?: string[];
  harnessSource?: 'action' | 'repo' | 'local'; newCases?: string[]; serveTools?: ServeTools; connectors?: ConnectorRegistry;
  history?: Record<string, number>; quarantine?: string[]; plantLocations?: Record<string, string>;
  /** Extra cases (tests, `ves run --case-file`). */
  extraCases?: LoadedCase2[];
  /** Where the agent under test lives (PR head) when the suite comes from the base worktree (--suite-root, §6.4). Default: the config dir. */
  agentRoot?: string;
  /** Injected for the models package (Vertex ADC uses `gcloud auth print-access-token`). */
  exec?: ExecLike;
  /** A prebuilt models API (tests); otherwise createModelsApi(config.models, …) when the package is installed. */
  models?: ModelsApi;
  /** The suite (config + cases) comes from the base worktree (--suite-root other than the agent dir). */
  suiteFromBase?: boolean;
  /** Where --baseline came from, for the card: artifact (main's last run), run-base (re-ran the base agent) or path. */
  baselineSource?: 'artifact' | 'run-base' | 'path';
};
export type RunConfigOutcome = {
  runDir: string; runId: string; manifest: any; rows: ResultRow2[]; gate: GateResult; card: string; cardModel: CardModel;
  invalid: boolean; invalidReason?: string; expansions: ExpandResult[]; catalog: Catalog; cases: LoadedCase2[];
};

// ------------------------------------------------------------------------------------------- preparation
export type Prepared = { catalog: Catalog; cases: LoadedCase2[]; expansions: ExpandResult[]; errors: string[]; warnings: string[]; ruleErrors: string[]; packSha: Record<string, string> };

/** Declared tool schemas for `schemas_from` = <file> (OpenAI tools array or [{name, input_schema}]). */
export function declaredFromFile(cfg: ResolvedConfig): { name: string; description?: string; input_schema?: unknown }[] {
  const s = cfg.tools.schemas_from;
  if (!s || s === 'bridge' || s === 'mcp' || s === 'inline') return [];
  const f = resolveFixturePath(s, [cfg.dir]);
  if (!f) throw new UsageError(`tools.schemas_from ${s} not found`);
  const arr = JSON.parse(readFileSync(f, 'utf8')) as any[];
  return arr.map((t) => (t?.type === 'function' && t.function ? { name: t.function.name, description: t.function.description, input_schema: t.function.parameters } : { name: t.name, description: t.description, input_schema: t.input_schema ?? t.inputSchema ?? t.parameters }));
}

export async function prepare(o: { harnessRoot: string; config: ResolvedConfig; tier: Tier; packs?: string[]; declared?: { name: string; description?: string; input_schema?: unknown }[]; caseFilter?: string; personaFilter?: string; extraCases?: LoadedCase2[]; variants?: ResolvedVariant[] }): Promise<Prepared> {
  const cfg = o.config;
  const errors: string[] = [];
  const warnings: string[] = [];
  const { catalog, errors: catErr } = buildCatalog(cfg.tools.catalog, { gate_classes: cfg.tools.gate_classes, declared: [...declaredFromFile(cfg), ...(o.declared ?? [])] });
  errors.push(...catErr);
  warnings.push(...catalog.warnings);
  const { packs, errors: packErr } = await loadPacks({ harnessRoot: o.harnessRoot, repoDir: cfg.dir });
  errors.push(...packErr);
  const intents = loadIntents(cfg.intents_path);
  const wanted = o.packs ?? [...cfg.packs.map((p) => p.id), ...(cfg.tiers[o.tier].packs ?? [])];
  const expansions: ExpandResult[] = [];
  const cases: LoadedCase2[] = [];
  const packSha: Record<string, string> = Object.fromEntries(packs.map((p) => [p.manifest.id, p.sha256]));
  for (const id of [...new Set(wanted)]) {
    const p = packs.find((x) => x.manifest.id === id);
    if (!p) { errors.push(`pack ${id} not found (looked in packs/ and ves-packs/)`); continue; }
    const ref = cfg.packs.find((x) => x.id === id);
    if (ref?.version && ref.version !== p.manifest.version) errors.push(`pack ${id}: config pins ${ref.version}, found ${p.manifest.version}`);
    const r = expandPack(p, { catalog, config: cfg, intents, variants: o.variants?.map((v) => ({ name: v.name, role: v.role, capabilities: v.capabilities })) }, ref?.options ?? {});
    expansions.push(r);
    errors.push(...r.errors);
    cases.push(...r.cases);
    if (p.module?.validate) errors.push(...p.module.validate({ pack: p.manifest, options: ref?.options ?? {}, catalog, config: cfg, intents, seedOf: () => 0, synthArgs: () => null, canary: () => '', select: () => [] }));
  }
  const suites = loadCaseDirs(cfg.dir, cfg.suites, { fixtureDirs: [cfg.dir] });
  errors.push(...suites.errors);
  if (suites.v1.length) errors.push(`${suites.v1.length} ves-case/1 file(s) in config suites (${suites.v1[0].__file}…): v1 cases run with --profile vibiz, or convert them with \`ves migrate --to 2\``);
  cases.push(...suites.v2);
  // --extra-cases: the PR head's added or changed cases, forced advisory (§6.4). A head case whose id the base suite
  // already has runs beside it as `<id>.pr-head`: the base version keeps gating, the PR cannot weaken it by editing it.
  const baseIds = new Set(cases.map((c) => c.id));
  const renamed = new Map<string, string>();
  for (const x of o.extraCases ?? []) if (baseIds.has(x.id)) renamed.set(x.id, `${x.id}.pr-head`);
  for (const x of o.extraCases ?? []) {
    const id = renamed.get(x.id) ?? x.id;
    const twin = x.twin && renamed.has(x.twin) && (o.extraCases ?? []).some((y) => y.id === x.twin) ? renamed.get(x.twin) : x.twin;
    cases.push(Object.assign(x, { id, ...(twin ? { twin } : {}), __new: true, __extra: true }));
  }
  // persona cases: resolve `input.persona.ref` against <config dir>/personas/*.persona.json (src/cases/personas.ts)
  const lib = loadPersonaLibrary(join(cfg.dir, 'personas'), cfg.dir);
  errors.push(...lib.errors, ...resolveCasePersonas(cases, lib));
  const re = o.caseFilter ? globRe(o.caseFilter) : null;
  const tiered = cases.filter((c) => inTier(c, o.tier));
  // rules run on every case of the tier (twins resolve even when --case narrows the selection)
  const ruleErrors = checkRules2(tiered, catalog, JSON.parse(readFileSync(join(o.harnessRoot, 'judges', 'registry.json'), 'utf8')));
  const pf = o.personaFilter ? globRe(o.personaFilter) : null;
  const selected = tiered.filter((c) => (!re || re.test(c.id)) && (!pf || (!!c.__persona && (pf.test(c.__persona.id) || (!!c.__persona.ref && pf.test(c.__persona.ref))))));
  return { catalog, cases: selected, expansions, errors, warnings, ruleErrors, packSha };
}

/** `eve.persona.*` style glob -> anchored RegExp (only `*` is special). */
export const globRe = (g: string): RegExp => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

/** Runner rules outside the schema (§3.2 list + VES-1 §2.3). */
export function checkRules2(cases: LoadedCase2[], cat: Catalog, registry: { admitted: { dimension: string; version: string }[] }): string[] {
  const errs: string[] = [];
  const ids = new Map<string, number>();
  for (const c of cases) ids.set(c.id, (ids.get(c.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) errs.push(`duplicate case id ${id}`);
  for (const c of cases) {
    const e = c.expect;
    const names = [
      ...(e.calls ?? []).flatMap((m) => (m.tool ? [m.tool] : [])), ...(e.must_not_call ?? []).filter((r) => !r.startsWith('class:')),
      ...(e.gated ?? []).map((g) => g.tool), ...(e.effects ?? []).flatMap((x) => (x.tool ? [x.tool] : [])), ...(e.hitl?.before ? [e.hitl.before] : []),
      ...(c.oracle.steps ?? []).flatMap((s) => ('call' in s ? [s.call] : 'ask' in s ? [s.ask.tool] : [])),
      ...(c.fixture.plants ?? []).flatMap((p) => ('tool' in p.at ? [p.at.tool] : [])),
    ];
    for (const t of new Set(names)) if (!cat.byName[t]) errs.push(`${c.id}: tool ${t} is not in the catalog`);
    for (const g of e.gated ?? []) if (cat.byName[g.tool] && !cat.byName[g.tool].gated) errs.push(`${c.id}: expect.gated says ${g.tool} is gated but the catalog does not gate it`);
    for (const g of c.graders ?? []) {
      if (!knownGraderId(g.id)) errs.push(`${c.id}: grader ${g.id} is not installed`);
      if (isSafetyGraderId(g.id) && g.role === 'advisory') errs.push(`${c.id}: safety grader ${g.id} cannot be advisory (§3.2 rule 2)`);
      if (g.id === 'persona_outcome' && g.role === 'gate') errs.push(`${c.id}: persona_outcome is a judge of a simulated user and stays advisory (VES-1 §12); gate on persona_metrics instead`);
      if ((g.id === 'persona_outcome' || g.id === 'persona_metrics') && !c.input.persona) errs.push(`${c.id}: grader ${g.id} needs input.persona`);
      if (g.id === 'judge' && g.role === 'gate') {
        const dims = (e.judge ?? []).map((j) => j.rubric_ref.replace(/^.*\//, '').replace(/\.md$/, ''));
        if (!dims.length || !dims.every((d) => registry.admitted.some((a) => `${a.dimension}@${a.version}` === d))) errs.push(`${c.id}: judge grader has role gate but ${dims.join(', ') || 'no dimension'} is not admitted`);
      }
    }
    if (c.twin && !ids.has(c.twin)) errs.push(`${c.id}: twin ${c.twin} not in the loaded cases`);
  }
  return errs;
}

// ----------------------------------------------------------------------------------------- per variant
/** A pack-generated case that does not name a contract variant explicitly is not applicable to it (dogfood fix
 * 2026-11-07): the agent packs (core-tool-use, hitl-approval, prompt-injection, data-isolation, over-refusal) need an
 * agent (a model) in the loop. In contract mode the harness scripts both the agent and the human, so those cases would
 * grade the harness's own replay, not the server: a false PASS (hitl-approval) or a false BLOCK (core-tool-use).
 * Contract packs (mcp-conformance) list their variants by name; hand-written cases are unaffected. */
export const notForContract = (c: LoadedCase2, v: ResolvedVariant): boolean => v.role === 'contract' && !!c.provenance?.pack && !(c.variants ?? []).includes(v.name);
export const appliesTo2 = (c: LoadedCase2, v: ResolvedVariant): boolean => {
  if (notForContract(c, v)) return false;
  if (c.input.persona && v.role === 'contract') return false; // a simulated person needs an agent to talk to
  const pats = c.variants ?? ['*'];
  return v.explicit_only ? pats.includes(v.name) : pats.some((p) => variantMatches(p, v.name));
};
export function overrideSkip2(c: LoadedCase2, v: string): string | undefined {
  for (const [p, o] of Object.entries(c.overrides ?? {})) if (o.skip && variantMatches(p, v)) return o.skip;
  return undefined;
}
function deepMerge(a: any, b: any): any {
  if (b === undefined) return a;
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out: any = { ...(a ?? {}) };
  for (const [k, x] of Object.entries(b)) out[k] = deepMerge(out[k], x);
  return out;
}
export function effectiveExpect2(c: LoadedCase2, v: string): Expect2 {
  let e: Expect2 = c.expect;
  const spec = (p: string) => (p === '*' ? 0 : p.endsWith('/*') ? 1 : 2);
  for (const p of Object.keys(c.overrides ?? {}).filter((x) => variantMatches(x, v)).sort((a, b) => spec(a) - spec(b))) e = deepMerge(e, c.overrides![p].expect);
  return e;
}
export function kFor2(c: LoadedCase2, v: ResolvedVariant, cfg: ResolvedConfig, tier: Tier): number {
  const t = cfg.tiers[tier];
  let k = c.suite === 'safety' ? (v.role === 'contract' ? 1 : t.k_safety) : t.k;
  if (c.trials?.k_min) k = Math.max(k, c.trials.k_min);
  return k;
}
function fixtureSha(c: LoadedCase2, cfg: ResolvedConfig): string {
  if (c.fixture.state_sha256) return c.fixture.state_sha256;
  const src = c.fixture.state ?? cfg.fixtures.state;
  if (typeof src === 'string') { const f = resolveFixturePath(src, [c.__dir, ...c.__fixture_dirs, cfg.dir]); return f ? sha256(readFileSync(f)) : 'missing'; }
  return sha256(canonicalJson(src ?? {}));
}

type TrialOut2 = { row: ResultRow2; collected: Collected2 | null; evidenceTools: Record<string, string> };
/** The persona record of a trial that failed mid-way (as far as the conversation got), for the INVALID/FAIL row. */
const t0Persona = (t: { persona?: PersonaRecord } | null, c: Collected2 | null): PersonaRecord | undefined => c?.persona ?? t?.persona;

async function runTrial2(a: ConnectorAdapter, c: LoadedCase2, trial: number, salt: string, runId: string, sv: string, o: RunConfigOptions, cat: Catalog, dir: string | null, models: ModelsLike = NO_MODELS, observationFloor?: ObservationLevel): Promise<TrialOut2> {
  const v = a.variant;
  const seed = unitSeed(c.fixture.seed, `${c.id}@${c.version}|${v.name}|${trial}|${salt}`);
  const ctx: TrialCtx2 = { runId, caseId: c.id, caseVersion: c.version, variant: v.name, trial, seed, salt, case: c };
  const pack = c.provenance.pack ? { id: c.provenance.pack.id, version: c.provenance.pack.version, template: c.provenance.pack.template } : undefined;
  const base = {
    schema_version: 'ves-result/2' as const, row_id: `${runId}|${c.id}@${c.version}|${v.name}|${trial}`, run_id: runId, case_id: c.id, case_version: c.version,
    suite_version: sv, surface: v.name, trial, seed, agent: { model: a.connector.kind === 'mock' ? 'mock' : o.config.agent.model ?? 'unknown', commit: o.target.sha, catalog_sha256: cat.sha256 },
    cache: { salt, hit_ratio: 0 }, created_at: (o.now?.() ?? new Date()).toISOString(), ...(pack ? { pack } : {}),
  };
  const started = Date.now();
  let collected: Collected2 | null = null;
  let t: Awaited<ReturnType<ConnectorAdapter['open']>> | null = null;
  const persona = personaOf(c);
  const mock = a.connector.kind === 'mock';
  try {
    t = await a.open(c, ctx);
    const limit = (c.limits?.timeout_s ?? 180) * 1000;
    const tt = t;
    const work = (async () => {
      if (c.input.trace) await a.ingest(tt, { ...c.input.trace, file: resolvePath(c.input.trace.file, [c.__dir, ...c.__fixture_dirs, o.config.dir]) ?? c.input.trace.file });
      for (const turn of c.input.turns ?? []) await a.turn(tt, turn);
      if (persona) {
        // the MockAgent always gets the offline simulator ($0); a real agent gets models.user_simulator
        let sim: UserSimulator;
        try { sim = mock ? scriptedUserSimulator() : models.userSimulator(); }
        catch (e) { throw (e as { harness?: boolean }).harness ? e : new HarnessError(`user simulator unavailable: ${(e as Error).message}`); }
        tt.persona = await runPersona(a, tt, persona, { sim, salt: `${salt}|${c.id}@${c.version}|${v.name}`, seed, scriptedSay: (c.input.turns ?? []).some((x) => 'say' in x) });
      }
      return a.collect(tt);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    collected = await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`agent timeout ${limit} ms`), { agentTimeout: true })), limit); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
    await a.close(t);
    t = null;
    // persona_outcome: the judge reads the conversation (advisory). Infra errors make the row INVALID, like the simulator's.
    const pj = collected.persona && !mock ? (models as ModelsLike).personaJudge : undefined;
    if (collected.persona && typeof pj === 'function') {
      collected.persona.outcome = await pj.call(models).score({ persona: collected.persona, transcript: visibleTranscript(collected.atif.steps ?? []), salt: `${salt}|${c.id}@${c.version}|${v.name}|outcome` });
    }
  } catch (e) {
    if (t) await a.close(t).catch(() => {});
    const err = e as Error & { fixtureUnavailable?: boolean; harness?: boolean; http_status?: number; origin?: 'agent' | 'provider' | 'host' };
    const reason: InvalidReason | null = err.fixtureUnavailable ? 'fixture_unavailable' : err.harness ? 'harness_bug'
      : classifyFailure({ origin: err.origin === 'provider' || err.origin === 'host' ? err.origin : err.http_status && !err.origin ? 'host' : 'agent', http_status: err.http_status });
    const row: ResultRow2 = { ...base, status: reason ? 'invalid' : 'fail', ...(reason ? { invalid_reason: reason } : {}), scores: [], host: { family: v.host.family }, ...(t0Persona(t, collected) ? { persona: t0Persona(t, collected)! } : {}),
      trace: { atif_uri: '', server_calls: 0 }, usage: { wall_ms: Date.now() - started }, error: { message: err.message.slice(0, 500), ...(err.http_status ? { http_status: err.http_status } : {}) } };
    return { row, collected: null, evidenceTools: {} };
  }
  const expect = effectiveExpect2(c, v.name);
  let specs = gradersFor(c, expect).map((g) => (g.id === 'format_fit' && Object.keys(v.format).length ? { ...g, params: { ...(g.params ?? {}), variant_format: v.format } } : g));
  if (c.__new) specs = specs.map((g) => (isSafetyGraderId(g.id) ? g : { ...g, role: 'advisory' as const }));
  const observation = observationFloor ?? collected.observation;
  const x: GradeCtx2 = {
    case: c, expect, c: collected, catalog: cat, observation, variant: v.name, hitl: v.hitl, canaries: collected.context?.canaries ?? [],
    foreignEntities: collected.context?.foreignEntities ?? [], requiredObservation: o.config.gate.safety_observation, surface: v.name, repoRoot: o.harnessRoot, upstreamObserved: true,
    claims: o.config.graders?.claims, reportedNames: { prefixes: o.config.tools.reported_prefixes, aliases: o.config.tools.reported_aliases },
  };
  // claims_vs_ledger is implicit on every agent trial, baselines included (gate; advisory for a case new in the PR).
  // Not on a contract variant (the harness itself scripts the replies there) or with graders.claims.implicit: false.
  const claimsMode = o.config.graders?.claims?.implicit === false || v.role === 'contract' ? 'off' : c.__new ? 'advisory' : 'gate';
  const scores = grade2(x, specs, { ...implicitFactsV2(c, collected, cat, x.foreignEntities), claims: claimsMode });
  let atifRel = '', snapRel = '';
  if (dir) {
    atifRel = `trajectories/${slug(c.id)}__${slug(v.name)}__${trial}${salt.startsWith('t') ? '' : `.${slug(salt)}`}.atif.json`;
    writeFileSync(join(dir, atifRel), JSON.stringify(collected.atif, null, 2));
    snapRel = `snapshots/${slug(c.id)}__${slug(v.name)}__${trial}${salt.startsWith('t') ? '' : `.${slug(salt)}`}.json`;
    writeFileSync(join(dir, snapRel), JSON.stringify(collected.snapshot));
  }
  const row: ResultRow2 = {
    ...base, status: trialStatus(scores), scores, host: { family: v.host.family, ...(v.host.model ? { model: v.host.model } : {}) },
    trace: { atif_uri: atifRel, ...(collected.otelTraceId ? { otel_trace_id: collected.otelTraceId } : {}), server_calls: collected.serverCalls.filter((y) => y.call_source === 'server').length,
      host_reported_calls: collected.serverCalls.filter((y) => y.call_source === 'host-reported').length, ...(collected.hostReportedMatched ? { host_reported_matched: collected.hostReportedMatched } : {}), upstream_writes: collected.upstreamWrites.length, approval_events: collected.approvalEvents.length,
      ...(snapRel ? { snapshot_uri: snapRel } : {}), observation },
    usage: { ...collected.usage, wall_ms: Math.round(collected.usage.wall_ms ?? Date.now() - started) },
    ...(collected.persona ? { persona: collected.persona } : {}),
  };
  const ev: Record<string, string> = {};
  for (const y of collected.serverCalls) ev[y.id] = y.canonical;
  for (const w of collected.upstreamWrites) ev[w.id] = w.canonical;
  for (const fx of collected.sideEffects) ev[fx.id] = fx.tool ?? '';
  for (const r of collected.hitlRequests) ev[r.request_id] = r.tool;
  return { row, collected, evidenceTools: ev };
}

// ------------------------------------------------------------------------------------------------ run
export async function runConfigOnce(o: RunConfigOptions): Promise<RunConfigOutcome> {
  const cfg = o.config;
  const env = o.env ?? process.env;
  const now = o.now?.() ?? new Date();
  const names = o.variants && o.variants !== 'auto' ? o.variants : cfg.tiers[o.tier].variants ?? Object.values(cfg.variants).filter((v) => !v.explicit_only).map((v) => v.name);
  for (const n of names) if (!cfg.variants[n]) throw new UsageError(`unknown variant ${n}; config has ${Object.keys(cfg.variants).join(', ')}`);
  const variants = names.map((n) => cfg.variants[n]);
  const reg = o.connectors ?? (await loadConnectors(o.harnessRoot));
  // models (judge, user simulator, host-sim, intent writer): one cache and one spend ledger capped at the tier budget,
  // agent-reported spend charged into the same pool. Never constructed for an all-mock run (no model in the loop).
  const allMock = o.connection === 'mock' || variants.every((v) => v.connection.type === 'mock');
  let models: ModelsLike = o.models ?? NO_MODELS;
  if (!o.models && !allMock) {
    const created = await createModelsApi(cfg.models, Object.assign({
      fetch: o.fetch ?? ((() => { throw new Error('no fetch injected'); }) as unknown as FetchLike),
      exec: o.exec ?? (async () => ({ code: 127, stdout: '', stderr: 'no exec injected' })), env, now: () => o.now?.() ?? new Date(),
      cacheDir: join(o.agentRoot ?? cfg.dir, '.ves-cache', 'models'), budget: { pool: o.tier, usd_cap: cfg.tiers[o.tier].budget_usd },
    }, {
      agent: { model: cfg.agent.model, name: cfg.agent.name, host_families: [...new Set(variants.map((v) => v.host.family).filter((f) => f && f !== 'other'))] },
      ...(existsSync(join(cfg.dir, 'evals', 'judges', 'registry.json')) ? { judgeRegistry: join(cfg.dir, 'evals', 'judges', 'registry.json') } : {}),
    }), o.harnessRoot).catch(() => ({ api: NO_MODELS, installed: false }));
    models = created.api as ModelsLike;
  }
  const backends: ToolBackend[] = [];

  // 1. connectors (health + handshake) before the catalog, so `schemas_from: bridge|mcp` can use declared tools
  const prelimCat = buildCatalog(cfg.tools.catalog, { gate_classes: cfg.tools.gate_classes }).catalog;
  const conns: { v: ResolvedVariant; c: Connector; health: { ok: boolean; reason?: InvalidReason; detail?: string }; info: Awaited<ReturnType<Connector['info']>> | null }[] = [];
  for (const v of variants) {
    const mock = o.connection === 'mock' || v.connection.type === 'mock';
    const deps = { fetch: o.fetch ?? ((() => { throw new Error('no fetch injected'); }) as unknown as FetchLike), spawn: o.spawn ?? ((() => { throw new Error('no spawn injected'); }) as unknown as SpawnLike), env, now: () => o.now?.() ?? new Date(), models, log: () => {}, repoRoot: o.agentRoot ?? cfg.dir, configDir: cfg.dir, variant: v.name, catalog: prelimCat };
    const c = mock ? new MockAgent({ behaviour: o.mockBehaviour ?? 'oracle', faults: o.faults }) : await createConnector(v.connection, deps, reg);
    let health: { ok: boolean; reason?: InvalidReason; detail?: string };
    try { health = await c.health(); } catch (e) { health = { ok: false, reason: 'harness_bug', detail: (e as Error).message }; }
    let info = null;
    try { info = health.ok ? await c.info() : null; } catch (e) { health = { ok: false, reason: 'harness_bug', detail: `info(): ${(e as Error).message}` }; }
    conns.push({ v, c, health, info });
  }
  const declared = (cfg.tools.schemas_from === 'bridge' || cfg.tools.schemas_from === 'mcp') ? conns.flatMap((x) => x.info?.declaredTools ?? []) : [];
  const prep = await prepare({ harnessRoot: o.harnessRoot, config: cfg, tier: o.tier, packs: o.packs, declared, caseFilter: o.caseFilter, personaFilter: o.personaFilter, extraCases: o.extraCases, variants });
  if (prep.errors.length) throw new UsageError(`validation failed:\n  ${prep.errors.join('\n  ')}`);
  if (prep.ruleErrors.length) throw new UsageError(`runner rules failed:\n  ${prep.ruleErrors.join('\n  ')}`);
  const cat = prep.catalog;
  // --new-cases tags cases advisory. When the suite comes from the base worktree, only head extras can be tagged: a
  // base case keeps gating even if the PR changed its file (the changed version runs as an extra).
  const cases = prep.cases.map((c) => (o.newCases?.includes(c.id) && (!o.suiteFromBase || c.__extra) ? Object.assign(c, { __new: true }) : c));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const sv = suiteVersionAny(cases);
  const runId = `ves-${isoCompact(now)}-${sha256(`${o.target.sha}|${sv}|${now.toISOString()}|${names.join(',')}|${o.connection ?? 'config'}|${cfg.sha256}`).slice(0, 8)}`;
  const dir = join(o.outDir, runId);
  for (const d of ['trajectories', 'snapshots', 'baselines/trajectories', 'baselines/snapshots', 'expanded-cases']) mkdirSync(join(dir, d), { recursive: true });

  const rows: ResultRow2[] = [];
  const retryIds: string[] = [];
  const kMap: Record<string, number> = {};
  const adapters: { surface: string; version: string; routes_sha256: string; diffs_from_prod: string[] }[] = [];
  const connections: Record<string, { kind: string; version: string; role: string; agent: { name: string; framework?: string; model?: string } }> = {};
  const observation: Record<string, ObservationLevel> = {};
  const hard: HardRegression[] = [];
  const quarantine = new Set(o.quarantine ?? []);
  const evidenceTools: Record<string, Record<string, string>> = {};
  const unproxiedWrite: string[] = [];
  const capsByVariant: Record<string, Set<string>> = {};
  const keep = (t: TrialOut2): ResultRow2 => { evidenceTools[t.row.row_id] = t.evidenceTools; return t.row; };
  // agent-reported spend goes into the models ledger (one budget_usd for harness models + agent), and the agent
  // process's stderr since the previous trial is kept next to the trajectory
  const stderrSeen = new Map<Connector, number>();
  const afterTrial = (connector: Connector, r: ResultRow2): void => {
    if (r.usage.usd_list) models.chargeExternal?.(r.usage.usd_list, `agent:${r.surface}`);
    const se = (connector as Connector & { stderr?: () => string }).stderr;
    if (typeof se !== 'function') return;
    let text = '';
    try { text = String(se.call(connector) ?? ''); } catch { return; }
    const from = stderrSeen.get(connector) ?? 0;
    const chunk = text.length >= from ? text.slice(from) : text; // the 1 MB buffer rolled over: keep what is there
    stderrSeen.set(connector, text.length);
    if (chunk.trim()) writeFileSync(join(dir, 'trajectories', `${slug(r.case_id)}__${slug(r.surface)}__${r.trial}${r.cache.salt.startsWith('t') ? '' : `.${slug(r.cache.salt)}`}.stderr.log`), chunk);
  };

  for (const { v, c: connector, health: h, info } of conns) {
    // Tool backend (§1.6 step 4): an `mcp` connection's server IS the backend (toolBackend()); otherwise
    // tools.backend `forward` calls the team's sandbox; otherwise the in-memory sim. MockAgent always uses the sim.
    let backendFor: (() => ToolBackend | undefined) | undefined;
    const tb = (connector as Connector & { toolBackend?: () => ToolBackend }).toolBackend;
    if (connector.kind !== 'mock' && typeof tb === 'function') backendFor = () => tb.call(connector);
    else if (connector.kind !== 'mock' && cfg.tools.backend.type === 'forward') {
      const fb = new ForwardBackend(cfg.tools.backend.target, { fetch: o.fetch, spawn: o.spawn, cwd: o.agentRoot ?? cfg.dir, env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string' && (e[0] === 'PATH' || e[0] === 'HOME' || e[0].startsWith('VES_')))) }, cfg.tools.backend.guard_signal);
      backends.push(fb);
      backendFor = () => fb;
    }
    // tools.ledger.url (§1.6): the backend's own record of every write, read once per trial at collect. A ledger row
    // with no proxied call is a bypass; every proxied write matched lifts the trial to observation `ledger`. The
    // answer may also carry the backend's `state`, which expect.state then grades (the sim never ran those tools).
    const ledgerUrl = cfg.tools.ledger?.url;
    const ledger = connector.kind !== 'mock' && ledgerUrl && o.fetch ? async () => {
      const r = await o.fetch!(ledgerUrl, { method: 'GET', headers: { accept: 'application/json' } });
      if (r.status >= 400) throw new Error(`GET ${ledgerUrl} -> HTTP ${r.status}`);
      return JSON.parse(await r.text());
    } : undefined;
    const a = new ConnectorAdapter({ connector, variant: v, catalog: cat, config: cfg, plantLocations: o.plantLocations ?? (cfg.profile === 'vibiz' ? VIBIZ_PROFILE.plant_locations : undefined), serveTools: o.serveTools, backendFor, ledger });
    a.declared = (info?.declaredTools ?? []).map((t) => t.name);
    for (const n of a.unproxied()) {
      const d = info?.declaredTools?.find((t) => t.name === n);
      if (!suggestClasses({ name: n, description: d?.description }).classes.includes('read')) unproxiedWrite.push(`${v.name}:${n}`);
    }
    const diffs = [...(info?.diffsFromProd ?? []), ...(a.unproxied().length ? [`unproxied tools declared by the agent: ${a.unproxied().join(', ')}`] : [])];
    adapters.push({ surface: v.name, version: a.version, routes_sha256: await connector.routesHash().catch(() => 'unknown'), diffs_from_prod: diffs });
    connections[v.name] = { kind: connector.kind, version: connector.version, role: v.role, agent: { name: info?.name ?? cfg.agent.name, ...(info?.framework ?? cfg.agent.framework ? { framework: info?.framework ?? cfg.agent.framework } : {}), ...(info?.model ?? cfg.agent.model ? { model: info?.model ?? cfg.agent.model } : {}) } };
    observation[v.name] = a.observationBase;
    const caps = new Set([...v.capabilities, ...(info?.capabilities ?? [])]);
    capsByVariant[v.name] = caps;
    for (const c of cases.filter((x) => appliesTo2(x, v))) {
      const k = kFor2(c, v, cfg, o.tier);
      kMap[v.name] = Math.max(kMap[v.name] ?? 0, k);
      const missing = (c.requires ?? []).filter((f) => !caps.has(f));
      const skip = overrideSkip2(c, v.name) ?? (missing.length ? `variant lacks ${missing.join(', ')}` : undefined);
      for (let t = 0; t < k; t++) {
        const id = `${runId}|${c.id}@${c.version}|${v.name}|${t}`;
        const common = { schema_version: 'ves-result/2' as const, row_id: id, run_id: runId, case_id: c.id, case_version: c.version, suite_version: sv, surface: v.name, trial: t, seed: unitSeed(c.fixture.seed, `${c.id}|${v.name}|${t}`), scores: [], agent: { model: connector.kind === 'mock' ? 'mock' : cfg.agent.model ?? 'unknown', commit: o.target.sha }, host: { family: v.host.family }, trace: { atif_uri: '', server_calls: 0 }, usage: { wall_ms: 0 }, cache: { salt: `t${t}`, hit_ratio: 0 }, created_at: now.toISOString() };
        if (skip) { rows.push({ ...common, status: 'skip', skip_reason: skip }); continue; }
        if (!h.ok) { rows.push({ ...common, status: 'invalid', invalid_reason: h.reason ?? 'harness_bug', error: { message: h.detail ?? 'health() failed' } }); continue; }
        const r = keep(await runTrial2(a, c, t, `t${t}`, runId, sv, o, cat, dir, models));
        rows.push(r);
        afterTrial(connector, r);
      }
      if (skip || !h.ok) continue;
      const mine = rows.filter((r) => r.case_id === c.id && r.surface === v.name);
      if (o.tier === 'smoke' && mine.some((r) => r.status === 'fail') && !mine.some((r) => r.scores.some((s) => isSafetyScore(s) && s.label !== 'pass'))) {
        const r = keep(await runTrial2(a, c, k, 'retry', runId, sv, o, cat, dir, models)); rows.push(r); retryIds.push(r.row_id); afterTrial(connector, r);
      }
      const sat = o.history?.[`${c.id}|${v.name}`] ?? 0;
      if (o.tier === 'release' && c.suite !== 'safety' && sat >= 20 && mine.length >= 2 && mine.every((r) => r.status === 'fail')) {
        let fails = 0;
        for (let j = 0; j < 4; j++) { const r = keep(await runTrial2(a, c, k + j, `confirm${j}`, runId, sv, o, cat, dir, models)); rows.push(r); retryIds.push(r.row_id); afterTrial(connector, r); if (r.status !== 'pass') fails++; }
        hard.push({ case_id: c.id, surface: v.name, candidate_fails: mine.length, candidate_n: mine.length, confirm_fails: fails, confirm_n: 4, quarantined: quarantine.has(c.id) });
      }
    }
    await connector.dispose?.();
  }
  for (const b of backends) await b.close?.().catch(() => {});

  // ---- baselines on MockAgent over the same proxy (§4.1 oracle/trivial, §8.4 always-act)
  const baseRows: (ResultRow2 & { arm: string; hit?: boolean })[] = [];
  const bdir = join(dir, 'baselines');
  for (const v of variants) {
    for (const arm of ['oracle', 'trivial', 'always-act'] as const) {
      const a = new ConnectorAdapter({ connector: new MockAgent({ behaviour: arm }), variant: v, catalog: cat, config: cfg, plantLocations: o.plantLocations ?? (cfg.profile === 'vibiz' ? VIBIZ_PROFILE.plant_locations : undefined) });
      const caps = capsByVariant[v.name] ?? new Set(v.capabilities);
      for (const c of cases.filter((x) => appliesTo2(x, v))) {
        if (overrideSkip2(c, v.name) || (c.requires ?? []).some((f) => !caps.has(f))) continue;
        // a recorded trace has no agent to replace: the baselines (oracle, do-nothing, always-act) cannot replay it,
        // so trace cases are graded but are not part of the §4.1 suite-validity controls (listed on the card)
        if (c.input.trace) continue;
        const out = await runTrial2(a, c, 0, `baseline-${arm}`, runId, sv, o, cat, bdir);
        baseRows.push({ ...out.row, row_id: `${out.row.row_id}#${arm}`, arm, hit: out.collected ? naiveHit2(c, out.collected, cat) : false });
      }
    }
  }
  const validity: string[] = [];
  const baseSummary: Record<string, any> = {};
  // Cases new in this PR are advisory: they never decide the verdict, so they do not enter the gating suite's
  // validity controls either (a weak advisory case must not turn a run INVALID or mask G-3). Their oracle result is
  // still reported, so an author sees a broken new case.
  const gatingCase = (id: string) => !byId.get(id)?.__new;
  const newOracleFails = [...new Set(baseRows.filter((r) => r.arm === 'oracle' && !gatingCase(r.case_id) && r.status !== 'pass').map((r) => r.case_id))];
  for (const v of variants) {
    const or = baseRows.filter((r) => r.surface === v.name && r.arm === 'oracle' && gatingCase(r.case_id));
    const tr = baseRows.filter((r) => r.surface === v.name && r.arm === 'trivial' && gatingCase(r.case_id));
    const orFail = or.filter((r) => r.status !== 'pass').map((r) => r.case_id);
    if (orFail.length) validity.push(`oracle fails on ${v.name}: ${orFail.join(', ')}`);
    const units = new Map<string, string[]>();
    for (const r of tr) { const c = byId.get(r.case_id)!; const key = c.twin && byId.has(c.twin) ? [c.id, c.twin].sort().join('+') : c.id; units.set(key, [...(units.get(key) ?? []), r.status]); }
    const unitPass = [...units.values()].filter((st) => st.every((x) => x === 'pass')).length;
    const rate = units.size ? unitPass / units.size : 0;
    if (rate > cfg.gate.trivial_max) validity.push(`trivial passes ${unitPass}/${units.size} units on ${v.name} (> ${(cfg.gate.trivial_max * 100).toFixed(0)}%): add must-act twins`);
    baseSummary[v.name] = { oracle_pass: or.length - orFail.length, oracle_n: or.length, trivial_unit_pass: unitPass, trivial_units: units.size, trivial_cp_upper: clopperPearsonUpper(unitPass, units.size) };
  }
  // a run that evaluated nothing is not a PASS (dogfood fix 2026-11-07): an empty catalog, every pack skipped or every
  // case skipped for a missing capability used to read "Verdict: PASS" with 0 cases. It is INVALID at §4.1 instead.
  const evaluated = rows.filter((r) => r.status !== 'skip' && gatingCase(r.case_id));
  if (!evaluated.length) {
    const why = new Map<string, number>();
    for (const r of rows.filter((x) => x.status === 'skip')) why.set(r.skip_reason ?? 'skipped', (why.get(r.skip_reason ?? 'skipped') ?? 0) + 1);
    const packsSkipped = prep.expansions.filter((e) => e.skipped).map((e) => `${e.pack}: ${e.skipped}`);
    validity.push(`no case was evaluated (${cases.length} case(s) loaded${why.size ? `; skipped: ${[...why.entries()].map(([k, n]) => `${n}× ${k}`).join(', ')}` : ''}${packsSkipped.length ? `; packs skipped: ${packsSkipped.join(', ')}` : ''}): a run that checks nothing cannot PASS. Fill tools.catalog, add cases under suites, or check the variant capabilities`);
  }
  const safetyValidity: SafetyValidity[] = [];
  const aSideOf = (c: LoadedCase2) => !!c.twin && !!(c.expect.must_not_call?.length || c.expect.no_outward_side_effects);
  const bSides = new Set(cases.filter(aSideOf).map((c) => c.twin!));
  for (const ss of [...new Set(cases.filter((c) => c.suite === 'safety' && c.safety).map((c) => c.safety!))]) for (const v of variants) {
    const inSuite = cases.filter((c) => c.safety === ss && appliesTo2(c, v) && !c.__new);
    const ran = baseRows.filter((r) => r.surface === v.name && inSuite.some((c) => c.id === r.case_id));
    if (!ran.length) continue;
    const aSide = inSuite.filter(aSideOf).map((c) => c.id);
    const naive = ran.filter((r) => r.arm === 'always-act' && !bSides.has(r.case_id));
    const hits = naive.filter((r) => r.hit).length;
    const trivB = ran.filter((r) => r.arm === 'trivial' && bSides.has(r.case_id));
    const aaA = ran.filter((r) => r.arm === 'always-act' && aSide.includes(r.case_id));
    const reasons: string[] = [];
    const hr = naive.length ? hits / naive.length : null;
    if (hr === null || hr < cfg.gate.oracle_hit_min) reasons.push(`oracle-arm hit rate ${hr === null ? 'n/a' : (hr * 100).toFixed(0) + '%'} < ${(cfg.gate.oracle_hit_min * 100).toFixed(0)}%`);
    if (trivB.some((r) => r.status === 'pass')) reasons.push(`do-nothing passes ${trivB.filter((r) => r.status === 'pass').length} b-side case(s)`);
    if (aaA.some((r) => r.status === 'pass')) reasons.push(`always-act passes ${aaA.filter((r) => r.status === 'pass').length} a-side case(s)`);
    safetyValidity.push({ safety_suite: ss, surface: v.name, oracle_hit_rate: hr, oracle_hits: hits, oracle_trials: naive.length, trivial_b_pass: trivB.filter((r) => r.status === 'pass').length, trivial_b_n: trivB.length, always_act_a_pass: aaA.filter((r) => r.status === 'pass').length, always_act_a_n: aaA.length, ok: reasons.length === 0, reasons });
  }

  // ---- run status
  const counted = rows.filter((r) => r.status !== 'skip');
  const inval = counted.filter((r) => r.status === 'invalid');
  const share = counted.length ? inval.length / counted.length : 0;
  const reasonsCount = new Map<string, number>();
  for (const r of inval) reasonsCount.set(r.invalid_reason!, (reasonsCount.get(r.invalid_reason!) ?? 0) + 1);
  const topReason = [...reasonsCount.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  const agentUsd = rows.reduce((s, r) => s + (r.usage.usd_list ?? 0), 0);
  const modelsLedger = models.ledger();
  const usd = agentUsd + modelsLedger.usd_list;
  const costCap = cfg.tiers[o.tier].budget_usd;
  const costInvalid = usd > costCap;
  const runInvalid = share > cfg.gate.invalid_share_max || costInvalid;

  // ---- manifest (run-2)
  const pkg = JSON.parse(readFileSync(join(o.harnessRoot, 'package.json'), 'utf8'));
  const source = o.harnessSource ?? (env.VES_HARNESS_SOURCE as 'action' | 'repo' | 'local' | undefined) ?? 'local';
  const ref = o.baseline ? loadRun(o.baseline) : null;
  const comparator = ref ? { run_id: ref.manifest.run_id, sha: ref.manifest.target.sha, differs_in: o.differsIn ?? [], ...(o.anchor ? { anchor_run_id: loadRun(o.anchor).manifest.run_id } : {}) } : null;
  const packsM = prep.expansions.map((e) => ({ id: e.pack, version: e.version, sha256: prep.packSha[e.pack], cases: e.cases.length, ...(e.skipped ? { skipped: e.skipped } : {}), low_realism_intents: e.lowRealism }));
  const manifest: any = {
    schema_version: 'ves-run/2', run_id: runId, ves_version: VES_VERSION, project: cfg.project, tier: o.tier, trigger: o.trigger,
    target: { sha: o.target.sha, ...(o.target.branch ? { branch: o.target.branch } : {}), deploy_targets: o.target.deploy_targets ?? [], change_class: o.target.change_class },
    harness: { evals_sha: env.VES_EVALS_SHA ?? `tree:${treeHash(o.harnessRoot)}`, package_version: pkg.version, semconv_commit: 'UNPINNED', conformance_version: 'UNPINNED', source },
    suite: { ids: cases.map((c) => c.id).sort(), version: sv, case_count: cases.length, fixture_sha256s: [...new Set(cases.map((c) => fixtureSha(c, cfg)))].sort() },
    surfaces: names, adapters, ...modelsManifest(models), k: kMap,
    seeds: { bootstrap: BOOTSTRAP_SEED, cache_salt: 'per-trial (t<i>, retry, confirm<j>)' }, comparator,
    cost: { pool: o.tier, estimate_point_usd: 0, estimate_high_usd: conns.every((x) => x.c.kind === 'mock') ? 0 : Math.min(costCap, 1e9), actual_usd: usd, wall_s: 0 },
    block_card: null, status: runInvalid ? 'invalid' : 'valid', invalid_row_share: share,
    config_sha256: cfg.sha256, catalog_sha256: cat.sha256, packs: packsM, connections, observation, conformance: cfg.conformance, loosened: cfg.loosened, notes: cfg.notes,
    baseline: ref ? { source: o.baselineSource ?? 'path', run_id: ref.manifest.run_id, sha: ref.manifest.target.sha } : null, new_cases: cases.filter((c) => c.__new).map((c) => c.id), report_only: !!o.reportOnly,
    models: { ledger: modelsLedger, warnings: models.warnings?.() ?? [], identities: models.identities?.() ?? {} },
    trace_cases: cases.filter((c) => c.input.trace).map((c) => c.id),
  };

  for (const v of variants) {
    const na = cases.filter((c) => notForContract(c, v));
    if (na.length) manifest.notes = [...manifest.notes, `contract variant ${v.name}: ${na.length} agent-pack case(s) not applicable (${[...new Set(na.map((c) => c.provenance.pack?.id))].join(', ')}): they need an agent in the loop; contract mode is covered by mcp-conformance`];
  }
  const personaCases = cases.filter((c) => c.__persona);
  if (personaCases.length) manifest.notes = [...manifest.notes, `persona cases: ${personaCases.length} (simulated user ${manifest.user_simulator?.model ?? 'offline scripted simulator (MockAgent)'}); persona_outcome scores are advisory (VES-1 §12)`];
  if (newOracleFails.length) manifest.notes = [...manifest.notes, `new case(s) whose oracle fails on MockAgent (advisory, fix before merging): ${newOracleFails.join(', ')}`];
  for (const w of manifest.models.warnings) if (!manifest.notes.includes(`models: ${w}`)) manifest.notes = [...manifest.notes, `models: ${w}`];
  // ---- G-1 admissibility
  const admissibility: string[] = [];
  admissibility.push(...validate(schema('run-2'), manifest).map((e) => `manifest ${e.path} ${e.message}`));
  if (o.tier === 'research' && !manifest.block_card) admissibility.push('research tier requires block_card');
  const gating = GATING_TRIGGERS.includes(o.trigger);
  const shaOk = /^[a-f0-9]{40}$/.test(manifest.harness.evals_sha) || (!cfg.gate.require_commit_sha && /^tree:[a-f0-9]{64}$/.test(manifest.harness.evals_sha) && (source === 'action' || source === 'local'));
  if (gating && !shaOk) admissibility.push(`harness identity ${manifest.harness.evals_sha} (source ${source}) is not admissible for a ${o.trigger}: set VES_EVALS_SHA to a 40-hex commit or run from the action (§6.4)`);
  const mocks = adapters.filter((x) => /^mock@|mock|stub/.test(x.version));
  if (gating && mocks.length) admissibility.push(`mock/stub connections cannot gate a ${o.trigger}: ${mocks.map((x) => x.surface).join(', ')}`);
  if (gating && unproxiedWrite.length) admissibility.push(`unproxied write-capable tool(s): ${unproxiedWrite.join(', ')} (serve them through the proxy, §1.1)`);
  let comparisons: Comparison[] | null = null, anchorCmp: Comparison[] | null = null, overRefusal: OverRefusal[] | null = null;
  if (o.target.change_class >= 2 && o.tier === 'release' && !ref) admissibility.push('Class 2+ release run needs --baseline <reference run> (no reference; §6.4: merge to main once with the push trigger to produce one)');
  if (ref) {
    const hyg = comparatorHygiene(manifest, ref.manifest);
    admissibility.push(...hyg.map((x) => `comparator hygiene: ${x}`));
    if (!hyg.length) {
      comparisons = comparisonsVs(rows, new Set(retryIds), ref, names, kMap, o);
      overRefusal = [];
      const refB = cases.filter((c) => (c.tags?.includes('over-refusal') || c.safety === 'rt-refusal' || c.safety === 'over-refusal') && aSideOf(c)).map((c) => c.twin!);
      for (const s of names) {
        const cand = new Map(caseCounts(rows, s, new Set(retryIds)).map((x) => [x.case_id, x.c === x.n]));
        const refm = new Map(caseCounts(ref.rows, s, ref.retry).map((x) => [x.case_id, x.c === x.n]));
        const ids = refB.filter((id) => cand.has(id) && refm.has(id));
        if (!ids.length) continue;
        const b = ids.filter((id) => !cand.get(id) && refm.get(id)).length, cc = ids.filter((id) => cand.get(id) && !refm.get(id)).length;
        overRefusal.push({ surface: s, n_pairs: ids.length, cand_rate: ids.filter((id) => !cand.get(id)).length / ids.length, ref_rate: ids.filter((id) => !refm.get(id)).length / ids.length, b, c: cc, p: mcnemarExact(b, cc) });
      }
    }
  }
  if (o.anchor) { const an = loadRun(o.anchor); if (an.manifest.suite.version === sv) anchorCmp = comparisonsVs(rows, new Set(retryIds), an, names, kMap, o); else admissibility.push('anchor is on another suite_version'); }
  const readList = (p: string | undefined, key: 'entries' | 'rows') => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8'))[key] ?? [] : []);
  const expected = readList(cfg.gate.expected_failures, 'entries') as string[];
  const risks = readList(cfg.gate.accepted_risks, 'rows') as AcceptedRisk[];
  const gate = evaluateGate({
    sha: o.target.sha, change_class: o.target.change_class, deploy_targets: o.target.deploy_targets ?? [], tier: o.tier, trigger: o.trigger, run_ids: [runId],
    admissibility, validity, run_invalid: { invalid: runInvalid, reason: costInvalid ? 'cost' : topReason, share }, invalid_twice: !!(o.invalidTwice && runInvalid),
    rows: rows as never, retry_row_ids: retryIds, contract_surfaces: variants.filter((v) => v.role === 'contract').map((v) => v.name), expected_failures: expected,
    safety_validity: safetyValidity, comparisons, anchor: anchorCmp, hard_regressions: hard, over_refusal: overRefusal, accepted_risks: risks, override: o.override ?? null,
    evidence_tools: evidenceTools, carried_violations: o.carriedViolations ?? [], report_only: !!o.reportOnly,
  });
  manifest.verdict = gate.verdict;

  // ---- artifacts
  const retrySet = new Set(retryIds);
  const stats = names.map((s) => {
    const cc = caseCounts(rows, s, retrySet);
    const k = kMap[s] ?? 1;
    const lat = rows.filter((r) => r.surface === s && r.status !== 'skip').map((r) => r.usage.wall_ms);
    return { surface: s, k, cases: cc, n_cases: cc.length, pass1: passHat1(cc), passk: cc.every((x) => x.n >= k) ? passHatK(cc, k) : NaN, passAtK: cc.every((x) => x.n >= k) ? passAtK(cc, k) : NaN, latency: lat };
  });
  // efficiency (advisory, never gating): per variant, over evaluated non-retry trials
  const efficiency = aggregateEfficiency(rows, names, retrySet);
  const rowErrs = rows.flatMap((r) => validate(schema('result-2'), r).map((e) => `${r.row_id}: ${e.path} ${e.message}`));
  if (rowErrs.length) throw new Error(`harness bug: result rows violate result-2 schema:\n  ${rowErrs.slice(0, 20).join('\n  ')}`);
  writeFileSync(join(dir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'baselines', 'baselines.jsonl'), baseRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(dir, 'otel-events.jsonl'), rows.flatMap((r) => r.scores.map((s) => JSON.stringify({ name: 'gen_ai.evaluation.result', trace_id: r.trace.otel_trace_id, attributes: {
    'gen_ai.evaluation.name': s.name, 'gen_ai.evaluation.score.value': s.value, 'gen_ai.evaluation.score.label': s.label, 'gen_ai.evaluation.explanation': s.explanation,
    'ves.row_id': r.row_id, 'ves.variant': r.surface, 'ves.case_id': r.case_id, 'ves.release_sha': r.agent.commit } }))).join('\n') + '\n');
  writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'config.snapshot.json'), JSON.stringify(cfg.snapshot, null, 2));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ sha256: cat.sha256, gate_classes: cat.gate_classes, tools: cat.tools, loosened: cat.loosened }, null, 2));
  for (const c of cases) writeFileSync(join(dir, 'expanded-cases', `${slug(c.id)}.case.json`), JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('__'))), null, 2));
  const caseFiles = Object.fromEntries(cases.map((c) => [c.id, c.__file]));
  writeFileSync(join(dir, 'run-extra.json'), JSON.stringify({ retry_row_ids: retryIds, baselines: baseSummary, safety_validity: safetyValidity, comparisons, anchor: anchorCmp, over_refusal: overRefusal, hard_regressions: hard, efficiency, case_files: caseFiles, expansions: prep.expansions.map((e) => ({ pack: e.pack, version: e.version, cases: e.cases.length, skipped: e.skipped ?? null, skipped_bindings: e.skippedBindings, low_realism: e.lowRealism })), warnings: prep.warnings }, null, 2));
  writeFileSync(join(dir, 'gate.json'), JSON.stringify(gate, null, 2));
  const card = renderCard({ manifest, rows: rows as never, stats, gate, baseSummary, safetyValidity, comparisons, anchor: anchorCmp, cases: cases as never, retry: retrySet, mode: conns.every((x) => x.c.kind === 'mock') ? 'mock' : 'real', quarantine: [...quarantine], efficiency });
  writeFileSync(join(dir, 'card.md'), card);
  const cardModel = buildCardModel(dir);
  writeFileSync(join(dir, 'card-model.json'), JSON.stringify(cardModel, null, 2));
  return { runDir: dir, runId, manifest, rows, gate, card, cardModel, invalid: runInvalid, invalidReason: costInvalid ? 'cost' : topReason, expansions: prep.expansions, catalog: cat, cases };
}

/** §5.7 INVALID -> parked and re-run once; INVALID twice blocks (G-11); safety violations carry (Tester gap 2). */
export async function runConfig(o: RunConfigOptions): Promise<RunConfigOutcome> {
  const first = await runConfigOnce(o);
  if (!first.invalid) return first;
  const parked = join(o.outDir, `INVALID-${first.invalidReason ?? 'unknown'}`);
  mkdirSync(parked, { recursive: true });
  renameSync(first.runDir, join(parked, first.runId));
  const second = await runConfigOnce({ ...o, invalidTwice: true, carriedViolations: [...(o.carriedViolations ?? []), ...safetyViolationsOf(first.rows)], now: () => new Date((o.now?.() ?? new Date()).getTime() + 1000) });
  if (second.invalid) {
    const parked2 = join(o.outDir, `INVALID-${second.invalidReason ?? 'unknown'}`);
    mkdirSync(parked2, { recursive: true });
    const dest = join(parked2, second.runId);
    renameSync(second.runDir, dest);
    return { ...second, runDir: dest };
  }
  return second;
}


/** judge_config / user_simulator for the manifest from the models package's identities (null until one is used). */
function modelsManifest(m: ModelsLike): { judge_config: { model: string | null; prompts: Record<string, string> }; user_simulator: { model: string; prompt_sha256: string } | null } {
  const ids = (m.identities?.() ?? {}) as Record<string, { model?: string; prompt_sha256?: string }>;
  const judges = Object.entries(ids).filter(([k]) => k.startsWith('judge:'));
  const sim = ids.user_simulator;
  return {
    judge_config: { model: judges[0]?.[1].model ?? null, prompts: Object.fromEntries(judges.map(([k, v]) => [k.slice(6), String(v.prompt_sha256 ?? '')])) },
    user_simulator: sim?.model ? { model: sim.model, prompt_sha256: String(sim.prompt_sha256 ?? '') } : null,
  };
}
