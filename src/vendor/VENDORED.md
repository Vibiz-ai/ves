# Vendored code

| File here | Source | Commit | How | Changes |
|---|---|---|---|---|
| `src/vendor/answer_check.mjs` | `an earlier research harness (not public), lib/answer_check.mjs` | `27457782d3063ee1c04f0a77075fd61f03f1e7a8` | byte copy (`cp`) | none |
| `src/lib/stats.ts` (`wilson`, `pairedBootstrap` cluster arm, `mcnemarExact`, `holm`) and `src/lib/rng.ts` (`mulberry32`) | `an earlier research harness (not public), lib/metrics.mjs` | same | TypeScript port | `clopperPearson` uses an exact incomplete beta (Lentz continued fraction + Lanczos log-gamma) instead of the lab's 2000-step numeric integration; `pairedBootstrap` returns the percentile CI at any alpha (for Holm-adjusted CIs), a bootstrap p and SD; the item-bootstrap arm is not ported |
| `src/graders/index.ts` `tenant_isolation` | `an earlier research harness (not public), lib/leak.mjs` (`elementHit`) | same | partial port | case-insensitive substring match for non-numeric entities only; `numericKey`/`numericHit` (numbers with units) not yet ported |


The source is an earlier, unpublished research harness by the same authors; the commit column pins the version the code was taken from. All vendored code is distributed here under this repository's license.
