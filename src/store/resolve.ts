// Which store a command uses. Order: --store <url>, then $VES_STORE, then the `store` block of ves.config.json
// (--config, else ./ves.config.json), then ./.ves/store. A URL is a local path or gs://bucket[/prefix].
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { AdcToken } from '../models/vertex.ts';
import type { ExecLike } from '../core/types.ts';
import { GcsBackend, parseGsUrl } from './gcs.ts';
import { LocalBackend } from './local.ts';
import { RunStore } from './store.ts';
import { StoreError, type StoreFetch } from './types.ts';

export const DEFAULT_STORE = '.ves/store';
export type StoreConfig = { url?: string; auto_push?: boolean; project?: string };
export type StoreDeps = { env: Record<string, string | undefined>; cwd: string; exec: ExecLike; fetch: StoreFetch; now?: () => Date; sleep?: (ms: number) => Promise<void> };
export type ResolvedStore = { url: string; source: 'args' | 'env' | 'config' | 'default'; project?: string; auto_push: boolean };

/** The raw `store` block of a config file, or null. Read without full config validation: archiving must not depend on
 * the agent wiring being valid. */
export function readStoreBlock(configPath: string | undefined, cwd: string): { block: StoreConfig; dir: string } | null {
  const f = configPath ? resolve(cwd, configPath) : resolve(cwd, 'ves.config.json');
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j && typeof j.store === 'object' && j.store ? { block: j.store as StoreConfig, dir: dirname(f) } : { block: {}, dir: dirname(f) };
  } catch { return null; }
}

export function resolveStoreUrl(o: { arg?: string; config?: string; env: Record<string, string | undefined>; cwd: string }): ResolvedStore {
  const cfg = readStoreBlock(o.config, o.cwd);
  const project = cfg?.block.project ?? o.env.VES_STORE_PROJECT ?? o.env.GOOGLE_CLOUD_PROJECT ?? o.env.CLOUDSDK_CORE_PROJECT;
  const auto_push = cfg?.block.auto_push === true;
  const abs = (u: string, base: string) => (u.startsWith('gs://') || isAbsolute(u) ? u : resolve(base, u));
  if (o.arg) return { url: abs(o.arg, o.cwd), source: 'args', project, auto_push };
  if (o.env.VES_STORE) return { url: abs(o.env.VES_STORE, o.cwd), source: 'env', project, auto_push };
  if (cfg?.block.url) return { url: abs(cfg.block.url, cfg.dir), source: 'config', project, auto_push };
  return { url: resolve(o.cwd, DEFAULT_STORE), source: 'default', project, auto_push };
}

export function openStore(r: { url: string; project?: string }, deps: StoreDeps): RunStore {
  if (r.url.startsWith('gs://')) {
    const { bucket, prefix } = parseGsUrl(r.url);
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const adc = new AdcToken(deps.exec, deps.now ?? (() => new Date()), sleep);
    if (!r.project) throw new StoreError('config', `gcs store ${r.url}: no billing project for x-goog-user-project (set store.project in ves.config.json, or VES_STORE_PROJECT / GOOGLE_CLOUD_PROJECT)`);
    return new RunStore(new GcsBackend({ bucket, prefix, project: r.project, fetch: deps.fetch, token: (force) => adc.token(force), sleep }), { now: deps.now });
  }
  return new RunStore(new LocalBackend(r.url), { now: deps.now });
}
