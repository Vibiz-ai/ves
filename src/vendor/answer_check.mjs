// Amendment 9 block C: check a draft reply against the text shown for it. Model-free. From the draft take numbers, money,
// percentages, dates and capitalised names that are not in the question; each must appear in the shown text. Frozen
// before any item row of block R9A is opened. No word list from any corpus.
const norm = (s) => String(s).toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ')
const STOP = new Set(['i', 'the', 'a', 'an', 'we', 'you', 'it', 'this', 'that', 'these', 'those', 'there', 'they', 'he', 'she', 'our', 'your', 'their', 'in', 'on', 'at', 'for', 'to', 'of', 'by', 'with', 'from', 'as', 'if', 'but', 'and', 'or', 'not', 'no', 'yes', 'use', 'try', 'do', 'don\'t', 'please', 'however', 'also', 'based', 'according', 'unfortunately', 'sorry', 'because', 'since', 'after', 'before', 'when', 'while', 'so', 'then', 'here', 'what', 'which', 'who', 'how', 'why', 'my', 'is', 'are', 'was', 'were'])
const MONTH = 'january|february|march|april|may|june|july|august|september|october|november|december'
const NUM = /(?<![\p{L}\p{N}])[$€£]?\d[\d,]*(?:\.\d+)?%?(?![\p{L}\p{N}])/gu
const DATE = new RegExp(`\\b(?:\\d{1,2}\\s+(?:${MONTH})(?:\\s+\\d{4})?|(?:${MONTH})\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2})\\b`, 'gi')
const NAME = /\p{Lu}[\p{L}\p{N}'-]*(?:\s+(?:of\s+|the\s+)?\p{Lu}[\p{L}\p{N}'-]*)*/gu

/** Sentence-first words are capitalised by grammar: a lone one counts only if it is not a plain lower-case word in the
 * draft or the shown text. Numbers keep their digits; "1,200" and "1200" are the same. */
export function claimsOf(draft, question = '') {
  const text = String(draft)
  const q = norm(question)
  const out = []
  const add = (kind, v) => {
    const n = norm(v).replace(/[.,;:]+$/, '')
    if (n && !q.includes(n) && !out.some((x) => x.norm === n)) out.push({ kind, value: v.trim(), norm: n })
  }
  for (const m of text.match(DATE) ?? []) add('date', m)
  const noDates = text.replace(DATE, ' ')
  for (const m of noDates.match(NUM) ?? []) add('number', m)
  for (const m of noDates.match(NAME) ?? []) {
    const parts = m.split(/\s+/)
    while (parts.length && STOP.has(parts[0].toLowerCase())) parts.shift()
    if (!parts.length) continue
    const name = parts.join(' ')
    if (new RegExp(`^(?:${MONTH})$`, 'i').test(name)) continue
    add('name', name)
  }
  return out
}

const digits = (s) => s.replace(/(\d),(\d)/g, '$1$2')
/** The claims of a draft that the shown text does not hold. A lone capitalised word held in lower case counts as held. */
export function unsupported(draft, shown, question = '') {
  const hay = digits(norm(shown))
  return claimsOf(draft, question).filter((c) => !hay.includes(digits(c.norm)))
}

export const repairPrompt = (items) => `These items in your reply are not in the memory shown to you: ${items.map((c) => `"${c.value}"`).join(', ')}. Answer the question again using only the memory shown. If it does not record the answer, say that it is not recorded. Give only the new answer.`
