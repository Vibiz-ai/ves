"""ves-agent/1 bridge for LangGraph / LangChain (Python). Copy to ves/bridge.py; connection: command ["python", "ves/bridge.py"].

Written against langgraph + langchain-mcp-adapters (API names per their docs as of 2026-11; not installed or
checked here). Tools come from the VES proxy over MCP (MultiServerMCPClient, streamable_http). The graph's own
`interrupt()` is the approval point: an interrupt becomes hitl.request; the decision resumes with Command(resume=...).
"""
import asyncio, json, sys
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from my_app.graph import build_graph  # YOUR factory: build_graph(tools, checkpointer) -> compiled graph (prod prompt/model/interrupts)


def send(m): sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()


class Session:
    def __init__(self, m):
        self.id = m["session_id"]
        self.mcp = MultiServerMCPClient({"ves": {"url": m["tool_transport"]["mcp"]["url"], "transport": "streamable_http"}})
        self.config = {"configurable": {"thread_id": self.id}}
        self.graph = None

    async def start(self):
        self.graph = build_graph(await self.mcp.get_tools(), InMemorySaver())

    async def finish(self, out, turn_id):
        interrupts = out.get("__interrupt__") or []
        if interrupts:  # e.g. interrupt({"tool": name, "args": args, "prompt": ...}) inside a gated tool node
            v = interrupts[0].value if isinstance(interrupts[0].value, dict) else {"prompt": str(interrupts[0].value)}
            send({"type": "hitl.request", "session_id": self.id, "request_id": f"{turn_id}-i", "tool": v.get("tool", ""), "args": v.get("args", {}), "prompt": v.get("prompt")})
            return "awaiting_hitl"
        last = out["messages"][-1]
        send({"type": "message", "session_id": self.id, "text": last.content if isinstance(last.content, str) else json.dumps(last.content)})
        u = getattr(last, "usage_metadata", None)
        if u:
            send({"type": "usage", "session_id": self.id, "input_tokens": u.get("input_tokens", 0), "output_tokens": u.get("output_tokens", 0)})
        return "done"

    async def turn(self, m):
        return await self.finish(await self.graph.ainvoke({"messages": [("user", m["text"])]}, self.config), m["turn_id"])

    async def decide(self, m):
        # pass the decision through unchanged; your interrupt handler decides what "approve" means (as prod does)
        resume = {"decision": m["decision"], "by": m["as"], "text": m.get("text")}
        return await self.finish(await self.graph.ainvoke(Command(resume=resume), self.config), m["request_id"])


async def main():
    loop = asyncio.get_running_loop()
    send({"type": "ready", "protocol": "ves-agent/1", "agent": {"name": "my-graph", "framework": "langgraph"}, "capabilities": ["multi_turn", "hitl_structured"]})
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
            await sessions[sid].start()
            send({"type": "session.opened", "session_id": sid})
        elif t == "session.close":
            sessions.pop(sid, None)
        elif t in ("turn", "hitl.decision"):
            tid = m.get("turn_id") or m.get("request_id")
            try:
                reason = await (sessions[sid].turn(m) if t == "turn" else sessions[sid].decide(m))
                send({"type": "turn.end", "session_id": sid, "turn_id": tid, "reason": reason})
            except Exception as e:
                send({"type": "turn.end", "session_id": sid, "turn_id": tid, "reason": "error", "error": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
