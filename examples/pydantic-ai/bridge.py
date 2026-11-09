"""ves-agent/1 bridge for Pydantic AI. Copy to ves/bridge.py; connection: command ["python", "ves/bridge.py"].

Written against pydantic-ai (API names per its docs as of 2026-11; not installed or checked here). Tools come from
the VES proxy as an MCPServerStreamableHTTP toolset. Your approval-required tools (deferred tools, e.g.
`toolset.approval_required(...)`) end a run with DeferredToolRequests: each approval becomes hitl.request, and the
decisions resume the run with DeferredToolResults.
"""
import asyncio, json, sys
from pydantic_ai import DeferredToolRequests, DeferredToolResults, ToolDenied
from pydantic_ai.mcp import MCPServerStreamableHTTP

from my_app.agent import build_agent  # YOUR factory: build_agent(toolsets=[...]) -> Agent(output_type=[str, DeferredToolRequests])


def send(m): sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()


class Session:
    def __init__(self, m):
        self.id = m["session_id"]
        self.agent = build_agent(toolsets=[MCPServerStreamableHTTP(m["tool_transport"]["mcp"]["url"])])
        self.history, self.pending, self.decided = [], {}, {}

    def finish(self, result):
        self.history = result.all_messages()
        u = result.usage()
        send({"type": "usage", "session_id": self.id, "input_tokens": u.input_tokens or 0, "output_tokens": u.output_tokens or 0})
        if isinstance(result.output, DeferredToolRequests):
            for call in result.output.approvals:
                self.pending[call.tool_call_id] = call
                send({"type": "hitl.request", "session_id": self.id, "request_id": call.tool_call_id, "tool": call.tool_name, "args": call.args_as_dict()})
            return "awaiting_hitl"
        send({"type": "message", "session_id": self.id, "text": str(result.output)})
        return "done"

    async def turn(self, m):
        return self.finish(await self.agent.run(m["text"], message_history=self.history))

    async def decide(self, m):
        if self.pending.pop(m["request_id"], None) is None:
            return "done"
        self.decided[m["request_id"]] = True if m["decision"] == "approve" else ToolDenied("The user did not approve this action.")
        if self.pending:
            return "awaiting_hitl"
        results, self.decided = DeferredToolResults(approvals=self.decided), {}
        return self.finish(await self.agent.run(message_history=self.history, deferred_tool_results=results))


async def main():
    loop = asyncio.get_running_loop()
    send({"type": "ready", "protocol": "ves-agent/1", "agent": {"name": "my-agent", "framework": "pydantic-ai"}, "capabilities": ["multi_turn", "hitl_structured"]})
    sessions = {}
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        if not line.strip():
            continue
        m = json.loads(line)
        t, sid = m.get("type"), m.get("session_id")
        if t == "shutdown":
            return
        if t == "session.open":
            sessions[sid] = Session(m)
            send({"type": "session.opened", "session_id": sid})
        elif t == "session.close":
            sessions.pop(sid, None)
        elif t in ("turn", "hitl.decision"):
            tid = m.get("turn_id") or m.get("request_id")
            try:
                async with sessions[sid].agent:  # opens the MCP toolset for this run
                    reason = await (sessions[sid].turn(m) if t == "turn" else sessions[sid].decide(m))
                send({"type": "turn.end", "session_id": sid, "turn_id": tid, "reason": reason})
            except Exception as e:
                send({"type": "turn.end", "session_id": sid, "turn_id": tid, "reason": "error", "error": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
