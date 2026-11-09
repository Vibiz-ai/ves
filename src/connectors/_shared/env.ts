// Environment for an agent process (DESIGN-agnostic §1.1 "Bypass limits"): only PATH, HOME, VES_* and the names in
// connection.env_passthrough are passed through, plus connection.env (already ${VAR}-interpolated by core).
// Tool-backend credentials therefore do not reach the agent unless the team lists them.
const ALWAYS = ['PATH', 'HOME', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP', 'LANG'];

export function agentEnv(src: Record<string, string | undefined>, passthrough: unknown, extra: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const names = new Set<string>([...ALWAYS, ...(Array.isArray(passthrough) ? passthrough.map(String) : [])]);
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (names.has(k) || k.startsWith('VES_')) out[k] = v;
  }
  if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra as Record<string, unknown>)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}
