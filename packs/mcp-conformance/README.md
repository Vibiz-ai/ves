# mcp-conformance

**Purpose.** S0 contract checks for teams whose product is an MCP server. The checks are model-free, cost $0 and run with k = 1 at smoke.

**Needs.** A variant with `role: "contract"`, for example:

```json
"variants": { "mcp": { "role": "contract", "connection": { "type": "mcp", "transport": "http", "url": "http://127.0.0.1:3100/mcp", "mode": "contract" }, "capabilities": ["rpc"] } }
```

Without one, the pack is skipped with the reason "no contract variant". Every case runs only on the contract variants.

## Checks

| Check | Evidence | Passes when |
|---|---|---|
| `handshake` | transcript | `initialize` returns `protocolVersion`, `capabilities` and `serverInfo.name`, and `notifications/initialized` is accepted |
| `tools-list-paging` | transcript | Cursor paging terminates within 50 pages, and tool names are unique |
| `tool-schema-valid` (per tool) | transcript | `inputSchema` is an object schema (`type: "object"`, well-formed `properties` and `required`). The advisory part: a description is present. |
| `annotations-consistent` (per tool) | transcript | No `readOnlyHint: true` on a tool the catalog classes as a write. The advisory part: `destructiveHint` is set on destructive tools. Annotations never decide gating (VES-1 §8.2 G6). |
| `unknown-tool` | transcript | `tools/call` of an unknown name returns a JSON-RPC error or `isError: true` |
| `invalid-args` (per tool with required args) | transcript | `tools/call` with `{}` returns an error. With a ledger, core's G1 also fails any upstream write it caused on a gated tool. |
| `read-idempotent` (per read tool) | proxied calls | Two identical calls give the same result shape (keys and types) |
| `gated-without-approval` (per gated tool) | proxied calls | A call without approval is refused (an error or `guard_signal`), and no upstream write happens |
| `structured-output` (per non-gated tool with `output_schema`) | proxied calls | The result validates against `output_schema` |

**Not shipped: `official-conformance`.** It would run the pinned `@modelcontextprotocol/conformance` runner and the Inspector CLI. Both need `npx` and the network, which neither this build nor its tests may touch.

## Two kinds of evidence

**Call checks** replay the case oracle's `call` steps through `HarnessIO.callTool`, so the proxy records them against your server (forward backend). The MockAgent oracle replays the same steps on the sim for the baselines.

**Transcript checks** carry `requires: ["rpc"]`. They grade the JSON-RPC exchanges the harness had with your server. Contract-mode connectors must report every exchange as an effect:

```json
{ "type": "effect", "session_id": "…", "kind": "mcp.rpc",
  "args": { "seq": 1, "method": "initialize", "params": { }, "status": 200, "response": { "result": { } } } }
```

Each exchange records `seq`, `method`, optional `params`, the HTTP `status`, and `response` (the JSON-RPC `{result}` or `{error}`, or `null`). The connector reports:
- `initialize` and `notifications/initialized`, at session open;
- one entry per `rpc` turn;
- one entry per page for `tools/list`, following `nextCursor` up to 50 pages.

`transcript.ts` (`McpTranscriptClient`) implements exactly this over an injected `send` function. `tools/call` rpc turns must go **raw** to the server, not through the proxy, because they test the server's own error behaviour.

## Reading a failure

Contract failures block at **G-2** unless they are listed in `expected_failures`. The failing check's explanation names the tool and the field, for example `email_itinerary: readOnlyHint true, but the catalog classes it as write+outward`.

A transcript check that says "no MCP transcript recorded" means the connector did not report the exchanges. Fix the connector, not the server.
