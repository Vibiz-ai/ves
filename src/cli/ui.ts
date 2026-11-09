// `ves ui`: starts the read-only dashboard in ui/ (its own Vite app and server). The dashboard only reads run
// directories; it never imports harness code, so the eval logic stays independent of the UI.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Args, str } from './args.ts';
import { resolveStoreUrl } from '../store/resolve.ts';

export function cmdUi(a: Args, root: string): Promise<number> {
  const server = join(root, 'ui', 'server', 'index.mjs');
  if (!existsSync(join(root, 'ui', 'dist', 'index.html'))) {
    process.stderr.write(`The dashboard is not built. Run: cd ${join(root, 'ui')} && npm install && npm run build\n`);
    return Promise.resolve(2);
  }
  const args = [server, '--results', resolve(str(a.results) ?? 'results'), '--repo', resolve(str(a.repo) ?? '.'), '--port', str(a.port) ?? '4317'];
  // the run store for History / Compare: --store, $VES_STORE, ves.config.json store.url, else ./.ves/store if it exists
  const st = resolveStoreUrl({ arg: typeof a.store === 'string' ? a.store : undefined, config: str(a.config), env: process.env, cwd: process.cwd() });
  if (st.source !== 'default' || existsSync(st.url)) args.push('--store', st.url);
  if (st.project) args.push('--store-project', st.project);
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => done(code ?? 0));
  });
}
