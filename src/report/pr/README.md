# src/report/pr/ (owned by the ci package, DESIGN-agnostic §7.4)

`src/registry/report.ts` imports `src/report/pr/index.ts` for `ves report --format pr|summary|junit|annotations`.
It must export `renderPrComment`, `renderJobSummary`, `renderJUnit`, `renderAnnotations` (types: `PrReportModule`
and `CardModel` in `src/core/types.ts`). Input is `buildCardModel(runDir)` from `src/report/model.ts`; every run
also writes `card-model.json`. `ves init` / `ves ci` load from `src/cli/init.ts` and `src/cli/ci.ts` (default export
`CliCommand`) through `src/registry/commands.ts`.
