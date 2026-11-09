// The vibiz pack (DESIGN-agnostic §4.9): the 33 VES-1 seed cases moved byte-for-byte into packs/vibiz, wired through
// pack.json `cases` and profile.json `suites`, run on the v1 path (`ves run --profile vibiz`). In a v2 config run the
// pack refuses loudly instead of contributing a silent empty suite, and the generic packs apply to a
// `profile: "vibiz"` config directly (they bind the Vibiz catalog's gated tools by class).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCaseDirs, suiteVersionAny } from '../../src/cases/load.ts';
import { resolveConfig } from '../../src/config/load.ts';
import { prepare } from '../../src/runner/run-v2.ts';
import { V2_GUIDANCE } from '../../packs/vibiz/pack.ts';
import { GENERIC_PACKS, ROOT, SAFETY_PACKS, extraOf, firedRules, pack, runPacks, tmpDir } from './helpers.ts';

const tmp = tmpDir('vibiz');
after(tmp.cleanup);
const VIBIZ = join(ROOT, 'packs', 'vibiz');
const vibizCfg = () => {
  const r = resolveConfig({ schema_version: 'ves-config/1', project: 'vibiz', agent: { name: 'eve', connection: { type: 'mock' } }, tools: { catalog: [] }, profile: 'vibiz', variants: { default: { capabilities: ['multi_turn', 'hitl_structured'] } } } as any, { dir: ROOT, env: {} });
  assert.deepEqual(r.errors, []);
  return r.config;
};

test('pack.json and profile.json point at the same moved v1 suites: 14 smoke + 19 safety, schema-valid, suite_version as stored', async () => {
  const p = await pack('vibiz');
  const profile = JSON.parse(readFileSync(join(VIBIZ, 'profile.json'), 'utf8'));
  assert.deepEqual(p.manifest.cases, profile.suites.release);
  assert.deepEqual(profile.suites.smoke, ['cases/smoke']);
  assert.equal(p.manifest.requires?.profile, 'vibiz');
  for (const d of p.manifest.cases!) assert.ok(existsSync(join(VIBIZ, d)), d);
  const smoke = loadCaseDirs(ROOT, [join(VIBIZ, 'cases', 'smoke')]);
  const all = loadCaseDirs(ROOT, p.manifest.cases!.map((d) => join(VIBIZ, d)));
  assert.deepEqual(all.errors, []);
  assert.equal(smoke.v1.length, 14);
  assert.equal(all.v1.length, 33);
  assert.equal(all.v2.length, 0);
  assert.equal(suiteVersionAny(smoke.v1), '05bf651672f91aa72d35c61727dfa4f3c66b5a7cb8f4be47db40f1aa2575f536');
  assert.equal(suiteVersionAny(all.v1), '801f32c8faa5253a5a5a5a8b7bddfb300b5ea9aaa91943f62e18bbc47e783a05');
  for (const f of [profile.catalog, `${profile.fixture_root}/lumen-yoga.json`, 'cases/safety/README.md', 'README.md']) assert.ok(existsSync(join(VIBIZ, f)), f);
});

test('enabling the vibiz pack in a v2 config run is a loud error that says where its cases run, never an empty suite', async () => {
  const p = await prepare({ harnessRoot: ROOT, config: vibizCfg(), tier: 'release', packs: ['vibiz'] });
  assert.ok(p.errors.some((e) => e === `vibiz/pack.ts expand(): ${V2_GUIDANCE}`), p.errors.join('\n'));
  assert.match(V2_GUIDANCE, /ves run --profile vibiz/);
  assert.equal(p.cases.length, 0);
});

test('the generic packs apply to the Vibiz catalog: hitl-approval binds ads.delete and ads.launch; every pack is valid and PASSes on MockAgent', async () => {
  const cfg = vibizCfg();
  for (const id of GENERIC_PACKS) {
    const r = await runPacks(cfg, [id], tmp.dir);
    assert.equal(r.gate.verdict, 'PASS', `${id}: ${firedRules(r)}`);
    const b = extraOf(r).baselines.default;
    assert.equal(b.oracle_pass, b.oracle_n, id);
    assert.equal(b.trivial_unit_pass, 0, id);
    if (SAFETY_PACKS.has(id)) assert.ok(extraOf(r).safety_validity.every((v: any) => v.ok), id);
    if (id === 'hitl-approval') assert.deepEqual([...new Set(r.cases.map((c) => c.provenance.pack!.bindings!.tool))].sort(), ['ads.delete', 'ads.launch']);
  }
});
