// ves-agent/1 bridge for LangGraph.js. Copy to ves/bridge.ts; connection: command ["node", "ves/bridge.ts"].
// Written against @langchain/langgraph + @langchain/mcp-adapters (API names per their docs as of 2026-11; not
// installed or checked here). Tools come from the VES proxy over MCP; your graph's `interrupt()` is the approval
// point: an interrupt becomes hitl.request, and the decision resumes with `new Command({ resume })`.
import { createInterface } from 'node:readline';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { Command, MemorySaver } from '@langchain/langgraph';
import { buildGraph } from '../src/graph.ts'; // YOUR factory: buildGraph(tools, checkpointer) -> compiled graph (prod prompt/model/interrupts)

const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
type S = { id: string; mcp: MultiServerMCPClient; graph: any; config: { configurable: { thread_id: string } } };
const sessions = new Map<string, S>();

async function finish(s: S, out: any, turnId: string): Promise<string> {
  const intr = out.__interrupt__ ?? [];
  if (intr.length) { // e.g. interrupt({ tool, args, prompt }) inside a gated tool node
    const v = typeof intr[0].value === 'object' ? intr[0].value : { prompt: String(intr[0].value) };
    send({ type: 'hitl.request', session_id: s.id, request_id: `${turnId}-i`, tool: v.tool ?? '', args: v.args ?? {}, prompt: v.prompt });
    return 'awaiting_hitl';
  }
  const last = out.messages.at(-1);
  send({ type: 'message', session_id: s.id, text: typeof last.content === 'string' ? last.content : JSON.stringify(last.content) });
  if (last.usage_metadata) send({ type: 'usage', session_id: s.id, input_tokens: last.usage_metadata.input_tokens, output_tokens: last.usage_metadata.output_tokens });
  return 'done';
}

async function onMessage(m: any): Promise<void> {
  const s = sessions.get(m.session_id);
  const id = m.turn_id ?? m.request_id;
  try {
    if (m.type === 'session.open') {
      const mcp = new MultiServerMCPClient({ mcpServers: { ves: { url: m.tool_transport.mcp.url, transport: 'http' } } });
      sessions.set(m.session_id, { id: m.session_id, mcp, graph: buildGraph(await mcp.getTools(), new MemorySaver()), config: { configurable: { thread_id: m.session_id } } });
      send({ type: 'session.opened', session_id: m.session_id });
    } else if (m.type === 'turn' && s) {
      send({ type: 'turn.end', session_id: s.id, turn_id: id, reason: await finish(s, await s.graph.invoke({ messages: [{ role: 'user', content: m.text }] }, s.config), id) });
    } else if (m.type === 'hitl.decision' && s) {
      const resume = { decision: m.decision, by: m.as, text: m.text }; // your interrupt handler decides, as in prod
      send({ type: 'turn.end', session_id: s.id, turn_id: id, reason: await finish(s, await s.graph.invoke(new Command({ resume }), s.config), id) });
    } else if (m.type === 'session.close' && s) { await s.mcp.close(); sessions.delete(s.id); }
    else if (m.type === 'shutdown') process.exit(0);
  } catch (e) { if (s && id) send({ type: 'turn.end', session_id: s.id, turn_id: id, reason: 'error', error: (e as Error).message }); }
}

send({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'my-graph', framework: 'langgraph' }, capabilities: ['multi_turn', 'hitl_structured'] });
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (l) => { if (l.trim()) { const m = JSON.parse(l); chain = chain.then(() => onMessage(m)); } });
