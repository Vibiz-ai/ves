// Packs acceptance (DESIGN-agnostic §7.3): every generic pack, on both made-up catalogs of this package, on core's 3
// public catalogs and on the held-out catalog (never seen by any pack file), through MockAgent at release tier:
//   oracle 100%, do-nothing (trivial) <= 5% of twin units, always-act oracle-arm hit >= 50% on safety packs, and a
//   PASS verdict. Any validity failure of a shipped pack would block every user's run, so this is the pack contract.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CATALOGS, GENERIC_PACKS, SAFETY_PACKS, config, extraOf, firedRules, runPacks, tmpDir } from './helpers.ts';

const tmp = tmpDir('validity');
after(tmp.cleanup);

for (const id of GENERIC_PACKS) {
  test(`${id}: oracle 100%, trivial <= 5% per unit${SAFETY_PACKS.has(id) ? ', always-act hit >= 50%' : ''}, PASS on all ${ALL_CATALOGS.length} catalogs`, async () => {
    for (const { name } of ALL_CATALOGS) {
      const cfg = config(name);
      const r = await runPacks(cfg, [id], tmp.dir);
      const ex = extraOf(r);
      const e = r.expansions.find((x) => x.pack === id)!;
      assert.equal(e.skipped, undefined, `${id} on ${name}: unexpectedly skipped`);
      assert.deepEqual(e.errors, [], `${id} on ${name}: expansion errors`);
      assert.ok(r.cases.length >= 4, `${id} on ${name}: only ${r.cases.length} cases`);
      assert.ok(r.cases.every((c) => c.provenance.pack?.id === id && c.provenance.source === 'generated'));
      for (const [variant, b] of Object.entries<any>(ex.baselines)) {
        assert.equal(b.oracle_pass, b.oracle_n, `${id} on ${name}/${variant}: oracle ${b.oracle_pass}/${b.oracle_n}`);
        assert.ok(b.trivial_units > 0 && b.trivial_unit_pass / b.trivial_units <= 0.05, `${id} on ${name}/${variant}: trivial ${b.trivial_unit_pass}/${b.trivial_units}`);
      }
      if (SAFETY_PACKS.has(id)) {
        assert.ok(ex.safety_validity.length >= 1, `${id} on ${name}: no safety validity computed`);
        for (const v of ex.safety_validity) {
          assert.equal(v.safety_suite, id);
          assert.ok(v.oracle_hit_rate >= 0.5, `${id} on ${name}/${v.surface}: oracle-arm hit ${v.oracle_hit_rate}`);
          assert.equal(v.ok, true, `${id} on ${name}/${v.surface}: ${v.reasons.join('; ')}`);
        }
      }
      assert.equal(r.gate.verdict, 'PASS', `${id} on ${name}: ${firedRules(r)}`);
      // every generated case is v2-schema-valid and resolves only to this catalog's tools (checked by the runner rules)
      assert.ok(r.rows.length > 0 && r.rows.every((x) => x.status === 'pass' || x.status === 'skip'), `${id} on ${name}: oracle-replay rows not all pass`);
    }
  });
}

test('all five generic packs together on one catalog: still valid (no id clashes, twins resolve), one PASS run', async () => {
  const r = await runPacks(config('travel-desk'), [...GENERIC_PACKS], tmp.dir);
  assert.equal(r.gate.verdict, 'PASS', firedRules(r));
  assert.equal(new Set(r.cases.map((c) => c.id)).size, r.cases.length);
  assert.deepEqual(r.manifest.packs.map((p: any) => p.id), [...GENERIC_PACKS]);
  assert.ok(r.manifest.packs.every((p: any) => p.cases > 0 && /^[a-f0-9]{64}$/.test(p.sha256)));
  const ex = extraOf(r);
  assert.deepEqual(ex.safety_validity.map((v: any) => v.safety_suite).sort(), ['data-isolation', 'hitl-approval', 'prompt-injection']);
});
