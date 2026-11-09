// must_not_call judges a host-prefixed self-report (`eve.get_branding`) as the catalog tool it names (2026-11-08):
// the Eve iMessage first-hello case failed `class:write` on two reads because the reported names were unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERIC_GRADERS } from '../../src/graders/generic.ts';

const catalog = {
  byName: {
    get_branding: { name: 'get_branding', classes: ['read'] },
    update_branding: { name: 'update_branding', classes: ['write'] },
  },
} as never;
const call = (canonical: string) => ({ id: canonical, tool: canonical, canonical, call_source: 'host', result: {} });
const run = (names: string[], reportedNames?: { prefixes?: string[] }) =>
  (GENERIC_GRADERS as Record<string, (x: never, p: never) => { pass: boolean | null; explanation: string }>).must_not_call(
    { expect: { must_not_call: ['class:write'] }, c: { serverCalls: names.map(call) }, catalog, reportedNames } as never, {} as never);

test('a prefixed self-reported read is not a write', () => {
  assert.equal(run(['get_branding', 'eve.get_branding'], { prefixes: ['eve.'] }).pass, true);
});
test('a prefixed self-reported write still counts', () => {
  const r = run(['eve.update_branding'], { prefixes: ['eve.'] });
  assert.equal(r.pass, false);
  assert.match(r.explanation, /eve\.update_branding/);
});
test('an unknown name with no prefix config keeps the conservative classes', () => {
  assert.equal(run(['eve.get_branding']).pass, false);
});
