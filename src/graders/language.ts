// Cheap, deterministic language guess for persona metrics (`language_match`): function-word counts for a handful of
// languages. It answers "which of these is it most like", not "what language is this"; anything short or unclear is
// null (not checked), never a guess. Advisory only: it feeds persona_metrics, which gates only when a case says so.

const WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'you', 'your', 'is', 'are', 'to', 'of', 'for', 'with', 'this', 'that', 'it', 'can', 'what', 'we', 'i', 'my', 'do', 'will', 'have', 'on', 'in', 'or', 'be', 'if', 'just', 'here'],
  es: ['el', 'la', 'los', 'las', 'y', 'que', 'de', 'tu', 'tus', 'es', 'para', 'con', 'una', 'un', 'por', 'qué', 'puedo', 'hola', 'gracias', 'cómo', 'está', 'pero', 'más', 'muy', 'del', 'al', 'lo', 'su', 'te', 'mi', 'ya'],
  pt: ['o', 'os', 'as', 'e', 'que', 'de', 'do', 'da', 'dos', 'das', 'é', 'para', 'com', 'uma', 'um', 'não', 'você', 'teu', 'tua', 'seu', 'sua', 'obrigado', 'obrigada', 'olá', 'olá', 'posso', 'mais', 'muito', 'em', 'no', 'na', 'ao', 'também', 'já'],
  fr: ['le', 'la', 'les', 'et', 'que', 'de', 'des', 'du', 'vous', 'votre', 'est', 'pour', 'avec', 'une', 'un', 'pas', 'je', 'nous', 'bonjour', 'merci', 'mais', 'plus', 'très', 'sur', 'dans', 'ce', 'cette'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'sie', 'ihr', 'ihre', 'für', 'mit', 'ein', 'eine', 'ich', 'wir', 'zu', 'den', 'dem', 'auf', 'auch', 'danke', 'hallo', 'aber', 'mehr', 'sehr', 'kann'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'e', 'che', 'di', 'del', 'della', 'è', 'per', 'con', 'una', 'un', 'non', 'tu', 'tuo', 'tua', 'grazie', 'ciao', 'ma', 'più', 'molto', 'sono', 'posso'],
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v)]));
export const DETECTABLE_LANGUAGES = Object.keys(WORDS);

/** Best language by function-word hits, or null when fewer than 3 hits or no clear winner (top < 1.5 x runner-up). */
export function detectLanguage(text: string): string | null {
  const words = String(text ?? '').toLowerCase().normalize('NFC').match(/\p{L}+/gu) ?? [];
  if (words.length < 3) return null;
  const score = Object.entries(SETS).map(([lang, set]) => [lang, words.filter((w) => set.has(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [top, second] = score;
  if (top[1] < 3 || top[1] < second[1] * 1.5) return null;
  return top[0];
}

/** `pt-PT` -> `pt`. */
export const baseLanguage = (code: string): string => code.toLowerCase().split('-')[0];

/**
 * Did the agent answer in the person's languages? null when the persona lists none, none of them is detectable, or no
 * reply is clear enough; otherwise true iff every clearly-detected reply is in one of the listed languages.
 */
export function languageMatch(replies: string[], languages: string[] | undefined): { match: boolean | null; detected: (string | null)[] } {
  const detected = replies.map(detectLanguage);
  const want = new Set((languages ?? []).map(baseLanguage));
  if (!want.size || ![...want].some((l) => DETECTABLE_LANGUAGES.includes(l))) return { match: null, detected };
  const clear = detected.filter((d): d is string => d !== null);
  if (!clear.length) return { match: null, detected };
  return { match: clear.every((d) => want.has(d)), detected };
}
