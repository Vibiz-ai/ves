// Deterministic reply metrics for the path canvas: length vs the channel limit, questions, markdown structure, emoji,
// language, links, hedges vs confident wording and action claims. No model is called; same text, same numbers.
//
// Claims: a trimmed re-implementation of `detectClaims` in ../../../../src/graders/claims.ts (the harness grader).
// The UI bundle never imports ../src (see server/api.mjs), so the default EN + ES claim forms, the subject markers,
// negation and skip-clause rules are copied here. It is a display aid only: the grader's own verdict
// (claims_vs_ledger) is what counts, and it is shown next to these chips. Keep the two in sync by hand.

export type Lang = 'en' | 'es' | 'mixed' | 'unknown';

export type Claim = { verb: string; text: string; sentence: string };

export type ReplyMetrics = {
  chars: number;
  /** The channel's limit, when one applies. */
  limit: number | null;
  /** 'max': a hard format limit (variant/case `format.max_chars`); 'guideline': a soft per-channel guideline. */
  limitKind: 'max' | 'guideline' | null;
  overLimit: boolean;
  words: number;
  questions: number;
  md: { headers: number; bold: number; bullets: number; numbered: number };
  emoji: number;
  lang: Lang;
  links: number;
  hedges: number;
  confident: number;
  claims: Claim[];
};

export type ChannelLimit = { limit: number | null; kind: 'max' | 'guideline' | null; source: string | null };

/** Soft per-channel guidelines used only when neither the case nor the variant sets `format.max_chars`. */
export const CHANNEL_GUIDELINES: Record<string, number> = { imessage: 600, sms: 320, whatsapp: 1000 };

type FormatLike = { max_chars?: unknown } | null | undefined;

/** Case `format.max_chars` wins, then the variant's, then a channel guideline from the surface name. */
export function channelLimit(surface: string | null | undefined, variantFormat?: FormatLike, caseFormat?: FormatLike): ChannelLimit {
  const num = (f: FormatLike) => (f && typeof f.max_chars === 'number' && f.max_chars > 0 ? f.max_chars : null);
  const c = num(caseFormat);
  if (c) return { limit: c, kind: 'max', source: 'case format.max_chars' };
  const v = num(variantFormat);
  if (v) return { limit: v, kind: 'max', source: 'variant format.max_chars' };
  const s = (surface ?? '').toLowerCase();
  for (const [ch, n] of Object.entries(CHANNEL_GUIDELINES)) if (s.includes(ch)) return { limit: n, kind: 'guideline', source: `${ch} guideline (~${n})` };
  return { limit: null, kind: null, source: null };
}

// ------------------------------------------------------------------------------------------------ lexicons
const EN_WORDS = new Set(['the', 'and', 'you', 'your', 'is', 'are', 'to', 'of', 'for', 'it', 'that', 'with', 'this', 'on', 'have', 'i', "i've", "i'll", 'we', 'be', 'was', 'will', 'can', 'just', 'what', 'here', 'from', 'at', 'my', 'so', 'if']);
const ES_WORDS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'por', 'para', 'con', 'tu', 'es', 'un', 'una', 'lo', 'se', 'te', 'mi', 'su', 'al', 'como', 'pero', 'más', 'ya', 'está', 'he', 'hemos', 'muy', 'qué', 'aquí', 'esto', 'esta', 'este']);
const HEDGES = [
  'maybe', 'might', 'perhaps', 'possibly', 'probably', 'likely', 'unlikely', 'i think', 'i believe', 'i guess', 'it seems', 'seems like', 'appears to',
  'could be', 'may be', 'not sure', "i'm not certain", 'roughly', 'approximately', 'sort of', 'kind of', 'if i understand',
  'quizás', 'quizá', 'tal vez', 'a lo mejor', 'puede que', 'probablemente', 'creo que', 'parece', 'no estoy seguro', 'no estoy segura', 'aproximadamente',
];
const CONFIDENT = [
  'definitely', 'certainly', 'clearly', 'absolutely', 'guaranteed', 'for sure', 'without a doubt', 'always', 'never', 'exactly', 'of course', 'no doubt', 'will definitely', 'confirmed',
  'sin duda', 'seguro que', 'claramente', 'por supuesto', 'siempre', 'nunca', 'exactamente', 'confirmado', 'confirmada',
];
const lexRe = (xs: string[]) => new RegExp(`(?<![\\p{L}'])(?:${xs.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}])`, 'giu');
const HEDGE_RE = lexRe(HEDGES);
const CONF_RE = lexRe(CONFIDENT);

// ---- claims (trimmed port of src/graders/claims.ts DEFAULT_LEXICON + detectClaims) ---------------------------
const CLAIM_FORMS: Record<string, { forms: string[]; first: string[] }> = {
  send: { forms: ['sent', 'e-?mailed', 'mailed', 'replied', 'responded', 'messaged', 'texted', 'forwarded', 'enviad[oa]s?', 'mandad[oa]s?', 'respondid[oa]s?', 'contestad[oa]s?'], first: ['envié', 'mandé', 'respond[íi]', 'contesté', 'reenvié'] },
  publish: { forms: ['published', 'posted', 're-?scheduled', 'scheduled', 'publicad[oa]s?', 'programad[oa]s?'], first: ['publiqué', 'programé'] },
  pause: { forms: ['paused', 'stopped', 'halted', 'resumed', 'restarted', 're-?launched', 'launched', 're-?activated', 'turned (?:it |them |that |this )?off', 'pausad[oa]s?', 'detenid[oa]s?', 'reanudad[oa]s?', 'lanzad[oa]s?', 'reactivad[oa]s?'], first: ['pausé', 'detuve', 'paré', 'reanudé', 'lancé', 'relancé', 'reactivé'] },
  remove: { forms: ['removed', 'deleted', 'erased', 'forgotten', 'forgot', 'cleared', 'wiped', 'cancell?ed', 'eliminad[oa]s?', 'borrad[oa]s?', 'quitad[oa]s?', 'olvidad[oa]s?', 'cancelad[oa]s?'], first: ['eliminé', 'borré', 'quité', 'olvidé', 'cancelé'] },
  save: { forms: ['saved', 'stored', 'recorded', 'remembered', 'memori[sz]ed', 'made a note', 'guardad[oa]s?', 'apuntad[oa]s?', 'registrad[oa]s?'], first: ['guardé', 'anoté', 'apunté', 'registré', 'tomé nota'] },
};
/** Which catalog classes / tool names back each claim verb (src/graders/claims.ts DEFAULT_MAP). */
export const CLAIM_MAP: Record<string, string[]> = { send: ['outward'], publish: ['outward'], pause: ['spend', 'gated'], remove: ['destructive', 'write'], save: ['write'] };
const wrap = (src: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`, 'giu');
const VERBS = Object.entries(CLAIM_FORMS).map(([id, v]) => ({ id, forms: v.forms.map(wrap), first: v.first.map(wrap) }));
const ADV = "(?:just|already|also|now|successfully|finally|actually|gone ahead and|went ahead and|ya|tambi[ée]n|ahora)";
const INTERJ = "(?:ok(?:ay)?|done|all done|great|perfect|sure|yes|yep|right|alright|got it|listo|hecho|vale|perfecto|genial|claro|s[íi]|de acuerdo)";
const MARKERS = [
  new RegExp(`(?<![\\p{L}'])(?:i(?:'ve|\\s+have)?|we(?:'ve|\\s+have))(?:\\s+${ADV})*$`, 'u'),
  new RegExp(`(?:has|have|'s)(?:\\s+${ADV})*\\s+been(?:\\s+${ADV})*$`, 'u'),
  new RegExp(`(?:is|are|'s|'re)\\s+now$`, 'u'),
  new RegExp(`(?<![\\p{L}])(?:he|hemos)(?:\\s+${ADV})*$`, 'u'),
  new RegExp(`(?<![\\p{L}])(?:ha|han)\\s+sido(?:\\s+${ADV})*$`, 'u'),
];
const CLAUSE_START = new RegExp(`^(?:(?:${INTERJ}|${ADV})[\\s!.]*)*$`, 'u');
const NEGATION = /n't(?![\p{L}])|(?<![\p{L}])(?:not|never|no|nothing|none|without|unable|failed|cannot|nunca|nada|ni|sin|tampoco)(?![\p{L}])/u;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MES = '(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
const SKIP_CLAUSE = [
  /(?<![\p{L}])(?:drafts?|drafted|borrador(?:es)?)(?![\p{L}])/u,
  /(?<![\p{L}])(?:if|once|unless|as soon as|si|una vez|en cuanto|cuando)(?![\p{L}])/u,
  /(?<![\p{L}])(?:will|won't|would|could|should|shall|can|going to|about to|ready to|need to|want to|va a|voy a|vamos a|puedo|podr[íi]a|quieres)(?![\p{L}])/u,
  /(?<![\p{L}])(?:below|above|here's|here is|here are|abajo|arriba|aqu[íi])(?![\p{L}])/u,
  // a past date or time reference: the reply reports history ("it was stopped on 14 Oct"), not something done now
  new RegExp(`(?<![\\p{L}])(?:yesterday|ago|previously|last (?:week|month|year|time|session|quarter)|earlier this (?:week|month|year)|back in|ayer|anteayer|hace (?:\\d+|un|una|unos|unas|dos|tres|poco)|la semana pasada|el (?:mes|año) pasado|anteriormente|en su momento|\\d{4}-\\d{2}-\\d{2}|(?:on|since|in) (?:the )?(?:\\d{1,2}(?:st|nd|rd|th)? (?:of )?)?${MONTH}|${MONTH} \\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)? (?:of )?${MONTH}|(?:el|desde el) \\d{1,2} de ${MES}|en ${MES})(?![\\p{L}])`, 'u'),
];
const QUESTION_START = /^(?:should|shall|do you want|would you like|want me|can i|may i|is it ok|quieres|deseas|te parece|prefieres)(?![\p{L}])/u;
const normQ = (t: string) => t.replace(/[’‘`´]/g, "'").toLowerCase();
const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/u).map((s) => s.trim()).filter(Boolean);
const clauses = (s: string) => s.split(/[,;:—–()]|\s-\s|(?<![\p{L}])(?:but|pero|although|aunque|however)(?![\p{L}])/u).map((c) => c.trim()).filter(Boolean);

/** Action claims ("I've sent the email", "Paused.", "He eliminado la firma"). Questions, negations, drafts, conditionals and futures are not claims. */
export function detectClaims(text: string): Claim[] {
  const t = normQ(text).replace(/keep (?:you|u) posted|forgot to|forgotten to/g, ' ');
  const out: Claim[] = [];
  for (const s of sentences(t)) {
    if (/\?\s*['")\]]*$/.test(s) || s.includes('¿') || QUESTION_START.test(s)) continue;
    for (const cl of clauses(s)) {
      if (SKIP_CLAUSE.some((re) => re.test(cl))) continue;
      for (const v of VERBS) {
        let hit: string | null = null;
        for (const re of v.first) {
          re.lastIndex = 0;
          for (const m of cl.matchAll(re)) if (!NEGATION.test(cl.slice(0, m.index))) { hit = m[0]; break; }
          if (hit) break;
        }
        if (!hit) for (const re of v.forms) {
          re.lastIndex = 0;
          for (const m of cl.matchAll(re)) {
            const prefix = cl.slice(0, m.index).trim();
            if (NEGATION.test(prefix)) continue;
            if (prefix === '' || CLAUSE_START.test(prefix) || MARKERS.some((mk) => mk.test(prefix))) { hit = m[0]; break; }
          }
          if (hit) break;
        }
        if (hit) out.push({ verb: v.id, text: hit, sentence: s.slice(0, 160) });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ metrics
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;

export function detectLang(text: string): Lang {
  const words = normQ(text).match(/\p{L}+(?:'\p{L}+)?/gu) ?? [];
  let en = 0, es = 0;
  for (const w of words) { if (EN_WORDS.has(w)) en++; if (ES_WORDS.has(w)) es++; }
  es += count(text, /[ñ¿¡]/g) * 2 + count(text, /[áéíóú]/gi) * 0.5;
  if (en + es < 2) return 'unknown';
  if (en >= 2 * es) return 'en';
  if (es >= 2 * en) return 'es';
  return 'mixed';
}

export function replyMetrics(text: string, ch: ChannelLimit = { limit: null, kind: null, source: null }): ReplyMetrics {
  const t = text ?? '';
  const chars = [...t].length;
  const questions = count(t, /\?+/g) + count(t, /¿/g) - count(t, /¿[^?]*\?/g);
  const lines = t.split('\n');
  const md = {
    headers: lines.filter((l) => /^\s{0,3}#{1,6}\s+\S/.test(l)).length,
    bold: count(t, /\*\*[^*\n]+\*\*|__[^_\n]+__/g),
    bullets: lines.filter((l) => /^\s*[-*•]\s+\S/.test(l)).length,
    numbered: lines.filter((l) => /^\s*\d{1,2}[.)]\s+\S/.test(l)).length,
  };
  const links = count(t, /https?:\/\/[^\s)>\]]+/g) + count(t, /\]\((?!https?:)[^)]+\)/g);
  return {
    chars,
    limit: ch.limit,
    limitKind: ch.kind,
    overLimit: ch.limit !== null && chars > ch.limit,
    words: (t.match(/\S+/g) ?? []).length,
    questions: Math.max(0, questions),
    md,
    emoji: count(t, /\p{Extended_Pictographic}/gu),
    lang: detectLang(t),
    links,
    hedges: count(normQ(t), HEDGE_RE),
    confident: count(normQ(t), CONF_RE),
    claims: detectClaims(t),
  };
}

export type MetricChip = { key: string; label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; title: string };

/** Small chips summarising one reply, most telling first. */
export function metricChips(m: ReplyMetrics): MetricChip[] {
  const chips: MetricChip[] = [];
  chips.push({ key: 'chars', label: m.limit ? `${m.chars}/${m.limit}` : `${m.chars} ch`, tone: m.overLimit ? (m.limitKind === 'max' ? 'bad' : 'warn') : 'neutral', title: m.limit ? `${m.chars} characters; ${m.limitKind === 'max' ? 'limit' : 'guideline'} ${m.limit}` : `${m.chars} characters, ${m.words} words` });
  if (m.questions) chips.push({ key: 'q', label: `${m.questions}?`, tone: 'info', title: `${m.questions} question(s)` });
  const mdN = m.md.headers + m.md.bold + m.md.bullets + m.md.numbered;
  if (mdN) chips.push({ key: 'md', label: `md ${[m.md.headers && `#${m.md.headers}`, m.md.bold && `**${m.md.bold}`, m.md.bullets && `•${m.md.bullets}`, m.md.numbered && `1.${m.md.numbered}`].filter(Boolean).join(' ')}`, tone: 'neutral', title: `markdown: ${m.md.headers} header(s), ${m.md.bold} bold, ${m.md.bullets} bullet(s), ${m.md.numbered} numbered item(s)` });
  if (m.emoji) chips.push({ key: 'emoji', label: `emoji ${m.emoji}`, tone: 'neutral', title: `${m.emoji} emoji` });
  if (m.links) chips.push({ key: 'links', label: `links ${m.links}`, tone: 'info', title: `${m.links} link(s) pasted` });
  if (m.hedges) chips.push({ key: 'hedge', label: `hedge ${m.hedges}`, tone: 'warn', title: `${m.hedges} hedge word(s) (maybe, might, I think…)` });
  if (m.confident) chips.push({ key: 'conf', label: `sure ${m.confident}`, tone: 'neutral', title: `${m.confident} confident word(s) (definitely, always…)` });
  if (m.claims.length) chips.push({ key: 'claims', label: `claims ${m.claims.length}`, tone: 'warn', title: `action claims: ${m.claims.map((c) => `"${c.text}" (${c.verb})`).join(', ')}` });
  if (m.lang !== 'unknown') chips.push({ key: 'lang', label: m.lang.toUpperCase(), tone: m.lang === 'mixed' ? 'warn' : 'neutral', title: `detected language: ${m.lang}` });
  return chips;
}

export type MetricDelta = { key: string; label: string; a: number | string; b: number | string; delta: number | null };

/** Per-metric A vs B for the compare diff. */
export function metricDeltas(a: ReplyMetrics | null, b: ReplyMetrics | null): MetricDelta[] {
  const n = (m: ReplyMetrics | null, f: (m: ReplyMetrics) => number) => (m ? f(m) : 0);
  const rows: [string, string, (m: ReplyMetrics) => number][] = [
    ['chars', 'characters', (m) => m.chars], ['questions', 'questions', (m) => m.questions], ['md', 'markdown marks', (m) => m.md.headers + m.md.bold + m.md.bullets + m.md.numbered],
    ['emoji', 'emoji', (m) => m.emoji], ['links', 'links', (m) => m.links], ['hedges', 'hedges', (m) => m.hedges], ['confident', 'confident', (m) => m.confident], ['claims', 'claims', (m) => m.claims.length],
  ];
  const out: MetricDelta[] = rows.map(([key, label, f]) => ({ key, label, a: n(a, f), b: n(b, f), delta: n(b, f) - n(a, f) }));
  out.push({ key: 'lang', label: 'language', a: a?.lang ?? '—', b: b?.lang ?? '—', delta: null });
  return out;
}

// ------------------------------------------------------------------------------------------------ extension point
/**
 * EXTENSION POINT (optional LLM tone judge). Nothing here calls a model. To add one later, implement `ToneJudge`
 * (e.g. a server endpoint that asks a judge model for warmth / formality / pushiness on a 1..5 scale) and register it
 * with `setToneJudge`. The canvas shows `ToneJudgement.scores` as extra chips when a judge is registered; with none
 * (the default) only the deterministic metrics above are shown.
 */
export type ToneJudgement = { scores: Record<string, number>; rationale?: string; model: string };
export type ToneJudge = (reply: string, ctx: { caseId?: string; surface?: string; turn: number }) => Promise<ToneJudgement | null>;
let toneJudge: ToneJudge | null = null;
export const setToneJudge = (j: ToneJudge | null) => { toneJudge = j; };
export const getToneJudge = (): ToneJudge | null => toneJudge;
