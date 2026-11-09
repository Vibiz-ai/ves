import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, resolveInsideRun, createdFromRunId } from '../server/api.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'ves-ui-'));
cpSync(join(here, 'fixtures'), tmp, { recursive: true });
const RID = 'ves-20261107T100000Z-deadbeef';
const api = createApi({ resultsDir: join(tmp, 'results'), repoDir: join(tmp, 'repo') });
after(() => { api.close(); rmSync(tmp, { recursive: true, force: true }); });
const get = (u) => api.handle('GET', u);

test('GET /api/runs summarises a v2 run defensively', () => {
  const { status, body } = get('/api/runs');
  assert.equal(status, 200);
  assert.equal(body.runs.length, 1);
  const r = body.runs[0];
  assert.equal(r.verdict, 'BLOCK');
  assert.equal(r.decided_by, 'G-3 safety');
  assert.equal(r.repo, 'acme/support-agent');
  assert.equal(r.created, '2026-11-07T10:00:00Z');
  assert.deepEqual(r.counts, { pass: 2, fail: 1, invalid: 1, skip: 1, other: 0 });
  assert.equal(r.trial_pass_rate, 2 / 3);
  assert.ok(Math.abs(r.usd_rows - 0.42) < 1e-9);
  assert.equal(r.usd_cap, 5);
  assert.match(r.errors.join(), /1 unparsable line/);
});

test('GET /api/runs/:id and /rows', () => {
  const d = get(`/api/runs/${RID}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.gate.verdict, 'BLOCK');
  assert.ok(d.body.card.includes('Per-surface'));
  // run-extra.json efficiency (advisory) reaches the run detail page unchanged, read-only
  assert.equal(d.body.extra.efficiency.default.tool_calls_per_success, 2.5);
  assert.match(d.body.extra.efficiency.default.flags[0], /duplicate tool calls 22%/);
  const rows = get(`/api/runs/${RID}/rows`);
  assert.equal(rows.body.rows.length, 5);
  assert.equal(rows.body.parse_errors, 1);
});

test('unknown / malicious run ids are rejected', () => {
  assert.equal(get('/api/runs/nope').status, 404);
  assert.equal(get('/api/runs/..%2F..%2Fetc').status, 400);
  assert.ok([400, 404].includes(get('/api/runs/%2E%2E').status)); // URL parser collapses it to /api/
  assert.equal(api.handle('POST', '/api/runs').status, 405);
  assert.equal(get('/not-api'), null);
});

test('trajectory endpoint reads the ATIF file and the snapshot ledger', () => {
  const row = encodeURIComponent(`${RID}|demo.approval@1|slack|1`);
  const t = get(`/api/runs/${RID}/trajectory?row=${row}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.atif.steps.length, 3);
  assert.deepEqual(t.body.snapshot_sim.writes[0].canonical, 'orders.refund');
  assert.equal(t.body.snapshot_sim.big, undefined);
});

test('trajectory endpoint refuses path traversal and handles skips', () => {
  const evil = encodeURIComponent(`${RID}|demo.approval@1|slack|0`);
  assert.equal(get(`/api/runs/${RID}/trajectory?row=${evil}`).status, 403);
  const skip = encodeURIComponent(`${RID}|demo.approval@1|default|0`);
  const s = get(`/api/runs/${RID}/trajectory?row=${skip}`);
  assert.equal(s.status, 200);
  assert.equal(s.body.atif, null);
  assert.equal(get(`/api/runs/${RID}/trajectory`).status, 400);
  assert.equal(get(`/api/runs/${RID}/trajectory?row=missing`).status, 404);
});

test('resolveInsideRun rejects absolute, parent, scheme and symlink escapes', () => {
  const run = join(tmp, 'results', RID);
  assert.equal(resolveInsideRun(run, '/etc/passwd'), null);
  assert.equal(resolveInsideRun(run, '../other/x.json'), null);
  assert.equal(resolveInsideRun(run, 'trajectories/../../x'), null);
  assert.equal(resolveInsideRun(run, 'http://example.com/a'), null);
  assert.equal(resolveInsideRun(run, 'a\0b'), null);
  assert.equal(resolveInsideRun(run, '.'), null);
  assert.equal(resolveInsideRun(run, 'trajectories/ok.atif.json').exists, true);
  mkdirSync(join(tmp, 'outside'), { recursive: true });
  writeFileSync(join(tmp, 'outside', 'secret.json'), '{}');
  symlinkSync(join(tmp, 'outside', 'secret.json'), join(run, 'trajectories', 'link.json'));
  assert.equal(resolveInsideRun(run, 'trajectories/link.json'), null);
});

test('GET /api/cases walks packs/*/cases and skips non-case JSON', () => {
  const c = get('/api/cases');
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.cases.map((x) => x.id), ['demo.refund']);
  assert.equal(c.body.packs[0].id, 'demo');
  assert.equal(c.body.packs[0].case_count, 1);
  assert.equal(c.body.cases[0].provenance.source, 'synthetic');
});

test('missing results dir is reported, not thrown', () => {
  const a = createApi({ resultsDir: join(tmp, 'does-not-exist'), repoDir: tmp });
  const r = a.handle('GET', '/api/runs');
  assert.equal(r.status, 200);
  assert.equal(r.body.exists, false);
  assert.deepEqual(r.body.runs, []);
  a.close();
});

test('createdFromRunId', () => {
  assert.equal(createdFromRunId('ves-20261106T212658Z-b2626ec5'), '2026-11-06T21:26:58Z');
  assert.equal(createdFromRunId('custom'), null);
});

test('GET /api/personas: library + conversations with the opening exchange; run summaries name the people', () => {
  const root = mkdtempSync(join(tmpdir(), 'ves-ui-persona-'));
  const rid = 'ves-20261108T220855Z-1ea6a7da';
  const run = join(root, 'results', rid);
  mkdirSync(join(run, 'trajectories'), { recursive: true });
  mkdirSync(join(root, 'repo', 'packs', 'p', 'personas'), { recursive: true });
  writeFileSync(join(root, 'repo', 'packs', 'p', 'personas', 'gym.persona.json'), JSON.stringify({ schema_version: 'ves-persona/1', id: 'gym', name: 'Marco, owner of a gym', temperament: ['cold'], languages: ['en'], opening: 'hi' }));
  writeFileSync(join(run, 'run.json'), JSON.stringify({ run_id: rid, tier: 'smoke', trigger: 'manual', surfaces: ['eve/imessage'] }));
  const rows = [
    { row_id: `${rid}|eve.persona.baker@1|eve/imessage|0`, case_id: 'eve.persona.baker', surface: 'eve/imessage', trial: 0, status: 'pass', agent: { model: 'm1' },
      persona: { id: 'baker', name: 'Inês, baker', outcome: { goal_met: 'yes' } }, trace: { atif_uri: 'trajectories/b0.atif.json' } },
    { row_id: `${rid}|eve.persona.gym@1|eve/imessage|0`, case_id: 'eve.persona.gym', surface: 'eve/imessage', trial: 0, status: 'invalid', invalid_reason: 'harness_bug' },
    { row_id: `${rid}|eve.bench.x@1|eve/imessage|0`, case_id: 'eve.bench.x', surface: 'eve/imessage', trial: 0, status: 'pass' },
  ];
  writeFileSync(join(run, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(run, 'trajectories', 'b0.atif.json'), JSON.stringify({ steps: [
    { source: 'user', message: 'olá!' }, { source: 'agent', tool_calls: [{ function_name: 'x' }] }, { source: 'agent', message: 'Hi Inês, ' + 'x'.repeat(400) }, { source: 'user', message: 'thanks' },
  ] }));
  const a = createApi({ resultsDir: join(root, 'results'), repoDir: join(root, 'repo') });
  try {
    const s = a.handle('GET', '/api/runs').body.runs[0];
    assert.deepEqual(s.personas, [{ id: 'baker', name: 'Inês, baker' }, { id: 'gym', name: 'Marco, owner of a gym' }]); // gym: INVALID row, name from the library
    assert.deepEqual(s.case_ids, ['eve.bench.x', 'eve.persona.baker', 'eve.persona.gym']);
    const p = a.handle('GET', '/api/personas');
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.library.map((l) => [l.id, l.file]), [['gym', join('packs', 'p', 'personas', 'gym.persona.json')]]);
    assert.deepEqual(p.body.runs.map((r) => r.id), [rid]);
    const cs = p.body.conversations;
    assert.deepEqual(cs.map((c) => [c.persona_id, c.status]), [['baker', 'pass'], ['gym', 'invalid']]);
    assert.equal(cs[0].preview.user, 'olá!');
    assert.ok(cs[0].preview.agent.startsWith('Hi Inês') && cs[0].preview.agent.length <= 220 && cs[0].preview.agent.endsWith('…'));
    assert.equal(cs[0].preview.user_messages, 2);
    assert.equal(cs[0].agent_model, 'm1');
    assert.equal(cs[0].run_created, '2026-11-08T22:08:55Z');
    assert.equal(cs[1].persona, null);
    assert.equal(cs[1].preview.user, null);
  } finally { a.close(); rmSync(root, { recursive: true, force: true }); }
});
