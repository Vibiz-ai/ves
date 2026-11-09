// ves-agent/1 bridge for Mastra. Copy to ves/bridge.ts; connection: command ["node", "ves/bridge.ts"] (or expose the
// same routes from your Mastra server and use the `http` connector). Written against @mastra/core + @mastra/mcp
// (API names per the Mastra docs as of 2026-11; not installed or checked here). Tools come from the VES proxy over
// MCP (MCPClient). Your approval step (tool approval / workflow suspend) calls `askApproval()`, which emits
// hitl.request, ends the turn as awaiting_hitl and resolves on hitl.decision.
import { createInterface } from 'node:readline';
import { MCPClient } from '@mastra/mcp';
import { buildAgent } from '../src/mastra/agent.ts'; // YOUR factory: buildAgent(tools, askApproval) -> Agent (prod prompt/model/policy)

const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
type S = { id: string; mcp: MCPClient; agent: any; turnId: string; n: number; waiting: Map<string, (d: any) => void>; history: any[] };
const sessions = new Map<string, S>();

function askApprovalFor(s: S) {
  return (tool: string, args: Record<string, unknown>, prompt?: string): Promise<boolean> => {
    const rid = `r${++s.n}`;
    const p = new Promise<any>((res) => s.waiting.set(rid, res));
    send({ type: 'hitl.request', session_id: s.id, request_id: rid, tool, args, prompt });
    send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'awaiting_hitl' });
    s.turnId = rid;
    return p.then((d) => d.decision === 'approve');
  };
}

async function runTurn(s: S, text: string, turnId: string): Promise<void> {
  s.turnId = turnId;
  try {
    s.history.push({ role: 'user', content: text });
    const r = await s.agent.generate(s.history, { maxSteps: 20 });
    s.history.push({ role: 'assistant', content: r.text });
    send({ type: 'message', session_id: s.id, text: r.text });
    if (r.usage) send({ type: 'usage', session_id: s.id, input_tokens: r.usage.inputTokens ?? r.usage.promptTokens ?? 0, output_tokens: r.usage.outputTokens ?? r.usage.completionTokens ?? 0 });
    send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'done' });
  } catch (e) { send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'error', error: (e as Error).message }); }
}

send({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'my-agent', framework: 'mastra' }, capabilities: ['multi_turn', 'hitl_structured'] });
createInterface({ input: process.stdin }).on('line', async (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  const s = sessions.get(m.session_id);
  if (m.type === 'session.open') {
    const mcp = new MCPClient({ servers: { ves: { url: new URL(m.tool_transport.mcp.url) } } });
    const sess: S = { id: m.session_id, mcp, agent: null, turnId: '', n: 0, waiting: new Map(), history: [] };
    sess.agent = buildAgent(await mcp.getTools(), askApprovalFor(sess));
    sessions.set(m.session_id, sess);
    send({ type: 'session.opened', session_id: m.session_id });
  } else if (m.type === 'turn' && s) void runTurn(s, m.text, m.turn_id);
  else if (m.type === 'hitl.decision' && s) { s.waiting.get(m.request_id)?.(m); s.waiting.delete(m.request_id); }
  else if (m.type === 'session.close' && s) { await s.mcp.disconnect(); sessions.delete(s.id); }
  else if (m.type === 'shutdown') process.exit(0);
});
