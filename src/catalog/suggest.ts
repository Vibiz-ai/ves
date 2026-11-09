// `ves catalog suggest` (DESIGN-agnostic §5.6): suggest classes for imported tools. IMPORTABLE.
// Name + description regexes; MCP readOnlyHint/destructiveHint are suggestions only; conflicts resolve to the
// riskier class. Every suggestion is written with review: "suggested" so a human must confirm it.
import type { CatalogEntry, ToolClass } from '../core/types.ts';

const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.:/-]+/g, ' ').toLowerCase();
const RULES: { cls: ToolClass; re: RegExp }[] = [
  { cls: 'destructive', re: /\b(delete|remove|destroy|drop|purge|wipe)\b/ },
  { cls: 'spend', re: /\b(pay|charge|refund|purchase|buy|budget|bid|transfer|invoice|subscribe)\b/ },
  { cls: 'outward', re: /\b(send|email|post|publish|tweet|dm|message|notify|reply|invite|share|webhook)\b/ },
];
const READ_RE = /^(get|list|search|read|find|fetch|lookup|describe|show|count)\b/;
/** Words that are verbs AND common nouns ("get_post", "list_messages", "Save a draft post"). They suggest a risky class
 * only in verb position (dogfood fix 2026-11-07: `get_post` was suggested write+outward, a false-BLOCK trap):
 *   - in a name that starts with a read verb: never (the read verb is the action);
 *   - in a description: only as its first word ("Post a tweet", "Email the customer").
 * Elsewhere in a name they still count (conservative: a risky tool suggested as a plain write is the worse error). */
const AMBIGUOUS = /^(post|posts|message|messages|email|emails|invoice|invoices|share|shares|reply|replies|budget|budgets|transfer|transfers|bid|bids|charge|charges|dm|dms|notify|webhook|webhooks|invite|invites|subscribe)$/;
const strip = (s: string, keepFirst: boolean): string => s.split(' ').filter((w, i) => !AMBIGUOUS.test(w) || (keepFirst && i === 0)).join(' ');

export type Suggestion = { name: string; classes: ToolClass[]; gated_by_default: boolean; why: string[] };

export function suggestClasses(t: { name: string; description?: string; annotations?: CatalogEntry['annotations'] }, gateClasses: ToolClass[] = ['spend', 'outward', 'destructive']): Suggestion {
  const rawName = words(t.name);
  const readVerb = READ_RE.test(rawName);
  const name = readVerb ? strip(rawName, false) : rawName;
  const desc = strip(words(t.description ?? '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(), true);
  const why: string[] = [];
  const risky = new Set<ToolClass>();
  for (const r of RULES) {
    if (r.re.test(name)) { risky.add(r.cls); why.push(`name matches ${r.cls}`); }
    else if (r.re.test(desc)) { risky.add(r.cls); why.push(`description matches ${r.cls}`); }
  }
  if (t.annotations?.destructiveHint === true && !risky.has('destructive')) { risky.add('destructive'); why.push('MCP destructiveHint (suggestion only)'); }
  let classes: ToolClass[];
  if (risky.size) classes = ['write', ...(['spend', 'outward', 'destructive'] as ToolClass[]).filter((c) => risky.has(c))];
  else if (readVerb || t.annotations?.readOnlyHint === true) {
    classes = ['read'];
    why.push(readVerb ? 'name starts with a read verb' : 'MCP readOnlyHint (suggestion only)');
  } else { classes = ['write']; why.push('no read verb: default write'); }
  return { name: t.name, classes, gated_by_default: classes.some((c) => gateClasses.includes(c)), why };
}

/** Catalog entries for imported tools, marked review: "suggested". Existing entries are kept as they are. */
export function suggestCatalog(tools: { name: string; description?: string; input_schema?: unknown; annotations?: CatalogEntry['annotations'] }[], existing: CatalogEntry[] = []): CatalogEntry[] {
  const have = new Map(existing.map((e) => [e.name, e]));
  const out: CatalogEntry[] = [...existing];
  for (const t of tools) {
    if (have.has(t.name)) continue;
    const s = suggestClasses(t);
    out.push({ name: t.name, classes: s.classes, ...(t.description ? { description: t.description } : {}), ...(t.input_schema ? { input_schema: t.input_schema as CatalogEntry['input_schema'] } : {}), ...(t.annotations ? { annotations: t.annotations } : {}), review: 'suggested' });
  }
  return out;
}
