// Models package entry (DESIGN-agnostic §7.5). `src/registry/models.ts` imports this file and calls
// `createModels(config.models, deps)`. Default provider for every purpose: Vertex AI Gemini (`google/gemini-3.8-flash`,
// location global, project from config or GOOGLE_CLOUD_PROJECT, ADC auth). `provider: "vertex"` with an
// `anthropic/claude-*` model runs Claude on Vertex (vertex-anthropic.ts), billed to the same Google Cloud project. Any OpenAI-compatible endpoint is
// pluggable per purpose or by name. All calls share one content-hash cache and one spend ledger with a hard cap.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError, UsageError } from '../core/errors.ts';
import type { ChatModel, ChatRequest, CreateModels, IntentWriter, Judge, ModelPurpose, ModelRef, ModelsApi, ModelsConfig, UserSimulator } from '../core/types.ts';
import { canonicalJson } from '../lib/canonicalise.ts';
import { ModelCache } from './cache.ts';
import { createChatModel, worstCaseUsd } from './chat.ts';
import { createFakeProvider, type FakeResponder } from './fake.ts';
import { createIntentWriter } from './intent-writer.ts';
import { createJudge, loadRegistry, type RegistrySource } from './judge.ts';
import { SpendLedger, type LedgerRow } from './ledger.ts';
import { createOpenAICompatibleProvider } from './openai-compatible.ts';
import { type ModelsDepsExt, type Provider, type ProviderDeps, realSleep, RpmLimiter } from './provider.ts';
import { createUserSimulator } from './user-sim.ts';
import { AdcToken, createVertexProvider, VERTEX_DEFAULT_MODEL } from './vertex.ts';
import { anthropicVertexModel, createVertexAnthropicProvider } from './vertex-anthropic.ts';
import { createPersonaJudge, type PersonaJudge } from './persona-judge.ts';

export const DEFAULT_MODEL_REF: ModelRef = { provider: 'vertex', model: VERTEX_DEFAULT_MODEL, location: 'global' };
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_JUDGE_REGISTRY = join(HARNESS_ROOT, 'judges', 'registry.json');
const PURPOSE_KEYS: ModelPurpose[] = ['judge', 'user_simulator', 'host_sim', 'intent_writer'];

/** createModels' deps, everything beyond core's ModelsDeps optional. `fakeResponder` drives `provider: "fake"` refs. */
export type ModelsDepsAll = ModelsDepsExt & { fakeResponder?: FakeResponder };
/** ModelsApi plus extras core may use: ledger rows (cached flag, per-call cost), warnings (G-1 family clash, unpriced
 * models), agent-reported spend in the same pool, a worst-case estimate, and the resolved ref for manifests. */
export type ModelsApiExt = ModelsApi & {
  rows(): LedgerRow[];
  warnings(): string[];
  chargeExternal(usd: number, label?: string): void;
  estimate(ref: ModelRef | string, req: ChatRequest, purpose: ModelPurpose): number;
  resolve(ref: ModelRef | string): ModelRef;
  /** For the run manifest: the model, family and prompt SHAs of each purpose actually created. */
  identities(): Record<string, unknown>;
  /** The persona_outcome judge (advisory, persona-judge.ts), on the `judge` model. */
  personaJudge(): PersonaJudge;
};

/** Resolves `default`, a purpose key, a `named` key (`local` or `named.local`) or an inline ModelRef. */
export function resolveModelRef(cfg: ModelsConfig, ref: ModelRef | string, seen: string[] = []): ModelRef {
  if (ref && typeof ref === 'object') {
    if (!ref.provider || !ref.model) throw new UsageError(`model ref needs provider and model: ${JSON.stringify(ref).slice(0, 120)}`);
    return ref;
  }
  const key = String(ref);
  if (seen.includes(key)) throw new UsageError(`models: reference cycle ${[...seen, key].join(' -> ')}`);
  const next = [...seen, key];
  if (key === 'default') return cfg.default ?? DEFAULT_MODEL_REF;
  if ((PURPOSE_KEYS as string[]).includes(key)) {
    const v = (cfg as Record<string, unknown>)[key] as string | ModelRef | undefined;
    return v === undefined ? resolveModelRef(cfg, 'default', next) : resolveModelRef(cfg, v, next);
  }
  const name = key.startsWith('named.') ? key.slice(6) : key;
  const n = cfg.named?.[name];
  if (n) return n;
  throw new UsageError(`models: unknown model "${key}" (use default, judge, user_simulator, host_sim, intent_writer or a key of models.named)`);
}

export function createModelsExt(cfg: ModelsConfig | undefined, deps: ModelsDepsAll): ModelsApiExt {
  const conf: ModelsConfig = cfg ?? {};
  if (typeof deps?.fetch !== 'function' || typeof deps?.exec !== 'function') throw new HarnessError('createModels: deps.fetch and deps.exec must be injected');
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const warnings: string[] = [];
  const log = deps.log ?? (() => {});
  const warn = (m: string) => { if (!warnings.includes(m)) { warnings.push(m); log('warn', m); } };
  const pdeps: ProviderDeps = { fetch: deps.fetch, exec: deps.exec, env: deps.env ?? {}, now, sleep, log, maxAttempts: deps.maxAttempts ?? 6 };
  const limiter = new RpmLimiter(now, sleep);
  const adc = new AdcToken(deps.exec, now, sleep);
  const cache = new ModelCache(deps.cacheDir);
  const ledger = new SpendLedger(deps.budget?.usd_cap ?? 0, deps.budget?.pool ?? 'smoke', now);
  const ctx = { cache, ledger, prices: deps.prices, log, warn };
  let reg: RegistrySource | null = null;
  const registry = () => (reg ??= loadRegistry(deps.judgeRegistry, DEFAULT_JUDGE_REGISTRY));

  const models = new Map<string, { chat: ChatModel; provider: Provider }>();
  const providerFor = (r: ModelRef): Provider => {
    const p = (r as { provider: string }).provider;
    if (p === 'vertex') return anthropicVertexModel(r.model) ? createVertexAnthropicProvider(r, pdeps, { adc, limiter }) : createVertexProvider(r, pdeps, { adc, limiter });
    if (p === 'openai-compatible') return createOpenAICompatibleProvider(r, pdeps, limiter);
    if (p === 'fake') return createFakeProvider(r, deps.fakeResponder);
    throw new UsageError(`models: unknown provider "${p}" (vertex, openai-compatible, fake)`);
  };
  const get = (ref: ModelRef | string) => {
    const r = resolveModelRef(conf, ref);
    const k = canonicalJson(r);
    let m = models.get(k);
    if (!m) { const provider = providerFor(r); m = { provider, chat: createChatModel(provider, r, ctx) }; models.set(k, m); }
    return m;
  };
  const judges = new Map<string, Judge>();
  let sim: UserSimulator | null = null;
  let writer: IntentWriter | null = null;
  let personaJ: PersonaJudge | null = null;
  const identities: Record<string, unknown> = {};

  return {
    chat: (ref) => get(ref).chat,
    judge(dimension) {
      let j = judges.get(dimension);
      if (!j) {
        const m = get('judge');
        j = createJudge(m.chat, dimension, { reg: registry(), modelId: m.provider.model, agent: deps.agent, warn });
        judges.set(dimension, j);
        identities[`judge:${dimension}`] = j.identity;
      }
      return j;
    },
    userSimulator() {
      if (!sim) { const m = get('user_simulator'); sim = createUserSimulator(m.chat, { modelId: m.provider.model }); identities.user_simulator = sim.identity; }
      return sim;
    },
    personaJudge() {
      if (!personaJ) {
        const m = get('judge');
        personaJ = createPersonaJudge(m.chat, { modelId: m.provider.model, agent: deps.agent });
        identities['judge:persona_outcome'] = personaJ.identity;
      }
      return personaJ;
    },
    intentWriter() {
      if (!writer) { const m = get('intent_writer'); const w = createIntentWriter(m.chat, { warn }); writer = w; identities.intent_writer = { model: m.provider.model, prompt_sha256: w.prompt_sha256 }; }
      return writer;
    },
    ledger: () => ledger.summary(),
    rows: () => ledger.rows.map((r) => ({ ...r })),
    warnings: () => [...warnings],
    chargeExternal: (usd, label) => ledger.chargeExternal(usd, label),
    estimate: (ref, req, purpose) => worstCaseUsd(get(ref).provider, req, purpose, deps.prices),
    resolve: (ref) => resolveModelRef(conf, ref),
    identities: () => JSON.parse(JSON.stringify(identities)),
  };
}

export const createModels: CreateModels = (cfg, deps) => createModelsExt(cfg, deps as ModelsDepsAll);

export { SpendLedger } from './ledger.ts';
export { ModelCache, cacheKey } from './cache.ts';
export { effectiveJudgeRole, JUDGE_PROMPT_SHA256, isSafetyDimension } from './judge.ts';
export { USER_SIM_PROMPT_SHA256 } from './user-sim.ts';
export { PERSONA_JUDGE_PROMPT_SHA256 } from './persona-judge.ts';
export { anthropicVertexModel, anthropicVertexUrl } from './vertex-anthropic.ts';
export { INTENT_PROMPT_SHA256 } from './intent-writer.ts';
export { ModelHttpError, familyOf } from './provider.ts';
export { createFakeProvider, defaultFakeResponder, fakeOpenAIFetch, fakeExec } from './fake.ts';
export { vertexModelId, vertexUrl, VERTEX_DEFAULT_MODEL } from './vertex.ts';
