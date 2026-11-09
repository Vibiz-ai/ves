// List prices, USD per 1M tokens (VES-1 §11.3: list prices only, never promo). Every row ships `verified: false`:
// copied from an earlier research harness (not public), lib/prices.mjs (Vertex rows read 2026-10-22 from
// cloud.google.com/vertex-ai/generative-ai/pricing; OpenAI rows not re-verified there either). A config/deps `prices`
// override replaces a row (and counts as verified by whoever wrote it). An unknown remote model is priced at a
// deliberately high fallback so the spend cap stays a cap; a local model (localhost base_url, fake) defaults to 0.
export type PriceRow = { in: number; out: number; longIn?: number; longOut?: number; longAt?: number; verified: boolean; source: string };

const LAB = 'an earlier research harness (not public), lib/prices.mjs (2026-10-22), list price';
const ANTHROPIC = 'Anthropic API list price (2026-10-06), applied to Claude on Vertex AI';
export const PRICES: Record<string, PriceRow> = {
  'google/gemini-4-argon': { in: 4.0, out: 20.0, verified: false, source: LAB },
  'google/gemini-3.8-flash': { in: 1.5, out: 7.5, verified: false, source: LAB },
  'google/gemini-3.5-flash-lite': { in: 0.3, out: 2.5, verified: false, source: LAB },
  'google/gemini-3.5-flash': { in: 1.5, out: 9.0, verified: false, source: LAB },
  'google/gemini-3.1-pro-preview': { in: 2.0, out: 12.0, longIn: 4.0, longOut: 18.0, longAt: 200_000, verified: false, source: LAB },
  'google/gemini-2.5-pro': { in: 1.25, out: 10.0, longIn: 2.5, longOut: 15.0, longAt: 200_000, verified: false, source: LAB },
  'openai/gpt-oss-120b-maas': { in: 0.09, out: 0.36, verified: false, source: LAB },
  'gpt-5-mini': { in: 0.25, out: 2.0, verified: false, source: LAB },
  'gpt-5': { in: 1.25, out: 10.0, verified: false, source: LAB },
  'claude-sonnet-5-5': { in: 2.0, out: 10.0, verified: false, source: LAB },
  // Claude on Vertex AI (provider vertex, model anthropic/claude-*): Anthropic list prices; Vertex partner pricing may
  // differ by region (cloud.google.com/vertex-ai/generative-ai/pricing#claude-models). Not re-verified there.
  'claude-sonnet-4-6': { in: 3.0, out: 15.0, verified: false, source: ANTHROPIC },
  'claude-sonnet-5': { in: 2.0, out: 10.0, verified: false, source: ANTHROPIC },
  'claude-opus-4-6': { in: 5.0, out: 25.0, verified: false, source: ANTHROPIC },
  'claude-opus-5-5': { in: 4.0, out: 20.0, verified: false, source: ANTHROPIC },
  'claude-haiku-4-5': { in: 1.0, out: 5.0, verified: false, source: ANTHROPIC },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, longIn: 0.5, longOut: 2.5, longAt: 100_000, verified: false, source: LAB },
};
export const UNKNOWN_PRICE: PriceRow = { in: 15, out: 75, verified: false, source: 'fallback for an unpriced remote model (conservative; set models prices to override)' };
export const LOCAL_PRICE: PriceRow = { in: 0, out: 0, verified: false, source: 'local model (no list price)' };

export type PriceOverride = Record<string, { in_per_mtok: number; out_per_mtok: number }>;

export function lookupPrice(model: string, o: { local: boolean; overrides?: PriceOverride }): { row: PriceRow; fallback: boolean } {
  const bare = model.replace(/^(google|openai|anthropic)\//, '');
  for (const k of [model, bare, `google/${bare}`]) {
    const ov = o.overrides?.[k];
    if (ov) return { row: { in: ov.in_per_mtok, out: ov.out_per_mtok, verified: true, source: 'config prices override' }, fallback: false };
  }
  for (const k of [model, bare, `google/${bare}`]) if (PRICES[k]) return { row: PRICES[k], fallback: false };
  const pre = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((p) => model.startsWith(p) || bare.startsWith(p));
  if (pre) return { row: PRICES[pre], fallback: false };
  return o.local ? { row: LOCAL_PRICE, fallback: false } : { row: UNKNOWN_PRICE, fallback: true };
}

export function usdOf(p: PriceRow, inTok: number, outTok: number): number {
  const long = p.longAt !== undefined && inTok > p.longAt;
  const pin = long ? (p.longIn ?? p.in) : p.in;
  const pout = long ? (p.longOut ?? p.out) : p.out;
  return (inTok * pin + outTok * pout) / 1e6;
}

/** Conservative input-token estimate for the pre-call reservation: 1 token per 2 UTF-8 bytes of the body, plus framing. */
export function estimateInputTokens(body: Record<string, unknown>): number {
  const { messages, tools, response_format, system } = body as { messages?: unknown; tools?: unknown; response_format?: unknown; system?: unknown };
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools, response_format, system }), 'utf8') / 2) + 64;
}
