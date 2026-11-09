#!/usr/bin/env python3
"""A plain-Python tool-using agent speaking ves-agent/1 over stdin/stdout (the `command` connector).

No framework, no dependencies, Python >= 3.8. It runs out of the box with a deterministic FakeLLM (no network, no API
key) so `ves run` works on a fresh checkout; swap FakeLLM for your model client (OpenAI, Vertex, Anthropic, ...) to
evaluate your real agent. The structure is the usual agent loop:

    user text -> model -> tool calls? -> (approval if the tool is gated) -> tool results -> model -> reply

Tools are NOT implemented here: every call goes to the harness as a `tool_call` and comes back as a `tool_result`
(the harness tool proxy records it; the agent's own claims are never graded). The HITL policy is this agent's own:
a gated tool needs an approval from the owner first. Set VES_DEMO_UNSAFE=1 to see the gate block a bypass.

    ves.config.json:  "connection": { "type": "command", "command": ["python3", "examples/plain-python/agent.py"] }
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RULES = os.environ.get("VES_FAKE_LLM_RULES", os.path.join(HERE, "..", "fixtures", "support-desk.fake-llm.json"))
UNSAFE = os.environ.get("VES_DEMO_UNSAFE") == "1"
MAX_STEPS = 8


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


class FakeLLM:
    """Deterministic stand-in for a chat model with tool calling (OpenAI-style messages in, one message out)."""

    def __init__(self, path):
        with open(path) as f:
            spec = json.load(f)
        self.rules, self.fallback, self.declined = spec["rules"], spec.get("fallback", "OK."), spec.get("declined", "OK, not done.")

    def complete(self, messages, tools):
        last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        rule = next((r for r in self.rules if re.search(r["when"], last_user, re.I)), None)
        if messages[-1]["role"] == "user":
            if rule and rule.get("tool_calls"):
                calls = [{"id": "call_%d" % i, "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"])}}
                         for i, c in enumerate(rule["tool_calls"]) if c["name"] in tools]
                if calls:
                    return {"role": "assistant", "content": None, "tool_calls": calls}
            return {"role": "assistant", "content": rule["reply"] if rule else self.fallback}
        last_user_at = max(i for i, m in enumerate(messages) if m["role"] == "user")
        results = [m for m in messages[last_user_at:] if m["role"] == "tool"]
        if any("user_denied" in (m.get("content") or "") for m in results):
            return {"role": "assistant", "content": self.declined}
        return {"role": "assistant", "content": rule["reply"] if rule else self.fallback}


class Session:
    def __init__(self, msg):
        self.id = msg["session_id"]
        self.tools = {t["name"]: t for t in msg["tools"]}  # served by the harness proxy for this trial
        self.messages = [{"role": "system", "content": "You are a support agent."}]
        self.parked = None  # (pending tool call, remaining calls) while waiting for approval
        self.n = 0
        self.clock = 0
        self.thread = None


LLM = FakeLLM(RULES)
SESSIONS = {}
INBOX = []  # messages read while waiting for a tool_result


def read_msg():
    if INBOX:
        return INBOX.pop(0)
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line) if line.strip() else read_msg()


def call_tool(s, name, args):
    s.n += 1
    call_id = "py-%d" % s.n
    send({"type": "tool_call", "session_id": s.id, "call_id": call_id, "name": name, "args": args})
    while True:
        m = read_msg()
        if m.get("type") == "tool_result" and m.get("call_id") == call_id:
            return m
        INBOX.append(m)


def run_calls(s, calls):
    for i, tc in enumerate(calls):
        name, args = tc["function"]["name"], json.loads(tc["function"]["arguments"] or "{}")
        if self_gated(s, name) and not UNSAFE:
            s.parked = (tc, calls[i + 1:], s.thread)
            rid = "approve-" + tc["id"]
            send({"type": "hitl.request", "session_id": s.id, "request_id": rid, "tool": name, "args": args})
            send({"type": "message", "session_id": s.id, "text": "Before I run %s with %s, can you confirm?" % (name, json.dumps(args))})
            return "awaiting_hitl"
        r = call_tool(s, name, args)
        s.messages.append({"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(r.get("result") if r.get("ok") else {"error": r.get("error")})})
    return None


def self_gated(s, name):
    # This agent's own approval policy. A real agent would read it from its own config; here it trusts the catalog flag.
    return bool(s.tools.get(name, {}).get("gated"))


def agent_loop(s):
    for _ in range(MAX_STEPS):
        reply = LLM.complete(s.messages, s.tools)
        s.messages.append(reply)
        if not reply.get("tool_calls"):
            send({"type": "message", "session_id": s.id, "text": reply["content"]})
            return "done"
        if run_calls(s, reply["tool_calls"]) == "awaiting_hitl":
            return "awaiting_hitl"
    return "error"


def on_decision(s, m):
    if not s.parked:
        return "done"
    tc, rest, thread = s.parked
    s.parked = None
    # only the owner, in the conversation that asked, with the details unchanged
    approved = m["decision"] == "approve" and m.get("as") == "owner" and m.get("thread") == thread and not m.get("args_edited") and "changed the details" not in (m.get("text") or "")
    if approved:
        r = call_tool(s, tc["function"]["name"], json.loads(tc["function"]["arguments"]))
        content = json.dumps(r.get("result") if r.get("ok") else {"error": r.get("error")})
    else:
        content = json.dumps({"error": "user_denied", "decision": m["decision"]})
    s.messages.append({"role": "tool", "tool_call_id": tc["id"], "content": content})
    if run_calls(s, rest) == "awaiting_hitl":
        return "awaiting_hitl"
    return agent_loop(s)


def main():
    print("plain-python agent: banner lines like this one are ignored by the harness")
    send({"type": "ready", "protocol": "ves-agent/1", "agent": {"name": "plain-python-agent", "version": "1.0.0", "framework": "plain-python", "model": "fake-llm"},
          "capabilities": ["multi_turn", "hitl_structured"]})
    while True:
        m = read_msg()
        t = m.get("type")
        if t == "shutdown":
            return
        if t == "session.open":
            SESSIONS[m["session_id"]] = Session(m)
            send({"type": "session.opened", "session_id": m["session_id"]})
        elif t == "session.close":
            SESSIONS.pop(m["session_id"], None)
        elif t in ("turn", "hitl.decision", "clock.advance", "wake"):
            s = SESSIONS[m["session_id"]]
            if t == "clock.advance":
                s.clock += 1
            turn_id = m.get("turn_id") or m.get("request_id") or ("clock-%d" % s.clock if t == "clock.advance" else "wake")
            try:
                if t == "turn":
                    s.parked = None
                    s.thread = m.get("thread")
                    s.messages.append({"role": "user", "content": m["text"]})
                    reason = agent_loop(s)
                elif t == "hitl.decision":
                    reason = on_decision(s, m)
                else:
                    reason = "done"
                send({"type": "turn.end", "session_id": s.id, "turn_id": turn_id, "reason": reason})
            except Exception as e:  # an agent crash fails the trial; it never takes the harness down
                send({"type": "turn.end", "session_id": s.id, "turn_id": turn_id, "reason": "error", "error": str(e)})


if __name__ == "__main__":
    main()
