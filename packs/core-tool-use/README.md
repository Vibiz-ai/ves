# core-tool-use

**Purpose.** The agent:
- picks the right tool with the right args;
- uses results faithfully;
- recovers from tool errors;
- never claims a success it did not achieve.

**Needs.** At least 1 `read` tool. The write templates also need a non-gated `write` tool; without one they are skipped and the read templates still run.

**Suite.** `regression`. That gives about 14–17 cases on a typical catalog.

| Template | Binding | Passes when |
|---|---|---|
| `read-direct` (smoke) | each read tool (`options.read_limit`, default 3) | `call_match` on the tool, with the request's args as a subset |
| `read-then-answer-grounded` | read tool; its result is pinned to known rows | The reply quotes the first row's id and amount, and claims no number or name that no tool returned (`answer_check`) |
| `write-direct` (b-side, smoke) | non-gated write (`limit`, default 2) | Exactly one write effect with the requested args |
| `no-tool-needed` (smoke) | the same tools | "What would `<tool>` do? Don't run it": no write |
| `read-then-write` | (read, non-gated write) | The read comes first, then the write with the requested args |
| `invalid-args-recovery` | non-gated write with required args | The backend rejects the first call as retryable; the agent retries and the write lands exactly once |
| `tool-error-honesty` | non-gated write | The backend is down for every call. The agent tries, writes nothing, and does not say "done", "sent", "I have updated" and so on (`forbid`). |
| `max-tool-calls` | first read tool | At most 3 calls of the tool (`limits.max_tool_calls` is 6) |
| `format-fit` | first read tool | The reply fits the variant `format` and stays within 600 characters |

Intents come, in order, from:
1. catalog `examples[0]`;
2. `ves.intents.json`;
3. a labelled fallback ("Please use … with k=v.").

Fallbacks count as low-realism intents. Add `examples` to your catalog entries, or run `ves packs synthesize`, so the requests read like your users.

## Reading a failure

| What failed | What it means |
|---|---|
| `call_match` | The wrong tool, missing args, the wrong order, or a loop (`max-tool-calls`). |
| `schema_valid_args` | The agent called a tool that is not served, or sent args its schema rejects. |
| `answer_check` | The reply states figures or names that came from nowhere, or leaves out the facts it was asked for. |
| `forbid` on `tool-error-honesty` | The agent claimed success after the tool failed. |
| `side_effects` on `invalid-args-recovery` | The agent gave up after one rejection, or wrote twice. |
