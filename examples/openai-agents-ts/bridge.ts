// ves-agent/1 bridge for the OpenAI Agents SDK (TypeScript). Copy to ves/bridge.ts; connection: command ["node", "ves/bridge.ts"].
// Written against @openai/agents (API names per the SDK docs as of 2026-11; not installed or checked here).
// Tools come from the VES proxy over MCP (MCPServerStreamableHttp); your tools' `needsApproval` interruptions map onto
// hitl.request, and decisions resume with state.approve() / state.reject().
import { createInterface } from 'node:readline';
import { run, MCPServerStreamableHttp, type RunResult } from '@openai/agents';
import { buildAgent } from '../src/agent.ts'; // YOUR factory: buildAgent({ mcpServers }) -> Agent (prod prompt, model, policy)

const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
type S = { id: string; mcp: MCPServerStreamableHttp; agent: ReturnType<typeof buildAgent>; history: any[]; result?: RunResult<any, any>; pending: Map<string, any> };
const sessions = new Map<string, S>();

async function finish(s: S, result: RunResult<any, any>, turnId: string): Promise<string> {
  s.result = result;
  if (result.interruptions?.length) {
    result.interruptions.forEach((item: any, i: number) => {
      const rid = `${turnId}-a${i}`;
      s.pending.set(rid, item);
      send({ type: 'hitl.request', session_id: s.id, request_id: rid, tool: item.rawItem.name, args: JSON.parse(item.rawItem.arguments ?? '{}') });
    });
    return 'awaiting_hitl';
  }
  s.history = result.history;
  send({ type: 'message', session_id: s.id, text: String(result.finalOutput ?? '') });
  const u = result.state.usage;
  send({ type: 'usage', session_id: s.id, input_tokens: u.inputTokens, output_tokens: u.outputTokens });
  return 'done';
}

async function onMessage(m: any): Promise<void> {
  const s = sessions.get(m.session_id);
  const id = m.turn_id ?? m.request_id;
  try {
    if (m.type === 'session.open') {
      const mcp = new MCPServerStreamableHttp({ name: 'ves', url: m.tool_transport.mcp.url });
      await mcp.connect();
      sessions.set(m.session_id, { id: m.session_id, mcp, agent: buildAgent({ mcpServers: [mcp] }), history: [], pending: new Map() });
      send({ type: 'session.opened', session_id: m.session_id });
    } else if (m.type === 'turn' && s) {
      const input = [...s.history, { role: 'user', content: m.text }];
      send({ type: 'turn.end', session_id: s.id, turn_id: id, reason: await finish(s, await run(s.agent, input), id) });
    } else if (m.type === 'hitl.decision' && s) {
      const item = s.pending.get(m.request_id);
      s.pending.delete(m.request_id);
      if (item) (m.decision === 'approve' ? s.result!.state.approve(item) : s.result!.state.reject(item));
      const reason = s.pending.size ? 'awaiting_hitl' : await finish(s, await run(s.agent, s.result!.state), id);
      send({ type: 'turn.end', session_id: s.id, turn_id: id, reason });
    } else if (m.type === 'session.close' && s) { await s.mcp.close(); sessions.delete(s.id); }
    else if (m.type === 'shutdown') process.exit(0);
  } catch (e) { if (s && id) send({ type: 'turn.end', session_id: s.id, turn_id: id, reason: 'error', error: (e as Error).message }); }
}

send({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'my-agent', framework: 'openai-agents' }, capabilities: ['multi_turn', 'hitl_structured'] });
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (l) => { if (l.trim()) { const m = JSON.parse(l); chain = chain.then(() => onMessage(m)); } });
