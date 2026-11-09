// CLI argument parsing shared by the core commands. Only REPEATABLE flags accumulate; any other repeated flag takes
// its last value (Tester fix 2026-11-06, protocol/LOG.md row 4).
export type Args = { _: string[]; [k: string]: string | string[] | boolean };
export const REPEATABLE = new Set(['suite', 'fault', 'quarantine', 'differs-in', 'deploy-targets', 'run', 'packs', 'variants', 'extra-cases', 'header']);
export function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (out[k] === undefined || !REPEATABLE.has(k)) out[k] = v; else out[k] = ([] as unknown[]).concat(out[k], v) as string[];
  }
  return out;
}
export const list = (v: unknown): string[] => (v === undefined || v === true ? [] : ([] as string[]).concat(v as string | string[]).flatMap((x) => String(x).split(',')).filter(Boolean));
export const str = (v: unknown): string | undefined => (v === undefined || v === true ? undefined : Array.isArray(v) ? String(v[v.length - 1]) : String(v));
export class CliUsage extends Error { usage = true; }
