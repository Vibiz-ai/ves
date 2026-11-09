// The harness tool proxy for stdio-only MCP clients (DESIGN-agnostic §1.2 `tool_transport.mcp_stdio`): a stdio MCP
// server that forwards every JSON-RPC message to the per-trial Streamable-HTTP MCP endpoint core started for the trial
// (src/proxy/http-binding.ts). Frameworks whose MCP client only spawns stdio servers (some CrewAI / LangChain setups,
// Claude Agent SDK `type: "stdio"`) point at:
//   node src/connectors/_shared/stdio-bridge.ts --connect <tool_transport.mcp.url>
// Every call still lands in Proxy.invoke(), so the records are identical to the HTTP transport. The URL carries the
// per-trial token, so a stale bridge cannot write into another trial. `ves proxy --connect <url>` is this file.
import { fileURLToPath } from 'node:url';
import { lines } from './jsonl.ts';
import type { FetchLike, SessionOpen } from '../../core/types.ts';

export const STDIO_BRIDGE_PATH = fileURLToPath(import.meta.url);

/** session.open with `mcp_stdio` filled in whenever core served an HTTP MCP endpoint and no stdio bridge is set. */
export function withStdioBridge(o: SessionOpen, nodePath: string = process.execPath): SessionOpen {
  const t = o.tool_transport;
  if (!t?.mcp?.url || t.mcp_stdio) return o;
  return { ...o, tool_transport: { ...t, mcp_stdio: { command: nodePath, args: [STDIO_BRIDGE_PATH, '--connect', t.mcp.url] } } };
}

/** Parse JSON-RPC replies from a JSON or SSE body (all messages; notifications have none). */
export function rpcReplies(text: string, contentType: string | null): unknown[] {
  if (!text.trim()) return [];
  if (contentType?.includes('text/event-stream')) {
    const out: unknown[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) { try { out.push(JSON.parse(data)); } catch { /* keep-alive */ } }
    }
    return out;
  }
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : [j]; } catch { return []; }
}

/**
 * Forward stdin JSON-RPC lines to `url` and write the replies to stdout, one per line. Keeps `mcp-session-id` and
 * `mcp-protocol-version` across requests. A transport failure becomes a JSON-RPC error for that request id.
 */
export async function runStdioBridge(o: {
  url: string; headers?: Record<string, string>; fetch: FetchLike; input: AsyncIterable<string>; write: (line: string) => void; log?: (m: string) => void;
}): Promise<void> {
  let sid: string | undefined;
  let proto: string | undefined;
  for await (const raw of lines(o.input)) {
    const line = raw.trim();
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { o.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); continue; }
    const ids = (Array.isArray(msg) ? msg : [msg]).filter((m) => m && m.id !== undefined && m.id !== null).map((m) => m.id);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(o.headers ?? {}) };
      if (sid) headers['mcp-session-id'] = sid;
      if (proto) headers['mcp-protocol-version'] = proto;
      const res = await o.fetch(o.url, { method: 'POST', headers, body: line });
      const s = res.headers.get('mcp-session-id');
      if (s) sid = s;
      const text = await res.text();
      if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      for (const r of rpcReplies(text, res.headers.get('content-type'))) {
        const pv = (r as any)?.result?.protocolVersion;
        if (typeof pv === 'string') proto = pv;
        o.write(JSON.stringify(r));
      }
    } catch (e) {
      o.log?.(`bridge: ${(e as Error).message}`);
      for (const id of ids) o.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: `ves stdio bridge: ${(e as Error).message}` } }));
    }
  }
}

// CLI: node src/connectors/_shared/stdio-bridge.ts --connect <url> [--header "k: v"]...
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const url = argv[argv.indexOf('--connect') + 1];
  if (!argv.includes('--connect') || !url) { process.stderr.write('usage: stdio-bridge.ts --connect <mcp url> [--header "name: value"]\n'); process.exit(3); }
  const headers: Record<string, string> = {};
  argv.forEach((a, i) => { if (a === '--header' && argv[i + 1]) { const [k, ...v] = argv[i + 1].split(':'); headers[k.trim().toLowerCase()] = v.join(':').trim(); } });
  process.stdin.setEncoding('utf8');
  await runStdioBridge({ url, headers, fetch: globalThis.fetch as unknown as FetchLike, input: process.stdin as AsyncIterable<string>, write: (l) => process.stdout.write(l + '\n'), log: (m) => process.stderr.write(m + '\n') });
}
