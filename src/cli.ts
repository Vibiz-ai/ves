#!/usr/bin/env node
// ves CLI entry (DESIGN-agnostic §5). Exit codes: 0 PASS / REPORT_ONLY, 1 BLOCK, 2 INVALID, 3 usage or validation error.
//   ves run      [--config ves.config.json] [--tier smoke|release|research] [--packs a,b] [--variants a,b|auto] [--case <glob>]
//                [--trigger manual|pr|deploy|pre_release|nightly|canary|research] [--target <sha>] [--branch <b>]
//                [--change-class 0-3|auto] [--base-ref <ref>] [--baseline <run-dir>|none] [--anchor <run-dir>]
//                [--connection mock] [--report-only] [--out <dir>] [--json] [--override-by x --override-reason y]
//                [--profile vibiz]   # the Vibiz profile: v1 cases, surfaces and mock adapter, exact v1 semantics
//                # v1 aliases kept: --suite --surfaces --adapter mock|real --compare --differs-in --deploy-targets --fault --history --quarantine
//   ves validate [paths...] [--config ves.config.json] [--strict] [--json] | --profile vibiz [dirs...]
//   ves packs    list | show <id> | expand <id> [--out dir]
//   ves catalog  suggest | import --from openai-tools <file>
//   ves gate     --run <dir> [--run <dir>] | --require <sha> [--results <dir>] [--change-class n]
//   ves report   --run <dir> --format md|json|pr|summary|junit|annotations
//   ves migrate  <dir> --to 2 --profile vibiz [--out <dir>]
//   ves classify-change [--config ves.config.json] [--files-from f] [paths...] [--model-change] [--new-variant] [--protocol-change]
//   ves init | ves ci ...   (ci package)
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './cli/commands.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
main(process.argv.slice(2), ROOT).then((c) => process.exit(c), (e) => { console.error(e?.message ?? e); process.exit(e?.usage ? 3 : 2); });
