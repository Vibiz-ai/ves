#!/usr/bin/env python3
"""A small stdio MCP server (newline-delimited JSON-RPC, standard library only) standing in for YOUR MCP server, so the
`mcp` connector's stdio transport runs end to end. VES spawns it: "command": ["python3", "server.py"].

It serves the support-desk tools from examples/fixtures/support-desk.mcp-tools.json and has its OWN approval guard:
a tool marked requires_approval refuses with {"error": "approval_required", "review": {"pending_id": ...}} until
`approve_action({"pending_id": ...})` is called (VES plays the human; connection.approval in ves.config.json).
Every write it performs is appended as {"tool", "args"} to the JSONL audit log in $LEDGER_FILE (when set): that is the
upstream ledger VES reads (connection.ledger.file), so a write the harness proxy did not see shows up as a bypass.
VES_DEMO_UNSAFE=1 turns the guard off. Logs go to stderr; stdout carries only JSON-RPC.
"""
import json
import os
import re
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "fixtures", "support-desk.mcp-tools.json")) as f:
    DEFS = json.load(f)["tools"]
with open(os.path.join(HERE, "..", "fixtures", "support-desk.state.json")) as f:
    STATE = json.load(f)
UNSAFE = os.environ.get("VES_DEMO_UNSAFE") == "1"
PAGE = 5
APPROVE = {
    "name": "approve_action",
    "description": "Approve a pending action (called by the human reviewer, not by the agent).",
    "inputSchema": {"type": "object", "additionalProperties": False,
                    "properties": {"pending_id": {"type": "string", "minLength": 1}}, "required": ["pending_id"]},
    "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
}
TOOLS = DEFS + [APPROVE]
PENDING = {}  # pending_id -> {"key", "approved", "used"}
SEQ = [0]


def invalid(schema, args):
    """The subset of JSON Schema these tools use."""
    if not isinstance(args, dict):
        return "arguments must be an object"
    for k in schema.get("required", []):
        if k not in args:
            return "missing required " + k
    for k, v in args.items():
        p = schema.get("properties", {}).get(k)
        if p is None:
            if schema.get("additionalProperties") is False:
                return "unknown argument " + k
            continue
        if p.get("type") == "string":
            if not isinstance(v, str) or len(v) < p.get("minLength", 0):
                return k + " is not a valid string"
            if p.get("format") == "email" and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", v):
                return k + " is not an email"
        if p.get("type") == "number":
            if isinstance(v, bool) or not isinstance(v, (int, float)) or v < p.get("minimum", float("-inf")) or v > p.get("maximum", float("inf")):
                return k + " is out of range"
    return None


def ok(value):
    return {"content": [{"type": "text", "text": json.dumps(value)}],
            "structuredContent": {"result": value} if isinstance(value, list) else value}


def tool_err(value):
    return {"isError": True, "content": [{"type": "text", "text": json.dumps(value)}], "structuredContent": value}


def ledger(name, a):
    path = os.environ.get("LEDGER_FILE")
    if path:
        with open(path, "a") as f:
            f.write(json.dumps({"tool": name, "args": a}) + "\n")


def run(name, a):
    SEQ[0] += 1
    if name not in ("search_tickets", "get_customer", "list_orders"):
        ledger(name, a)
    if name == "search_tickets":
        word = str(a["query"]).lower().split()[0]
        return ok([t for t in STATE["tickets"] if word in t["subject"].lower()])
    if name == "get_customer":
        c = STATE["customers"].get(a["customer_id"])
        return ok(c) if c else tool_err({"error": "not_found"})
    if name == "list_orders":
        return ok([o for o in STATE["orders"] if o["customer_id"] == a["customer_id"]])
    if name == "add_note":
        STATE["notes"].append(a)
        return ok({"note_id": "N-%d" % SEQ[0]})
    if name == "close_ticket":
        STATE["ticket_status"][a["ticket_id"]] = "closed"
        return ok({"ok": True})
    if name == "send_email":
        STATE["sent_emails"].append(a)
        return ok({"status": "sent", "id": "E-%d" % SEQ[0]})
    if name == "issue_refund":
        STATE["refunds"].append(a)
        return ok({"refund_id": "R-%d" % SEQ[0]})
    if name == "delete_customer":
        STATE["customers"].pop(a["customer_id"], None)
        return ok({"deleted": a["customer_id"]})
    return tool_err({"error": "unknown_tool"})


def call_tool(name, args):
    d = next((t for t in TOOLS if t["name"] == name), None)
    if d is None:
        return None, {"code": -32602, "message": "unknown tool " + name}
    bad = invalid(d["inputSchema"], args)
    if bad:
        return tool_err({"error": "invalid_args", "detail": bad}), None
    if name == "approve_action":
        p = PENDING.get(args["pending_id"])
        if not p or p["used"]:
            return tool_err({"error": "not_found"}), None
        p["approved"] = True
        return ok({"approved": args["pending_id"]}), None
    if d.get("requires_approval") and not UNSAFE:
        key = name + ":" + json.dumps(args, sort_keys=True)
        grant = next((p for p in PENDING.values() if p["key"] == key and p["approved"] and not p["used"]), None)
        if grant is None:
            pid = "P-" + uuid.uuid4().hex[:8]
            PENDING[pid] = {"key": key, "approved": False, "used": False}
            return tool_err({"error": "approval_required", "review": {"pending_id": pid, "tool": name}}), None
        grant["used"] = True  # single use, bound to the exact arguments
    return run(name, args), None


def handle(msg):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        want = params.get("protocolVersion")
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": want if want in ("2025-06-18", "2025-03-26") else "2025-06-18",
            "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "support-desk-mcp-py", "version": "1.0.0"}}}
    if method == "notifications/initialized" or mid is None:
        return None
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        start = int(params.get("cursor") or 0)
        page = [{k: v for k, v in t.items() if k != "requires_approval"} for t in TOOLS[start:start + PAGE]]
        res = {"tools": page}
        if start + PAGE < len(TOOLS):
            res["nextCursor"] = str(start + PAGE)
        return {"jsonrpc": "2.0", "id": mid, "result": res}
    if method == "tools/call":
        result, error = call_tool(str(params.get("name", "")), params.get("arguments") or {})
        return {"jsonrpc": "2.0", "id": mid, "error": error} if error else {"jsonrpc": "2.0", "id": mid, "result": result}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found: %s" % method}}


def main():
    sys.stderr.write("support-desk MCP server (stdio)%s\n" % (" [UNSAFE: no approval guard]" if UNSAFE else ""))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            out = handle(msg)
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
