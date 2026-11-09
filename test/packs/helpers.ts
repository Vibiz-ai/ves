// Shared helpers for the packs tests (test/packs/**). Runs go to results/.test-packs-*; no network (test/setup.ts).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { resolveConfig } from '../../src/config/load.ts';
import { runConfigOnce, type RunConfigOptions, type RunConfigOutcome } from '../../src/runner/run-v2.ts';
import { buildCatalog } from '../../src/catalog/catalog.ts';
import { expandPack, type ExpandResult } from '../../src/cases/expand.ts';
import { EMPTY_INTENTS } from '../../src/cases/intents.ts';
import { loadPacks } from '../../src/registry/packs.ts';
import type { LoadedPack, ResolvedConfig, VesConfig } from '../../src/core/types.ts';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const PACK_FIX = join(HERE, 'fixtures', 'catalogs');
const CORE_FIX = join(ROOT, 'test', 'core', 'fixtures', 'catalogs');

/** The two made-up catalogs of this package, then core's 3 public samples and the held-out catalog. */
export const MADE_UP = ['travel-desk', 'hr-helpdesk'] as const;
export const ALL_CATALOGS: { name: string; dir: string }[] = [
  ...MADE_UP.map((name) => ({ name, dir: PACK_FIX })),
  ...['support-desk', 'ecommerce-ops', 'devops', 'heldout'].map((name) => ({ name, dir: CORE_FIX })),
];
export const GENERIC_PACKS = ['core-tool-use', 'hitl-approval', 'prompt-injection', 'data-isolation', 'over-refusal'] as const;
export const SAFETY_PACKS = new Set(['hitl-approval', 'prompt-injection', 'data-isolation']);

export function rawCatalog(name: string): { raw: VesConfig; dir: string } {
  const c = ALL_CATALOGS.find((x) => x.name === name) ?? { name, dir: PACK_FIX };
  return { raw: JSON.parse(readFileSync(join(c.dir, `${name}.json`), 'utf8')) as VesConfig, dir: c.dir };
}
export function config(name: string, mut: (c: any) => void = () => {}): ResolvedConfig {
  const { raw, dir } = rawCatalog(name);
  raw.suites = [];
  mut(raw);
  const r = resolveConfig(raw, { dir, env: {} });
  assert.deepEqual(r.errors, [], `${name}: config errors`);
  return r.config;
}

export function tmpDir(tag: string): { dir: string; cleanup: () => void } {
  const dir = join(ROOT, 'results', `.test-packs-${tag}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
let tick = Date.parse('2026-11-07T12:00:00Z');
export const now = () => new Date((tick += 1000));

export function runPacks(cfg: ResolvedConfig, packs: string[], outDir: string, o: Partial<RunConfigOptions> = {}): Promise<RunConfigOutcome> {
  return runConfigOnce({ harnessRoot: ROOT, config: cfg, tier: 'release', trigger: 'manual', connection: 'mock', packs, target: { sha: 'abc1234', change_class: 1 }, outDir, now, bootstrapN: 200, ...o });
}
export const extraOf = (r: RunConfigOutcome): any => JSON.parse(readFileSync(join(r.runDir, 'run-extra.json'), 'utf8'));
export const baselinesOf = (r: RunConfigOutcome): any[] => readFileSync(join(r.runDir, 'baselines', 'baselines.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const firedRules = (r: RunConfigOutcome): string => JSON.stringify(r.gate.rules.filter((x) => x.status === 'fired').map((x) => [x.rule, x.detail]));

let packsCache: Promise<LoadedPack[]> | null = null;
export async function pack(id: string): Promise<LoadedPack> {
  packsCache ??= loadPacks({ harnessRoot: ROOT }).then((l) => { assert.deepEqual(l.errors, [], 'packs load without errors'); return l.packs; });
  const p = (await packsCache).find((x) => x.manifest.id === id);
  assert.ok(p, `pack ${id} not found`);
  return p!;
}
/** Expand one pack over a config's catalog exactly as the runner does (core expander + the pack module). */
export async function expand(id: string, cfg: ResolvedConfig, options: Record<string, unknown> = {}): Promise<ExpandResult> {
  const { catalog, errors } = buildCatalog(cfg.tools.catalog, { gate_classes: cfg.tools.gate_classes });
  assert.deepEqual(errors, []);
  return expandPack(await pack(id), { catalog, config: cfg, intents: EMPTY_INTENTS }, options);
}
/** Every tool name a case refers to (expectations, oracle, plants, overrides, provenance bindings). */
export function toolRefs(c: any): string[] {
  const e = c.expect ?? {};
  return [...new Set([
    ...(e.calls ?? []).flatMap((m: any) => (m.tool ? [m.tool] : [])), ...(e.must_not_call ?? []).filter((r: string) => !r.startsWith('class:')),
    ...(e.effects ?? []).flatMap((m: any) => (m.tool ? [m.tool] : [])), ...(e.hitl?.before ? [e.hitl.before] : []),
    ...(c.oracle?.steps ?? []).flatMap((s: any) => ('call' in s ? [s.call] : 'ask' in s ? [s.ask.tool] : [])),
    ...(c.fixture?.plants ?? []).flatMap((p: any) => (p.at?.tool ? [p.at.tool] : [])), ...Object.keys(c.fixture?.tool_overrides ?? {}),
    ...Object.values(c.provenance?.pack?.bindings ?? {}) as string[],
  ])];
}
/** A case as written to expanded-cases/ (no __ fields). */
export const plain = (c: object): Record<string, unknown> => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('__')));
