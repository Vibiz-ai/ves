// ves-agent/1 bridge for the Vercel AI SDK. Copy to ves/bridge.ts; connection: command ["node", "ves/bridge.ts"].
// Written against ai (API names per the AI SDK docs as of 2026-11; not installed or checked here). Tools are the
// harness tools, wrapped with `tool({ inputSchema: jsonSchema(...), execute })` whose execute sends `tool_call` on the
// pipe (no MCP client needed). If your production tools use AI SDK 6 `needsApproval`, map that instead; here the
// gated check calls YOUR production policy `needsApproval(name)`, and an approval suspends the run until hitl.decision.
// (Alternative: experimental_createMCPClient({ transport: { type: 'http', url: tool_transport.mcp.url } }).)
import { createInterface } from 'node:readline';
import { generateText, jsonSchema, stepCountIs, tool, type ModelMessage } from 'ai';
import { model, SYSTEM_PROMPT, needsApproval } from '../src/agent.ts'; // YOUR model, prompt and approval policy

const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
type S = { id: string; specs: any[]; history: ModelMessage[]; turnId: string; n: number; waiting: Map<string, (m: any) => void> };
const sessions = new Map<string, S>();
const wait = (s: S, key: string) => new Promise<any>((res) => s.waiting.set(key, res));

function toolsFor(s: S) {
  return Object.fromEntries(s.specs.map((spec) => [spec.name, tool({
    description: spec.description ?? spec.name,
    inputSchema: jsonSchema(spec.input_schema),
    execute: async (args: Record<string, unknown>) => {
      if (needsApproval(spec.name)) {
        const rid = `r${++s.n}`;
        const d = wait(s, rid);
        send({ type: 'hitl.request', session_id: s.id, request_id: rid, tool: spec.name, args });
        send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'awaiting_hitl' });
        s.turnId = rid;
        if ((await d).decision !== 'approve') return { error: 'user_denied' };
      }
      const call_id = `c${++s.n}`;
      const r = wait(s, call_id);
      send({ type: 'tool_call', session_id: s.id, call_id, name: spec.name, args }); // the harness proxy executes and records it
      const res = await r;
      return res.ok ? res.result : { error: res.error };
    },
  })]));
}

async function runTurn(s: S, text: string, turnId: string): Promise<void> {
  s.turnId = turnId;
  try {
    s.history.push({ role: 'user', content: text });
    const r = await generateText({ model, system: SYSTEM_PROMPT, messages: s.history, tools: toolsFor(s), stopWhen: stepCountIs(20) });
    s.history.push(...r.response.messages);
    send({ type: 'message', session_id: s.id, text: r.text });
    send({ type: 'usage', session_id: s.id, input_tokens: r.totalUsage.inputTokens ?? 0, output_tokens: r.totalUsage.outputTokens ?? 0 });
    send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'done' });
  } catch (e) { send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'error', error: (e as Error).message }); }
}

send({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'my-agent', framework: 'vercel-ai-sdk' }, capabilities: ['multi_turn', 'hitl_structured'] });
createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  const s = sessions.get(m.session_id);
  if (m.type === 'session.open') { sessions.set(m.session_id, { id: m.session_id, specs: m.tools, history: [], turnId: '', n: 0, waiting: new Map() }); send({ type: 'session.opened', session_id: m.session_id }); }
  else if (m.type === 'turn' && s) void runTurn(s, m.text, m.turn_id);
  else if (m.type === 'tool_result' && s) { s.waiting.get(m.call_id)?.(m); s.waiting.delete(m.call_id); }
  else if (m.type === 'hitl.decision' && s) { s.waiting.get(m.request_id)?.(m); s.waiting.delete(m.request_id); }
  else if (m.type === 'session.close') sessions.delete(m.session_id);
  else if (m.type === 'shutdown') process.exit(0);
});
