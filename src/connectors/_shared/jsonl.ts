// ves-agent/1 JSONL codec (DESIGN-agnostic §1.2): one JSON object per line, UTF-8, `\n`-terminated, no embedded
// newlines. A non-JSON line is NOT an error (frameworks print banners): the decoder hands it back as `text`.

/** Encode one message. JSON.stringify never emits a raw newline, so the line is always a single record. */
export const encodeLine = (m: unknown): string => JSON.stringify(m) + '\n';

export type Decoded = { kind: 'msg'; msg: Record<string, unknown> } | { kind: 'text'; text: string };

/** Parse one line: an object with a string `type` is a message; anything else is text (logged, ignored). */
export function decodeLine(line: string): Decoded | null {
  const s = line.replace(/\r$/, '');
  if (!s.trim()) return null;
  if (s.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.type === 'string') return { kind: 'msg', msg: j };
    } catch { /* fall through: a banner that happens to start with "{" */ }
  }
  return { kind: 'text', text: s };
}

/** Splits arbitrary chunks into complete lines; keeps the partial tail for the next chunk. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) { out.push(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1); }
    return out;
  }
  /** The unterminated tail at end of stream (a last line without `\n`). */
  flush(): string[] { const t = this.buf; this.buf = ''; return t ? [t] : []; }
}

/** Lines of an async chunk stream (ChildLike.stdout, a fetch body decoded to text). */
export async function* lines(src: AsyncIterable<string>): AsyncGenerator<string> {
  const sp = new LineSplitter();
  for await (const chunk of src) for (const l of sp.push(String(chunk))) yield l;
  for (const l of sp.flush()) yield l;
}

/** Messages from an NDJSON body or an SSE body (`data:` lines, events separated by blank lines). */
export async function* agentMessages(src: AsyncIterable<string>, contentType: string | null, onText?: (t: string) => void): AsyncGenerator<Record<string, unknown>> {
  const sse = !!contentType && contentType.includes('text/event-stream');
  let data: string[] = [];
  const emit = function* (payload: string): Generator<Record<string, unknown>> {
    for (const l of payload.split('\n')) {
      const d = decodeLine(l);
      if (!d) continue;
      if (d.kind === 'msg') yield d.msg; else onText?.(d.text);
    }
  };
  for await (const raw of lines(src)) {
    const l = raw.replace(/\r$/, '');
    if (!sse) { yield* emit(l); continue; }
    if (l === '') { if (data.length) { yield* emit(data.join('')); data = []; } continue; }
    if (l.startsWith('data:')) data.push(l.slice(5).trimStart());
    // `event:`, `id:`, `retry:` and `:` comments are ignored
  }
  if (data.length) yield* emit(data.join(''));
}
