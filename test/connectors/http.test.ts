// `http` connector (DESIGN-agnostic §1.4) against in-process handlers through an injected fetch: handshake, host
// refusal, NDJSON and SSE event streams, the tool_call -> new POST continuation, agent-server errors, and the
// reference agent plus the TypeScript example passing the skeleton cases end to end. No sockets.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runConfigOnce, type RunConfigOptions } from '../../src/runner/run-v2.ts';
import { HttpConnector, bodyChunks } from '../../src/connectors/http/index.ts';
import { agentMessages } from '../../src/connectors/_shared/jsonl.ts';
import { createHttpHandler } from '../../examples/reference-agent/agent.mjs';
import { createVesHandler } from '../../examples/http-server/agent.ts';
import { catalogOf, deps, fetchFrom, recordingIO, registry, ROOT, SCRIPT, sessionOpen, supportDesk, toolSpecs, type Handler } from './helpers.ts';
import type { ResolvedConfig } from '../../src/core/types.ts';

const TMP = join(ROOT, 'results', `.test-connectors-http-${randomBytes(4).toString('hex')}`);
mkdirSync(TMP, { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
let tick = Date.parse('2026-11-07T12:00:00Z');
const now = () => new Date((tick += 1000));
const BASE = 'http://127.0.0.1:8000';
const tools = toolSpecs(catalogOf(supportDesk()));
const opts = (cfg: ResolvedConfig, o: Partial<RunConfigOptions> = {}): RunConfigOptions => ({
  harnessRoot: ROOT, config: cfg, tier: 'smoke', trigger: 'pr', target: { sha: 'abc1234', change_class: 1 }, outDir: TMP, now, bootstrapN: 300, connectors: registry(), ...o,
});
const READY = { type: 'ready', protocol: 'ves-agent/1', agent: { name: 'srv', framework: 'fastapi' }, capabilities: ['multi_turn'] };
const json = (status: number, b: unknown) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const wrap = (h: (m: string, p: string, b: string) => Promise<any>): Handler => (m, p, b) => h(m, p, b);

test('health: GET /ves/v1/health must return the ready message; failures say "agent did not handshake"; 401 is infra_auth', async () => {
  const ok = new HttpConnector({ type: 'http', base_url: BASE }, deps({ fetch: fetchFrom({ [BASE]: async () => json(200, READY) }) }));
  assert.deepEqual(await ok.health(), { ok: true });
  assert.equal((await ok.info()).framework, 'fastapi');
  const bad = new HttpConnector({ type: 'http', base_url: BASE }, deps({ fetch: fetchFrom({ [BASE]: async () => json(200, { hello: 1 }) }) }));
  assert.match((await bad.health()).detail!, /agent did not handshake: expected ready/);
  const auth = new HttpConnector({ type: 'http', base_url: BASE }, deps({ fetch: fetchFrom({ [BASE]: async () => json(401, { error: 'no' }) }) }));
  assert.equal((await auth.health()).reason, 'infra_auth');
  const down = new HttpConnector({ type: 'http', base_url: BASE }, deps({ fetch: (async () => { throw new Error('ECONNREFUSED'); }) as never }));
  assert.match((await down.health()).detail!, /agent did not handshake: ECONNREFUSED/);
});
test('production hosts are refused unless allow_hosts lists them; loopback, *.internal and *.test are allowed', async () => {
  const f = fetchFrom({ 'https://agent.acme.com': async () => json(200, READY), 'http://agent.svc.internal': async () => json(200, READY) });
  const prod = new HttpConnector({ type: 'http', base_url: 'https://agent.acme.com' }, deps({ fetch: f }));
  const h = await prod.health();
  assert.equal(h.ok, false);
  assert.match(h.detail!, /refusing non-local host agent\.acme\.com/);
  assert.equal(f.log.length, 0, 'refused before any request');
  assert.equal((await new HttpConnector({ type: 'http', base_url: 'https://agent.acme.com', allow_hosts: ['*.acme.com'] }, deps({ fetch: f })).health()).ok, true);
  assert.equal((await new HttpConnector({ type: 'http', base_url: 'http://agent.svc.internal' }, deps({ fetch: f })).health()).ok, true);
});
test('events: SSE replies parse; a tool_call is answered by a new POST and the turn continues in that response; headers are sent', async () => {
  const posts: any[] = [];
  const handler: Handler = async (method, path, body, headers) => {
    if (path === '/ves/v1/health') return json(200, READY);
    if (path === '/ves/v1/sessions') return json(200, { type: 'session.opened', session_id: JSON.parse(body).session_id });
    if (method === 'DELETE') return { status: 204, headers: {}, body: '' };
    const m = JSON.parse(body); posts.push({ m, auth: headers.authorization });
    const sid = m.session_id;
    if (m.type === 'turn') return { status: 200, headers: { 'content-type': 'text/event-stream' }, body:
      `: keep-alive\n\ndata: ${JSON.stringify({ type: 'message', session_id: sid, text: 'Looking.' })}\n\nevent: x\ndata: ${JSON.stringify({ type: 'tool_call', session_id: sid, call_id: 'k1', name: 'search_tickets', args: { query: 'login' } })}\n\n` };
    if (m.type === 'tool_result') return { status: 200, headers: { 'content-type': 'application/x-ndjson' }, body:
      `not json, ignored\n${JSON.stringify({ type: 'message', session_id: sid, text: `found ${m.result.n}` })}\n${JSON.stringify({ type: 'turn.end', session_id: sid, turn_id: 'turn-1', reason: 'done' })}\n` };
    return json(400, {});
  };
  const c = new HttpConnector({ type: 'http', base_url: BASE, headers: { Authorization: 'Bearer t0k' } }, deps({ fetch: fetchFrom({ [BASE]: handler }) }));
  await c.health();
  const io = recordingIO(async () => ({ ok: true, result: { n: 1 } }));
  const s = await c.open(sessionOpen(tools), io);
  assert.deepEqual(await c.turn(s, { text: 'find', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' }), { status: 'done' });
  assert.deepEqual(io.rec.calls, [{ name: 'search_tickets', args: { query: 'login' }, transport: 'pipe' }]);
  assert.deepEqual(io.rec.reports.map((r) => (r.ev as any).text), ['Looking.', 'found 1']);
  assert.deepEqual(posts.map((p) => p.m.type), ['turn', 'tool_result']);
  assert.ok(posts.every((p) => p.auth === 'Bearer t0k'));
  await c.close(s);
});
test('a non-2xx from the agent server on an event FAILs the trial (agent-side, even 5xx)', async () => {
  const handler: Handler = async (_m, path, body) => path === '/ves/v1/health' ? json(200, READY) : path === '/ves/v1/sessions' ? json(200, { type: 'session.opened', session_id: JSON.parse(body).session_id }) : json(500, { detail: 'Internal Server Error' });
  const c = new HttpConnector({ type: 'http', base_url: BASE }, deps({ fetch: fetchFrom({ [BASE]: handler }) }));
  await c.health();
  const s = await c.open(sessionOpen(tools), recordingIO());
  const r = await c.turn(s, { text: 'x', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  assert.equal(r.error!.origin, 'agent');
  assert.match(r.error!.message, /HTTP 500/);
});
test('a stream that ends without turn.end FAILs ("agent ended mid-turn" after close, or turn timeout)', async () => {
  const handler: Handler = async (_m, path, body) => path === '/ves/v1/health' ? json(200, READY) : path === '/ves/v1/sessions' ? json(200, { type: 'session.opened', session_id: JSON.parse(body).session_id }) : { status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: '' };
  const c = new HttpConnector({ type: 'http', base_url: BASE, turn_timeout_s: 0.1 }, deps({ fetch: fetchFrom({ [BASE]: handler }) }));
  await c.health();
  const s = await c.open(sessionOpen(tools), recordingIO());
  const r = await c.turn(s, { text: 'x', as: 'owner', thread: 'thread-main', turn_id: 'turn-1' });
  assert.match(r.error!.message, /agent timeout/);
});

// --------------------------------------------------------------------------------- end to end, runner + gate
const refCfg = () => supportDesk((c) => { c.agent.connection = { type: 'http', base_url: BASE }; c.fixtures.context = { script: SCRIPT }; });
test('reference agent over `http` (in-process handler, injected fetch) passes the skeleton cases on a PR trigger; --unsafe blocks at G-3', async () => {
  const good = await runConfigOnce(opts(refCfg(), { fetch: fetchFrom({ [BASE]: wrap(createHttpHandler({})) }) }));
  assert.equal(good.gate.verdict, 'PASS', JSON.stringify(good.gate.rules.filter((x) => x.status === 'fired')));
  assert.equal(good.manifest.connections.default.kind, 'http');
  const bad = await runConfigOnce(opts(refCfg(), { fetch: fetchFrom({ [BASE]: wrap(createHttpHandler({ unsafe: true })) }), override: { by: 'founder', reason: 'x' } }));
  assert.equal(bad.gate.decided_by, 'G-3 safety');
  assert.equal(bad.gate.override!.applied, false);
});
test('examples/http-server/agent.ts (TypeScript, fake LLM) passes the skeleton cases over `http`; VES_DEMO_UNSAFE blocks at G-3', async () => {
  const cfg = supportDesk((c) => { c.agent.connection = { type: 'http', base_url: BASE }; c.agent.framework = 'plain-node'; });
  const good = await runConfigOnce(opts(cfg, { fetch: fetchFrom({ [BASE]: wrap(createVesHandler()) }) }));
  assert.equal(good.gate.verdict, 'PASS', JSON.stringify(good.gate.rules.filter((x) => x.status === 'fired')));
  assert.equal(good.manifest.connections.default.agent.name, 'http-ts-agent');
  const bad = await runConfigOnce(opts(cfg, { fetch: fetchFrom({ [BASE]: wrap(createVesHandler({ unsafe: true })) }) }));
  assert.equal(bad.gate.decided_by, 'G-3 safety');
});

test('streamed bodies: a ReadableStream split mid-line and mid-UTF-8 character still yields whole messages', async () => {
  const enc = new TextEncoder().encode(`${JSON.stringify({ type: 'message', text: 'olá — ok' })}\n${JSON.stringify({ type: 'turn.end', turn_id: 't', reason: 'done' })}\n`);
  const cuts = [3, 21, 22, 40, enc.length];
  const body = new ReadableStream<Uint8Array>({ start(c) { let a = 0; for (const b of cuts) { c.enqueue(enc.slice(a, b)); a = b; } c.close(); } });
  const res = { status: 200, headers: { get: () => 'application/x-ndjson' }, text: async () => '', body };
  const got: any[] = [];
  for await (const m of agentMessages(bodyChunks(res), 'application/x-ndjson')) got.push(m);
  assert.deepEqual(got.map((m) => m.type), ['message', 'turn.end']);
  assert.equal(got[0].text, 'olá — ok');
});
