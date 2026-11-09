"""ves-agent/1 bridge for the OpenAI Agents SDK (Python). Copy to ves/bridge.py; connection: command ["python", "ves/bridge.py"].

Written against openai-agents (API names per the SDK docs as of 2026-11; not installed or checked here, so pin and
verify in your lockfile). Tools come from the VES proxy over MCP, so every call is recorded by the harness. Your
agent's own approval policy (`needs_approval`) maps onto hitl.request; resume with state.approve()/state.reject().
Optional: add_trace_processor(VesTraceProcessor(...)) (ves_trace_processor.py) for `traced` evidence.
"""
import asyncio, json, sys
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

from my_app.agent import build_agent  # YOUR factory: build_agent(mcp_servers=[...]) -> Agent (same prompt/model/policy as prod)


def send(m): sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()


async def messages():
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        if line.strip():
            yield json.loads(line)


class Session:
    def __init__(self, m):
        self.id = m["session_id"]
        self.mcp = MCPServerStreamableHttp(name="ves", params={"url": m["tool_transport"]["mcp"]["url"]}, cache_tools_list=True)
        self.agent: Agent = None
        self.history = []
        self.state = None
        self.pending = {}  # request_id -> interruption item

    async def start(self):
        await self.mcp.connect()
        self.agent = build_agent(mcp_servers=[self.mcp])

    async def finish(self, result, turn_id):
        if result.interruptions:  # tools whose needs_approval fired: ask the harness
            self.state = result.to_state()
            for i, item in enumerate(result.interruptions):
                rid = f"{turn_id}-a{i}"
                self.pending[rid] = item
                send({"type": "hitl.request", "session_id": self.id, "request_id": rid, "tool": item.raw_item.name, "args": json.loads(item.raw_item.arguments or "{}")})
            return "awaiting_hitl"
        self.history = result.to_input_list()
        send({"type": "message", "session_id": self.id, "text": str(result.final_output)})
        for r in result.raw_responses:
            u = r.usage
            send({"type": "usage", "session_id": self.id, "input_tokens": u.input_tokens, "output_tokens": u.output_tokens})
        return "done"

    async def turn(self, m):
        result = await Runner.run(self.agent, self.history + [{"role": "user", "content": m["text"]}])
        return await self.finish(result, m["turn_id"])

    async def decide(self, m):
        item = self.pending.pop(m["request_id"], None)
        if item is None:
            return "done"
        (self.state.approve if m["decision"] == "approve" else self.state.reject)(item)
        if self.pending:  # several approvals in one step: wait for all decisions
            return "awaiting_hitl"
        return await self.finish(await Runner.run(self.agent, self.state), m["request_id"])


async def main():
    send({"type": "ready", "protocol": "ves-agent/1", "agent": {"name": "my-agent", "framework": "openai-agents"}, "capabilities": ["multi_turn", "hitl_structured"]})
    sessions = {}
    async for m in messages():
        t, sid = m.get("type"), m.get("session_id")
        if t == "shutdown":
            return
        if t == "session.open":
            sessions[sid] = Session(m)
            await sessions[sid].start()
            send({"type": "session.opened", "session_id": sid})
        elif t == "session.close" and sid in sessions:
            await sessions.pop(sid).mcp.cleanup()
        elif t in ("turn", "hitl.decision"):
            tid = m.get("turn_id") or m.get("request_id")
            try:
                reason = await (sessions[sid].turn(m) if t == "turn" else sessions[sid].decide(m))
                send({"type": "turn.end", "session_id": sid, "turn_id": tid, "reason": reason})
            except Exception as e:
                send({"type": "turn.end", "session_id": sid, "turn_id": tid, "reason": "error", "error": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
