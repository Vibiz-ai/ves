import { createHash } from 'node:crypto';
import { canonicalJson } from './canonicalise.ts';

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
/** Hash of canonicalised args (sorted keys, normalised), used by G1 to tie approvals to writes. */
export const argsHash = (args: unknown): string => sha256(canonicalJson(args));
/** Unit seed rule from §11.5: int(sha256(seed+":"+k),16) % 2**31 (BigInt keeps it exact). */
export function unitSeed(seed: string | number, k: string | number): number {
  return Number(BigInt('0x' + sha256(`${seed}:${k}`)) % 2147483648n);
}
