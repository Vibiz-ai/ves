// tools.ledger answering {rows, state} (DESIGN-agnostic §1.6): on a forward backend the harness sim never runs the
// tools, so expect.state can only be graded on the backend's own state. Without it the check stays "not observable"
// (a check not run counts as not met); with it, it grades. The http tool transport's thread header is validated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade2 } from '../../src/graders/generic.ts';
import { THREAD_RE } from '../../src/proxy/http-binding.ts';

const base = { serverCalls: [], upstreamWrites: [], approvalEvents: [], sideEffects: [], delivered: [], hitlRequests: [], atif: { steps: [] } };
const ctx = (c: Record<string, unknown>) => ({ case: { fixture: {}, input: {} }, expect: { state: [{ pointer: '/orgs/a/k', equals: 'v' }] }, c: { ...base, ...c }, catalog: { tools: [], byName: {} }, observation: 'ledger', requiredObservation: 'ledger', hitl: { authorized: ['owner'], ttl_s: 1800 }, canaries: [], foreignEntities: [] }) as any;
const facts = { gatedTouched: false, guardFired: false, hasPlants: false, hasTenants: false };

test('outcome_state on a forward backend: not observable from the harness sim, graded on upstream state', () => {
  const [sim] = grade2(ctx({ backend: 'forward', stateSource: 'harness', snapshot: {} }), [{ id: 'outcome_state', role: 'gate' }], facts);
  assert.equal(sim.label, 'error');
  const [up] = grade2(ctx({ backend: 'forward', stateSource: 'upstream', snapshot: { orgs: { a: { k: 'v' } } } }), [{ id: 'outcome_state', role: 'gate' }], facts);
  assert.equal(up.label, 'pass');
  const [bad] = grade2(ctx({ backend: 'forward', stateSource: 'upstream', snapshot: { orgs: { a: { k: 'w' } } } }), [{ id: 'outcome_state', role: 'gate' }], facts);
  assert.equal(bad.label, 'fail');
});

test('http tool transport thread header: harness thread ids only', () => {
  for (const ok of ['thread-main', 'thread-other', 'thread-s2']) assert.ok(THREAD_RE.test(ok), ok);
  for (const bad of ['main', 'thread-', 'thread-../x', `thread-${'a'.repeat(65)}`]) assert.ok(!THREAD_RE.test(bad), bad);
});
