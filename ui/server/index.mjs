#!/usr/bin/env node
// VES UI server: serves the built SPA (ui/dist) and the read-only JSON API on 127.0.0.1.
//   node ui/server/index.mjs --results <dir> [--port 4317] [--repo <harness dir>] [--store <dir|gs://bucket/prefix>] [--store-project <gcp project>]
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, defaultDirs, isInside } from './api.mjs';

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
      out[k] = v;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('usage: node ui/server/index.mjs --results <dir> [--port 4317] [--repo <dir>] [--store <dir|gs://bucket/prefix>] [--store-project <project>]\n  Read-only. Binds 127.0.0.1 only. A gs:// store is read with ADC on the server; the token never reaches the browser.');
  process.exit(0);
}
const defaults = defaultDirs(uiDir);
const resultsDir = args.results ? resolve(args.results) : defaults.resultsDir;
const repoDir = args.repo ? resolve(args.repo) : defaults.repoDir;
const storeUrl = args.store ? (args.store.startsWith('gs://') ? args.store : resolve(args.store)) : defaults.storeUrl;
const storeProject = args['store-project'] ?? defaults.storeProject;
const port = Number(args.port ?? process.env.PORT ?? 4317);
const distDir = join(uiDir, 'dist');

const api = createApi({ resultsDir, repoDir, storeUrl, storeProject });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

function serveStatic(req, res) {
  if (!existsSync(distDir)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`No build at ${distDir}. Run \`npm run build\` in ui/ first (or use \`npm start\`, which builds then serves).`);
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname); }
  catch { res.writeHead(400); res.end('bad url'); return; }
  let file = resolve(distDir, '.' + pathname);
  if (!isInside(distDir, file)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, 'index.html'); // SPA fallback
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const immutable = file.includes(`${join(distDir, 'assets')}`);
  res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
}

const server = createServer((req, res) => {
  api.middleware(req, res, () => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    serveStatic(req, res);
  });
});

server.listen(port, '127.0.0.1', () => {
  const ok = existsSync(resultsDir);
  console.log(`VES UI  http://127.0.0.1:${port}`);
  console.log(`results ${resultsDir}${ok ? '' : '  (missing: run `npx ves run --tier smoke` or pass --results <dir>)'}`);
  console.log(`repo    ${repoDir}`);
  console.log(`store   ${storeUrl ?? '(none: History and Compare need --store <dir|gs://bucket/prefix>)'}`);
});

const stop = () => { api.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
