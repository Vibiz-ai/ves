# src/connectors/ (owned by the connectors package, DESIGN-agnostic §7.0, §7.2)

Discovery is by directory (`src/registry/connectors.ts`):
- every `src/connectors/<name>/index.ts` whose directory name does not start with `_` is imported;
- its `default` export must be a `ConnectorFactory` (`{ kind, version, create(cfg, deps) }`, `src/core/types.ts`);
- duplicate kinds are a startup error;
- no shared file needs editing to add a connector;
- `mock` is built into core (`src/core/mock-agent.ts`).

| Dir | Kind | What it connects | Tool records |
|---|---|---|---|
| `command/` | `command` | any process speaking `ves-agent/1` JSONL on stdin/stdout (§1.3) | `tool_call` -> `HarnessIO.callTool` (`pipe`), or the agent's MCP client on `tool_transport.mcp` |
| `http/` | `http` | an agent that is already a server: the four `/ves/v1` routes, NDJSON or SSE replies (§1.4) | same |
| `openai-chat/` | `openai-chat` | any OpenAI-compatible `/chat/completions` endpoint, no agent code (§1.5) | harness-executed `tool_calls` (`loop`) |
| `mcp/` | `mcp` | an MCP server, over HTTP or stdio: `contract` (no model) or `host-sim` (`deps.models`) (§1.7) | the server is the proxy's backend through `toolBackend()` |
| `trace/` | `trace` | recorded traces: OTel GenAI (and AI SDK legacy spans), ATIF, OpenAI Agents SDK JSONL (§1.8) | `traced` only: can fail a safety check, never pass one |

Shared code in `_shared/`, which discovery skips:

| File | Purpose |
|---|---|
| `jsonl.ts` | Codec. Non-JSON lines become text and are logged, never treated as errors. |
| `queue.ts` | Async queue with close and timeout. |
| `protocol.ts` | The §1.2 session state machine: every sequence rule, the turn ids, and the provider-status INVALID rule. |
| `tool-loop.ts` | Loop shared by openai-chat and host-sim, including parking for approvals and wire-safe tool names. |
| `mcp-client.ts` | Streamable HTTP client (moved from `src/adapters/mcp.ts`, which core keeps for the v1 tests) and the stdio client. |
| `stdio-bridge.ts` | `ves proxy --connect <url>`: a stdio MCP server forwarding to the per-trial HTTP endpoint. The `command` and `http` connectors put it in `session.open.tool_transport.mcp_stdio`. |
| `env.ts` | Agent environment filter: `PATH`, `HOME`, `VES_*`, `env_passthrough` and `env`. |
| `hosts.ts` | Refuses production hosts. |
| `routes.ts` | `routesHash` and globs. |
| `spawn.ts` | The node:child_process `SpawnLike`. It is the fallback when the runner did not inject one. |

Rules the core enforces for you:
- Tool calls go through `HarnessIO.callTool()` only, because that is the proxy. Use `report(ev, level)` for everything else.
- `HarnessIO.toolTransport()` holds the per-trial MCP and HTTP URLs that core started (`src/proxy/http-binding.ts`).
- A `TurnOutcome` error with `origin: 'provider' | 'host'` and an HTTP status becomes INVALID. `origin: 'agent'` is FAIL.
- Tests live in `test/connectors/**` and use fakes only (`test/setup.ts` blocks fetch and sockets): in-memory child processes, a fetch that calls in-process handlers, and local child processes for the runnable examples.
