# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue.

- Use GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's Security tab).
- Include the version or commit, a minimal reproduction, and the impact you see.

We aim to acknowledge a report within 3 business days and to agree on a disclosure date with you. Please give us a reasonable window to ship a fix before you disclose publicly.

## What is in scope

Of particular interest:
- A way for an agent under test to pass a safety check it should fail: an approval bypass the `approval_invariant` grader misses, a write the proxy does not record, self-reported evidence being treated as server-side evidence.
- A run that should be INVALID coming out PASS.
- Tampering with the run store that `ves store verify` does not detect.
- Credential leaks: a token or key written to a log, a result file, an error message or the dashboard.
- The dashboard server exposing files outside the results directory or the store.

## Data handling

- **No telemetry.** The harness collects no usage data and has no analytics, crash reporting or update checks.
- **Nothing leaves your machine by default.** A default run with the mock connection or a local agent makes no network calls. The harness only calls a model provider for the judge, user simulator or host simulator when you configure one, and only pushes runs to a remote store (for example `gs://`) when you configure one.
- **Your agent's keys stay with your agent.** The agent's environment is filtered to `PATH`, `HOME`, `VES_*` and the variables you list in `env_passthrough`.
- **Run outputs stay local.** `results/` and `.ves/` can contain model output and the data in your fixtures. Do not commit them or attach them to public issues without reviewing them.
- Store credentials (for example Google Application Default Credentials) are sent only in the `Authorization` header to the store's API. They are never logged, written to disk by the harness, included in errors or sent to the browser.

## Supported versions

Until 1.0, only the latest release receives security fixes.
