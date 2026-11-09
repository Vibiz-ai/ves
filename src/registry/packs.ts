// Pack discovery (DESIGN-agnostic §2.6, §4.1, §7.1 item 8): `packs/*/pack.json` in the harness, then the repo's
// `ves-packs/*/pack.json` (local packs, e.g. sealed red-team families). Each pack may ship `templates/*.tmpl.json`
// and an optional `pack.ts` whose default export is a PackModule (extra graders, custom expansion, validate).
// Pack graders are registered here; a pack may only register `<its id>/*` graders.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../lib/hash.ts';
import { validate } from '../lib/jsonschema.ts';
import { HARNESS_ROOT } from '../adapters/profiles.ts';
import { schema } from '../cases/load.ts';
import { registerPackGraders } from '../graders/generic.ts';
import type { LoadedPack, PackManifest, PackModule, PackTemplate } from '../core/types.ts';

export type PackLoad = { packs: LoadedPack[]; errors: string[] };

function filesUnder(d: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => { for (const n of readdirSync(x).sort()) { const p = join(x, n); if (statSync(p).isDirectory()) walk(p); else out.push(p); } };
  walk(d);
  return out;
}

export async function loadPackDir(dir: string, source: LoadedPack['source']): Promise<{ pack: LoadedPack | null; errors: string[] }> {
  const errors: string[] = [];
  const mf = join(dir, 'pack.json');
  let manifest: PackManifest;
  try { manifest = JSON.parse(readFileSync(mf, 'utf8')); } catch (e) { return { pack: null, errors: [`${mf}: ${(e as Error).message}`] }; }
  for (const e of validate(schema('pack-1'), manifest)) errors.push(`${mf}${e.path === '/' ? '' : e.path}: ${e.message}`);
  const tdir = join(dir, 'templates');
  const tschema = { ...(schema('pack-1') as Record<string, any>), ...((schema('pack-1') as any).$defs.template) };
  const templates: LoadedPack['templates'] = [];
  if (existsSync(tdir)) for (const f of readdirSync(tdir).filter((n) => n.endsWith('.tmpl.json')).sort()) {
    try {
      const t = JSON.parse(readFileSync(join(tdir, f), 'utf8')) as PackTemplate;
      const errs = validate(tschema, t);
      if (errs.length) { errors.push(...errs.map((e) => `${manifest.id}/templates/${f}${e.path === '/' ? '' : e.path}: ${e.message}`)); continue; }
      templates.push({ file: f, t });
    } catch (e) { errors.push(`${manifest.id}/templates/${f}: ${(e as Error).message}`); }
  }
  let module: PackModule | null = null;
  if (existsSync(join(dir, 'pack.ts'))) {
    try {
      const m = await import(pathToFileURL(join(dir, 'pack.ts')).href);
      module = (m.default ?? null) as PackModule | null;
      if (module?.graders) errors.push(...registerPackGraders(module.graders, manifest.id));
    } catch (e) { errors.push(`${manifest.id}/pack.ts: ${(e as Error).message}`); }
  }
  const sha = sha256(filesUnder(dir).map((f) => `${relative(dir, f)}:${sha256(readFileSync(f))}`).join('\n'));
  return { pack: { manifest, dir, source, templates, module, sha256: sha }, errors };
}

/** Every pack visible to a run: harness packs first, then repo-local `ves-packs/` (a repo pack may not shadow one). */
export async function loadPacks(o: { harnessRoot?: string; repoDir?: string } = {}): Promise<PackLoad> {
  const roots: [string, LoadedPack['source']][] = [[join(o.harnessRoot ?? HARNESS_ROOT, 'packs'), 'harness']];
  if (o.repoDir) roots.push([join(o.repoDir, 'ves-packs'), 'repo']);
  const packs: LoadedPack[] = [];
  const errors: string[] = [];
  for (const [root, source] of roots) {
    if (!existsSync(root)) continue;
    for (const n of readdirSync(root).sort()) {
      const d = join(root, n);
      if (!statSync(d).isDirectory() || !existsSync(join(d, 'pack.json'))) continue;
      const r = await loadPackDir(d, source);
      errors.push(...r.errors);
      if (!r.pack) continue;
      if (packs.some((p) => p.manifest.id === r.pack!.manifest.id)) { errors.push(`${d}: pack id ${r.pack.manifest.id} already provided by ${packs.find((p) => p.manifest.id === r.pack!.manifest.id)!.dir}`); continue; }
      packs.push(r.pack);
    }
  }
  return { packs, errors };
}
