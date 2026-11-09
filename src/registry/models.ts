// Models package discovery (DESIGN-agnostic §7.1 item 8, §7.5). `src/models/index.ts`, when present, exports
// `createModels: CreateModels`. When absent, every ModelsApi method throws "models package not installed", so runs
// that need no judge, user simulator, host-sim or intent writer still work.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_ROOT } from '../adapters/profiles.ts';
import { HarnessError } from '../core/errors.ts';
import type { CreateModels, ModelsApi, ModelsDeps, ResolvedConfig } from '../core/types.ts';

const notInstalled = (): never => { throw new HarnessError('models package not installed (src/models/index.ts); judges, user simulators, host-sim and the intent writer are unavailable'); };
export const NO_MODELS: ModelsApi = {
  chat: notInstalled, judge: notInstalled, userSimulator: notInstalled, intentWriter: notInstalled,
  ledger: () => ({ calls: 0, usd_list: 0, cache_hit_ratio: 0, by_purpose: { judge: { calls: 0, usd_list: 0 }, user_simulator: { calls: 0, usd_list: 0 }, host_sim: { calls: 0, usd_list: 0 }, intent_writer: { calls: 0, usd_list: 0 } }, spend_stopped: false }),
};

export async function loadCreateModels(root: string = HARNESS_ROOT): Promise<CreateModels | null> {
  const f = join(root, 'src', 'models', 'index.ts');
  if (!existsSync(f)) return null;
  const mod = await import(pathToFileURL(f).href);
  if (typeof mod.createModels !== 'function') throw new HarnessError('src/models/index.ts must export createModels: CreateModels');
  return mod.createModels as CreateModels;
}

export async function createModelsApi(cfg: ResolvedConfig['models'], deps: ModelsDeps, root: string = HARNESS_ROOT): Promise<{ api: ModelsApi; installed: boolean }> {
  const create = await loadCreateModels(root);
  return create ? { api: create(cfg, deps), installed: true } : { api: NO_MODELS, installed: false };
}
