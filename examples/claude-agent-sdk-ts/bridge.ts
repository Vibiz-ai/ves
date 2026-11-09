// ves-agent/1 bridge for the Claude Agent SDK (TypeScript). Copy to ves/bridge.ts; connection: command ["node", "ves/bridge.ts"].
// Written against @anthropic-ai/claude-agent-sdk (API names per the SDK docs as of 2026-11; not installed or checked here).
// Tools come from the VES proxy over MCP (`mcpServers: { ves: { type: "http", url } }`). `canUseTool` is the agent's
// approval point: it emits hitl.request, ends the turn as awaiting_hitl and suspends the run until hitl.decision.
import { createInterface } from 'node:readline';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SYSTEM_PROMPT, needsApproval } from '../src/agent.ts'; // YOUR prompt and YOUR production approval policy

const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
type S = { id: string; url: string; tools: string[]; turnId: string; resume?: string; waiting: Map<string, (d: any) => void>; n: number };
const sessions = new Map<string, S>();

async function runTurn(s: S, text: string, turnId: string): Promise<void> {
  s.turnId = turnId;
  try {
    for await (const msg of query({ prompt: text, options: {
      systemPrompt: SYSTEM_PROMPT, mcpServers: { ves: { type: 'http', url: s.url } }, allowedTools: s.tools.map((t) => `mcp__ves__${t}`),
      ...(s.resume ? { resume: s.resume } : {}),
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        const tool = toolName.replace(/^mcp__ves__/, '');
        if (!needsApproval(tool)) return { behavior: 'allow', updatedInput: input };
        const rid = `r${++s.n}`;
        const decision = new Promise<any>((res) => s.waiting.set(rid, res));
        send({ type: 'hitl.request', session_id: s.id, request_id: rid, tool, args: input });
        send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'awaiting_hitl' });
        s.turnId = rid; // the run continues as the decision's turn
        const d = await decision;
        return d.decision === 'approve' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user did not approve this action.' };
      },
    } })) {
      if (msg.type === 'system' && msg.subtype === 'init') s.resume = msg.session_id;
      if (msg.type === 'result') {
        if (msg.subtype === 'success') send({ type: 'message', session_id: s.id, text: msg.result });
        send({ type: 'usage', session_id: s.id, input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, usd: msg.total_cost_usd });
      }
    }
    send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'done' });
  } catch (e) { send({ type: 'turn.end', session_id: s.id, turn_id: s.turnId, reason: 'error', error: (e as Error).message }); }
}

send({ type: 'ready', protocol: 'ves-agent/1', agent: { name: 'my-agent', framework: 'claude-agent-sdk' }, capabilities: ['multi_turn', 'hitl_structured'] });
createInterface({ input: process.stdin }).on('line', (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  const s = sessions.get(m.session_id);
  if (m.type === 'session.open') {
    sessions.set(m.session_id, { id: m.session_id, url: m.tool_transport.mcp.url, tools: m.tools.map((t: any) => t.name), turnId: '', waiting: new Map(), n: 0 });
    send({ type: 'session.opened', session_id: m.session_id });
  } else if (m.type === 'turn' && s) void runTurn(s, m.text, m.turn_id); // keeps running while decisions arrive
  else if (m.type === 'hitl.decision' && s) { s.waiting.get(m.request_id)?.(m); s.waiting.delete(m.request_id); }
  else if (m.type === 'session.close') sessions.delete(m.session_id);
  else if (m.type === 'shutdown') process.exit(0);
});
