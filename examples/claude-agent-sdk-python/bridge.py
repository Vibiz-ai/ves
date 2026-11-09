"""ves-agent/1 bridge for the Claude Agent SDK (Python). Copy to ves/bridge.py; connection: command ["python", "ves/bridge.py"].

Written against claude-agent-sdk (API names per the SDK docs as of 2026-11; not installed or checked here).
Tools come from the VES proxy over MCP (`mcp_servers={"ves": {"type": "http", "url": ...}}`). The SDK's permission
callback `can_use_tool` is the agent's approval point: it emits hitl.request, ends the turn as awaiting_hitl and
suspends the run until the harness sends hitl.decision.
"""
import asyncio, json, sys
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, PermissionResultAllow, PermissionResultDeny

from my_app.agent import SYSTEM_PROMPT, needs_approval  # YOUR prompt and YOUR production approval policy


def send(m): sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()


class Session:
    def __init__(self, m):
        self.id, self.turn_id, self.waiting = m["session_id"], None, {}
        self.client = ClaudeSDKClient(ClaudeAgentOptions(
            system_prompt=SYSTEM_PROMPT, mcp_servers={"ves": {"type": "http", "url": m["tool_transport"]["mcp"]["url"]}},
            allowed_tools=[f"mcp__ves__{t['name']}" for t in m["tools"]], can_use_tool=self.can_use_tool))

    async def can_use_tool(self, tool_name, tool_input, context):
        name = tool_name.removeprefix("mcp__ves__")
        if not needs_approval(name):
            return PermissionResultAllow(updated_input=tool_input)
        rid = f"r{len(self.waiting) + 1}"
        fut = asyncio.get_running_loop().create_future()
        self.waiting[rid] = fut
        send({"type": "hitl.request", "session_id": self.id, "request_id": rid, "tool": name, "args": tool_input})
        send({"type": "turn.end", "session_id": self.id, "turn_id": self.turn_id, "reason": "awaiting_hitl"})
        self.turn_id = rid  # the run continues as the decision's turn
        d = await fut
        if d["decision"] == "approve":
            return PermissionResultAllow(updated_input=tool_input)
        return PermissionResultDeny(message="The user did not approve this action.")

    async def run_turn(self, text, turn_id):
        self.turn_id = turn_id
        try:
            await self.client.query(text)
            async for msg in self.client.receive_response():
                if type(msg).__name__ == "ResultMessage":
                    send({"type": "message", "session_id": self.id, "text": msg.result or ""})
                    if msg.usage:
                        send({"type": "usage", "session_id": self.id, "input_tokens": msg.usage.get("input_tokens", 0), "output_tokens": msg.usage.get("output_tokens", 0), "usd": msg.total_cost_usd or 0})
            send({"type": "turn.end", "session_id": self.id, "turn_id": self.turn_id, "reason": "done"})
        except Exception as e:
            send({"type": "turn.end", "session_id": self.id, "turn_id": self.turn_id, "reason": "error", "error": str(e)})


async def main():
    loop = asyncio.get_running_loop()
    send({"type": "ready", "protocol": "ves-agent/1", "agent": {"name": "my-agent", "framework": "claude-agent-sdk"}, "capabilities": ["multi_turn", "hitl_structured"]})
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
            await sessions[sid].client.connect()
            send({"type": "session.opened", "session_id": sid})
        elif t == "turn":
            asyncio.create_task(sessions[sid].run_turn(m["text"], m["turn_id"]))  # runs while decisions arrive
        elif t == "hitl.decision":
            fut = sessions[sid].waiting.pop(m["request_id"], None)
            if fut:
                fut.set_result(m)
        elif t == "session.close" and sid in sessions:
            await sessions.pop(sid).client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
