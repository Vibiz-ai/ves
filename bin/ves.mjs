#!/usr/bin/env node
// `ves` entry point (package.json "bin"). The harness is TypeScript run by Node's own type stripping (erasable syntax
// only, no build step, no dependencies). Node refuses to strip types for files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so `npm i -D <harness>` then `npx ves` failed for every user who did
// not install from a symlinked path (dogfood fix 2026-11-07). When this package lives under node_modules, a module
// load hook strips the harness's own .ts files with node:module's stripTypeScriptTypes (the same eraser Node uses)
// and hands them to Node as plain ES modules. Files outside the package (the user's packs, bridges) are untouched.
import module from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url).href;
if (/\/node_modules\//.test(fileURLToPath(ROOT)) && typeof module.registerHooks === 'function' && typeof module.stripTypeScriptTypes === 'function') {
  // stripTypeScriptTypes is marked experimental on some Node lines; its one-time warning is noise for CLI users
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/stripTypeScriptTypes|Type Stripping/i.test(String(w?.message ?? w)) ? undefined : emit.call(process, w, ...rest));
  module.registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(ROOT) && url.endsWith('.ts') && !url.slice(ROOT.length).includes('node_modules/')) {
        return { format: 'module', source: module.stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' }), shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
await import('../src/cli.ts');
