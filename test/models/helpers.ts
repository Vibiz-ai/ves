// Shared fixtures for the models tests: injected fetch/exec/clock/sleep only (test/setup.ts blocks real network).
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createModelsExt, type ModelsDepsAll } from '../../src/models/index.ts';
import { fakeExec, fakeOpenAIFetch, type FakeHttpAnswer, type RecordedRequest } from '../../src/models/fake.ts';
import type { ModelsConfig } from '../../src/core/types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function tmpDir(tag: string): { dir: string; cleanup: () => void } {
  const dir = join(ROOT, 'results', `.test-models-${tag}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export function clock(start = '2026-11-07T12:00:00Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}
export const json = (v: unknown) => JSON.stringify(v);

export function setup(o: {
  cfg?: ModelsConfig; handler?: (body: any, req: RecordedRequest, n: number) => FakeHttpAnswer; tokens?: (string | { code: number; stderr?: string })[];
  env?: Record<string, string | undefined>; cap?: number; cacheDir?: string; extra?: Partial<ModelsDepsAll>;
} = {}) {
  const c = clock();
  const sleeps: number[] = [];
  const fetch = fakeOpenAIFetch(o.handler ?? (() => ({ content: 'hello' })));
  const exec = fakeExec(o.tokens ?? ['ya29.token-one']);
  const logs: string[] = [];
  const api = createModelsExt(o.cfg ?? {}, {
    fetch, exec, env: o.env ?? { GOOGLE_CLOUD_PROJECT: 'proj-test' }, now: c.now, cacheDir: o.cacheDir ?? '',
    budget: { pool: 'smoke', usd_cap: o.cap ?? 2 }, sleep: async (ms) => { sleeps.push(ms); }, log: (_l, m) => logs.push(m),
    judgeRegistry: { admitted: [] }, ...(o.extra ?? {}),
  });
  return { api, fetch, exec, sleeps, logs, clock: c };
}
