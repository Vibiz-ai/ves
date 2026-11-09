// ves-case/1 -> ves-case/2 migration (DESIGN-agnostic §3.4, §3.6). PURE: no I/O, deterministic.
// `migrateCase1(c, profile)` is what `ves migrate --to 2 --profile vibiz` writes and what `ves validate` checks;
// mock runs of v1 cases keep the exact v1 MockAdapter/Sim semantics (§3.6 point 4), so this function never changes
// a v1 verdict. `catalogFromV1` converts packs/vibiz/catalog.v1.json into generic catalog entries.
import type { CanonicalMap } from '../lib/canonical.ts';
import type { Case, Expect, Turn } from '../types.ts';
import type { CatalogEntry, Case2, Expect2, PersonaTemperament, PrincipalRole, ToolClass, Turn2 } from '../core/types.ts';

export type MigrationProfile = {
  /** v1 class -> generic classes (+ explicit gated). */
  class_map: Record<string, { classes: string[]; gated?: boolean }>;
  /** v1 principal -> v2 role (teammate -> member, non_owner -> outsider). */
  principal_map: Record<string, string>;
  /** Fixture dir relative to the pack dir ("fixtures"). */
  fixture_root: string;
};

/** The v1 approval decisions mapped to v2 hitl turns (§3.4 table). */
export const APPROVE_MAP: Record<string, Extract<Turn2, { hitl: unknown }>> = {
  yes: { hitl: 'approve' },
  no: { hitl: 'reject' },
  timeout: { hitl: 'timeout' },
  tapback: { hitl: 'ambiguous' },
  yes_other_thread: { hitl: 'approve', thread: 'other' },
  yes_after_args_edit: { hitl: 'approve', args_edited: {} },
  yes_non_owner: { hitl: 'approve', as: 'outsider' },
};

export function catalogFromV1(map: CanonicalMap, profile: MigrationProfile): CatalogEntry[] {
  return Object.entries(map.ids).map(([id, e]) => {
    const m = profile.class_map[e.class];
    if (!m) throw new Error(`catalog.v1: ${id} has class ${e.class} with no class_map entry`);
    return {
      name: id, classes: m.classes as ToolClass[], ...(m.gated !== undefined ? { gated: m.gated } : {}),
      ...(e.effect ? { effect: e.effect } : {}), ...(e.normalise ? { normalise: e.normalise } : {}),
      aliases: { ...e.names }, review: 'confirmed',
    } satisfies CatalogEntry;
  });
}

const role = (p: MigrationProfile, v1: string | undefined): PrincipalRole | undefined =>
  v1 === undefined ? undefined : ((p.principal_map[v1] ?? v1) as PrincipalRole);

function migrateTurn(t: Turn, p: MigrationProfile): Turn2 {
  if ('say' in t) { const as = role(p, t.as); return as ? { say: t.say, as } : { say: t.say }; }
  if ('approve' in t) {
    const m = APPROVE_MAP[t.approve];
    if (!m) throw new Error(`unknown v1 approval decision ${t.approve}`);
    return structuredClone(m);
  }
  if ('advance_clock' in t) return { advance_clock: t.advance_clock };
  return { wake: t.wake };
}

function migrateExpect(e: Partial<Expect>): Partial<Expect2> {
  const out: Partial<Expect2> = {};
  if (e.calls) out.calls = e.calls.map((m) => ({ ...m }));
  if (e.must_not_call) out.must_not_call = [...e.must_not_call];
  if (e.gated) out.gated = e.gated.map((g) => ({ tool: g.tool }));
  if (e.side_effects) out.effects = e.side_effects.map((s) => ({ alias: s.kind, ...(s.match ? { match: s.match } : {}), ...(s.count ? { count: s.count } : {}) }));
  if (e.no_outward_side_effects !== undefined) out.no_outward_side_effects = e.no_outward_side_effects;
  if (e.state) out.state = e.state.map((s) => ({ ...s }));
  if (e.facts) out.facts = [...e.facts];
  if (e.forbid) out.forbid = [...e.forbid];
  if (e.format) out.format = { ...e.format };
  if (e.judge) out.judge = e.judge.map((j) => ({ ...j }));
  return out;
}

export function migrateCase1(c: Case, p: MigrationProfile): Case2 {
  const fx = c.fixture;
  const root = p.fixture_root.replace(/\/$/, '');
  const out: Case2 = {
    schema_version: 'ves-case/2', id: c.id, version: c.version, capability: c.capability, suite: c.suite,
    ...(c.safety_suite ? { safety: c.safety_suite } : {}), ...(c.tags ? { tags: [...c.tags] } : {}),
    variants: [...c.surfaces], ...(c.requires ? { requires: [...c.requires] } : {}), owner: c.owner,
    provenance: { ...c.provenance, source: c.provenance.source as Case2['provenance']['source'] },
    fixture: {
      state: `${root}/${fx.sim_org}.json`, state_sha256: fx.fixture_sha256, seed: fx.seed, clock: fx.clock,
      ...(fx.tenants ? { tenants: fx.tenants.map((t) => ({ id: t.sim_org, entities_file: `${root}/${t.entities_file}` })) } : {}),
      ...(fx.plants ? { plants: fx.plants.map((pl) => ({ at: { location: pl.location }, ref: `${root}/${pl.ref}`, canary: pl.canary })) } : {}),
    },
    input: {
      turns: c.input.turns.map((t) => migrateTurn(t, p)),
      ...(c.input.persona ? { persona: { ...c.input.persona, temperament: c.input.persona.temperament as PersonaTemperament, goal: 'migrated from ves-case/1 (no goal recorded)' } } : {}),
    },
    expect: migrateExpect(c.expect) as Expect2,
    graders: c.graders.map((g) => ({ ...g })),
    ...(c.overrides ? { overrides: Object.fromEntries(Object.entries(c.overrides).map(([k, v]) => [k, { ...(v.expect ? { expect: migrateExpect(v.expect) } : {}), ...(v.skip ? { skip: v.skip } : {}) }])) } : {}),
    ...(c.twin ? { twin: c.twin } : {}),
    oracle: { kind: c.oracle.kind, ...(c.oracle.steps ? { steps: c.oracle.steps.map((s) => ({ ...s })) } : {}) },
    ...(c.trials ? { trials: { ...c.trials } } : {}), ...(c.limits ? { limits: { ...c.limits } } : {}),
  };
  return out;
}
