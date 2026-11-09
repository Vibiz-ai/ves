// §5.2: canonicalisation for the S0 determinism check. Drops timestamps, durations, request ids and generated UUIDs,
// sorts object keys. Arrays are kept in order unless the key is listed as an array of independent items.
const VOLATILE_KEYS = new Set([
  'created_at', 'updated_at', 'at', 'expires_at', 'timestamp', 'ts', 'wall_ms', 'ttft_ms', 'wall_s', 'duration_ms',
  'request_id', 'requestId', 'run_id', 'row_id', 'atif_uri', 'snapshot_uri', 'otel_trace_id', 'session_id',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function canonicalise(v: unknown, opts: { dropVolatile?: boolean; unorderedKeys?: string[] } = {}, key = ''): unknown {
  const unordered = new Set(opts.unorderedKeys ?? []);
  if (Array.isArray(v)) {
    const xs = v.map((x) => canonicalise(x, opts));
    return unordered.has(key) ? xs.map((x) => JSON.stringify(x)).sort().map((s) => JSON.parse(s)) : xs;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      if (opts.dropVolatile && VOLATILE_KEYS.has(k)) continue;
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) continue;
      out[k] = canonicalise(x, opts, k);
    }
    return out;
  }
  if (opts.dropVolatile && typeof v === 'string' && (UUID.test(v) || ISO.test(v))) return '<volatile>';
  if (typeof v === 'string') return v.normalize('NFC');
  return v;
}
export const canonicalJson = (v: unknown, opts?: { dropVolatile?: boolean; unorderedKeys?: string[] }): string =>
  JSON.stringify(canonicalise(v, opts ?? {}));
