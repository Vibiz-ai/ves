// `ves validate` (DESIGN-agnostic §5.5): offline, $0. Config schema + catalog rules, loosened bars (warning with the
// conformance impact), unreviewed suggested classes (warning; error with --strict), v1 and v2 case schemas and runner
// rules, pack expansion dry run, low-realism intents, and every oracle replayed on MockAgent (must pass 100%).
// Persona cases: library refs resolved, then replayed against the MockAgent with the offline scripted simulator (one
// message, approves what is asked, stops), so the conversation loop and graders run; no model is called.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadCases, checkRunnerRules } from '../runner/load.ts';
import { loadCaseDirs } from '../cases/load.ts';
import { migrateCase1 } from '../cases/migrate-v1.ts';
import { schema } from '../cases/load.ts';
import { validate as validateSchema } from '../lib/jsonschema.ts';
import { loadCanonical } from '../lib/canonical.ts';
import { KNOWN_SURFACES, profileOf, VIBIZ_PROFILE, vibizCatalogPath, vibizPackDir } from '../adapters/profiles.ts';
import { loadConfig } from '../config/load.ts';
import { resolveConfig } from '../config/load.ts';
import { prepare, runConfigOnce } from '../runner/run-v2.ts';
import { readFileSync } from 'node:fs';
import { type Args, list, str } from './args.ts';

export async function cmdValidate(a: Args, root: string, env: Record<string, string | undefined>): Promise<number> {
  const json = a.json === true;
  const strict = a.strict === true;
  const errors: string[] = [], warnings: string[] = [], info: string[] = [];
  if (str(a.profile) === 'vibiz' || (!a.config && a._.length)) {
    const dirs = (a._.length ? a._ : [join(vibizPackDir(root), 'cases')]).map((d) => resolve(d));
    const { cases, errors: se } = loadCases(root, dirs);
    const reg = JSON.parse(readFileSync(join(root, 'judges', 'registry.json'), 'utf8'));
    const rules = checkRunnerRules(cases, loadCanonical(vibizCatalogPath(root)), reg, KNOWN_SURFACES, (s) => new Set(profileOf(s).caps));
    errors.push(...se, ...rules);
    // every v1 case must migrate to a case-2-valid file (§3.6)
    let migrated = 0;
    for (const c of cases) { const m = migrateCase1(c, VIBIZ_PROFILE); const e = validateSchema(schema('case-2'), m); if (e.length) errors.push(`${c.id}: migration to ves-case/2 invalid: ${e[0].path} ${e[0].message}`); else migrated++; }
    info.push(`${cases.length} case(s) schema-valid; ${se.length} schema error(s); ${rules.length} runner-rule error(s); ${migrated} migrate to ves-case/2`);
  } else {
    const cfgPath = resolve(str(a.config) ?? 'ves.config.json');
    let raw: any;
    try { raw = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch (e) { errors.push(`${cfgPath}: ${(e as Error).message}`); }
    if (raw) {
      const r = resolveConfig(raw, { dir: resolve(cfgPath, '..'), path: cfgPath, env });
      errors.push(...r.errors); warnings.push(...r.warnings.filter((w) => !w.includes('suggested'))); info.push(...(r.info ?? []));
      const suggested = r.warnings.filter((w) => w.includes('suggested'));
      (strict ? errors : warnings).push(...suggested);
      if (r.config.loosened.length) warnings.push(`conformance custom (not VES-1): ${r.config.loosened.join('; ')}`);
      if (!r.errors.length) {
        const cfg = loadConfig(cfgPath, env);
        const extraDirs = a._.map((d) => resolve(d));
        if (extraDirs.length) { const x = loadCaseDirs(cfg.dir, extraDirs); errors.push(...x.errors); }
        for (const tier of ['smoke', 'release'] as const) {
          const p = await prepare({ harnessRoot: root, config: cfg, tier, packs: a.packs ? list(a.packs) : undefined });
          errors.push(...p.errors, ...p.ruleErrors);
          if (tier === 'release') {
            for (const e of p.expansions) info.push(`pack ${e.pack}@${e.version}: ${e.skipped ? `skipped (${e.skipped})` : `${e.cases.length} case(s)${e.lowRealism ? `, ${e.lowRealism} low-realism intent(s) (run \`ves packs synthesize\`)` : ''}`}${e.skippedBindings.length ? `; ${e.skippedBindings.length} binding(s) skipped` : ''}`);
            for (const e of p.expansions) for (const s of e.skippedBindings) warnings.push(s);
            info.push(`${p.cases.length} case(s) at release tier`);
            // persona cases: refs resolved above (prepare); the replay below plays them with the offline scripted
            // simulator against the MockAgent, so the loop, approvals and graders run without a model ($0)
            const personaCases = p.cases.filter((c) => c.__persona);
            if (personaCases.length) info.push(`${personaCases.length} persona case(s) (${[...new Set(personaCases.map((c) => c.__persona!.ref ?? `${c.__persona!.id} (inline)`))].join(', ')}): refs resolved; replayed with the offline simulator`);
            // `ves cases from-trace` placeholders a human has not filled yet (the case fails every real run until then)
            for (const c of p.cases) for (const g of c.graders ?? []) if (typeof g.params?.todo === 'string' && JSON.stringify(g.params).includes('TODO_REPLY_CHECK')) warnings.push(`${c.id}: ${g.id} still has the TODO_REPLY_CHECK placeholder (fill mentions/forbid and the oracle replies)`);
          }
        }
        if (!errors.length && a['no-replay'] !== true) {
          const tmp = mkdtempSync(join(tmpdir(), 'ves-validate-'));
          try {
            const out = await runConfigOnce({ harnessRoot: root, config: cfg, tier: 'release', trigger: 'manual', connection: 'mock', target: { sha: '0000000', change_class: 0 }, outDir: tmp, bootstrapN: 200, packs: a.packs ? list(a.packs) : undefined });
            const v = out.gate.rules.find((x) => x.rule === 'V §4.1 suite validity');
            if (v?.status === 'fired') errors.push(`oracle replay on MockAgent: ${v.detail}`);
            const g4 = out.gate.rules.find((x) => x.rule === 'G-4 safety validity');
            if (g4?.status === 'fired') errors.push(`safety validity on MockAgent: ${g4.detail}`);
            info.push(`oracle replay on MockAgent: ${v?.status === 'fired' ? 'FAILED' : 'every oracle passes'} (${out.rows.length} rows)`);
          } finally { rmSync(tmp, { recursive: true, force: true }); }
        }
      }
    }
  }
  if (json) process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors, warnings, info }, null, 2) + '\n');
  else {
    for (const e of errors) process.stderr.write(`ERROR ${e}\n`);
    for (const w of warnings) process.stderr.write(`WARN  ${w}\n`);
    for (const i of info) process.stdout.write(`${i}\n`);
  }
  return errors.length ? 3 : 0;
}
