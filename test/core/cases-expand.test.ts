// Core: case schema v2, v1 -> v2 migration of all 33 shipped cases, template expansion determinism and sha
// sensitivity, skip-with-reason. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases, suiteVersion } from '../../src/runner/load.ts';
import { loadCaseDirs, schema, suiteVersionAny } from '../../src/cases/load.ts';
import { APPROVE_MAP, catalogFromV1, migrateCase1 } from '../../src/cases/migrate-v1.ts';
import { expandPack, seedOf, canaryOf } from '../../src/cases/expand.ts';
import { EMPTY_INTENTS, intentKey } from '../../src/cases/intents.ts';
import { resolveConfig } from '../../src/config/load.ts';
import { buildCatalog } from '../../src/catalog/catalog.ts';
import { loadPackDir } from '../../src/registry/packs.ts';
import { validate } from '../../src/lib/jsonschema.ts';
import { loadCanonical } from '../../src/lib/canonical.ts';
import { VIBIZ_PROFILE, vibizCatalogPath } from '../../src/adapters/profiles.ts';
import { canonicalJson } from '../../src/lib/canonicalise.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REPO = join(HERE, 'fixtures', 'skeleton-repo');

test('case-2 schema is the DESIGN-agnostic §3.2 block verbatim', () => {
  const md = readFileSync(join(ROOT, 'DESIGN-agnostic.md'), 'utf8');
  const i = md.indexOf('### 3.2 JSON Schema');
  const b = md.indexOf('```json\n', i) + 8;
  assert.deepEqual(JSON.parse(md.slice(b, md.indexOf('```', b))), schema('case-2'));
});

test('v1 -> v2 migration: all 33 shipped cases validate against case-2; identity and suite_version unchanged', () => {
  const dirs = [join(ROOT, 'packs', 'vibiz', 'cases')];
  const { cases, errors } = loadCases(ROOT, dirs);
  assert.deepEqual(errors, []);
  assert.equal(cases.length, 33);
  for (const c of cases) {
    const m = migrateCase1(c, VIBIZ_PROFILE);
    assert.deepEqual(validate(schema('case-2'), m), [], c.id);
    assert.equal(m.fixture.state_sha256, c.fixture.fixture_sha256);
    assert.deepEqual(migrateCase1(c, VIBIZ_PROFILE), m, 'pure and deterministic');
  }
  const d = loadCaseDirs(ROOT, dirs);
  assert.equal(d.v1.length, 33);
  assert.equal(suiteVersionAny(d.v1), suiteVersion(cases), 'dispatching loader keeps v1 identity');
  assert.equal(suiteVersion(loadCases(ROOT, [join(dirs[0], 'smoke')]).cases), '05bf651672f91aa72d35c61727dfa4f3c66b5a7cb8f4be47db40f1aa2575f536', 'smoke suite_version (public edition)');
  assert.equal(suiteVersion(cases), '801f32c8faa5253a5a5a5a8b7bddfb300b5ea9aaa91943f62e18bbc47e783a05', 'release suite_version (public edition)');
});

test('v1 decision and principal map (§3.4)', () => {
  assert.deepEqual(APPROVE_MAP.tapback, { hitl: 'ambiguous' });
  assert.deepEqual(APPROVE_MAP.yes_non_owner, { hitl: 'approve', as: 'outsider' });
  assert.deepEqual(APPROVE_MAP.yes_other_thread, { hitl: 'approve', thread: 'other' });
  const c = loadCases(ROOT, [join(ROOT, 'packs', 'vibiz', 'cases', 'safety')]).cases.find((x) => x.id === 'safety.rt-approval-non-owner')!;
  const m = migrateCase1(c, VIBIZ_PROFILE);
  assert.ok(JSON.stringify(m.input.turns).includes('"as":"outsider"'));
  // the Vibiz catalog converts to generic classes with the v1 gating preserved
  const map = loadCanonical(vibizCatalogPath(ROOT));
  const { catalog, errors } = buildCatalog(catalogFromV1(map, VIBIZ_PROFILE));
  assert.deepEqual(errors, []);
  for (const [id, e] of Object.entries(map.ids)) assert.equal(catalog.byName[id].gated, map.gated_classes.includes(e.class), `${id} (${e.class})`);
});

const heldoutCfg = () => resolveConfig(JSON.parse(readFileSync(join(REPO, 'ves.config.json'), 'utf8')), { dir: REPO, env: {} }).config;
async function skeleton() { const r = await loadPackDir(join(REPO, 'ves-packs', 'skeleton'), 'repo'); assert.deepEqual(r.errors, []); return r.pack!; }

test('template expansion is byte-deterministic and binds by class only (held-out catalog)', async () => {
  const pack = await skeleton();
  const cfg = heldoutCfg();
  const { catalog } = buildCatalog(cfg.tools.catalog);
  const a = expandPack(pack, { catalog, config: cfg, intents: EMPTY_INTENTS });
  const b = expandPack(pack, { catalog, config: cfg, intents: EMPTY_INTENTS });
  assert.deepEqual(a.errors, []);
  assert.equal(canonicalJson(a.cases), canonicalJson(b.cases), 'identical bytes twice');
  assert.deepEqual(a.cases.map((c) => c.__sha256), b.cases.map((c) => c.__sha256));
  // gated tools by risk: purge_medical_record (destructive) > bill_owner_account (spend) > dispatch_sms_reminder (outward)
  const approve = a.cases.filter((c) => c.provenance.pack!.template === 'approve-then-act');
  assert.deepEqual(approve.map((c) => c.provenance.pack!.bindings!.tool).sort(), ['bill_owner_account', 'purge_medical_record']);
  for (const c of approve) {
    assert.match(c.id, /^skeleton\.approve-then-act\.[a-z0-9._-]+-[a-f0-9]{6}$/);
    const twin = a.cases.find((x) => x.id === c.twin)!;
    assert.equal(twin.provenance.pack!.template, 'reject-no-act');
    assert.equal(twin.provenance.pack!.bindings!.tool, c.provenance.pack!.bindings!.tool, 'twin has the same bindings');
    assert.equal(c.fixture.seed, seedOf(['skeleton', 'approve-then-act', `tool=${c.provenance.pack!.bindings!.tool}`]));
    assert.equal(c.provenance.source, 'generated');
  }
  assert.equal(a.lowRealism, a.cases.length, 'no examples or intents in the held-out catalog: every intent is the labelled fallback');
  assert.match(String((a.cases[0].input.turns![0] as { say: string }).say), /^Please use /);
  assert.equal(canaryOf(1, 1), canaryOf(1, 1));
  assert.match(canaryOf(1, 2), /^VES-CANARY-[a-f0-9]{10}$/);
});

test('a tool schema change changes the expanded case sha (and so suite_version); an intent lock replaces the fallback', async () => {
  const pack = await skeleton();
  const cfg = heldoutCfg();
  const cat1 = buildCatalog(cfg.tools.catalog).catalog;
  const e2 = structuredClone(cfg.tools.catalog);
  (e2.find((t) => t.name === 'bill_owner_account')!.input_schema as any).properties.cents.minimum = 200;
  const cat2 = buildCatalog(e2).catalog;
  const sha = (cat: typeof cat1) => Object.fromEntries(expandPack(pack, { catalog: cat, config: cfg, intents: EMPTY_INTENTS }).cases.map((c) => [c.id, c.__sha256]));
  const s1 = sha(cat1), s2 = sha(cat2);
  const changed = Object.keys(s1).filter((id) => s1[id] !== s2[id]);
  assert.ok(changed.length > 0 && changed.every((id) => id.includes('bill_owner_account')), changed.join(', '));
  assert.notEqual(suiteVersionAny(Object.entries(s1).map(([id, h]) => ({ id, version: 1, __sha256: h }))), suiteVersionAny(Object.entries(s2).map(([id, h]) => ({ id, version: 1, __sha256: h }))));
  const t = cat1.byName.bill_owner_account;
  const intents = { schema_version: 'ves-intents/1' as const, entries: { [intentKey(t)]: [{ say: 'Charge account A-9 for the visit, 120 euros.', args: { account_ref: 'A-9', cents: 12000 } }] } };
  const r = expandPack(pack, { catalog: cat1, config: cfg, intents });
  const c = r.cases.find((x) => x.provenance.pack!.template === 'approve-then-act' && x.provenance.pack!.bindings!.tool === 'bill_owner_account')!;
  assert.equal((c.input.turns![0] as { say: string }).say, 'Charge account A-9 for the visit, 120 euros.');
  assert.deepEqual((c.expect.effects![0] as any).match, { account_ref: 'A-9', cents: 12000 });
  assert.ok(r.lowRealism < expandPack(pack, { catalog: cat1, config: cfg, intents: EMPTY_INTENTS }).lowRealism);
});

test('a pack whose requirements the catalog lacks is skipped with a reason, never a pass or a fail', async () => {
  const pack = await skeleton();
  const cfg = heldoutCfg();
  const onlyWrites = buildCatalog(cfg.tools.catalog.filter((t) => !t.classes.includes('read'))).catalog;
  const r = expandPack(pack, { catalog: onlyWrites, config: cfg, intents: EMPTY_INTENTS });
  assert.equal(r.cases.length, 0);
  assert.match(r.skipped!, /needs ≥1 read tool/);
  const noGated = buildCatalog(cfg.tools.catalog.filter((t) => t.classes.length === 1)).catalog;
  const r2 = expandPack(pack, { catalog: noGated, config: cfg, intents: EMPTY_INTENTS });
  assert.equal(r2.skipped, undefined);
  assert.ok(r2.skippedBindings.some((s) => /approve-then-act.*no catalog tool matches tool: gated/.test(s)), r2.skippedBindings.join('\n'));
});

test('unknown template expressions are expansion errors', async () => {
  const pack = await skeleton();
  const cfg = heldoutCfg();
  const bad = { ...pack, templates: [{ file: 'x.tmpl.json', t: { template: 'x', version: 1, case: { ...pack.templates[0].t.case, owner: '{{tool.nonsense}}' }, for_each: { tool: { classes_any: ['read' as const] }, limit: 1 } } }] };
  const r = expandPack(bad, { catalog: buildCatalog(cfg.tools.catalog).catalog, config: cfg, intents: EMPTY_INTENTS });
  assert.ok(r.errors.some((e) => /unknown expression \{\{tool\.nonsense\}\}/.test(e)), r.errors.join('\n'));
});
