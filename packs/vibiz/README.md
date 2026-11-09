# vibiz (example production profile)

The VES-1 seed suites written for Vibiz's production agent, kept as a worked example of a full production profile on the generic core (DESIGN-agnostic §4.9). The business in the fixtures (Lumen Yoga, Sunrise Pilates) is fictional, and the paths in `profile.json` are illustrative, not a real repository layout.

| Path | What it is |
|---|---|
| `cases/smoke/*.case.json` (14), `cases/safety/*.case.json` (19) | The VES-1 seed suites, `ves-case/1`. |
| `cases/safety/README.md` | The "legitimate yes" table per surface, and the twin pairs |
| `fixtures/` | The `lumen-yoga` sim org, the `sunrise-pilates` foreign tenant and the injection plants |
| `catalog.v1.json` | The former `canonical-ids.json` |
| `profile.json` | The Vibiz data that used to be hard-coded in `src/`: surfaces as variants, the class map, `plant_locations`, deploy targets, change-class paths, stub plans, `gate.safety_observation: "ledger"`, and `require_commit_sha` |
| `pack.json` | `requires.profile: "vibiz"`; `cases` lists the two suite directories (the same as `profile.json` `suites.release`) |
| `pack.ts` | Refuses loudly when a v2 config run enables this pack (see below) |

## How to run it

| What you want | Command |
|---|---|
| Run the Vibiz suites with exact v1 semantics (the v1 MockAdapter and Sim) | `ves run --profile vibiz --tier smoke\|release` (`npm run smoke:mock`, `npm run release:mock`) |
| Run them in a `ves.config.json` | Convert them first: `ves migrate packs/vibiz/cases --to 2 --profile vibiz`. Migration is explicit only (§3.6). |
| Add the generic packs to Vibiz | Add them to a `profile: "vibiz"` config (`"packs": ["hitl-approval", "prompt-injection", …]`) |

**Why `pack.ts` refuses.** This pack has no v2 cases, so in a v2 config run it would add an empty suite without a word. Instead, enabling it there is an expansion error that says where its cases run.

**What the generic packs bind.** They bind the Vibiz catalog by class:

| Pack | Vibiz tools it binds |
|---|---|
| `hitl-approval` | `ads.delete`, `ads.launch` |
| `prompt-injection` | source `billing.read`, targets `ads.delete` and `ads.launch` |
| `data-isolation` | `email.send` and `email.send_template` for `export-outward` |

All five pass on MockAgent over the Vibiz catalog (`test/packs/vibiz.test.ts`).
