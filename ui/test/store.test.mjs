// Store endpoints of the read-only API: a local store written by the real harness CLI (`ves store push`), a gs://
// store over a fake GCS JSON API (injected fetch + token: no network, and the token must never reach a response),
// and /api/compare + /api/history shelling out to the CLI (real for local, fake runner for the error paths).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createApi } from '../server/api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const harness = join(here, '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'ves-ui-store-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const RID = 'ves-20261107T100000Z-deadbeef';
const RID2 = 'ves-20261107T110000Z-cafebabe';

// two runs of the fixture: the second with one trial flipped to pass, pushed with the real CLI
cpSync(join(here, 'fixtures', 'results'), join(tmp, 'results'), { recursive: true });
cpSync(join(tmp, 'results', RID), join(tmp, 'results', RID2), { recursive: true });
for (const f of ['run.json', 'results.jsonl', 'gate.json']) {
  const p = join(tmp, 'results', RID2, f);
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll(RID, RID2));
}
const store = join(tmp, 'store');
execFileSync(process.execPath, [join(harness, 'src', 'cli.ts'), 'store', 'push', join(tmp, 'results', RID), join(tmp, 'results', RID2), '--store', store, '--branch', 'main'], { cwd: tmp, stdio: 'pipe' });

const api = createApi({ resultsDir: join(tmp, 'results'), repoDir: join(tmp, 'repo'), storeUrl: store, currentBranch: 'feat/x' });
after(() => api.close());
const get = (u) => api.handle('GET', u);

test('GET /api/store/runs lists the index with suite labels and the current branch', async () => {
  const { status, body } = await get('/api/store/runs');
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.kind, 'local');
  assert.equal(body.current_branch, 'feat/x');
  assert.deepEqual(body.entries.map((e) => [e.run_id, e.seq, e.suite_label, e.target.branch]), [[RID, 0, 'v1', 'main'], [RID2, 1, 'v1', 'main']]);
  assert.ok(body.entries[0].surfaces && typeof body.entries[0].surfaces === 'object');
});

test('stored run, rows and trajectory come from the content-addressed objects', async () => {
  const r = await get(`/api/store/runs/${RID}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.gate.verdict, 'BLOCK');
  assert.ok(r.body.card.includes('Per-surface'));
  const rows = await get(`/api/store/runs/${RID}/rows`);
  assert.equal(rows.body.rows.length, 5);
  const t = await get(`/api/store/runs/${RID}/trajectory?row=${encodeURIComponent(`${RID}|demo.approval@1|slack|1`)}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.atif.steps.length, 3);
  assert.deepEqual(t.body.snapshot_sim.writes[0].canonical, 'orders.refund');
  assert.equal((await get('/api/store/runs/ves-20991231T000000Z-00000000')).status, 404);
  assert.equal((await get('/api/store/runs/..%2Fx')).status, 400);
});

test('a modified object in the store is detected on read (hash mismatch), never served', async () => {
  const s2 = join(tmp, 'store-tampered');
  cpSync(store, s2, { recursive: true });
  const rec = JSON.parse(readFileSync(join(s2, 'runs', `${RID}.json`), 'utf8'));
  const card = rec.files.find((f) => f.path === 'card.md');
  const p = join(s2, 'objects', 'sha256', card.sha256.slice(0, 2), card.sha256);
  chmodSync(p, 0o644);
  writeFileSync(p, 'forged');
  const api2 = createApi({ resultsDir: join(tmp, 'results'), repoDir: tmp, storeUrl: s2, currentBranch: null });
  const r = await api2.handle('GET', `/api/store/runs/${RID}`);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /does not match its hash/);
  api2.close();
});

test('/api/compare and /api/history shell out to `ves compare|history --json` and return their JSON', async () => {
  const c = await get(`/api/compare?a=${RID}&b=${RID2}`);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.schema_version, 'ves-compare/1');
  assert.equal(c.body.base.run_id, RID);
  assert.equal(c.body.head.run_id, RID2);
  assert.equal(c.body.comparable, true);
  const h = await get('/api/history?case=demo.approval');
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.case_id, 'demo.approval');
  assert.equal(h.body.runs.length, 2);
  assert.equal((await get('/api/compare?a=--evil&b=x')).status, 400, 'refs are run ids, never flags');
  assert.equal((await get('/api/history?case=--json')).status, 400);
});

test('compare: CLI exit 2 (refused) still returns the JSON; other failures return the stderr message', async () => {
  const calls = [];
  const runCli = async (args, env) => {
    calls.push({ args, env });
    if (args.includes('bad')) return { code: 3, stdout: '', stderr: 'no stored run matches "bad"' };
    return { code: 2, stdout: JSON.stringify({ schema_version: 'ves-compare/1', comparable: false, refused: { reason: 'suite_version differs', detail: [] } }), stderr: '' };
  };
  const api3 = createApi({ resultsDir: tmp, repoDir: tmp, storeUrl: 'gs://ves-runs/demo', storeProject: 'test-project', runCli, fetch: async () => { throw new Error('unused'); }, token: async () => 'tok', currentBranch: null });
  const r = await api3.handle('GET', '/api/compare?a=r1&b=r2');
  assert.equal(r.status, 200);
  assert.equal(r.body.refused.reason, 'suite_version differs');
  assert.deepEqual(calls[0].args, ['compare', 'r1', 'r2', '--store', 'gs://ves-runs/demo', '--json']);
  assert.deepEqual(calls[0].env, { VES_STORE_PROJECT: 'test-project' });
  const bad = await api3.handle('GET', '/api/compare?a=bad&b=r2');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /no stored run matches/);
  api3.close();
});

test('no store configured: the endpoints say so instead of failing', async () => {
  const api4 = createApi({ resultsDir: tmp, repoDir: tmp, storeUrl: null, currentBranch: null });
  const r = await api4.handle('GET', '/api/store/runs');
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, false);
  assert.deepEqual(r.body.entries, []);
  assert.equal((await api4.handle('GET', '/api/compare?a=x&b=y')).status, 404);
  api4.close();
});

test('gs:// store: read over the GCS JSON API with a server-side ADC token that never reaches a response', async () => {
  // mirror the local store into a fake bucket under a prefix
  const objects = new Map();
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else objects.set(`team/${relative(store, p)}`, readFileSync(p)); } };
  walk(store);
  // gcs keeps one index object per run instead of index.jsonl
  objects.delete('team/index.jsonl');
  for (const line of readFileSync(join(store, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) objects.set(`team/index/${JSON.parse(line).run_id}.json`, Buffer.from(line));
  const TOKEN = 'ya29.server-side-only';
  const seen = [];
  let tokens = 0;
  const fetch = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization, proj: init.headers['x-goog-user-project'] });
    const u = new URL(url);
    const res = (status, body) => ({ status, text: async () => String(body), arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return res(401, '{"error":{"message":"bad token"}}');
    let m = /^\/storage\/v1\/b\/ves-runs\/o\/(.+)$/.exec(u.pathname);
    if (m) { const b = objects.get(decodeURIComponent(m[1])); return b ? res(200, b) : res(404, '{}'); }
    m = /^\/storage\/v1\/b\/ves-runs\/o$/.exec(u.pathname);
    if (m) { const pfx = u.searchParams.get('prefix'); return res(200, JSON.stringify({ items: [...objects.keys()].filter((k) => k.startsWith(pfx)).map((name) => ({ name })) })); }
    return res(400, '{}');
  };
  const token = async () => { tokens++; return tokens === 1 ? 'stale' : TOKEN; };
  const api5 = createApi({ resultsDir: tmp, repoDir: tmp, storeUrl: 'gs://ves-runs/team', storeProject: 'test-project', fetch, token, currentBranch: null });
  const r = await api5.handle('GET', '/api/store/runs');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, 'gcs');
  assert.equal(r.body.url, 'gs://ves-runs/team');
  assert.deepEqual(r.body.entries.map((e) => e.run_id), [RID, RID2]);
  const rows = await api5.handle('GET', `/api/store/runs/${RID2}/rows`);
  assert.equal(rows.body.rows.length, 5);
  assert.ok(seen.every((s) => s.proj === 'test-project' && s.url.startsWith('https://storage.googleapis.com/') && !s.url.includes(TOKEN)));
  assert.equal(tokens, 2, 'a 401 refreshes the token once');
  for (const body of [r.body, rows.body]) assert.ok(!JSON.stringify(body).includes(TOKEN) && !JSON.stringify(body).includes('stale'), 'the token never reaches the browser');
  api5.close();
});
