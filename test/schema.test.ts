import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/lib/jsonschema.ts';
import { loadCases, suiteVersion } from '../src/runner/load.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIBIZ = join(ROOT, 'packs', 'vibiz'); // Vibiz assets moved here by the Core step (DESIGN-agnostic §7.1 item 10)
const schema = (n: string) => JSON.parse(readFileSync(join(ROOT, 'schemas', n), 'utf8'));
const caseSchema = schema('case-1.schema.json');
const good = JSON.parse(readFileSync(join(VIBIZ, 'cases/smoke/guard-ad-budget.case.json'), 'utf8'));

test('schemas are the spec blocks verbatim (parsed equality with STANDARD.md)', () => {
  const md = readFileSync(join(ROOT, 'STANDARD.md'), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(blocks[0], caseSchema);
  assert.deepEqual(blocks[1], schema('result-1.schema.json'));
  assert.deepEqual(blocks[2], schema('run-1.schema.json'));
});

test('every shipped case validates and cites a source', () => {
  const { cases, errors } = loadCases(ROOT, [join(VIBIZ, 'cases')]);
  assert.deepEqual(errors, []);
  assert.ok(cases.length >= 30);
  for (const c of cases) assert.ok(c.provenance.source_ref, `${c.id} has source_ref`);
  assert.match(suiteVersion(cases), /^[a-f0-9]{64}$/);
});

test('case schema rejects what the spec forbids', () => {
  const bad = (mut: (c: any) => void) => { const c = structuredClone(good); mut(c); return validate(caseSchema, c); };
  assert.deepEqual(validate(caseSchema, good), []);
  assert.ok(bad((c) => { delete c.twin; }).length, 'inaction case without twin');
  assert.ok(bad((c) => { c.surfaces = ['eve/telegram']; }).length, 'unknown surface');
  assert.ok(bad((c) => { c.provenance = { author: 'x', created: '2026-11-06', source: 'production-failure', source_ref: 'INC-1' }; }).length, 'production failure must be redacted');
  assert.ok(bad((c) => { c.suite = 'safety'; }).length, 'safety needs safety_suite');
  assert.ok(bad((c) => { c.input.turns = [{ approve: 'maybe' }]; }).length, 'unknown approval turn');
  assert.ok(bad((c) => { c.fixture.fixture_sha256 = 'abc'; }).length, 'fixture sha pattern');
  assert.ok(bad((c) => { c.extra = 1; }).length, 'additionalProperties false');
  assert.ok(bad((c) => { c.input.turns = [{ advance_clock: 'P' }]; }).length, 'empty ISO duration');
  assert.ok(bad((c) => { c.expect = {}; }).length, 'expect needs a property');
});

test('result schema requires invalid_reason on invalid rows', () => {
  const rs = schema('result-1.schema.json');
  const row: any = { schema_version: 'ves-result/1', row_id: 'x', run_id: 'ves-20261106T000000Z-0123abcd', case_id: 'c', case_version: 1, suite_version: 'a'.repeat(64), surface: 'eve/web', trial: 0, seed: 1, status: 'pass', scores: [], agent: { model: 'm', commit: 'abc1234' }, host: { family: 'vibiz' }, trace: { atif_uri: '', server_calls: 0 }, usage: { wall_ms: 0 }, cache: { salt: 's', hit_ratio: 0 }, created_at: '2026-11-06T00:00:00Z' };
  assert.deepEqual(validate(rs, row), []);
  assert.ok(validate(rs, { ...row, status: 'invalid' }).length);
  assert.deepEqual(validate(rs, { ...row, status: 'invalid', invalid_reason: 'infra_rate_limit' }), []);
  assert.ok(validate(rs, { ...row, run_id: 'run-1' }).length);
});
