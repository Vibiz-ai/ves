"""ves-agent/1 bridge for CrewAI. Copy to ves/bridge.py; connection: command ["python", "ves/bridge.py"].

Written against crewai + crewai-tools (MCPServerAdapter) (API names per their docs as of 2026-11; not installed or
checked here). Tools come from the VES proxy over MCP. CrewAI runs synchronously, so each turn runs in a worker
thread; your approval step (the gated-tool check your crew already has) calls `ask_approval()`, which emits
hitl.request, ends the turn as awaiting_hitl and blocks the crew until the harness sends hitl.decision.
"""
import json, sys, threading, queue
from crewai_tools import MCPServerAdapter

from my_app.crew import build_crew, needs_approval  # YOUR factory build_crew(tools, ask_approval) and YOUR policy

out_lock = threading.Lock()
def send(m):
    with out_lock:
        sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()


class Session:
    def __init__(self, m):
        self.id, self.turn_id, self.n = m["session_id"], None, 0
        self.decisions = queue.Queue()
        self.mcp = MCPServerAdapter({"url": m["tool_transport"]["mcp"]["url"], "transport": "streamable-http"})
        self.tools = self.mcp.__enter__()
        self.crew = build_crew(self.tools, self.ask_approval)

    def ask_approval(self, tool, args, prompt=None):
        """Call this from your gated-tool step; True only on an approve decision."""
        if not needs_approval(tool):
            return True
        self.n += 1
        rid = f"r{self.n}"
        send({"type": "hitl.request", "session_id": self.id, "request_id": rid, "tool": tool, "args": args, "prompt": prompt})
        send({"type": "turn.end", "session_id": self.id, "turn_id": self.turn_id, "reason": "awaiting_hitl"})
        self.turn_id = rid
        d = self.decisions.get()
        return d["decision"] == "approve"

    def run_turn(self, text, turn_id):
        self.turn_id = turn_id
        try:
            out = self.crew.kickoff(inputs={"request": text})
            send({"type": "message", "session_id": self.id, "text": str(out.raw)})
            u = getattr(out, "token_usage", None)
            if u:
                send({"type": "usage", "session_id": self.id, "input_tokens": u.prompt_tokens, "output_tokens": u.completion_tokens})
            send({"type": "turn.end", "session_id": self.id, "turn_id": self.turn_id, "reason": "done"})
        except Exception as e:
            send({"type": "turn.end", "session_id": self.id, "turn_id": self.turn_id, "reason": "error", "error": str(e)})


def main():
    send({"type": "ready", "protocol": "ves-agent/1", "agent": {"name": "my-crew", "framework": "crewai"}, "capabilities": ["hitl_structured"]})
    sessions = {}
    for line in sys.stdin:
        if not line.strip():
            continue
        m = json.loads(line)
        t, sid = m.get("type"), m.get("session_id")
        if t == "shutdown":
            return
        if t == "session.open":
            sessions[sid] = Session(m)
            send({"type": "session.opened", "session_id": sid})
        elif t == "turn":
            threading.Thread(target=sessions[sid].run_turn, args=(m["text"], m["turn_id"]), daemon=True).start()
        elif t == "hitl.decision":
            sessions[sid].decisions.put(m)
        elif t == "session.close" and sid in sessions:
            sessions.pop(sid).mcp.__exit__(None, None, None)


if __name__ == "__main__":
    main()
