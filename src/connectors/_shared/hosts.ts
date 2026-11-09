// Production-host refusal (DESIGN-agnostic §1.4), the generic form of v1's *.vibiz.ai refusal: by default only
// loopback and *.internal / *.test / *.localhost hosts are allowed; anything else must be listed in `allow_hosts`
// (exact host, or "*.suffix").
export function hostAllowed(url: string, allow: unknown): { ok: boolean; host: string; reason?: string } {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return { ok: false, host: '', reason: `invalid url ${url}` }; }
  const list = Array.isArray(allow) ? allow.map((x) => String(x).toLowerCase()) : [];
  if (host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)) return { ok: true, host };
  if (/\.(internal|test|localhost)$/.test(host)) return { ok: true, host };
  for (const a of list) {
    if (a === host) return { ok: true, host };
    if (a.startsWith('*.') && host.endsWith(a.slice(1))) return { ok: true, host };
  }
  return { ok: false, host, reason: `refusing non-local host ${host}: list it in connection.allow_hosts if it is a sandbox (production hosts are never evaluated by default)` };
}
