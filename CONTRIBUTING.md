# Contributing to VES

Thanks for helping. This file covers how to run the tests, the four most common kinds of change (a grader, a connector, a pack, a fix to the rules) and the one process rule that is not negotiable: changes to the standard go through the amendment log.

## Setup

You need Node 22.18 or newer. Node runs the TypeScript sources directly, so there is no build step for the harness.

```sh
npm ci                      # root: the harness has no runtime dependencies
npm test                    # node --test over test/**; test/setup.ts blocks network access
npm run typecheck           # tsc -p tsconfig.json (needs typescript installed)
node examples/run-all.mjs   # every runnable example through the real CLI, offline

cd ui && npm ci && npm test # the dashboard has its own package and tests
```

A mock smoke run, offline and free:

```sh
node src/cli.ts run --config examples/plain-node/ves.config.json --tier smoke --connection mock --out results
```

## Ground rules

- **Tests never touch the network.** `test/setup.ts` blocks `fetch` and sockets. Use fakes: in-memory child processes, a `fetch` that calls in-process handlers, or the local example servers.
- **No telemetry, no default egress.** The harness only calls a model provider or a store that you configured. Do not add calls home, update checks or analytics.
- **Zero runtime dependencies** in the harness. The `ui/` package has its own dependencies.
- **The agent's word is never evidence of safety.** Safety graders read only server-side records: proxied calls, the upstream ledger, sim state. Self-reported or traced evidence can fail a safety check but never pass one.
- **Judges never gate.** An LLM judge stays advisory until it is admitted through calibration (STANDARD §4.3), and safety dimensions are never judged.
- Keep docs plain and direct. No emojis.

## Add a grader

There are two kinds.

**A pack grader** (most contributions). Export it from your pack's `pack.ts`:

```ts
import type { PackModule } from '../../src/core/types.ts';
export default {
  graders: [{
    id: 'my-pack/no_apology_loop', version: '1.0.0', kind: 'code',
    grade(x, params) { /* x is a GradeCtx2: x.c holds the collected calls, ledger, delivered text and state */ return { pass: true, explanation: 'no loop', evidence: [] }; },
  }],
} satisfies PackModule;
```

- A pack may only register graders under its own id (`<pack id>/*`). Registration happens in `src/registry/packs.ts`.
- Set `safety: true` only for graders that read server-side evidence. A safety score counts toward gate rule G-3, and no override clears it.
- Bump `version` on any change in behaviour. A fix is a patch bump.

**A core grader** (`src/graders/`). Core graders are part of the standard. Add the id to `GRADER_VERSION`, follow the grading order in STANDARD §4.1 (state, then trace, then model-free text, then judge), and add tests in `test/graders.test.ts`. A new core grader, or a change to what an existing one accepts, needs an amendment row (see below).

## Add a connector

Connectors are discovered by directory. See `src/connectors/README.md` for the full contract.

1. Create `src/connectors/<name>/index.ts`. Directories starting with `_` are shared code and are skipped.
2. Default-export a `ConnectorFactory`: `{ kind, version, create(cfg, deps) }` (`src/core/types.ts`).
3. Route every tool call through `HarnessIO.callTool()`, which is the proxy. Report everything else with `report(ev, level)`.
4. Map provider and host errors (`origin: 'provider' | 'host'`) to INVALID, and agent errors to FAIL.
5. Add tests under `test/connectors/` using fakes only, and a runnable example under `examples/<name>/` with an entry in `examples/index.json` if `ves init` should offer it.

No shared file needs editing. Duplicate kinds are a startup error.

## Add a pack

A pack is a directory with `pack.json` (schema `schemas/pack-1.schema.json`), optional `templates/*.tmpl.json` and an optional `pack.ts`.

- Harness packs live in `packs/<id>/`. Repo-local packs live in `ves-packs/<id>/` in the user's repo.
- Templates bind to tools by **class** (`read`, `write`, `gated`, ...), never by tool name, so a pack works on any catalog.
- Before a pack ships, it must meet two bars on every test catalog: the oracle passes 100%, and the do-nothing agent passes 5% or less per unit. `test/packs/validity.test.ts` checks this.
- Write a `README.md` for the pack: what it catches, what it needs, and its known limits. `ves packs show <id>` prints it.
- Check expansion on the bundled catalogs with `ves packs expand <id> --out <dir>` and `ves validate`.

## Changes to the standard: preregistration and amendments

The rules in [STANDARD.md](STANDARD.md) are preregistered. Once a version is tagged, nobody edits the rules in place.

- **Every deviation or fix goes in `protocol/LOG.md`**, as a new row at the bottom. The log is append-only: never edit or delete an existing row.
- A row has: number, date, section, the deviation or fix, the reason, the measured impact, and the commit.
- **Loosening a bar** (a threshold, delta, k, a safety rule) is a major version change and needs a written amendment with its reason. Tightening is a minor change.
- A change to a case's meaning bumps its `version`. A change to a grader's behaviour bumps its `grader_version`. `suite_version` is a content hash, so comparisons across suite versions are refused automatically.
- Do not edit a case and the agent change it gates in the same PR.

If your PR changes what the gate accepts, say so in the PR description and include the LOG.md row.

## Pull requests

- One topic per PR. Include tests.
- Run `npm test`, `npm run typecheck` and the UI tests before you open it.
- Never commit run outputs (`results/`, `.ves/`), caches or `.env` files. They are in `.gitignore` for a reason: they can contain model output and workspace data.

By contributing, you agree that your contributions are licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
