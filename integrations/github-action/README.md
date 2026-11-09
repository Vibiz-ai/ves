# VES eval gate: GitHub Action

A composite action that runs VES on your agent for every PR, whatever framework it is built with, and:

- gates the PR: the step fails on **BLOCK** or **INVALID** (configurable with `fail-on`), so it can be a required check;
- writes the result card to the job summary and failing checks as annotations;
- upserts **one** PR comment per project (it edits its own comment on every push, never piles up new ones);
- uploads `ves-results` as an artifact, which the next PR uses as its **baseline** (pushes to `main` produce it).

No `@actions/*` dependencies: the steps are Node (>= 22.18, set up by the action), `git` and `gh`, which GitHub-hosted
runners already have.

## Quick start

```sh
node path/to/ves/src/cli.ts init      # detects the framework, writes ves.config.json + .github/workflows/ves.yml
```

or add the step yourself after your agent's own setup:

```yaml
permissions: { contents: read, pull-requests: write, actions: read }
jobs:
  ves:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # needed: the suite comes from the base branch, the change class from the diff
      # ... your agent's runtime setup (setup-python + pip install, setup-node + npm ci, ...)
      - uses: <org>/ves/integrations/github-action@<40-hex-sha>   # pin by full commit SHA
        with: { config: ves.config.json }
        env: { OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}' }             # your agent's own keys (env_passthrough)
```

Run it on `pull_request`, on `push` to `main` (produces the baseline) and on a nightly `schedule` (release tier,
report only). The workflow `ves init` writes does all three.

## Inputs

| input | default | meaning |
|---|---|---|
| `config` | `ves.config.json` | path to the config, relative to `working-directory` |
| `working-directory` | `.` | repo dir holding the config (monorepos) |
| `tier` | `auto` | `auto`: PR -> smoke (release for Class 2+); push to main and nightly -> release |
| `packs` | `''` | comma list overriding the config's packs |
| `variants` | `auto` | `auto` or a comma list |
| `trigger` | `auto` | `auto`: PR -> `pr`, push to the default branch -> `deploy`, schedule -> `nightly`, else `manual` |
| `suite-from` | `base` | `base`: config, cases, packs and fixtures come from the PR's base commit (a PR cannot weaken the evals that gate it); `head`: from the PR (self-gating, recorded in the manifest) |
| `baseline` | `auto` | `auto` (artifact, else run the base agent, else none), `artifact`, `run-base`, `none`, or a path |
| `comment` | `true` | upsert the PR comment |
| `fail-on` | `block` | `block` (BLOCK or INVALID fail), `invalid` (INVALID only), `never` |
| `artifact-name` | `ves-results` | results artifact, also the name the baseline lookup downloads |
| `node-version` | `22` | Node for the harness (>= 22.18) |
| `github-token` | `github.token` | comments and artifact lookup |

## Outputs

`verdict` (PASS | BLOCK | INVALID | REPORT_ONLY), `decided-by` (first rule that fired), `run-dir`, `comment-url`.

## What runs, step by step

1. `ves ci context`: trigger, tier, change class (`git diff base...head` through `change_classes`), the suite root
   (a `git worktree` of the base commit), fork and first-run detection, harness identity (the action ref when it is a
   full SHA, else a tree hash). It also lists case files added or changed in the PR: they run as advisory.
2. `ves ci baseline` (PRs): the newest successful run of this workflow on the base branch, artifact `ves-results`,
   newest run with tier >= the current one that passes the pre-run hygiene (valid, same project, same harness, same
   config hash). Otherwise `run-base` runs the base agent from the base worktree (`ves/setup-base.sh` installs its
   dependencies, isolated from the PR's). Otherwise none: a Class 2+ release run is then INVALID at G-1 with "no
   reference", as in VES-1; merge once to `main` to produce one.
3. `ves run ... --json`, then `ves ci outputs` (also writes `pr-comment.md` and `junit.xml` into the run directory).
4. Job summary and annotations (`ves report --format summary|annotations`).
5. `ves ci comment`: finds the comment whose first line is `<!-- ves:pr-comment project=<project> -->` through
   `gh api` (or the REST API when `gh` is missing), PATCHes it, else POSTs one; duplicates it finds are removed.
6. Upload of `$RUNNER_TEMP/ves-results` (90 days).
7. `ves ci exit`: the step's exit code from the verdict and `fail-on`.

## Forks and first runs

- **Fork PRs** get no secrets and a read-only token. The action then runs a wiring-only mock run (`--connection
  mock`, $0), writes the job summary, skips the comment and forces REPORT_ONLY. **Never** switch this workflow to
  `pull_request_target` to get secrets for forks: that runs untrusted fork code with your secrets.
- **First run**: if the base branch has no `ves.config.json` yet, the run uses the PR head in REPORT_ONLY mode, so
  the PR that adds VES never blocks itself.

## Harness-side models

Packs that need a judge, user simulator or host-sim call Vertex AI Gemini through ADC by default. In Actions, use
Workload Identity Federation (`google-github-actions/auth@v2`) before this step; no key file is needed.

## Other CI systems

GitLab: `integrations/gitlab/`. Jenkins, CircleCI, Buildkite, Azure DevOps: run `ves run`, gate on its exit code
(0 PASS / REPORT_ONLY, 1 BLOCK, 2 INVALID, 3 usage), publish `ves report --format junit`, keep `ves-results/` as
the artifact the next run uses with `--baseline`.
