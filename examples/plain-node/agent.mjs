#!/usr/bin/env node
// A plain Node.js tool-using agent speaking ves-agent/1 over stdin/stdout (the `command` connector). No framework, no
// dependencies. It runs out of the box with a deterministic FakeLLM (no network, no API key); swap `fakeLLM` for your
// model client to evaluate your real agent. Tools stay on the harness side: every call is a `tool_call` the proxy
// records. This agent's own policy: a gated tool needs the owner's approval (VES_DEMO_UNSAFE=1 skips it, to see G-3 block).
//   ves.config.json: "connection": { "type": "command", "command": ["node", "examples/plain-node/agent.mjs"] }
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const RULES = JSON.parse(readFileSync(process.env.VES_FAKE_LLM_RULES ?? new URL('../fixtures/support-desk.fake-llm.json', import.meta.url), 'utf8'));
const UNSAFE = process.env.VES_DEMO_UNSAFE === '1';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

/** Deterministic stand-in for a chat model with tool calling (OpenAI-style messages). */
function fakeLLM(messages, tools) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const rule = RULES.rules.find((r) => new RegExp(r.when, 'i').test(lastUser));
  if (messages.at(-1).role === 'user') {
    const calls = (rule?.tool_calls ?? []).filter((c) => tools.has(c.name)).map((c, i) => ({ id: `call_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    return calls.length ? { role: 'assistant', content: null, tool_calls: calls } : { role: 'assistant', content: rule?.reply ?? RULES.fallback };
  }
  const denied = messages.slice(messages.map((m) => m.role).lastIndexOf('user')).some((m) => m.role === 'tool' && m.content.includes('user_denied'));
  return { role: 'assistant', content: denied ? RULES.declined : rule?.reply ?? RULES.fallback };
}

const sessions = new Map();
const waiting = new Map(); // call_id -> resolve
let n = 0;
const callTool = (s, name, args) => new Promise((resolve) => { const call_id = `n${++n}`; waiting.set(call_id, resolve); send({ type: 'tool_call', session_id: s.id, call_id, name, args }); });
const content = (r) => JSON.stringify(r.ok ? r.result ?? null : { error: r.error });

async function runCalls(s, calls) {
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const args = JSON.parse(c.function.arguments || '{}');
    if (s.gated.has(c.function.name) && !UNSAFE) {
      s.parked = { call: c, rest: calls.slice(i + 1), thread: s.thread };
      send({ type: 'hitl.request', session_id: s.id, request_id: `approve-${c.id}`, tool: c.function.name, args });
      send({ type: 'message', session_id: s.id, text: `Before I run ${c.function.name}, can you confirm?` });
      return 'awaiting_hitl';
    }
    s.messages.push({ role: 'tool', tool_call_id: c.id, content: content(await callTool(s, c.function.name, args)) });
  }
  return null;
}
async function agentLoop(s) {
  for (let step = 0; step < 8; step++) {
    const m = fakeLLM(s.messages, s.tools);
    s.messages.push(m);
    if (!m.tool_calls) { send({ type: 'message', session_id: s.id, text: m.content }); return 'done'; }
    if ((await runCalls(s, m.tool_calls)) === 'awaiting_hitl') return 'awaiting_hitl';
  }
  return 'error';
}
async function decide(s, m) {
  const p = s.parked;
  if (!p) return 'done';
  s.parked = null;
  const ok = m.decision === 'approve' && m.as === 'owner' && m.thread === p.thread && !m.args_edited && !/changed the details/.test(m.text ?? ''); // owner, same conversation, unchanged details (args_edited voids it)
  const r = ok ? content(await callTool(s, p.call.function.name, JSON.parse(p.call.function.arguments))) : JSON.stringify({ error: 'user_denied' });
  s.messages.push({ role: 'tool', tool_call_id: p.call.id, content: r });
  return (await runCalls(s, p.rest)) ?? agentLoop(s);
}

let chain = Promise.resolve();
async function onMessage(m) {
  const s = sessions.get(m.session_id);
  if (m.type === 'shutdown') process.exit(0);
  if (m.type === 'session.open') {
    sessions.set(m.session_id, { id: m.session_id, tools: new Set(m.tools.map((t) => t.name)), gated: new Set(m.tools.filter((t) => t.gated).map((t) => t.name)), messages: [], parked: null, clock: 0 });
    return send({ type: 'session.opened', session_id: m.session_id });
  }
  if (!s) return;
  if (m.type === 'session.close') return sessions.delete(m.session_id);
  const turn_id = m.type === 'hitl.decision' ? m.request_id : m.type === 'clock.advance' ? `clock-${++s.clock}` : m.turn_id ?? 'wake';
  try {
    const reason = m.type === 'turn' ? (s.parked = null, s.thread = m.thread, s.messages.push({ role: 'user', content: m.text }), await agentLoop(s)) : m.type === 'hitl.decision' ? await decide(s, m) : 'done';
    send({ type: 'turn.end', session_id: s.id, turn_id, reason });
  } catch (e) { send({ type: 'turn.end', session_id: s.id, turn_id, reason: 'error', error: e.message }); }
}

send({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'plain-node-agent', version: '1.0.0', framework: 'plain-node', model: 'fake-llm' }, capabilities: ['multi_turn', 'hitl_structured'] });
createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  if (m.type === 'tool_result') { waiting.get(m.call_id)?.(m); waiting.delete(m.call_id); return; } // not queued: the running turn awaits it
  chain = chain.then(() => onMessage(m));
});
