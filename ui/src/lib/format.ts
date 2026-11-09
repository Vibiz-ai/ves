export const DASH = '—';

export function pct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  return `${(x * 100).toFixed(digits)}%`;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return DASH;
  return `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortSha(sha: string | null | undefined): string {
  if (!sha) return DASH;
  const s = sha.replace(/^tree:/, '');
  return s.length > 7 ? s.slice(0, 7) : s;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const s = Math.round((now - t) / 1000);
  const abs = Math.abs(s);
  const fmt = (v: number, u: string) => (s >= 0 ? `${v}${u} ago` : `in ${v}${u}`);
  if (abs < 45) return s >= 0 ? 'just now' : 'in a moment';
  if (abs < 3600) return fmt(Math.round(abs / 60), 'm');
  if (abs < 86400) return fmt(Math.round(abs / 3600), 'h');
  if (abs < 86400 * 30) return fmt(Math.round(abs / 86400), 'd');
  return new Date(t).toISOString().slice(0, 10);
}

export function absTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return DASH;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : DASH;
  return String(v);
}

/** Readable local date and time: "Nov 8, 2026 · 22:08" (`year: false` drops the year). */
export function niceTime(iso: string | null | undefined, opts: { year?: boolean } = {}): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const d = new Date(t);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(opts.year === false ? {} : { year: 'numeric' }) });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}
