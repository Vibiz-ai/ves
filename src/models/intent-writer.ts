// Intent writer for `ves packs synthesize` (DESIGN-agnostic §5): realistic user requests for one catalog tool, each
// with the arguments the resulting call should carry. Generated args are validated against the tool's input_schema
// and invalid ones are dropped; duplicates (same `say`) are dropped. The output file is committed and reviewed like
// code, so CI never calls a model to build cases. Deterministic per (tool schema, n, seed) through the cache salt.
import type { CatalogTool, ChatModel, IntentWriter } from '../core/types.ts';
import { validate } from '../lib/jsonschema.ts';
import { sha256 } from '../lib/hash.ts';
import { parseModelJson } from './json.ts';

export const INTENT_PROMPT_ID = 'ves-intent-writer/1';
export const INTENT_SYSTEM = [
  'You write realistic requests that users type to an AI assistant.',
  'Each request must lead a competent assistant to call the given tool, and comes with the exact arguments that call should carry.',
  'Vary wording, length, tone and specifics. Use plausible but clearly fictional names, emails and amounts.',
  'Use only argument names from the input schema, with values the schema accepts.',
  'Reply with one JSON object and nothing else: {"intents": [{"say": "...", "args": {...}}]}',
].join('\n');
export const INTENT_PROMPT_SHA256 = sha256(`${INTENT_PROMPT_ID}\n${INTENT_SYSTEM}`);

export function createIntentWriter(model: ChatModel, o: { warn?: (m: string) => void } = {}): IntentWriter & { readonly prompt_sha256: string } {
  return {
    prompt_sha256: INTENT_PROMPT_SHA256,
    async write(tool: CatalogTool, n: number, seed: number) {
      const want = Math.max(0, Math.floor(n));
      if (!want) return [];
      const user = [
        `Tool: ${tool.name}`, tool.title ? `Title: ${tool.title}` : '', tool.description ? `Description: ${tool.description}` : '',
        `Input schema: ${JSON.stringify(tool.input_schema)}`,
        tool.examples?.length ? `Existing examples (do not repeat them): ${JSON.stringify(tool.examples.slice(0, 3))}` : '',
        `Write ${want} requests. Variation seed: ${seed}.`,
      ].filter(Boolean).join('\n');
      const r = await model.chat({ messages: [{ role: 'system', content: INTENT_SYSTEM }, { role: 'user', content: user }], temperature: 0.9, response_format: { type: 'json_object' } },
                                 { purpose: 'intent_writer', salt: `intent:${tool.name}:${tool.schema_sha256}:${want}:${seed}` });
      const p = parseModelJson(r.message.content);
      if (!p.ok || !Array.isArray(p.value.intents)) { o.warn?.(`intent writer ${tool.name}: unusable output (${p.ok ? 'no intents array' : p.error})`); return []; }
      const seen = new Set<string>(tool.examples?.map((e) => e.say.trim().toLowerCase()) ?? []);
      const out: { say: string; args: Record<string, unknown> }[] = [];
      let dropped = 0;
      for (const it of p.value.intents) {
        const say = typeof it?.say === 'string' ? it.say.trim() : '';
        const args = it?.args;
        if (!say || !args || typeof args !== 'object' || Array.isArray(args) || seen.has(say.toLowerCase())) { dropped++; continue; }
        if (validate(tool.input_schema as Record<string, unknown>, args).length) { dropped++; continue; }
        seen.add(say.toLowerCase());
        out.push({ say, args: args as Record<string, unknown> });
        if (out.length >= want) break;
      }
      if (dropped) o.warn?.(`intent writer ${tool.name}: dropped ${dropped} invalid or duplicate intents`);
      return out;
    },
  };
}
