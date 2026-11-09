// Core: ves.config.json loader, conformance, tool catalog semantics, synthArgs, class suggestion. No network, no I/O
// beyond reading fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, VES1_DEFAULTS } from '../../src/config/load.ts';
import { argsHashFor, buildCatalog, isGated, nameOnVariant, selectTools, catalogNameFor, resolveToolRef } from '../../src/catalog/catalog.ts';
import { synthArgs, synthArgsAlt } from '../../src/catalog/synth-args.ts';
import { suggestClasses } from '../../src/catalog/suggest.ts';
import { validate } from '../../src/lib/jsonschema.ts';
import type { VesConfig } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAT = (n: string) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'catalogs', `${n}.json`), 'utf8')) as VesConfig;
const CATALOGS = ['support-desk', 'ecommerce-ops', 'devops', 'heldout'];

test('every sample catalog is a schema-valid VES-1-conformant ves.config.json', () => {
  for (const n of CATALOGS) {
    const r = resolveConfig(CAT(n), { dir: HERE, env: {} });
    assert.deepEqual(r.errors, [], n);
    assert.equal(r.config.conformance, 'VES-1', n);
    assert.deepEqual(r.config.gate, { ...VES1_DEFAULTS.gate }, n);
  }
});

test('config: any loosened bar makes conformance "custom" and names the bar; tightening does not', () => {
  const base = CAT('support-desk');
  const loose = (mut: (c: any) => void) => { const c = structuredClone(base); mut(c); return resolveConfig(c, { dir: HERE, env: {} }).config; };
  assert.equal(loose((c) => { c.gate = { delta: 0.02 }; }).conformance, 'VES-1', 'a tighter delta is fine');
  assert.equal(loose((c) => { c.tiers = { release: { k: 3, k_safety: 8 } }; }).conformance, 'VES-1', 'more trials is fine');
  const cases: [string, (c: any) => void, RegExp][] = [
    ['delta', (c) => { c.gate = { delta: 0.1 }; }, /gate\.delta=0\.1/],
    ['k_safety', (c) => { c.tiers = { release: { k_safety: 2 } }; }, /tiers\.release\.k_safety=2/],
    ['trivial_max', (c) => { c.gate = { trivial_max: 0.2 }; }, /gate\.trivial_max/],
    ['oracle_hit_min', (c) => { c.gate = { oracle_hit_min: 0.3 }; }, /gate\.oracle_hit_min/],
    ['gated:false on spend', (c) => { c.tools.catalog.find((t: any) => t.name === 'issue_refund').gated = false; }, /tools\.issue_refund\.gated=false/],
    ['gate_classes', (c) => { c.tools.gate_classes = ['spend']; }, /gate_classes omits outward/],
    ['ttl', (c) => { c.hitl = { ttl_s: 7200 }; }, /hitl\.ttl_s/],
    ['outsider approvals', (c) => { c.hitl = { authorized: ['owner', 'outsider'] }; }, /outsider/],
  ];
  for (const [name, mut, re] of cases) {
    const c = loose(mut);
    assert.equal(c.conformance, 'custom', name);
    assert.ok(c.loosened.some((l) => re.test(l)), `${name}: ${c.loosened.join('; ')}`);
  }
  assert.ok(loose((c) => { c.hitl = { binding: 'thread' }; }).notes.includes('approval binding: thread (weaker)'));
});

test('config: ${VAR} interpolates only agent.connection / variants.*.connection / models; the snapshot keeps the template', () => {
  const c = CAT('support-desk') as any;
  c.agent.connection = { type: 'http', base_url: 'http://127.0.0.1:8000', headers: { authorization: 'Bearer ${AGENT_TOKEN}' } };
  c.models = { default: { provider: 'vertex', model: 'google/gemini-3.8-flash', project: '${GOOGLE_CLOUD_PROJECT}' } };
  c.project = 'acme';
  c.tools.catalog[0].description = 'literal ${AGENT_TOKEN} stays';
  const r = resolveConfig(c, { dir: HERE, env: { AGENT_TOKEN: 'sekret', GOOGLE_CLOUD_PROJECT: 'proj-1' } });
  assert.deepEqual(r.errors, []);
  assert.equal((r.config.agent.connection as any).headers.authorization, 'Bearer sekret');
  assert.equal((r.config.variants.default.connection as any).headers.authorization, 'Bearer sekret');
  assert.equal(r.config.models.default!.project, 'proj-1');
  assert.equal(r.config.tools.catalog[0].description, 'literal ${AGENT_TOKEN} stays');
  assert.ok(!JSON.stringify(r.config.snapshot).includes('sekret'), 'resolved secrets never reach the snapshot');
  assert.match(r.config.sha256, /^[a-f0-9]{64}$/);
});

test('config: schema rejects YAML-isms and unknown keys', () => {
  const bad = (mut: (c: any) => void) => { const c = structuredClone(CAT('support-desk')) as any; mut(c); return resolveConfig(c, { dir: HERE, env: {} }).errors; };
  assert.ok(bad((c) => { c.hitl = { binding: false }; }).length, 'binding must be args|thread (no Norway problem)');
  assert.ok(bad((c) => { c.unknown = 1; }).length);
  assert.ok(bad((c) => { c.variants = { 'Bad Name': {} }; }).length);
  assert.ok(bad((c) => { c.tools.catalog.push({ name: 'x', classes: ['read', 'write'] }); }).some((e) => /read must not be combined/.test(e)));
  assert.ok(bad((c) => { c.tools.catalog.push({ name: 'search_tickets', classes: ['read'] }); }).some((e) => /duplicate tool/.test(e)));
});

test('catalog: implied write, read exclusivity, gating by class / explicit / unreviewed, unknown tools are conservative', () => {
  const { catalog, errors } = buildCatalog([
    { name: 'r', classes: ['read'] },
    { name: 'pay', classes: ['spend'] },
    { name: 'mail', classes: ['outward'] },
    { name: 'note', classes: ['write'] },
    { name: 'pause_ads', classes: ['write'], gated: true },
    { name: 'g', classes: ['gated'] },
    { name: 'imported', classes: ['write'], review: 'suggested' },
    { name: 'imported_read', classes: ['read'], review: 'suggested' },
    { name: 'bad', classes: ['read', 'destructive'] },
  ]);
  assert.ok(errors.some((e) => /bad: read must not be combined/.test(e)));
  assert.deepEqual(catalog.byName.pay.classes, ['write', 'spend'], 'spend implies write');
  assert.deepEqual(catalog.byName.mail.classes, ['write', 'outward']);
  assert.deepEqual(catalog.byName.g.classes, ['write'], 'gated implies write and is a flag, not a class');
  assert.equal(catalog.byName.pay.gated, true);
  assert.equal(catalog.byName.mail.gated, true);
  assert.equal(catalog.byName.note.gated, false);
  assert.equal(catalog.byName.pause_ads.gated, true);
  assert.equal(catalog.byName.g.gated, true);
  assert.equal(catalog.byName.imported.gated_reason, 'unreviewed', 'a suggested non-read tool is gated until confirmed');
  assert.equal(catalog.byName.imported_read.gated, false);
  assert.equal(isGated(catalog, 'never_heard_of_it'), true, 'unknown tool is gated (conservative)');
  assert.ok(catalog.tools.findIndex((t) => t.name === 'pay') < catalog.tools.findIndex((t) => t.name === 'mail'), 'spend ranks above outward');
  assert.ok(catalog.tools.findIndex((t) => t.name === 'mail') < catalog.tools.findIndex((t) => t.name === 'note'));
  assert.deepEqual(resolveToolRef(catalog, 'class:spend'), ['pay']);
  assert.deepEqual(selectTools(catalog, { gated: true }, 2).map((t) => t.name), ['pay', 'mail']);
});

test('catalog: aliases per variant, normalise and ignore_args in args_hash', () => {
  const { catalog } = buildCatalog([{ name: 'email.send', classes: ['outward'], normalise: { to: 'lower' }, ignore_args: ['idempotency_key'], aliases: { 'eve/*': 'send_email', 'gateway/*': 'vibiz_email_send' } }]);
  assert.equal(nameOnVariant(catalog, 'email.send', 'eve/slack'), 'send_email');
  assert.equal(nameOnVariant(catalog, 'email.send', 'default'), 'email.send');
  assert.equal(catalogNameFor(catalog, 'vibiz_email_send', 'gateway/contract'), 'email.send');
  assert.equal(argsHashFor(catalog, 'email.send', { to: 'A@B.example', idempotency_key: '1' }), argsHashFor(catalog, 'email.send', { to: 'a@b.example', idempotency_key: '2' }));
});

test('synthArgs: deterministic and schema-valid on all 4 catalogs; unsatisfiable patterns give null (binding skipped)', () => {
  let built = 0;
  for (const n of CATALOGS) {
    const { catalog } = buildCatalog(CAT(n).tools.catalog);
    for (const t of catalog.tools) {
      const a = synthArgs(t.input_schema, 42);
      assert.deepEqual(synthArgs(t.input_schema, 42), a, `${n}/${t.name} deterministic`);
      if (a === null) { assert.equal(t.name, 'get_inventory', `${n}/${t.name}: only the SKU pattern tool is unsatisfiable`); continue; }
      assert.deepEqual(validate(t.input_schema as Record<string, unknown>, a), [], `${n}/${t.name}`);
      const alt = synthArgsAlt(t.input_schema, a, 42);
      if (alt) { assert.deepEqual(validate(t.input_schema as Record<string, unknown>, alt), [], `${n}/${t.name} alt`); assert.notDeepEqual(alt, a); }
      built++;
    }
  }
  assert.ok(built >= 29);
  assert.deepEqual(synthArgs({ type: 'object', required: ['to', 'when', 'n'], properties: { to: { type: 'string', format: 'email' }, when: { type: 'string', format: 'date-time' }, n: { type: 'integer', minimum: 3 } } }, 7, { clock: '2026-01-05T09:00:00Z' }),
    { to: 'ves.user+7@example.test', when: '2026-01-05T09:00:00Z', n: 3 });
});

test('catalog suggest: riskier class wins, MCP hints are suggestions only', () => {
  assert.deepEqual(suggestClasses({ name: 'send_refund_email' }).classes, ['write', 'spend', 'outward']);
  assert.deepEqual(suggestClasses({ name: 'listOrders' }).classes, ['read']);
  assert.deepEqual(suggestClasses({ name: 'deleteUser' }).classes, ['write', 'destructive']);
  assert.deepEqual(suggestClasses({ name: 'frobnicate' }).classes, ['write']);
  assert.deepEqual(suggestClasses({ name: 'get_and_publish', annotations: { readOnlyHint: true } }).classes, ['write', 'outward'], 'a read hint never overrides a risky name');
});
