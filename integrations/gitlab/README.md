# VES on GitLab CI

`ves init --ci gitlab` writes `ves.gitlab-ci.yml` (from `ves.gitlab-ci.yml` here) with the harness pinned by commit
SHA. Include it from your `.gitlab-ci.yml`:

```yaml
include:
  - local: ves.gitlab-ci.yml
```

It runs on merge-request pipelines, on the default branch (which produces the baseline artifact) and on schedules.

| Piece | How |
|---|---|
| Context | `ves ci context --gitlab` -> `ves.env` (`VES_TRIGGER`, `VES_TIER`, `VES_CHANGE_CLASS`, `VES_SUITE_ROOT`, ...). Suite from the MR's base commit (a worktree), like the GitHub action |
| Baseline | `ves ci baseline --gitlab` downloads `jobs/artifacts/<default branch>/download?job=ves` with `CI_JOB_TOKEN` and applies the same pre-run hygiene; else runs the base agent; else none |
| Gate | `ves ci exit --verdict ... --fail-on block` (set `VES_FAIL_ON` to `invalid` or `never` to relax) |
| MR comment | one note per project, upserted through `/projects/:id/merge_requests/:iid/notes`; needs a masked `GITLAB_TOKEN` (project access token, `api` scope). Skipped for MRs from forks |
| Test report | `ves report --format junit` -> `ves-results/junit.xml`, shown in the MR widget |

The job image is `node:22`. If your agent needs another runtime, use your own image with Node >= 22.18 added, or
install the runtime in `before_script`.
