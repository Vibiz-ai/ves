#!/usr/bin/env node
// VES reference agent: a rule-based, no-model agent that speaks ves-agent/1 (DESIGN-agnostic §7.4). The connectors and
// ci tests use it; it is also the smallest complete example of the protocol.
//
// Behaviour comes from a script of rules, from session.open.context.script, or from --script <file> (or
// VES_REF_SCRIPT). Each rule is { "when": "<regex on the user text>", "steps": [...] } with oracle-shaped steps:
//   { "call": "<tool>", "args": {...} }                 tool_call on the pipe, waits for tool_result
//   { "ask": { "tool", "args", "prompt"? } }            hitl.request + turn.end awaiting_hitl; continues on approve
//   { "reply": "<text>" }                               message
// Its HITL policy: only an `approve` from the owner, on the same thread, with unchanged details, counts. `--unsafe`
// (or VES_REF_UNSAFE=1) skips every ask: the gated-write bypass the gate must catch.
//
//   stdio:  node examples/reference-agent/agent.mjs [--script f.json] [--unsafe]
//   http:   node examples/reference-agent/agent.mjs --http 8000          (GET /ves/v1/health, POST /ves/v1/sessions, ...)
// `createReferenceAgent()` and `createHttpHandler()` are exported so tests can run it in-process with fakes.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function createReferenceAgent(opts = {}) {
  const unsafe = !!opts.unsafe;
  const defaultScript = opts.script ?? [];
  const sessions = new Map();
  let emit = opts.emit ?? (() => {});
  const send = (m) => emit(m);

  const ready = { type: 'ready', protocol: 'ves-agent/1', agent: { name: 'ves-reference-agent', version: '1.0.0', framework: 'plain-node', model: 'none' + (unsafe ? ' (unsafe)' : '') }, capabilities: ['multi_turn', 'hitl_structured', 'schedule_clock'] };

  const callTool = (s, name, args) => new Promise((resolve) => {
    const call_id = `c${++s.n}`;
    s.waiting.set(call_id, resolve);
    send({ type: 'tool_call', session_id: s.id, call_id, name, args });
  });
  const say = (s, text, turn_id) => send({ type: 'message', session_id: s.id, ...(turn_id ? { turn_id } : {}), text });

  // Run the current rule's steps from s.ptr: stop at an ask (awaiting) or the end (done).
  async function advance(s, thread) {
    while (s.ptr < s.steps.length) {
      const st = s.steps[s.ptr++];
      if (st.reply !== undefined) { say(s, st.reply); continue; }
      if (st.ask) {
        if (unsafe) continue;
        const request_id = `r${++s.n}`;
        s.pending = { request_id, tool: st.ask.tool, thread };
        send({ type: 'hitl.request', session_id: s.id, request_id, tool: st.ask.tool, args: st.ask.args, ...(st.ask.prompt ? { prompt: st.ask.prompt } : {}) });
        say(s, st.ask.prompt ?? `Before I do this, please confirm: ${st.ask.tool} ${JSON.stringify(st.ask.args)}.`);
        return 'awaiting_hitl';
      }
      if (st.call) {
        const r = await callTool(s, st.call, st.args ?? {});
        if (!r.ok) { say(s, `That did not work (${r.error ?? 'error'}).`); s.ptr = s.steps.length; }
      }
    }
    return 'done';
  }
  function skipPending(s, tool) {
    while (s.ptr < s.steps.length) {
      const st = s.steps[s.ptr];
      if (st.call === tool) { s.ptr++; continue; }
      if (st.reply !== undefined) s.ptr++;
      break;
    }
  }
  async function onTurn(s, m) {
    const rule = s.script.find((r) => new RegExp(r.when, 'i').test(m.text));
    if (s.pending && /^(yes|ok|go ahead)\b/i.test(m.text)) return onDecision(s, { request_id: s.pending.request_id, decision: 'approve', as: m.as, thread: m.thread, text: m.text });
    s.pending = null;
    if (!rule) { say(s, 'Got it.'); return 'done'; }
    s.steps = rule.steps ?? []; s.ptr = 0;
    return advance(s, m.thread);
  }
  async function onDecision(s, m) {
    const p = s.pending;
    s.pending = null;
    if (!p) { say(s, 'There is nothing waiting for a decision.'); return 'done'; }
    const ok = m.decision === 'approve' && m.as === 'owner' && m.thread === p.thread && !m.args_edited && !/changed the details/.test(m.text ?? '');
    if (!ok) {
      skipPending(s, p.tool);
      say(s, m.decision === 'approve' && /changed the details/.test(m.text ?? '') ? 'The details changed, so I need a fresh approval. Nothing was changed.' : 'Okay, I have not done it.');
      return 'done';
    }
    return advance(s, p.thread);
  }
  // One turn at a time per session; tool_result messages bypass the chain (the running turn is waiting for them).
  function run(s, turn_id, job) {
    s.chain = s.chain.then(async () => {
      let reason = 'done', error;
      try { reason = await job(); } catch (e) { reason = 'error'; error = String(e?.message ?? e); }
      send({ type: 'turn.end', session_id: s.id, turn_id, reason, ...(error ? { error } : {}) });
    });
  }

  function onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'shutdown') { opts.onShutdown?.(); return; }
    if (m.type === 'session.open') {
      const script = Array.isArray(m.context?.script) ? m.context.script : defaultScript;
      sessions.set(m.session_id, { id: m.session_id, script, steps: [], ptr: 0, n: 0, pending: null, waiting: new Map(), chain: Promise.resolve(), clockN: 0 });
      send({ type: 'session.opened', session_id: m.session_id });
      return;
    }
    const s = sessions.get(m.session_id);
    if (!s) { send({ type: 'log', level: 'warn', msg: `unknown session ${m.session_id}` }); return; }
    switch (m.type) {
      case 'tool_result': { const w = s.waiting.get(m.call_id); if (w) { s.waiting.delete(m.call_id); w(m); } return; }
      case 'turn': run(s, m.turn_id, () => onTurn(s, m)); return;
      case 'hitl.decision': run(s, m.request_id, () => onDecision(s, m)); return;
      case 'clock.advance': run(s, `clock-${++s.clockN}`, async () => 'done'); return;
      case 'wake': run(s, `wake-${m.schedule_id}`, async () => 'done'); return;
      case 'session.close': sessions.delete(m.session_id); return;
      default: send({ type: 'log', level: 'debug', msg: `ignored ${m.type}` });
    }
  }
  return { ready, onMessage, setEmit: (f) => { emit = f; }, sessions };
}

/** ves-agent/1 over HTTP for the reference agent: a pure handler (method, path, body) -> {status, headers, body}.
 *  Each POST .../events response carries the agent's messages until turn.end, or until a tool_call (the harness then
 *  POSTs the tool_result and the turn continues in that response). */
export function createHttpHandler(opts = {}) {
  const collectors = new Map(); // session_id -> resolve(messages)
  let opened = null;
  const route = (m) => {
    if (m.type === 'session.opened') { opened = m; return; }
    const c = collectors.get(m.session_id);
    if (!c) return;
    c.msgs.push(m);
    if (m.type === 'turn.end' || m.type === 'tool_call') { collectors.delete(m.session_id); c.resolve(c.msgs); }
  };
  const agent = createReferenceAgent({ ...opts, emit: route });
  const collect = (sid, m) => new Promise((resolve) => { collectors.set(sid, { msgs: [], resolve }); agent.onMessage(m); });
  return async function handle(method, path, body) {
    if (method === 'GET' && path === '/ves/v1/health') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(agent.ready) };
    if (method === 'POST' && path === '/ves/v1/sessions') { opened = null; agent.onMessage(JSON.parse(body)); return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(opened) }; }
    const ev = /^\/ves\/v1\/sessions\/([^/]+)\/events$/.exec(path);
    if (method === 'POST' && ev) return ndjson(await collect(decodeURIComponent(ev[1]), JSON.parse(body)));
    const del = /^\/ves\/v1\/sessions\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && del) { agent.onMessage({ type: 'session.close', session_id: decodeURIComponent(del[1]) }); return { status: 204, headers: {}, body: '' }; }
    return { status: 404, headers: {}, body: '' };
  };
}
const ndjson = (msgs) => ({ status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: msgs.map((m) => JSON.stringify(m)).join('\n') + '\n' });

// ------------------------------------------------------------------------------------------------------ main
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const scriptFile = arg('--script') ?? process.env.VES_REF_SCRIPT;
  const script = scriptFile ? JSON.parse(readFileSync(scriptFile, 'utf8')) : [];
  const unsafe = argv.includes('--unsafe') || process.env.VES_REF_UNSAFE === '1';
  const port = arg('--http');
  if (port) {
    const { createServer } = await import('node:http');
    const handle = createHttpHandler({ script, unsafe });
    createServer((req, res) => {
      let b = ''; req.setEncoding('utf8'); req.on('data', (c) => { b += c; });
      req.on('end', async () => { const r = await handle(req.method, req.url.split('?')[0], b); res.writeHead(r.status, r.headers).end(r.body); });
    }).listen(Number(port), '127.0.0.1', () => process.stderr.write(`reference agent on http://127.0.0.1:${port}\n`));
  } else {
    process.stdout.write('ves reference agent starting (this banner is not JSON and must be ignored)\n');
    const agent = createReferenceAgent({ script, unsafe, emit: (m) => process.stdout.write(JSON.stringify(m) + '\n'), onShutdown: () => process.exit(0) });
    process.stdout.write(JSON.stringify(agent.ready) + '\n');
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (l) => { if (!l.trim()) return; try { agent.onMessage(JSON.parse(l)); } catch (e) { process.stderr.write(`bad line: ${e.message}\n`); } });
    rl.on('close', () => process.exit(0));
  }
}
