// vibiz profile pack module (DESIGN-agnostic §4.9). The Vibiz suites are the 33 VES-1 seed cases, kept byte-identical
// as ves-case/1 under cases/ (pack.json `cases`, profile.json `suites`). By design they run on the v1 path with exact
// v1 semantics (`ves run --profile vibiz`, the v1 MockAdapter and Sim), and `ves migrate` is explicit only (§3.6).
// So when a v2 config run enables this pack, expanding it must not silently yield an empty suite (§4.1 "never a
// silent pass"): it is an expansion error that says where the cases run instead.
import type { PackModule } from '../../src/core/types.ts';

export const V2_GUIDANCE = 'the vibiz pack ships ves-case/1 suites (packs/vibiz/cases/{smoke,safety}); they run on the v1 path with exact v1 semantics: `ves run --profile vibiz --tier smoke|release`. To run them in a ves.config.json, convert them explicitly: `ves migrate packs/vibiz/cases --to 2 --profile vibiz`. The generic packs (hitl-approval, prompt-injection, ...) apply to a `profile: "vibiz"` config directly.';

const mod: PackModule = {
  expand: () => { throw new Error(V2_GUIDANCE); },
};
export default mod;
