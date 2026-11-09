# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Changes to the standard's rules are also logged, row by row, in [protocol/LOG.md](protocol/LOG.md).

## [Unreleased]

### Added
- `examples/personas`: the support-desk example with three simulated customers (`personas/*.persona.json`) and one persona case each; `npm run demo` and `npm run demo:personas`.
- `claims_vs_ledger` grader: checks what the agent said it did against what the proxy and the upstream ledger recorded; `silent_actions` (advisory) flags the reverse.
- Persona cases: `input.persona` now runs. A user simulator plays the person against the agent (say, approval decisions, stop) for up to `max_user_turns`; simulated messages are tagged in the trajectory and the row carries a `persona` record. Simulator failures are INVALID, never FAIL.
- Persona library `personas/<id>.persona.json` (`ves-persona/1`, `schemas/persona-1.schema.json`), referenced with `input.persona.ref`; `ves personas list | show`, `ves run --persona <glob>`.
- `persona_outcome` grader (judge, always advisory: goal_met, gave_up, frustration, tone_fit, why) and `persona_metrics` (deterministic: user turns, turns to goal, reply chars per turn, language match; gates only when a case says so).
- Claude on Vertex AI: `provider: "vertex"` with an `anthropic/claude-*` model (rawPredict, ADC, list prices); `ves run --simulator` / `--judge` to switch the harness model for one run.

### Changed
- `ves-case/2` schema (backward-compatible): `input.persona` takes `ref`, `name`, `background`, `languages`, `style`, `opening`, and `temperament` as one value or a list; `id`/`temperament`/`goal` are required only for an inline persona; `input` may be a persona alone. `ves-result/2` rows gain an optional `persona` object.
- User simulator prompt `ves-user-sim/2` (new SHA): renders the new persona fields, allows approvals answered in chat, and returns a stop `outcome`.
- `packs/vibiz` is now documented as an example production profile: illustrative paths in `profile.json`, the agent deploy target renamed `agent` (run-1 schema too), so its suite_versions change. See protocol/LOG.md row 12.
- README rewritten; dashboard screenshots in `docs/images/`.

## [0.1.0] - 2026-11-08

First public release.

### Added
- Framework-agnostic harness: `ves.config.json`, tool catalog bound by class, case schemas `ves-case/1` and `ves-case/2`.
- Connectors: `command` (JSONL over stdio), `http`, `openai-chat`, `mcp` (HTTP and stdio, contract and host-sim) and `trace` (OTel GenAI, Vercel AI SDK spans, ATIF, OpenAI Agents JSONL).
- Tool proxy that records every call server-side, with upstream-ledger support for detecting writes the proxy did not see.
- Safety graders that run on every trial: `approval_invariant`, `no_upstream_on_guard`, `injection_noncompliance`, `tenant_isolation`.
- Packs: `core-tool-use`, `hitl-approval`, `prompt-injection`, `data-isolation`, `over-refusal`, `mcp-conformance`, plus the `vibiz` example production profile.
- Statistics: pass^k, Wilson and Clopper-Pearson intervals, paired cluster bootstrap, Holm step-down.
- Deploy gate with PASS, BLOCK and INVALID verdicts and suite-validity controls (oracle, do-nothing and always-act baselines).
- CLI: `init`, `run`, `gate`, `report`, `validate`, `packs`, `doctor`, `catalog`, `proxy`, `ci`, `store`, `compare`, `history`, `migrate`, `classify-change`, `ui`.
- GitHub Action, GitLab template and pre-commit hook.
- Content-addressed, append-only run store (local directory or Google Cloud Storage) with `compare` and `history`.
- Read-only local dashboard (`ves ui`) with run cards, trajectories, history and compare pages.
- Runnable offline examples and bridges for common agent frameworks.
- The VES-1 standard (STANDARD.md) and the append-only protocol log.
