#!/usr/bin/env node
// Run every runnable example through the real CLI, once as shipped and once with VES_DEMO_UNSAFE=1 (the agent or
// server skips its approval step), and check each verdict. Local processes and loopback only: no API key, no network,
// $0. Usage: node examples/run-all.mjs [--tier smoke|release] [--out <dir>]
//   exit 0 when every verdict is the expected one, 1 otherwise.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const tier = argv.includes('--tier') ? argv[argv.indexOf('--tier') + 1] : 'smoke';
const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : mkdtempSync(join(tmpdir(), 'ves-examples-'));
const env = { ...process.env, MCP_TEST_TOKEN: 'dev', AGENT_KEY: 'dev' };

// [name, connector, config, server to start (or null), extra args, expected verdict, expected verdict when unsafe]
const EXAMPLES = [
  ['plain-python', 'command', 'examples/plain-python/ves.config.json', null, [], 'PASS', 'BLOCK G-3'],
  ['plain-node', 'command', 'examples/plain-node/ves.config.json', null, [], 'PASS', 'BLOCK G-3'],
  ['http-server', 'http', 'examples/http-server/ves.config.json', ['examples/http-server/agent.ts', '--port', '8000'], [], 'PASS', 'BLOCK G-3'],
  ['openai-compatible', 'openai-chat', 'examples/openai-compatible/ves.config.json', ['examples/openai-compatible/fake-endpoint.mjs', '--port', '4000'], [], 'PASS', 'BLOCK G-3'],
  ['mcp-server-node', 'mcp (http)', 'examples/mcp-server-node/ves.config.json', ['examples/mcp-server-node/server.mjs', '--port', '3100'], [], 'PASS', 'BLOCK G-2'],
  ['mcp-server-python', 'mcp (stdio)', 'examples/mcp-server-python/ves.config.json', null, [], 'PASS', 'BLOCK G-2'],
  ['trace (note)', 'trace', 'examples/trace/ves.config.json', null, ['--case', 'trace.note*'], 'PASS', null],
  ['trace (refund)', 'trace', 'examples/trace/ves.config.json', null, ['--case', 'trace.refund*'], 'BLOCK G-3', null],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withServer(cmd, e, fn) {
  if (!cmd) return fn();
  const p = spawn(process.execPath, cmd, { cwd: ROOT, env: e, stdio: ['ignore', 'ignore', 'pipe'] });
  let ready = false;
  p.stderr.on('data', (d) => { if (/on http:\/\//.test(String(d))) ready = true; });
  for (let i = 0; i < 50 && !ready; i++) await sleep(100);
  try { return await fn(); } finally { p.kill(); await new Promise((r) => p.once('exit', r)); }
}
function run(config, extra, e) {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'run', '--config', config, '--tier', tier, '--out', out, '--json', ...extra], { cwd: ROOT, env: e, encoding: 'utf8' });
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    return { verdict: `${j.verdict}${j.decided_by ? ` ${j.decided_by.split(' ')[0]}` : ''}`, exit: r.status, dir: j.run_dir };
  } catch { return { verdict: `ERROR (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`, exit: r.status, dir: '' }; }
}

const rows = [];
for (const [name, kind, config, server, extra, want, wantUnsafe] of EXAMPLES) {
  const t0 = Date.now();
  const a = await withServer(server, env, async () => run(config, extra, env));
  rows.push({ name, kind, mode: 'as shipped', got: a.verdict, want, ms: Date.now() - t0, dir: a.dir });
  if (wantUnsafe) {
    const ue = { ...env, VES_DEMO_UNSAFE: '1' };
    const t1 = Date.now();
    const b = await withServer(server, ue, async () => run(config, extra, ue));
    rows.push({ name, kind, mode: 'VES_DEMO_UNSAFE=1', got: b.verdict, want: wantUnsafe, ms: Date.now() - t1, dir: b.dir });
  }
}
const pad = (s, n) => String(s).padEnd(n);
process.stdout.write(`tier ${tier}; results in ${out}\n\n${pad('example', 19)}${pad('connector', 13)}${pad('mode', 19)}${pad('verdict', 13)}${pad('expected', 13)}ok\n`);
for (const r of rows) process.stdout.write(`${pad(r.name, 19)}${pad(r.kind, 13)}${pad(r.mode, 19)}${pad(r.got, 13)}${pad(r.want, 13)}${r.got === r.want ? 'yes' : 'NO'}  (${(r.ms / 1000).toFixed(1)} s)\n`);
const bad = rows.filter((r) => r.got !== r.want);
process.stdout.write(`\n${rows.length - bad.length}/${rows.length} as expected\n`);
process.exit(bad.length ? 1 : 0);
