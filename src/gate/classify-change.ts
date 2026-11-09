// §7.1 change classifier: diff paths -> class 0..3.
// Class 3 is not path-based (model id change, new surface/variant, protocol change, store/directory submission,
// pooled cross-tenant learning), so it comes in as explicit flags from the CI job.
//
// Two entry points:
//   classifyChange(paths, flags)                  the Vibiz profile (globs and surface map in packs/vibiz/profile.json)
//   classifyByGlobs(paths, change_classes, flags) generic: the `change_classes` globs of ves.config.json (DESIGN §2.7)
import { VIBIZ_PROFILE } from '../adapters/profiles.ts';

// `**/` matches zero or more directories, so `**/*.md` also matches a root README.md (dogfood fix 2026-11-07)
export const glob = (g: string): RegExp => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0000/g, '.*') + '$');

const CLASS2 = VIBIZ_PROFILE.change_classes['2'].map(glob);
const CLASS1 = VIBIZ_PROFILE.change_classes['1'].map(glob);
const SURFACES_FOR = VIBIZ_PROFILE.surfaces_for.map((x) => ({ re: new RegExp(x.re), surfaces: x.surfaces }));

export type Class3Flags = { modelChange?: boolean; newSurface?: boolean; protocolChange?: boolean; submission?: boolean; pooledLearning?: boolean };
export type Classified = { change_class: 0 | 1 | 2 | 3; reasons: string[]; surfaces_touched: string[] };

/** Vibiz surfaces a path touches (for `--surfaces auto`). */
export function surfacesFor(path: string): string[] {
  return SURFACES_FOR.flatMap((x) => (x.re.test(path) ? x.surfaces : []));
}

export function classifyChange(paths: string[], flags: Class3Flags = {}): Classified {
  const reasons: string[] = [];
  let cls: 0 | 1 | 2 | 3 = 0;
  for (const p of paths) {
    if (CLASS2.some((r) => r.test(p))) { cls = Math.max(cls, 2) as 2; reasons.push(`class 2: ${p}`); }
    else if (CLASS1.some((r) => r.test(p))) { cls = Math.max(cls, 1) as 1 | 2; reasons.push(`class 1: ${p}`); }
  }
  for (const [k, v] of Object.entries(flags)) if (v) { cls = 3; reasons.push(`class 3: ${k}`); }
  const surfaces = [...new Set(paths.flatMap(surfacesFor))].sort();
  return { change_class: cls, reasons: reasons.length ? reasons : ['class 0: no listed path touched'], surfaces_touched: surfaces };
}

/** Paths that are class 2 whatever the config says: any change to evals is class 2 (VES-1 §7.1, DESIGN §2.7). */
export const ALWAYS_CLASS2 = ['ves.config.json', 'ves.intents.json'];

/**
 * Generic classifier (DESIGN §2.7). A path takes the highest class whose glob matches; unmatched paths are class 1;
 * the config, the intents lock and every suite directory are class 2 even if not listed. With no paths at all the
 * class is 0 (nothing changed). Class 3 comes from flags.
 */
export function classifyByGlobs(paths: string[], changeClasses: Partial<Record<'0' | '1' | '2', string[]>>, flags: Class3Flags & { autoModelChange?: boolean } = {}, suiteDirs: string[] = []): Classified {
  const by = (k: '0' | '1' | '2') => (changeClasses[k] ?? []).map(glob);
  const c2 = [...by('2'), ...ALWAYS_CLASS2.map(glob), ...suiteDirs.map((d) => glob(`${d.replace(/\/$/, '')}/**`))], c1 = by('1'), c0 = by('0');
  const reasons: string[] = [];
  let cls: 0 | 1 | 2 | 3 = 0;
  for (const p of paths) {
    const k = c2.some((r) => r.test(p)) ? 2 : c1.some((r) => r.test(p)) ? 1 : c0.some((r) => r.test(p)) ? 0 : 1;
    if (k > cls) cls = k as 0 | 1 | 2;
    reasons.push(`class ${k}: ${p}${k === 1 && !c1.some((r) => r.test(p)) ? ' (unmatched)' : ''}`);
  }
  for (const [k, v] of Object.entries(flags)) if (v) { cls = 3; reasons.push(`class 3: ${k}`); }
  return { change_class: cls, reasons: reasons.length ? reasons : ['class 0: no path changed'], surfaces_touched: [] };
}
