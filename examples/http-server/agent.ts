// A TypeScript tool-using agent served over HTTP with ves-agent/1 (the `http` connector). Node >= 22.18 runs it
// directly (type stripping): `node examples/http-server/agent.ts --port 8000`. No dependencies.
//
// It runs out of the box with a deterministic FakeLLM (no network, no API key). In your server, keep the four routes
// and replace `FakeLLM` with your model client and `runAgent` with your agent; tools stay on the harness side (every
// call is a `tool_call` the harness proxy records), and your own approval policy maps onto `hitl.request`.
//   GET  /ves/v1/health                 -> the ready message
//   POST /ves/v1/sessions               -> session.open  -> session.opened
//   POST /ves/v1/sessions/:id/events    -> one message   -> NDJSON until turn.end (or until a tool_call: the harness
//                                          POSTs the tool_result and the turn continues in that response)
//   DELETE /ves/v1/sessions/:id         -> 204
//   ves.config.json: "connection": { "type": "http", "base_url": "http://127.0.0.1:8000" }
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

type Msg = Record<string, any>;
type ChatMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] };
type Rule = { when: string; tool_calls?: { name: string; args: Record<string, unknown> }[]; reply: string };

const RULES = process.env.VES_FAKE_LLM_RULES ?? fileURLToPath(new URL('../fixtures/support-desk.fake-llm.json', import.meta.url));

/** Deterministic stand-in for a chat model with tool calling. */
export class FakeLLM {
  rules: Rule[]; fallback: string; declined: string;
  constructor(path: string = RULES) { const j = JSON.parse(readFileSync(path, 'utf8')); this.rules = j.rules; this.fallback = j.fallback ?? 'OK.'; this.declined = j.declined ?? 'OK, not done.'; }
  async complete(messages: ChatMsg[], tools: Set<string>): Promise<ChatMsg> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const rule = this.rules.find((r) => new RegExp(r.when, 'i').test(lastUser));
    if (messages[messages.length - 1].role === 'user') {
      const calls = (rule?.tool_calls ?? []).filter((c) => tools.has(c.name)).map((c, i) => ({ id: `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      return calls.length ? { role: 'assistant', content: null, tool_calls: calls } : { role: 'assistant', content: rule?.reply ?? this.fallback };
    }
    const since = messages.map((m) => m.role).lastIndexOf('user');
    const denied = messages.slice(since).some((m) => m.role === 'tool' && (m.content ?? '').includes('user_denied'));
    return { role: 'assistant', content: denied ? this.declined : rule?.reply ?? this.fallback };
  }
}

type Session = {
  id: string; tools: Map<string, { gated: boolean }>; messages: ChatMsg[]; n: number;
  parked: { call: NonNullable<ChatMsg['tool_calls']>[number]; rest: NonNullable<ChatMsg['tool_calls']>; thread: string } | null; thread: string;
  waiting: Map<string, (r: Msg) => void>; out: ((m: Msg) => void) | null; clock: number;
};

export function createVesHandler(o: { llm?: FakeLLM; unsafe?: boolean; maxSteps?: number } = {}) {
  const llm = o.llm ?? new FakeLLM();
  const sessions = new Map<string, Session>();
  const ready = { type: 'ready', protocol: 'ves-agent/1', agent: { name: 'http-ts-agent', version: '1.0.0', framework: 'plain-node', model: 'fake-llm' }, capabilities: ['multi_turn', 'hitl_structured'] };
  const emit = (s: Session, m: Msg) => s.out?.({ session_id: s.id, ...m });

  const callTool = (s: Session, name: string, args: Record<string, unknown>) => new Promise<Msg>((resolve) => {
    const call_id = `ts-${++s.n}`;
    s.waiting.set(call_id, resolve);
    emit(s, { type: 'tool_call', call_id, name, args }); // ends this HTTP response; the tool_result POST continues
  });
  const content = (r: Msg) => JSON.stringify(r.ok ? r.result ?? null : { error: r.error });

  async function runCalls(s: Session, calls: NonNullable<ChatMsg['tool_calls']>): Promise<'awaiting_hitl' | null> {
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const args = JSON.parse(c.function.arguments || '{}');
      if (s.tools.get(c.function.name)?.gated && !o.unsafe) { // this agent's own policy: gated tools need approval
        s.parked = { call: c, rest: calls.slice(i + 1), thread: s.thread };
        emit(s, { type: 'hitl.request', request_id: `approve-${c.id}`, tool: c.function.name, args });
        emit(s, { type: 'message', text: `Before I run ${c.function.name}, can you confirm?` });
        return 'awaiting_hitl';
      }
      s.messages.push({ role: 'tool', tool_call_id: c.id, content: content(await callTool(s, c.function.name, args)) });
    }
    return null;
  }
  async function runAgent(s: Session): Promise<string> {
    for (let step = 0; step < (o.maxSteps ?? 8); step++) {
      const m = await llm.complete(s.messages, new Set(s.tools.keys()));
      s.messages.push(m);
      if (!m.tool_calls?.length) { emit(s, { type: 'message', text: m.content ?? '' }); return 'done'; }
      if ((await runCalls(s, m.tool_calls)) === 'awaiting_hitl') return 'awaiting_hitl';
    }
    return 'error';
  }
  async function decide(s: Session, m: Msg): Promise<string> {
    const p = s.parked;
    if (!p) return 'done';
    s.parked = null;
    const ok = m.decision === 'approve' && m.as === 'owner' && m.thread === p.thread && !m.args_edited && !/changed the details/.test(m.text ?? ''); // owner, same conversation, unchanged details (args_edited voids it)
    const r = ok ? content(await callTool(s, p.call.function.name, JSON.parse(p.call.function.arguments))) : JSON.stringify({ error: 'user_denied', decision: m.decision });
    s.messages.push({ role: 'tool', tool_call_id: p.call.id, content: r });
    return (await runCalls(s, p.rest)) ?? runAgent(s);
  }
  /** Feed one harness message; resolve with the NDJSON lines of this response. */
  function onEvent(s: Session, m: Msg): Promise<Msg[]> {
    return new Promise((resolve) => {
      const buf: Msg[] = [];
      s.out = (x) => { buf.push(x); if (x.type === 'turn.end' || x.type === 'tool_call') { s.out = null; resolve(buf); } };
      if (m.type === 'tool_result') { const w = s.waiting.get(m.call_id); s.waiting.delete(m.call_id); w?.(m); return; }
      const turn_id = m.type === 'hitl.decision' ? m.request_id : m.type === 'clock.advance' ? `clock-${++s.clock}` : m.turn_id ?? 'wake';
      const job = m.type === 'turn' ? (s.parked = null, s.thread = m.thread, s.messages.push({ role: 'user', content: m.text }), runAgent(s)) : m.type === 'hitl.decision' ? decide(s, m) : Promise.resolve('done');
      job.then((reason) => emit(s, { type: 'turn.end', turn_id, reason }), (e: Error) => emit(s, { type: 'turn.end', turn_id, reason: 'error', error: e.message }));
    });
  }

  return async function handle(method: string, path: string, body: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const json = (status: number, b: unknown) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    if (method === 'GET' && path === '/ves/v1/health') return json(200, ready);
    if (method === 'POST' && path === '/ves/v1/sessions') {
      const m = JSON.parse(body);
      sessions.set(m.session_id, { id: m.session_id, tools: new Map(m.tools.map((t: Msg) => [t.name, { gated: !!t.gated }])), messages: [{ role: 'system', content: 'You are a support agent.' }], n: 0, parked: null, waiting: new Map(), out: null, clock: 0, thread: '' });
      return json(200, { type: 'session.opened', session_id: m.session_id });
    }
    const ev = /^\/ves\/v1\/sessions\/([^/]+)(\/events)?$/.exec(path);
    const s = ev ? sessions.get(decodeURIComponent(ev[1])) : undefined;
    if (!ev || !s) return json(404, { error: 'not found' });
    if (method === 'DELETE' && !ev[2]) { sessions.delete(s.id); return { status: 204, headers: {}, body: '' }; }
    if (method === 'POST' && ev[2]) {
      const msgs = await onEvent(s, JSON.parse(body));
      return { status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: msgs.map((x) => JSON.stringify(x)).join('\n') + '\n' };
    }
    return json(405, { error: 'method not allowed' });
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8000;
  const handle = createVesHandler({ unsafe: process.env.VES_DEMO_UNSAFE === '1' });
  createServer((req, res) => {
    let b = ''; req.setEncoding('utf8'); req.on('data', (c) => { b += c; });
    req.on('end', async () => { const r = await handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], b); res.writeHead(r.status, r.headers).end(r.body); });
  }).listen(port, '127.0.0.1', () => process.stderr.write(`http-ts-agent on http://127.0.0.1:${port}\n`));
}
