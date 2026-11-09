# VES pre-commit and local loop

`ves validate --strict` checks `ves.config.json`, the tool catalog, every case (v1 and v2), pack expansion and the
oracle replay on the MockAgent. It is offline, costs $0 and runs in seconds, so it fits a pre-commit hook. The agent
is never run at commit time.

## pre-commit (https://pre-commit.com)

Two ways to wire it, depending on where the harness lives.

**From the harness repository** (pinned by SHA). pre-commit looks for `.pre-commit-hooks.yaml` at the root of the
hook repository; this file lives in `integrations/pre-commit/`, so the harness repo root must carry a copy or a
symlink of it (see the ci package report). Then:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/<org>/ves
    rev: <40-hex-sha>
    hooks:
      - id: ves-validate
```

**Local hook** (works today, with the harness checked out or vendored anywhere):

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: ves-validate
        name: ves validate (offline, $0)
        entry: node path/to/ves/src/cli.ts validate --strict
        language: system
        pass_filenames: false
        files: ^(ves\.config\.json|ves\.intents\.json|evals/)
```

Node >= 22.18 must be on `PATH` (the harness is TypeScript run by Node's type stripping, no build step).

## Plain git hook (no pre-commit)

```sh
printf '#!/bin/sh\nexec node path/to/ves/src/cli.ts validate --strict\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Optional pre-push: a smoke run that never blocks

A smoke run talks to your real agent (and its model), so it is slower and may cost the agent's own tokens. As a
pre-push hook it should report, not block:

```yaml
  - repo: local
    hooks:
      - id: ves-smoke
        name: ves smoke (report only)
        entry: node path/to/ves/src/cli.ts run --tier smoke --report-only
        language: system
        pass_filenames: false
        stages: [pre-push]
```

## Local loop

| Command | What it does |
|---|---|
| `ves run --tier smoke` | real agent, $0 harness-side |
| `ves run --tier smoke --connection mock` | authoring cases: oracle replay, no agent |
| `ves run --baseline ves-results/<main run>` | compare against a main-branch run locally |
| `ves report --run ves-results/<run> --format md` | the card |
| `ves report --run ves-results/<run> --format pr` | the PR comment exactly as CI posts it |
