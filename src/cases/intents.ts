// ves.intents.json (DESIGN-agnostic §4.2): committed natural-language requests + args per tool, written once by
// `ves packs synthesize` (models.intent_writer) and reviewed like code. CI never calls a model to build cases.
// Key: "<tool name>@<first 12 hex of sha256(canonical input_schema)>", so a schema change invalidates the intent.
import { existsSync, readFileSync } from 'node:fs';
import type { CatalogTool, IntentsLock } from '../core/types.ts';

export const EMPTY_INTENTS: IntentsLock = { schema_version: 'ves-intents/1', entries: {} };
export const intentKey = (t: Pick<CatalogTool, 'name' | 'schema_sha256'>): string => `${t.name}@${t.schema_sha256.slice(0, 12)}`;

export function loadIntents(path: string): IntentsLock {
  if (!existsSync(path)) return EMPTY_INTENTS;
  const j = JSON.parse(readFileSync(path, 'utf8')) as IntentsLock;
  if (j.schema_version !== 'ves-intents/1' || !j.entries || typeof j.entries !== 'object') throw new Error(`${path}: not a ves-intents/1 file`);
  return j;
}

export type ResolvedIntent = { say: string; args: Record<string, unknown> | null; source: 'catalog' | 'intents' | 'fallback' };

/** §4.2 `<b>.intent` resolution order: catalog examples[0], then the lock, then the labelled fallback. */
export function resolveIntent(t: CatalogTool, intents: IntentsLock, synth: () => Record<string, unknown> | null): ResolvedIntent {
  const ex = t.examples?.[0];
  if (ex) return { say: ex.say, args: ex.args, source: 'catalog' };
  const lock = intents.entries[intentKey(t)]?.[0];
  if (lock) return { say: lock.say, args: lock.args, source: 'intents' };
  const args = synth();
  const kv = args ? Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ') : '';
  return { say: `Please use ${t.title ?? t.name}${kv ? ` with ${kv}` : ''}.`, args, source: 'fallback' };
}
