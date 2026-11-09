#!/usr/bin/env node
// A stand-in OpenAI-compatible /v1/chat/completions endpoint for the `openai-chat` example, so the example runs with no
// network and no API key: `node examples/openai-compatible/fake-endpoint.mjs --port 4000`. In real use this is your
// agent server, LiteLLM, vLLM, Ollama or a gateway, and you delete this file.
//
// It behaves like a small tool-calling model (stateless; it reads only the request's messages and tools):
//   - the latest user message picks a rule in examples/fixtures/support-desk.fake-llm.json (or VES_FAKE_LLM_RULES);
//   - a rule's tool call that the system prompt says to "ask before" (refunds, emails, deletions) goes through the
//     approval function the harness offers (`ves_request_approval`, connection.hitl.request_tool), and runs only after
//     an owner approval from this conversation's thread with unchanged details;
//   - VES_DEMO_UNSAFE=1 skips the approval step, to watch the harness block at G-3.
// The harness executes every tool call itself (connection.tools "harness"), so the proxy records them all.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const RULES = JSON.parse(readFileSync(process.env.VES_FAKE_LLM_RULES ?? new URL('../fixtures/support-desk.fake-llm.json', import.meta.url), 'utf8'));
const UNSAFE = process.env.VES_DEMO_UNSAFE === '1';
const APPROVAL = 'ves_request_approval';
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || process.env.PORT || 4000);

/** Which tools the system prompt says to ask about, e.g. "Ask before refunds, emails and deletions." */
function askFirst(system) {
  const m = /ask before ([^.]+)/i.exec(system ?? '');
  if (!m) return () => false;
  const words = m[1].split(/,|\band\b/).map((w) => w.trim().toLowerCase().replace(/s$/, '').replace(/ion$/, '').replace(/e$/, '')).filter(Boolean);
  return (tool) => words.some((w) => tool.toLowerCase().includes(w));
}

let n = 0;
const call = (name, args) => ({ id: `call_${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content) => ({ role: 'assistant', content });

function complete(body) {
  const messages = body.messages ?? [];
  const offered = new Set((body.tools ?? []).map((t) => t.function?.name));
  const ask = askFirst(messages.find((m) => m.role === 'system')?.content);
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  const rule = RULES.rules.find((r) => new RegExp(r.when, 'i').test(String(messages[lastUserIdx]?.content ?? '')));
  const last = messages.at(-1);
  if (last?.role === 'user') {
    const calls = (rule?.tool_calls ?? []).filter((c) => offered.has(c.name));
    if (!calls.length) return reply(rule?.reply ?? RULES.fallback);
    const first = calls[0];
    if (!UNSAFE && ask(first.name) && offered.has(APPROVAL)) return { role: 'assistant', content: null, tool_calls: [call(APPROVAL, { tool: first.name, args: first.args, prompt: `May I run ${first.name}?` })] };
    return { role: 'assistant', content: null, tool_calls: calls.map((c) => call(c.name, c.args)) };
  }
  if (last?.role === 'tool') {
    // the tool message answers the assistant call just before it
    const asked = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.id === last.tool_call_id));
    const tc = asked?.tool_calls?.find((c) => c.id === last.tool_call_id);
    if (tc?.function?.name === APPROVAL) {
      let d = {};
      try { d = JSON.parse(last.content); } catch { /* not a decision */ }
      const req = JSON.parse(tc.function.arguments);
      const ok = d.decision === 'approve' && d.by === 'owner' && (d.thread === undefined || d.thread === 'thread-main') && !/changed the details/.test(d.note ?? '');
      return ok ? { role: 'assistant', content: null, tool_calls: [call(req.tool, req.args)] } : reply(RULES.declined);
    }
    return reply(rule?.reply ?? RULES.fallback);
  }
  return reply(RULES.fallback);
}

createServer((req, res) => {
  if (req.method === 'GET' && /\/v1\/models$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'support-agent' }] })); return; }
  if (req.method !== 'POST' || !/\/v1\/chat\/completions$/.test(req.url)) { res.writeHead(404); res.end(); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"error":"bad json"}'); return; }
    const message = complete(body);
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(JSON.stringify(message).length / 4) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `chatcmpl-${n}`, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage }));
  });
}).listen(port, '127.0.0.1', () => process.stderr.write(`fake OpenAI-compatible endpoint on http://127.0.0.1:${port}/v1\n`));
