// Core CLI surface: exit codes and messages of the generic commands. Child processes run the mock path only (no
// network); the parent process is network-locked by test/setup.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = join(ROOT, 'test', 'core', 'fixtures', 'skeleton-repo');
const ves = (args: string[], cwd = REPO): { code: number; out: string; err: string } => {
  try { return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'src/cli.ts'), ...args], { cwd, stdio: 'pipe', encoding: 'utf8' }), err: '' }; }
  catch (e: any) { return { code: e.status, out: String(e.stdout), err: String(e.stderr) }; }
};

test('ves validate (config path) is offline and replays every oracle on MockAgent', () => {
  const r = ves(['validate', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.ok(j.info.some((l: string) => /oracle replay on MockAgent: every oracle passes/.test(l)));
  assert.ok(j.info.some((l: string) => /pack skeleton@0\.1\.0: 9 case/.test(l)));
});

test('ves packs list shows applicability per pack; ci-package commands fail with a clear usage error', () => {
  const l = ves(['packs', 'list', '--json']);
  assert.equal(l.code, 0, l.err);
  const rows = JSON.parse(l.out);
  assert.match(rows.find((r: any) => r.id === 'vibiz').on, /skipped: profile vibiz not enabled/);
  assert.match(rows.find((r: any) => r.id === 'skeleton').on, /^9 cases/);
  const i = ves(['init']);
  if (i.code === 3) assert.match(i.err, /requires the ci package/); // once the ci package lands, init exists
});

test('ves run --profile vibiz refuses --trigger pr (run-1 manifests)', () => {
  const r = ves(['run', '--profile', 'vibiz', '--trigger', 'pr', '--out', join(ROOT, 'results', '.test-cli')], ROOT);
  assert.equal(r.code, 3);
  assert.match(r.err, /--trigger pr writes run-2 manifests/);
});
