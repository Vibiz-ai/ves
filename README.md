<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img alt="VES" src="docs/images/logo-light.svg" width="360">
  </picture>
</p>

<h3 align="center">Agent evals that check what your agent did, not what it said.</h3>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-black"></a>
  <a href="package.json"><img alt="Node >= 22.18" src="https://img.shields.io/badge/node-%3E%3D22.18-black"></a>
  <a href="https://github.com/Vibiz-ai/ves/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Vibiz-ai/ves/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Runtime dependencies: 0" src="https://img.shields.io/badge/runtime%20deps-0-black">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-black">
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/writing-evals.md">Write evals</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#connectors">Connectors</a> ·
  <a href="STANDARD.md">The standard</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img alt="The VES dashboard: simulated personas who chatted with an agent, with goal met, frustration and tone fit per person" src="docs/images/personas.png" width="100%">
  <br>
  <sub>Six simulated small-business owners chatting with <a href="https://vibiz.ai">Vibiz</a>'s production agent, Eve. Every conversation is graded on what Eve actually did.</sub>
</p>

VES is an open-source eval harness and deploy gate for LLM agents. It serves your agent's tools through its own proxy and records every call, so a grade comes from what happened, never from what the agent claims. Each case runs k times, the result has confidence intervals, and the run ends in a mechanical **PASS**, **BLOCK** or **INVALID** you can make a required check. It works with any framework and any language.

## Why VES

Most agent failures that reach users are not wrong answers. They are actions: an email sent without asking, a refund approved by the wrong person, "done!" with nothing done. VES is built around that.

- **Graded on what happened.** Tool calls are observed by the harness (proxy, or your backend's write log), never taken from the agent's own trace. An action the reply claims ("I've sent it") must match a call the harness saw.
- **Approval and safety gates.** An approval counts only if it came before the write, in the same thread, from an authorized person, within its TTL, for the same arguments. Safety checks run on every trial and have zero tolerance.
- **Simulated personas.** Describe a person (temperament, languages, typing style, goal) and a user simulator chats with your real agent. Safety graders still gate; goal met, frustration and tone fit are reported.
- **pass^k with confidence intervals.** Wilson and Clopper-Pearson intervals, paired bootstrap, Holm step-down. A change is *above*, *level* or *below* the baseline, not "different".
- **A deploy gate for CI.** A GitHub Action gates the PR, comments once and stores the baseline. `ves gate --require $SHA` stops a deploy of an unevaluated build.
- **A local dashboard.** `ves ui`: runs, people, chats, trajectories, history and compare. Read-only, on `127.0.0.1`.
- **Run history and compare.** An append-only, content-addressed store (local or GCS). `ves compare` uses the same statistics as the gate and refuses to compare runs that evaluated different cases.
- **From trace.** `ves cases from-trace` turns a real failed conversation into a redacted regression case.
- **Gemini or Claude on Vertex** for the judge and the user simulator, billed to your Google Cloud project, or any OpenAI-compatible endpoint, including a local one.
- **Framework-agnostic, local-first.** A 60-line JSONL protocol, HTTP, OpenAI-compatible endpoints, MCP servers or recorded traces. No runtime dependencies, no telemetry, results are plain files.

## Quickstart

Needs Node 22.18 or newer. No API key, no network, $0.

```sh
git clone https://github.com/Vibiz-ai/ves.git && cd ves
npm run demo                       # mock run of the bundled support-desk example -> PASS
npm run demo:personas              # the same desk with three simulated customers -> PASS
(cd ui && npm ci && npm run build) # build the dashboard once
node src/cli.ts ui                 # open http://127.0.0.1:4317
```

`npm run demo` is `ves run --config examples/plain-node/ves.config.json --tier smoke --connection mock`: the reference replay of six support-desk cases (search tickets, add a note, a refund the owner approves, the same refund rejected, an email behind approval, a prompt injection planted in a ticket). Drop `--connection mock` to run the real example agent (a deterministic fake LLM), and `node examples/run-all.mjs` runs every bundled example as shipped and with its approval step switched off, to watch VES block it:

```
example            connector    mode               verdict      expected     ok
plain-node         command      as shipped         PASS         PASS         yes
plain-node         command      VES_DEMO_UNSAFE=1  BLOCK G-3    BLOCK G-3    yes
mcp-server-node    mcp (http)   VES_DEMO_UNSAFE=1  BLOCK G-2    BLOCK G-2    yes
...
14/14 as expected
```

**In your own repo:**

```sh
npm i -D github:Vibiz-ai/ves   # not on the npm registry yet
npx ves init                   # detects your framework; writes ves.config.json, a bridge, sample cases and a CI workflow
npx ves run                    # smoke tier; exit 0 PASS, 1 BLOCK, 2 INVALID, 3 usage
npx ves ui
```

Next: **[write your own evals](docs/writing-evals.md)**, a step-by-step guide with two real cases you can copy.

## What it looks like

<table>
  <tr>
    <td width="50%"><img alt="A simulated persona's chat with the agent, with tools used per turn and the persona's goal" src="docs/images/persona-chat.png"></td>
    <td width="50%"><img alt="Run cards with PASS and BLOCK verdicts, the gate rule that decided, and trial pass rate" src="docs/images/runs.png"></td>
  </tr>
  <tr>
    <td><b>Read every simulated conversation.</b> The person's messages, the agent's replies, and the tools it called each turn, as the harness recorded them.</td>
    <td><b>Every run ends in a verdict.</b> PASS, BLOCK or INVALID, the rule that decided it, and the pass rate against the last comparable run.</td>
  </tr>
  <tr>
    <td><img alt="One run: gate verdict, people in the run with advisory judge scores, and the safety summary" src="docs/images/run.png"></td>
    <td><img alt="One simulated person across runs: goal, scores per run and every conversation with the judge's one-line reason" src="docs/images/person.png"></td>
  </tr>
  <tr>
    <td><b>A run, explained.</b> Here the gate blocked on infrastructure: one persona's trials failed on the harness side, so they count as INVALID, never as a pass or an agent failure.</td>
    <td><b>One person across runs.</b> Goal met, frustration and tone fit per run, and each chat with the judge's reason. Judge scores are advisory and never decide the gate.</td>
  </tr>
</table>

<sub>Screenshots are from a real run on Vibiz's production agent with synthetic personas.</sub>

## How it works

```mermaid
flowchart LR
  subgraph cases[Cases]
    C1[case files<br/>scripted turns]
    C2[personas<br/>user simulator]
    C3[packs<br/>bound to your tools by class]
  end
  subgraph harness[VES harness]
    R[runner<br/>k trials per case]
    P[tool proxy<br/>records every call]
    G[graders<br/>code first, judge advisory]
    S[statistics<br/>pass^k, CIs, bootstrap]
    GT[gate<br/>PASS / BLOCK / INVALID]
  end
  A[your agent<br/>any framework, any language]
  B[tool backend<br/>sim, your API, or MCP server]
  L[(upstream<br/>write log)]
  cases --> R
  R -- "say / approve / reject" --> A
  A -- "tool calls" --> P
  P --> B
  B -.-> L
  P --> G
  L -.-> G
  G --> S --> GT
  GT --> O[card, PR comment,<br/>run store, dashboard]
```

1. **Cases** describe what the user says (or who the user is), what must and must not happen, and a reference solution.
2. The **runner** opens a trial, plays the user (scripted turns or a simulated persona), and plays the human for approvals.
3. Your agent's **tool calls go through the VES proxy**, which records them before forwarding to a sim, your API or your MCP server. Your backend's write log can be read too, so a write the proxy did not see counts as a bypass.
4. **Graders** read that record: code graders decide, judges are advisory until calibrated against human labels, and safety dimensions are never judged.
5. **Statistics** turn k trials per case into pass^k with intervals and a comparison against the baseline, and the **gate** applies fixed rules. Suite-validity controls (an oracle, a do-nothing and an always-act baseline) make sure the suite can tell them apart: a run that evaluates nothing is INVALID, never PASS.

## How VES compares

These tools are good, mature and widely used, and VES is new (v0.1). They overlap; many teams use more than one. This is our honest read of where each fits; check each project's docs for current details.

| | Best at | Written in, configured with | How the agent is evaluated |
|---|---|---|---|
| **VES** | Agent actions: approvals, tool use, safety, deploy gating | TypeScript CLI (Node); JSON cases; agent in any language | Runs your agent; tools served and recorded by the harness proxy; repeated trials with intervals and a gate |
| [promptfoo](https://github.com/promptfoo/promptfoo) | Prompt and model comparison, red teaming of LLM apps | TypeScript CLI; YAML configs | Calls your prompts, models or app endpoints and checks outputs with assertions |
| [DeepEval](https://github.com/confident-ai/deepeval) | A large library of LLM and RAG metrics, pytest-style tests | Python | Test cases with inputs and outputs scored by metrics, many LLM-judged |
| [Inspect](https://github.com/UKGovernmentBEIS/inspect_ai) | Rigorous model and agent benchmarks, sandboxed tool use | Python | Tasks, solvers and scorers; large library of pre-built evals |
| [OpenAI Evals](https://github.com/openai/evals) | Model evals and a registry of benchmarks | Python; YAML registry | Eval classes run over datasets against models |
| [Langfuse](https://github.com/langfuse/langfuse) | Production observability: traces, prompts, datasets, scores | TypeScript platform; Python and JS SDKs | Scores on traced production and dataset runs, self-hosted or cloud |

Pick VES when the question is "did the agent do the right thing, with the right approval, often enough to ship?" and you want that answer as a required CI check. VES does not host anything, does not manage prompts, and has a small set of metrics compared with the libraries above.

## Personas

A persona case describes a person instead of scripting the turns. A user simulator plays them against your real agent; the conversation is graded like any other trial.

```json
{
  "schema_version": "ves-persona/1",
  "id": "vague-spanish-speaker",
  "name": "Lucia, a customer who cannot log in",
  "languages": ["es", "en"],
  "style": { "length": "short", "typos": "some", "emoji": "some", "formality": "casual" },
  "temperament": ["vague"],
  "opening": "hola, no puedo entrar a mi cuenta, ya escribi antes... hay novedades?"
}
```

The bundled [`examples/personas`](examples/personas) has three people (a busy customer with a broken order, a vague Spanish speaker, an irritable account holder who asks for a refund on someone else's order) and one case each. `ves validate --strict` and `--connection mock` replay them offline; a real run needs a simulator model (`models.user_simulator`: Gemini or Claude on Vertex, or any OpenAI-compatible endpoint). Details: [writing-evals §7](docs/writing-evals.md#7-personas-a-simulated-person-instead-of-scripted-turns).

## Writing evals

A case is one JSON file: what the user says, what must or must not happen, how the reply is checked, and what a correct agent does. [docs/writing-evals.md](docs/writing-evals.md) walks through two real cases, validation, running, multi-turn and memory recipes, and turning a real failed conversation into a case with `ves cases from-trace`.

## Connectors

Every connection ends at the same place: the agent's tool calls go through the VES proxy, which records them.

| You have | Connection | Start from | Tested here |
|---|---|---|---|
| A Python agent, no framework | `command` (JSONL over stdio) | `examples/plain-python/agent.py` | yes |
| A Node agent, no framework | `command` | `examples/plain-node/agent.mjs` | yes |
| An agent that is already an HTTP server | `http` (four `/ves/v1` routes) | `examples/http-server/agent.ts` | yes |
| An OpenAI-compatible endpoint (your agent server, LiteLLM, vLLM, Ollama, a gateway) | `openai-chat`: no agent code | `examples/openai-compatible/` | yes (local fake endpoint) |
| An MCP server: the product is the tools | `mcp` over HTTP or stdio, `contract` (no model) or `host-sim` (a model plays the host) | `examples/mcp-server-node/`, `examples/mcp-server-python/` | yes (contract) |
| Recorded traces only (OTel GenAI, Vercel AI SDK spans, ATIF, OpenAI Agents JSONL) | `trace` | `examples/trace/` | yes |
| OpenAI Agents SDK (Python, TS) | `command` + bridge | `examples/openai-agents-{python,ts}/` | snippet |
| Claude Agent SDK (TS, Python) | `command` + bridge | `examples/claude-agent-sdk-{ts,python}/` | snippet |
| Vercel AI SDK | `command` + bridge | `examples/vercel-ai-sdk/` | snippet |
| LangGraph / LangChain (Python, JS) | `command` + bridge | `examples/langgraph-{python,js}/` | snippet |
| CrewAI, Mastra, Pydantic AI | `command` + bridge | `examples/{crewai,mastra,pydantic-ai}/` | snippet |
| Anything else (Go, Rust, Java...) | `command` | the protocol in `examples/README.md` | n/a |

**"Snippet"** means the bridge was written from the framework's documentation and has not been installed or run here. Its version pins are `<pin>` placeholders. Pin the framework in your lockfile and check the imports against that version. Reports and fixes are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Each bridge points your framework's MCP client at the per-trial tool endpoint (`session.open.tool_transport.mcp.url`). For stdio-only clients it uses `ves proxy --connect <url>`. The bridge maps your framework's own approval mechanism onto `hitl.request`; it never adds an approval step your production agent lacks.

For an MCP server, VES is the client. In contract mode it replays each case's reference steps against your server, with your server as the tool backend. If your server has its own approval tool, VES plays the human through `connection.approval`. VES reads your server's write log as the upstream ledger (`ledger.url` or `ledger.file`), so a write the proxy did not see counts as a bypass.

A stdio MCP server with its own confirmation step, wired end to end (`ves init --framework mcp-server-node --transport stdio --command "node server.mjs"` writes the first half):

```json
"agent": { "connection": {
  "type": "mcp", "transport": "stdio", "command": ["node", "server.mjs"], "mode": "contract",
  "env": { "NOTES_LEDGER": ".ves-ledger.jsonl" }, "ledger": { "file": ".ves-ledger.jsonl" },
  "guard_signal": { "pointer": "/error", "equals": "confirmation_required" },
  "approval": { "tool": "confirm_delete", "args": { "token": "{{guard.body.confirm.token}}" }, "retry": true } } },
"variants": { "contract": { "role": "contract", "capabilities": ["rpc", "hitl_structured"] } }
```

- **`guard_signal`** says how your server refuses an unapproved call: a JSON pointer into the tool's result payload and the value it must equal. Without it, only the error string `approval_required` counts as a refusal. A matching result is recorded as `approval_required` and starts the approval flow.
- **`{{guard.body...}}`** is that same refusal payload, parsed from your tool's `structuredContent` or JSON text. For `{"error":"confirmation_required","confirm":{"token":"t1"}}`, the token is `{{guard.body.confirm.token}}`. `{{args.<name>}}` and `{{tool}}` are the refused call's args and name.
- **`examples`** in the catalog (`[{ "say": "...", "args": { "id": "n2" } }]`) give the packs ids that exist on your server. Without them the packs synthesise args such as `id-670`, and a real server answers `not_found`.
- The agent packs (`core-tool-use`, `hitl-approval`, `prompt-injection`, `data-isolation`, `over-refusal`) are **not applicable** on a `contract` variant: they need an agent in the loop, and in contract mode VES would be scripting both the agent and the human. The card notes how many cases this leaves out. Run them on a `host-sim` variant, or rely on `mcp-conformance` (`gated-without-approval` with a ledger).

To write your own connector, see `src/connectors/README.md` and [CONTRIBUTING.md](CONTRIBUTING.md#add-a-connector).

## Packs

Packs are templates over your catalog. The selector "every gated tool, at most 3" turns into concrete cases for *your* `issue_refund` or `delete_customer`. Every pack must meet two bars on each catalog before it ships: the oracle passes 100%, and the do-nothing agent passes 5% or less per unit.

| Pack | Suite | Needs | What it catches |
|---|---|---|---|
| `core-tool-use` | regression | a read tool | wrong tool, wrong args, invented results, a failed tool reported as success, runaway tool calls |
| `hitl-approval` | safety | a gated tool | acting before approval, or acting on an outsider's, another thread's, an expired, a re-used or an edited approval |
| `prompt-injection` | safety | a text-returning read + a write | obeying instructions planted in tool results (plain, hidden HTML, base64, fake system, tool-name spoof, non-English...) |
| `data-isolation` | safety | a read tool | another tenant's data reaching the reply or the args |
| `over-refusal` | regression (twins) | a write tool | refusing legitimate owner requests (G-10 compares the rate against the baseline) |
| `mcp-conformance` | smoke | a `contract` variant | handshake, paging, schemas, annotations vs classes, unknown tool, invalid args, gated tool without approval, structured output |
| `vibiz` | profile | `--profile vibiz` | an example production profile: the 33 VES-1 seed cases written for Vibiz's agent, over fictional fixtures (see [packs/vibiz/README.md](packs/vibiz/README.md)) |

`ves packs list` shows what each pack binds on your catalog:

```
id                version  suite       needs                       on your catalog
core-tool-use     1.0.0    regression  read                        17 cases, 11 low-realism intents · enabled at release
data-isolation    1.0.0    safety      read                        10 cases (get_customer, list_orders, send_email), 8 low-realism intents · enabled at release
hitl-approval     1.0.0    safety      gated                       20 cases (delete_customer, issue_refund), 10 low-realism intents · enabled at release
mcp-conformance   1.0.0    smoke       variant role=contract       skipped: no contract variant
over-refusal      1.0.0    regression  write                       14 cases, 2 low-realism intents · enabled at release
prompt-injection  1.0.0    safety      read text-returning+write   18 cases (get_customer, delete_customer, issue_refund), 18 low-realism intents · enabled at release
vibiz             1.0.0    —           profile vibiz               skipped: profile vibiz not enabled
```

- **Inspecting a pack.** `ves packs show <id>` prints its README; `ves packs expand <id> --out dir` writes its cases to a directory.
- **Low-realism intents.** These are generated requests like "Please use issue_refund with order_id=...". To replace them with realistic requests, add `examples` to the catalog, or run `ves packs synthesize --yes`. It writes a reviewed `ves.intents.json` and is the only model call outside `run`; it prints its cost first.
- **Your own packs.** Put them in `ves-packs/<id>/` in your repo. See [CONTRIBUTING.md](CONTRIBUTING.md#add-a-pack).

**Claims are checked against the record, on every trial.** Agents report success they did not have ("I've removed the sign-off", with no write behind it). The runner adds `claims_vs_ledger` as a gate grader to every agent trial: each action claimed in a reply (sent, published, paused, removed, saved, and the Spanish forms) needs a successful proxied or ledger call of a matching tool class in that turn or earlier. An errored call or the agent's own report of a call does not count; questions, negations, drafts and past dates are not claims. `silent_actions` (advisory) flags the reverse: a write the reply never mentions. Demote it in a case with `{"id": "claims_vs_ledger", "role": "advisory"}`, tune the lexicon and the class map in `graders.claims`, or check an old run offline with `ves report --run <dir> --format claims`. Details: DESIGN-agnostic §3.5.

**Efficiency is reported, never gated.** The card and run-extra.json carry, per variant: tool calls per trial, duplicate calls (same tool, same args), turns, tool calls and tokens per passing trial, USD per success and wall-clock p50/p95. A self-reported tool event that describes a proxied call is counted once (`tools.reported_prefixes`, `tools.reported_aliases`). Agents report cost on `turn.end.usage: {input_tokens, output_tokens, usd?, usd_estimated?}` (examples/README.md).

**The approval check runs on every trial, whatever the case lists.** A trial may touch a tool your config marks gated: a proxied call, a ledger row, a traced call, or even an effect the agent only self-reports. When it does, the runner adds `approval_invariant` as a gate grader. A case or pack can add graders but cannot remove or downgrade it. It works the same way for `no_upstream_on_guard`, `injection_noncompliance` and `tenant_isolation`.

## CI: the GitHub Action

`ves init` writes `.github/workflows/ves.yml`. Its core is one step:

```yaml
permissions: { contents: read, pull-requests: write, actions: read }
jobs:
  ves:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # ... your agent's own setup (setup-node / setup-python, install) ...
      - uses: <org>/<repo>/integrations/github-action@<40-hex-sha>   # pin by full SHA
        with: { config: ves.config.json }
        env: { OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}' }     # your agent's keys (env_passthrough)
```

On each PR the action does the following:
- **Picks the suite from the base branch.** A PR can't weaken the evals that gate it. Cases the PR adds or edits run beside the base suite as advisory (`--extra-cases`).
- **Classifies the change.** It runs `git diff` through your `change_classes` globs.
- **Finds a baseline.** It uses main's last `ves-results` artifact, otherwise it re-runs the base agent, otherwise it runs with no baseline.
- **Gates the PR.** It fails the check on BLOCK or INVALID, so you can make it a required check.
- **Comments and reports.** It upserts one PR comment (forks are skipped), writes the job summary and annotations, and uploads the results as the next baseline.

Pushes to `main` produce the baseline. The nightly release tier runs REPORT_ONLY. Fork PRs run on the mock connection, report-only.

Other CI:
- **GitLab:** `integrations/gitlab/ves.gitlab-ci.yml`, written by `ves init --ci gitlab`.
- **pre-commit:** the `ves-validate` hook (`.pre-commit-hooks.yaml`) runs `ves validate --strict`. It is offline and costs $0.
- **Anything else:** `ves ci context|baseline|outputs|comment|exit` and `ves report --format pr|summary|junit|annotations`.
- **Deploy steps:** `ves gate --require $SHA --results <dir>` exits 1 unless that SHA has a PASS, so a deploy script can refuse to promote an unevaluated build.

A first run has no baseline. Regression rules (G-6/G-7) need one, so on a first run they are not evaluated, and a PASS with failing non-safety trials says so on the card and in the PR comment. Smoke canaries (G-5) still block without a baseline: a case that fails, and fails again on its retry, is a BLOCK at smoke.

**Baselines are matched by tier.** A smoke PR is compared only with a smoke run, a release PR only with a release run (another tier is another suite, which G-1 would reject). Below Class 2 a comparison is optional, so when main has no run of the PR's tier, the action runs without one rather than re-running the base agent.

**A broken git context fails closed.** When the action cannot read the base commit or diff it (a shallow checkout, a missing base SHA, no git), the PR is not treated as a first run. It is raised to Class 2 (release tier, a baseline required) and an `::error` annotation says why. Check out with `fetch-depth: 0`.

**The generated workflow does not start an HTTP agent or server for you.** Add a step before the VES step that starts it in the background and waits for it, e.g. `- run: (node server.mjs &) ; for i in $(seq 30); do curl -sf http://127.0.0.1:3100/health && break; sleep 1; done`, or use a `command` / stdio connection, which VES starts itself.

## Models

The agent under test always uses its own provider and keys. The harness itself calls a model only for the judge, the user simulator (persona cases), the MCP host-sim and the intent writer, and only when a case or command needs one.

Harness-side model calls default to Google Vertex AI Gemini (`google/gemini-3.8-flash`, location `global`), authenticated with Application Default Credentials: `gcloud auth application-default login` locally, Workload Identity Federation in CI. Any OpenAI-compatible endpoint can be plugged in instead, including a local one.

```json
"models": {
  "default": { "provider": "vertex", "model": "google/gemini-3.8-flash", "project": "${GOOGLE_CLOUD_PROJECT}", "location": "global" },
  "named":   { "local": { "provider": "openai-compatible", "base_url": "http://127.0.0.1:11434/v1", "model": "llama3.1" } },
  "host_sim": "local"
}
```

- **One budget.** All model calls share a content-hash cache (`.ves-cache/models/`) and one spend ledger, capped at the tier's `budget_usd`. Agent-reported spend counts against the same cap. Once the cap is reached, only cached answers are served.
- **Errors.** A provider 401, 429 or 5xx makes the row INVALID, never FAIL.
- **Judges stay advisory until admitted** (`judges/registry.json` is empty at VES-1.0). Safety dimensions are never judged.
- **Offline.** `provider: "fake"` is a deterministic offline model for tests and demos.
- **Claude.** `provider: "vertex"` with `model: "anthropic/claude-sonnet-4-6"` (any `anthropic/claude-*`) runs Claude on Vertex AI through the same ADC token, billed to the same Google Cloud project; enable the model in Vertex Model Garden first. Without Google Cloud, Anthropic's OpenAI-compatible endpoint works too: `{"provider": "openai-compatible", "base_url": "https://api.anthropic.com/v1/", "model": "claude-sonnet-4-6", "api_key_env": "ANTHROPIC_API_KEY"}`. `ves run --simulator <model>` / `--judge <model>` switch one run.

## Dashboard

`ves ui` starts a local, read-only dashboard over your results directory and, if configured, your run store. It binds to `127.0.0.1:4317` by default (`--port` to change it). From a checkout, build it once with `cd ui && npm install && npm run build`; the published package ships the built `ui/dist/`.

It shows run cards (verdict, gate rules, pass^1 with its interval per surface, cost), each trial's trajectory and grader evidence, and three store pages:
- **History:** a pass^1 trend per surface with the CI band, filter chips by branch and tier, and a BREAK marker labelled "cases changed v1->v2" wherever the suite_version changes. Lines and bands never cross a break.
- **Compare:** two run pickers. The default pair is the newest run on the current branch vs the newest earlier main run. The page shows the reading per surface, the flipped-case table, and both trajectories side by side.
- **Case timeline:** one dot per run per surface, each linking to the stored trial.

Run cards also show a pass^1 point delta against the previous comparable run (same tier and suite_version). The server reads the store directly, read-only, and re-hashes each object. For `/api/compare` and `/api/history` it shells out to `node src/cli.ts compare|history --json`, so the statistics live in one place and the UI never imports `src/`.

Also available as `node ui/server/index.mjs --store <url>`, or `VES_STORE=... npm run dev` inside `ui/`.

## The run store: history and comparisons

Every run can be kept forever in a **run store** and compared with any other run. The store is content-addressed and append-only: `ves store push` copies a run directory in unchanged, records the sha256 of every file, and appends one index entry per run. Nothing is ever overwritten or deleted. Pushing the same run again is a no-op when the bytes match, and an error when they differ, so a run edited after the fact is caught (tamper evident). `ves store verify` re-hashes every object.

```sh
npx ves store push results/ves-*                  # or: ves run ... --store   (or "store": {"auto_push": true} in ves.config.json)
npx ves store list --branch main --tier smoke     # --variant v, --since 7d|P7D|2026-11-01, --sha s, --limit n, --json
npx ves store verify                              # exit 1 on any hash mismatch, missing object, or record/index disagreement
npx ves store pull <run_id> --out restored/       # writes restored/<run_id>/ byte for byte, never overwrites
npx ves compare --base main --head <sha|run_id|run-dir>     # or: ves compare <base> <head>; --variant v; --json
npx ves history <case_id> --variant <variant>               # one case across every stored run
```

- **Which store.** The order is `--store <path|gs://bucket/prefix>`, then `$VES_STORE`, then `ves.config.json` `"store": {"url", "project", "auto_push"}` (a relative url is relative to the config file), then `./.ves/store`. The `store` block is not part of `config_sha256`, because where runs are archived does not change what they evaluate.
- **Layout.** The layout is the same on every backend:
  - `objects/sha256/<aa>/<sha256>` holds the file bytes;
  - `runs/<run_id>.json` lists each path's sha256 and size, plus a `tree_sha256` over the list;
  - the index is `index.jsonl` locally, and on GCS one object per run under `index/` (no read-modify-write of a shared file).
- **Index entry.** Each entry holds run_id, created, tier, trigger, verdict and decided_by, target sha, branch, suite_version, config and catalog SHAs, agent models, host families, variants, and pass^1 with its Wilson CI and n per surface. It also holds safety violation counts, case count and cost.
- **Branch.** The branch comes from `--branch`, else `run.json` `target.branch`, else the CI env (`GITHUB_HEAD_REF`, `GITHUB_REF`, `CI_COMMIT_REF_NAME`). Failing those, it comes from git, but only when the checkout's HEAD is the run's target SHA.
- **`ves run --store`.** Without `--store` or `store.auto_push`, `ves run` does not push anywhere. With either, the finished run directory is pushed. A failed push is reported on stderr (and as `"store"` in `--json`), and the exit code stays the gate's.
- **Ordering.** Runs are ordered by their earliest result row's `created_at` (millisecond precision), then push time, then append order. Runs from the same second therefore keep the order they were made in.

**`ves compare`** reports, with delta = head - base:
- **Per surface:** pass^1 delta with the runner's own paired cluster bootstrap by case (10,000 resamples, seed 20261025), Holm across surfaces, and the reading **above / level / below** (STANDARD §5.5). It is the same code path as the gate's G-6.
- **Per case:** the cases that flipped (pass->fail, fail->pass, new, removed, unscored).
- **Safety:** violations new vs fixed. "Fixed" means the same case version is scored in head and no longer violates.
- **Cost:** the cost delta.

**Honesty rule.** Two runs with a different `suite_version` ran different cases, so the aggregate comparison is **refused** (exit 2, `"refused"` in the JSON). Per-case flips are then listed only for cases whose `case_version` is identical in both runs. Cases whose version changed are listed and never compared. Other §5.5 hygiene differences (fixtures, adapters, judge, k, config) are printed as warnings: the comparison is descriptive, not a gate reference.

A ref is a run directory, a run id (or a unique prefix), a SHA (the newest run of it) or a branch. For a branch, compare takes the newest run of the same tier as the other side, preferring the same suite_version, then runs created before the head.

**Google Cloud Storage.** A `gs://bucket/prefix` store uses the GCS JSON API with plain `fetch`. Every object is written with `ifGenerationMatch=0`, so GCS itself refuses to replace one. Auth is Application Default Credentials (`gcloud auth application-default print-access-token`, cached 40 minutes, refreshed once on a 401). Each request sends `x-goog-user-project` from `store.project`, `$VES_STORE_PROJECT` or `$GOOGLE_CLOUD_PROJECT`. The token is only sent in the Authorization header: it is never logged, written, put in an error, or sent to the browser. One-time setup:

```sh
gcloud auth application-default login
gcloud storage buckets create gs://<bucket> --project <project-id> --location=<region> --uniform-bucket-level-access
# suggested: a retention policy makes the archive undeletable for its period, even by project owners
gcloud storage buckets update gs://<bucket> --retention-period=400d      # lock it with --lock-retention-period once you are sure
# then:  "store": { "url": "gs://<bucket>/ves", "project": "<project-id>", "auto_push": true }
```

In CI, give the job's Workload Identity service account `roles/storage.objectCreator` and `roles/storage.objectViewer` on the bucket (no delete permission).

**Relation to the GitHub Action's artifacts.** The action keeps main's **last** run as the `ves-results` artifact. That is the baseline for the next PR (§6.4), and GitHub expires it. The store is the permanent history next to it. The action's baseline logic does not read the store yet. To archive CI runs, add `--store gs://...` (or `store.auto_push`) to the run, or run `ves store push` on the results directory in a later step. Local and CI runs can share one bucket, and the branch and trigger in each index entry tell them apart.

## The standard

VES implements VES-1, a written standard for agent evals: the case and result schemas, the surface adapter contract, grader order, judge admission, statistics, tiers, gate rules, the safety suite and how results are versioned. Read it in [STANDARD.md](STANDARD.md). The schemas are in `schemas/`.

The standard is preregistered. After a version is tagged, rules change only through rows appended to [protocol/LOG.md](protocol/LOG.md), and loosening a bar is a major version change. See [CONTRIBUTING.md](CONTRIBUTING.md#changes-to-the-standard-preregistration-and-amendments).

## Commands

| Command | What it does |
|---|---|
| `ves init` | detect the framework; write the config, bridge, cases and workflow; doctor; offline check |
| `ves run` | run the evals and the gate (`--tier smoke\|release\|research`, `--packs`, `--variants`, `--case`, `--baseline`, `--connection mock`, `--report-only`, `--json`) |
| `ves gate` | pure re-evaluation: `--run <dir>...` (strictest verdict wins), or `--require <sha> --results <dir>` |
| `ves report` | `--format md\|json\|pr\|summary\|junit\|annotations\|claims\|efficiency` (the last two re-read a stored run offline) |
| `ves validate` | check the config, catalog, cases (v1 + v2), pack expansion and oracle replays; offline, $0 |
| `ves packs` | `list \| show \| expand \| synthesize` |
| `ves doctor` | handshake each variant's connection: reachable? declared tools? missing from the catalog? |
| `ves catalog` | `suggest \| import --from agent\|bridge\|mcp\|http\|openai-tools` (merges into `ves.config.json`; `--print` only prints) |
| `ves proxy` | `--connect <url>`: the stdio MCP bridge for stdio-only MCP clients |
| `ves ci` | the CI steps (GitHub and GitLab) |
| `ves store` | `push \| list \| verify \| pull`: the append-only run history (local dir or `gs://`) |
| `ves compare`, `ves history` | run vs run (per-surface delta with paired bootstrap CI, flips, safety, cost); one case across runs |
| `ves ui` | the local read-only dashboard |
| `ves migrate`, `ves classify-change` | v1 -> v2 cases; diff paths -> change class |
| `ves cases from-trace` | a real (failed) conversation -> a redacted regression case: an ATIF trajectory, `--run <dir> --row <ref>`, OpenAI-chat messages or OTel GenAI events; never overwrites without `--force` |

## Layout

| Path | Contents |
|---|---|
| `src/core`, `src/runner`, `src/gate`, `src/lib/stats.ts`, `src/graders`, `src/proxy`, `src/catalog`, `src/cases` | core: runner, proxy, graders, statistics, gate |
| `src/connectors/` | `command`, `http`, `openai-chat`, `mcp`, `trace` (discovered by directory) |
| `src/models/` | Vertex, OpenAI-compatible, fake; cache; ledger; judge; user simulator; intent writer |
| `src/store/` | run store: local and GCS backends, push/verify/pull, compare and history |
| `src/cli/`, `src/report/pr/`, `integrations/` | CLI, `init`, `ci`, PR renderers, GitHub Action, GitLab, pre-commit |
| `packs/` | the six generic packs and the `vibiz` example profile |
| `examples/` | the runnable examples, framework bridges, `index.json` (read by `ves init`) and `run-all.mjs` |
| `schemas/` | config-1, case-1/2, pack-1, result-1/2, run-1/2 |
| `ui/` | the dashboard (its own package) |
| `protocol/LOG.md` | every deviation and fix, append-only |

## Development

```sh
npm test                   # node --test over test/**, network locked by test/setup.ts
npm run typecheck          # needs typescript installed
node examples/run-all.mjs  # every example through the real CLI
cd ui && npm test          # dashboard tests
cd ui && npm run build     # dashboard bundle served by `ves ui`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a grader, a connector or a pack.

## Known limits

- **Framework bridges.** The snippets have not been run (see [Connectors](#connectors)).
- **Contract-mode packs.** In MCP contract mode, cases that check `expect.state` cannot be evaluated: your server, not the sim, holds the state. They count as not met. Assert effects, or use a ledger.
- **Agent packs in contract mode.** They are not applicable on `contract` variants (see [Connectors](#connectors)). Contract mode does not yet check that a server binds an approval to the args it was given (approve `id: n1`, then call with `id: n2`); test that in your server's own suite or on `host-sim`.
- **Pinned pack results.** Some pack templates pin a tool result (rows with `label` and `amount`) that ignores the tool's `output_schema`. An agent that validates tool output strictly can fail those cases for reasons unrelated to safety.
- **Traces.** Trace evidence is `traced`. It can fail a safety check but never pass one, and the baseline arms cannot replay a recorded trace. A trace signed by the VES proxy is not upgraded to `proxied` yet.
- **Not built yet.** `official-conformance` (needs `npx` and the network), the `memory-carryover` isolation case (needs multi-principal sessions), `card.html`, the Postgres run index and sealed sets.
- **Run store.** The GCS backend is tested only against a fake of the JSON API; no real bucket has been written. `ves ci baseline` does not read the store yet. `ves history` reads every stored run's `results.jsonl` (one GET each on GCS). Runs pushed before this feature have no index entry until pushed.
- **Not pinned.** `semconv.lock` and `tools.lock` are not pinned yet.
- **Claims lexicon.** `claims_vs_ledger` is a deterministic lexicon, tuned to prefer missing a claim over inventing one (EN + ES). It does not understand objects: with the default map, any write backs a "removed" claim; map verbs to tools (`graders.claims.map`) when your catalog lets you be stricter. Offline (`ves report --format claims`) a ledger row with no proxied call cannot back a claim.
- **Portability.** `ves init` writes `python` for Python bridges, or `python3` when only that runs on this machine. CI's `setup-python` provides both.
- **Vibiz coupling.** The v1 code path still loads `packs/vibiz/profile.json` at startup, so that pack must stay installed even if you never use it.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to add a connector, a grader or a pack, and how changes to the standard work. Please follow the [code of conduct](CODE_OF_CONDUCT.md), and report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). VES was built at [Vibiz](https://vibiz.ai) and is used on Vibiz's production agent.
