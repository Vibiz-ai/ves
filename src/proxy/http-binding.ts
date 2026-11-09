// node:http binding for the per-trial tool proxy (DESIGN-agnostic §1.2 "Calling tools"). Used ONLY outside tests.
// Binds 127.0.0.1 on a random port; every URL carries the unguessable per-trial token (/s/<128-bit hex>/...), so a
// stale agent process cannot write into another trial.
//   POST /s/<token>/mcp            MCP Streamable HTTP (mcp-server.ts handle())
//   POST /s/<token>/tools/<name>   plain HTTP tool transport: body = args -> {ok, result | error}; an optional
//                                  `x-ves-thread: thread-<id>` header names the conversation thread the call belongs to
//                                  (a backend that serves several threads, e.g. a workspace twin, says which one)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { McpReq, McpRes } from './mcp-server.ts';
import type { ToolTransport } from '../core/types.ts';

/** Thread ids the harness itself uses (`thread-main`, `thread-other`), or any `thread-<id>` up to 64 chars. */
export const THREAD_RE = /^thread-[a-z0-9-]{1,64}$/;

export type ToolEndpoints = { transport: ToolTransport; token: string; close(): Promise<void> };

const read = (req: IncomingMessage): Promise<string> => new Promise((res, rej) => {
  let s = ''; req.setEncoding('utf8'); req.on('data', (c) => { s += c; if (s.length > 8e6) req.destroy(); }); req.on('end', () => res(s)); req.on('error', rej);
});

export async function serveToolEndpoints(o: {
  mcp: (req: McpReq) => Promise<McpRes>;
  http: (name: string, args: Record<string, unknown>, meta?: { thread?: string }) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  token?: string;
}): Promise<ToolEndpoints> {
  const token = o.token ?? randomBytes(16).toString('hex');
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      const body = await read(req);
      if (!path.startsWith(`/s/${token}/`)) { res.writeHead(404).end(); return; }
      const rest = path.slice(`/s/${token}`.length);
      if (rest === '/mcp') {
        const r = await o.mcp({ method: req.method ?? 'POST', path, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), body });
        res.writeHead(r.status, r.headers).end(r.body);
        return;
      }
      const m = /^\/tools\/(.+)$/.exec(rest);
      if (m && req.method === 'POST') {
        let args: Record<string, unknown> = {};
        try { args = body ? JSON.parse(body) : {}; } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'invalid_json' })); return; }
        const th = req.headers['x-ves-thread'];
        const thread = typeof th === 'string' && THREAD_RE.test(th) ? th : undefined;
        const r = await o.http(decodeURIComponent(m[1]), args, thread ? { thread } : undefined);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
        return;
      }
      res.writeHead(404).end();
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: (e as Error).message })); }
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}/s/${token}`;
  return {
    token,
    transport: { pipe: true, mcp: { url: `${base}/mcp` }, http: { url: `${base}/tools` } },
    close: () => new Promise((res) => server.close(() => res())),
  };
}
