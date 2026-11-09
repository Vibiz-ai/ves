// Run store: content-addressed, append-only, tamper evident. Local backend on temp dirs; gcs backend on an in-memory
// fake of the GCS JSON API (injected fetch, no network).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LocalBackend } from '../../src/store/local.ts';
import { GcsBackend, parseGsUrl } from '../../src/store/gcs.ts';
import { detectBranch, RunStore, treeHash, walkRunDir } from '../../src/store/store.ts';
import { openStore, resolveStoreUrl } from '../../src/store/resolve.ts';
import { objectKey, StoreError, type StoreFetch } from '../../src/store/types.ts';
import { makeRun } from './fixtures.ts';

const TMP = mkdtempSync(join(tmpdir(), 'ves-store-test-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => { const d = join(TMP, `${name}-${n++}`); mkdirSync(d, { recursive: true }); return d; };
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const BR = { branch: 'main', source: 'args' as const };
const at = (iso: string) => () => new Date(iso);

function sampleRun(root: string, id = 'ves-20261107T100000Z-aaaaaaaa', fail: string[] = []) {
  return makeRun(root, { run_id: id, suite: 'S1', surfaces: ['web'], cases: ['c1', 'c2', 'c3', 'c4'].map((c) => ({ id: c, web: fail.includes(c) ? ['fail'] : ['pass'] })), extraFiles: { 'trajectories/c1.atif.json': '{"steps":[]}', 'card.md': '# card\n' } });
}

test('local: push stores every file content-addressed; a second identical push is a no-op', async () => {
  const run = sampleRun(fresh('runs'));
  const store = new RunStore(new LocalBackend(fresh('store')), { now: at('2026-11-07T10:05:00Z') });
  const r1 = await store.push(run, { branch: BR });
  assert.equal(r1.status, 'stored');
  assert.equal(r1.files, walkRunDir(run).length);
  assert.ok(r1.new_objects > 0 && r1.new_objects <= r1.files);
  const r2 = await store.push(run, { branch: BR });
  assert.equal(r2.status, 'unchanged');
  assert.equal(r2.new_objects, 0);
  const { entries } = await store.index();
  assert.equal(entries.length, 1, 'no second index entry');
  const e = entries[0];
  assert.equal(e.run_id, 'ves-20261107T100000Z-aaaaaaaa');
  assert.equal(e.target.branch, 'main');
  assert.equal(e.branch_source, 'args');
  assert.equal(e.suite_version, 'S1'.padEnd(64, '0'));
  assert.equal(e.tier, 'smoke');
  assert.equal(e.verdict, 'PASS');
  assert.equal(e.surfaces.web.pass1, 1);
  assert.equal(e.surfaces.web.n_cases, 4);
  assert.equal(e.case_count, 4);
  // the record is the content address of the directory
  const rec = (await store.record(e.run_id))!;
  assert.equal(rec.tree_sha256, treeHash(rec.files));
  assert.equal(e.tree_sha256, rec.tree_sha256);
  for (const f of rec.files) assert.equal(f.sha256, sha(readFileSync(join(run, f.path))));
  assert.equal((await store.verify()).ok, true);
});

test('local: a changed run dir with the same run_id is refused (tamper evident); the store keeps the original', async () => {
  const run = sampleRun(fresh('runs'));
  const store = new RunStore(new LocalBackend(fresh('store')));
  await store.push(run, { branch: BR });
  writeFileSync(join(run, 'card.md'), '# card, edited after the push\n');
  await assert.rejects(store.push(run, { branch: BR }), (e: StoreError) => e.code === 'tamper' && /DIFFERENT content/.test(e.message) && /~card\.md/.test(e.message));
  assert.equal(new TextDecoder().decode((await store.readFile('ves-20261107T100000Z-aaaaaaaa', 'card.md'))!), '# card\n');
  assert.equal((await store.index()).entries.length, 1);
});

test('local: stored objects are read-only and write-once; verify and reads catch a modified object', async () => {
  const run = sampleRun(fresh('runs'));
  const root = fresh('store');
  const b = new LocalBackend(root);
  const store = new RunStore(b);
  await store.push(run, { branch: BR });
  assert.equal(await b.put('runs/ves-20261107T100000Z-aaaaaaaa.json', new TextEncoder().encode('{}')), 'exists', 'put never overwrites');
  const rec = (await store.record('ves-20261107T100000Z-aaaaaaaa'))!;
  const card = rec.files.find((f) => f.path === 'card.md')!;
  const p = b.path(objectKey(card.sha256));
  assert.throws(() => writeFileSync(p, 'x'), /EACCES|permission/i, 'objects are chmod 0444');
  chmodSync(p, 0o644);
  writeFileSync(p, '# forged\n');
  const v = await store.verify();
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /card\.md: object .* was modified/);
  await assert.rejects(store.readFile(rec.run_id, 'card.md'), (e: StoreError) => e.code === 'tamper');
});

test('local: verify catches an edited record, a record without index entry and an index entry without record', async () => {
  const root = fresh('store');
  const b = new LocalBackend(root);
  const store = new RunStore(b);
  await store.push(sampleRun(fresh('runs')), { branch: BR });
  const rp = b.path('runs/ves-20261107T100000Z-aaaaaaaa.json');
  const rec = JSON.parse(readFileSync(rp, 'utf8'));
  rec.files = rec.files.filter((f: { path: string }) => f.path !== 'card.md');
  chmodSync(rp, 0o644);
  writeFileSync(rp, JSON.stringify(rec));
  await b.appendIndex({ ...(await store.index()).entries[0], run_id: 'ves-20261107T110000Z-bbbbbbbb' });
  const v = await store.verify();
  assert.equal(v.ok, false);
  const all = v.errors.join('\n');
  assert.match(all, /tree_sha256 does not match/);
  assert.match(all, /record bytes do not match the index/);
  assert.match(all, /ves-20261107T110000Z-bbbbbbbb has no record/);
});

test('local: pull writes the run back byte for byte and never overwrites', async () => {
  const run = sampleRun(fresh('runs'));
  const store = new RunStore(new LocalBackend(fresh('store')));
  await store.push(run, { branch: BR });
  const out = fresh('pull');
  const dest = await store.pull('ves-20261107T100000Z-aaaaaaaa', out);
  assert.deepEqual(walkRunDir(dest), walkRunDir(run));
  for (const f of walkRunDir(run)) assert.equal(sha(readFileSync(join(dest, f))), sha(readFileSync(join(run, f))));
  await assert.rejects(store.pull('ves-20261107T100000Z-aaaaaaaa', out), (e: StoreError) => e.code === 'conflict');
  await assert.rejects(store.pull('ves-20990101T000000Z-00000000', fresh('pull')), (e: StoreError) => e.code === 'not_found');
});

test('index order: created (row ms), then push order; same-second runs keep append order', async () => {
  const store = new RunStore(new LocalBackend(fresh('store')));
  const root = fresh('runs');
  // two runs in the same second: run_ids sort the "wrong" way, created_at (ms) and push order say b then a
  const b = makeRun(root, { run_id: 'ves-20261107T100000Z-ffffffff', created_at: '2026-11-07T10:00:00.100Z', suite: 'S1', surfaces: ['web'], cases: [{ id: 'c1', web: ['pass'] }] });
  const a = makeRun(root, { run_id: 'ves-20261107T100000Z-00000000', created_at: '2026-11-07T10:00:00.900Z', suite: 'S1', surfaces: ['web'], cases: [{ id: 'c1', web: ['fail'] }] });
  await store.push(b, { branch: BR });
  await store.push(a, { branch: BR });
  assert.deepEqual((await store.index()).entries.map((e) => e.run_id), ['ves-20261107T100000Z-ffffffff', 'ves-20261107T100000Z-00000000']);
});

test('detectBranch: args > manifest > CI env > git only when HEAD is the target sha', () => {
  const git = () => ({ branch: 'feat/x', head: 'abc1234def' });
  assert.deepEqual(detectBranch({ arg: 'a', manifestBranch: 'm', env: {}, git }), { branch: 'a', source: 'args' });
  assert.deepEqual(detectBranch({ manifestBranch: 'm', env: {}, git }), { branch: 'm', source: 'manifest' });
  assert.deepEqual(detectBranch({ env: { GITHUB_HEAD_REF: 'pr-branch' }, git }), { branch: 'pr-branch', source: 'ci-env' });
  assert.deepEqual(detectBranch({ env: { GITHUB_REF: 'refs/heads/main' }, git }), { branch: 'main', source: 'ci-env' });
  assert.deepEqual(detectBranch({ targetSha: 'abc1234', env: {}, git }), { branch: 'feat/x', source: 'git' });
  assert.deepEqual(detectBranch({ targetSha: '0000000', env: {}, git }), { branch: null, source: null }, 'an unrelated checkout is not the run branch');
});

test('a symlink inside a run dir is refused', async () => {
  const run = sampleRun(fresh('runs'));
  const { symlinkSync } = await import('node:fs');
  symlinkSync('/etc/hosts', join(run, 'link'));
  await assert.rejects(new RunStore(new LocalBackend(fresh('store'))).push(run, { branch: BR }), /symlink/);
});

test('resolveStoreUrl: --store > $VES_STORE > ves.config.json store.url (relative to the file) > ./.ves/store', () => {
  const dir = fresh('cfg');
  writeFileSync(join(dir, 'ves.config.json'), JSON.stringify({ store: { url: 'archive', project: 'p1', auto_push: true } }));
  assert.equal(resolveStoreUrl({ arg: 'gs://b/x', env: { VES_STORE: '/e' }, cwd: dir }).url, 'gs://b/x');
  assert.equal(resolveStoreUrl({ env: { VES_STORE: '/e' }, cwd: dir }).url, '/e');
  const c = resolveStoreUrl({ env: {}, cwd: dir });
  assert.deepEqual([c.url, c.source, c.project, c.auto_push], [join(dir, 'archive'), 'config', 'p1', true]);
  const d = resolveStoreUrl({ env: {}, cwd: fresh('empty') });
  assert.equal(d.source, 'default');
  assert.match(d.url, /\.ves\/store$/);
  assert.throws(() => openStore({ url: 'gs://bucket/p' }, { env: {}, cwd: dir, exec: async () => ({ code: 0, stdout: 't', stderr: '' }), fetch: (() => { throw new Error('no'); }) as never }), /x-goog-user-project/);
  assert.deepEqual(parseGsUrl('gs://my-bucket/a/b/'), { bucket: 'my-bucket', prefix: 'a/b' });
  assert.throws(() => parseGsUrl('s3://x'), /bad GCS store URL/);
});

// ------------------------------------------------------------------------------------------- fake GCS

type Obj = { body: Uint8Array; generation: number };
function fakeGcs(o: { pageSize?: number; failFirst?: number[]; tokenOk?: (t: string) => boolean } = {}) {
  const objects = new Map<string, Obj>();
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  let gen = 1;
  const fail = [...(o.failFirst ?? [])];
  const res = (status: number, body: string | Uint8Array = '') => ({
    status, text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
    arrayBuffer: async () => { const b = typeof body === 'string' ? new TextEncoder().encode(body) : body; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
  });
  const fetch: StoreFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers });
    if (fail.length) return res(fail.shift()!, '{"error":{"message":"injected"}}');
    if (o.tokenOk && !o.tokenOk(init.headers.authorization?.replace(/^Bearer /, '') ?? '')) return res(401, '{"error":{"message":"Invalid Credentials"}}');
    if (!init.headers['x-goog-user-project']) return res(403, '{"error":{"message":"no user project"}}');
    const u = new URL(url);
    let m = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
    if (m && init.method === 'POST') {
      assert.equal(u.searchParams.get('uploadType'), 'media');
      assert.equal(u.searchParams.get('ifGenerationMatch'), '0', 'every write is write-once');
      const name = u.searchParams.get('name')!;
      if (objects.has(name)) return res(412, '{"error":{"message":"conditionNotMet"}}');
      objects.set(name, { body: typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body!), generation: gen++ });
      return res(200, JSON.stringify({ name }));
    }
    m = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(u.pathname);
    if (m && init.method === 'GET') {
      const ob = objects.get(decodeURIComponent(m[2]));
      return ob ? res(200, ob.body) : res(404, '{"error":{"message":"No such object"}}');
    }
    m = /^\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
    if (m && init.method === 'GET') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const names = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const size = o.pageSize ?? 1000;
      const page = names.slice(start, start + size);
      return res(200, JSON.stringify({ items: page.map((name) => ({ name })), ...(start + size < names.length ? { nextPageToken: String(start + size) } : {}) }));
    }
    return res(400, '{"error":{"message":"unexpected request"}}');
  };
  return { fetch, objects, calls };
}
const TOKEN = 'ya29.SECRET-TOKEN-never-logged';

test('gcs: push/list/verify/pull through the JSON API with ifGenerationMatch=0, ADC bearer and x-goog-user-project', async () => {
  const g = fakeGcs({ pageSize: 3 });
  const backend = new GcsBackend({ bucket: 'ves-runs', prefix: 'team/a', project: 'test-project', fetch: g.fetch, token: async () => TOKEN, sleep: async () => {} });
  const store = new RunStore(backend, { now: at('2026-11-07T10:05:00Z') });
  const run = sampleRun(fresh('runs'));
  const r = await store.push(run, { branch: BR });
  assert.equal(r.status, 'stored');
  assert.equal(backend.url, 'gs://ves-runs/team/a');
  for (const c of g.calls) {
    assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers['x-goog-user-project'], 'test-project');
    assert.ok(c.url.startsWith('https://storage.googleapis.com/'), c.url);
    assert.ok(!c.url.includes(TOKEN), 'the token is a header, never in a URL');
  }
  const names = [...g.objects.keys()];
  assert.ok(names.every((k) => k.startsWith('team/a/')), 'everything under the prefix');
  assert.ok(names.includes('team/a/index/ves-20261107T100000Z-aaaaaaaa.json'), 'one index object per run');
  assert.ok(names.includes('team/a/runs/ves-20261107T100000Z-aaaaaaaa.json'));
  // listing pages (pageSize 3) and an identical re-push is a no-op that writes nothing new
  const before = g.objects.size;
  assert.equal((await store.push(run, { branch: BR })).status, 'unchanged');
  assert.equal(g.objects.size, before);
  const { entries } = await store.index();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].surfaces.web.pass1, 1);
  const v = await store.verify();
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.equal(v.objects_checked, new Set((await store.record(entries[0].run_id))!.files.map((f) => f.sha256)).size);
  const dest = await store.pull(entries[0].run_id, fresh('pull'));
  for (const f of walkRunDir(run)) assert.equal(sha(readFileSync(join(dest, f))), sha(readFileSync(join(run, f))));
});

test('gcs: an ifGenerationMatch conflict on the record (412) with different content is a tamper error, not an overwrite', async () => {
  const g = fakeGcs();
  const store = new RunStore(new GcsBackend({ bucket: 'b', prefix: '', project: 'p', fetch: g.fetch, token: async () => TOKEN }));
  const run = sampleRun(fresh('runs'));
  // another writer already created this run's record with other content (race lost / tampering)
  const forged = new TextEncoder().encode(JSON.stringify({ schema_version: 'ves-store-run/1', run_id: 'ves-20261107T100000Z-aaaaaaaa', tree_sha256: 'f'.repeat(64), files: [] }));
  g.objects.set('runs/ves-20261107T100000Z-aaaaaaaa.json', { body: forged, generation: 1 });
  await assert.rejects(store.push(run, { branch: BR }), (e: StoreError) => e.code === 'tamper' && !e.message.includes(TOKEN));
  assert.equal(new TextDecoder().decode(g.objects.get('runs/ves-20261107T100000Z-aaaaaaaa.json')!.body), new TextDecoder().decode(forged), 'the existing object is untouched');
  // put() itself maps 412 to 'exists'
  const b = new GcsBackend({ bucket: 'b', prefix: '', project: 'p', fetch: g.fetch, token: async () => TOKEN });
  assert.equal(await b.put('x/y', new TextEncoder().encode('1'), 'text/plain'), 'created');
  assert.equal(await b.put('x/y', new TextEncoder().encode('2'), 'text/plain'), 'exists');
  assert.equal(new TextDecoder().decode(g.objects.get('x/y')!.body), '1');
});

test('gcs: a 401 refreshes the ADC token once; 5xx retries; errors never contain the token', async () => {
  let issued = 0;
  const g = fakeGcs({ tokenOk: (t) => t === 'fresh-token' });
  const token = async (force?: boolean) => { issued++; return force ? 'fresh-token' : 'stale-token'; };
  const b = new GcsBackend({ bucket: 'b', prefix: 'p', project: 'proj', fetch: g.fetch, token, sleep: async () => {} });
  assert.equal(await b.put('a', new TextEncoder().encode('1'), 'text/plain'), 'created');
  assert.equal(issued, 2, 'stale token, 401, one forced refresh');
  const g2 = fakeGcs({ failFirst: [503, 500] });
  const b2 = new GcsBackend({ bucket: 'b', prefix: '', project: 'proj', fetch: g2.fetch, token: async () => TOKEN, sleep: async () => {} });
  assert.equal(await b2.get('missing'), null, 'retried through two 5xx, then 404 = null');
  const g3 = fakeGcs({ failFirst: [403] });
  const b3 = new GcsBackend({ bucket: 'b', prefix: '', project: 'proj', fetch: g3.fetch, token: async () => TOKEN });
  await assert.rejects(b3.get('k'), (e: StoreError) => e.code === 'auth' && /HTTP 403 injected/.test(e.message) && !e.message.includes(TOKEN));
  const b4 = new GcsBackend({ bucket: 'b', prefix: '', project: 'proj', fetch: g3.fetch, token: async () => { throw new Error('gcloud exited 1: Reauthentication required'); } });
  await assert.rejects(b4.get('k'), /ADC token unavailable .*application-default login/);
});

test('real runner output round-trips through the store unchanged (results/ fixture run)', async () => {
  const src = join(import.meta.dirname, '..', '..', 'ui', 'test', 'fixtures', 'results', 'ves-20261107T100000Z-deadbeef');
  const copy = join(fresh('runs'), 'ves-20261107T100000Z-deadbeef');
  cpSync(src, copy, { recursive: true });
  const store = new RunStore(new LocalBackend(fresh('store')));
  const r = await store.push(copy, { branch: { branch: null, source: null } });
  assert.equal(r.status, 'stored');
  assert.equal(r.entry!.verdict, 'BLOCK');
  assert.equal((await store.verify()).ok, true);
});
