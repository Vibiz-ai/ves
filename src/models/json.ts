// Lenient JSON extraction for model output: plain JSON, a ```json fenced block, or the outermost {...} span.
// Never throws; callers turn a failure into `unknown` (judge) or a retry/HarnessError (simulator).
export function parseModelJson(text: string | null | undefined): { ok: true; value: any } | { ok: false; error: string } {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, error: 'empty output' };
  const tries: string[] = [s];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) tries.push(fence[1].trim());
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
    } catch { /* next */ }
  }
  return { ok: false, error: `not a JSON object: ${s.replace(/\s+/g, ' ').slice(0, 120)}` };
}
