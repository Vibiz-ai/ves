// Models acceptance (DESIGN-agnostic §7.5), Vertex provider: URL and headers, ADC refresh on 401, three failed
// gcloud tries -> AuthLostError, non-Vertex ids refused, project rules, thought-signature shim, dropped fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthLostError, UsageError } from '../../src/core/errors.ts';
import { applyThoughtSignatureShim, THOUGHT_SIGNATURE_PLACEHOLDER, vertexModelId, vertexUrl } from '../../src/models/vertex.ts';
import { setup } from './helpers.ts';

const say = (salt = 's1') => ({ req: { messages: [{ role: 'user' as const, content: 'hi' }] }, o: { purpose: 'host_sim' as const, salt } });

test('vertex: default model, global URL, ADC bearer, x-goog-user-project; token never in logs', async () => {
  const { api, fetch, exec, logs } = setup();
  const m = api.chat('default');
  assert.equal(m.family, 'google');
  const r = await m.chat(say().req, say().o);
  assert.equal(r.message.content, 'hello');
  assert.equal(r.model, 'google/gemini-3.8-flash');
  const call = fetch.calls[0];
  assert.equal(call.url, 'https://aiplatform.googleapis.com/v1/projects/proj-test/locations/global/endpoints/openapi/chat/completions');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer ya29.token-one');
  assert.equal(call.headers['x-goog-user-project'], 'proj-test');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.body.model, 'google/gemini-3.8-flash');
  assert.deepEqual(exec.calls[0], { cmd: 'gcloud', args: ['auth', 'application-default', 'print-access-token'] });
  assert.ok(!logs.join('\n').includes('ya29'), 'token must never be logged');
});

test('vertex: project from config beats env; regional location uses the regional host', async () => {
  const { api, fetch } = setup({ cfg: { default: { provider: 'vertex', model: 'gemini-3.5-flash', project: 'cfg-proj', location: 'us-central1' } } });
  await api.chat('default').chat(say().req, say().o);
  assert.equal(fetch.calls[0].url, 'https://us-central1-aiplatform.googleapis.com/v1/projects/cfg-proj/locations/us-central1/endpoints/openapi/chat/completions');
  assert.equal(fetch.calls[0].headers['x-goog-user-project'], 'cfg-proj');
  assert.equal(fetch.calls[0].body.model, 'google/gemini-3.5-flash', 'gemini-* accepted as google/gemini-*');
  assert.equal(vertexUrl('p'), 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/chat/completions');
});

test('vertex: missing project is a usage error (empty interpolation, no env)', () => {
  const { api } = setup({ env: {}, cfg: { default: { provider: 'vertex', model: 'google/gemini-3.8-flash', project: '' } } });
  assert.throws(() => api.chat('default'), UsageError);
});

test('vertex: non-Vertex model ids are refused', () => {
  assert.equal(vertexModelId('gpt-5'), null);
  assert.equal(vertexModelId('openai/gpt-oss-120b-maas'), null);
  assert.equal(vertexModelId('claude-sonnet-5-5'), null);
  assert.equal(vertexModelId('gemini-3.8-flash'), 'google/gemini-3.8-flash');
  const { api, fetch } = setup({ cfg: { default: { provider: 'vertex', model: 'gpt-5-mini' } } });
  assert.throws(() => api.chat('default'), (e: Error) => e instanceof UsageError && /not a Vertex Gemini id/.test(e.message));
  assert.equal(fetch.calls.length, 0);
});

test('vertex: token cached, refreshed after 40 minutes', async () => {
  const { api, exec, fetch, clock } = setup({ tokens: ['ya29.a', 'ya29.b'] });
  const m = api.chat('default');
  await m.chat(say('a').req, say('a').o);
  await m.chat(say('b').req, say('b').o);
  assert.equal(exec.calls.length, 1);
  clock.advance(41 * 60_000);
  await m.chat(say('c').req, say('c').o);
  assert.equal(exec.calls.length, 2);
  assert.equal(fetch.calls[2].headers.authorization, 'Bearer ya29.b');
});

test('vertex: a 401 refreshes the token once and retries with the new one', async () => {
  const { api, exec, fetch } = setup({ tokens: ['ya29.old', 'ya29.new'], handler: (_b, req) => (req.headers.authorization === 'Bearer ya29.old' ? { status: 401, json: { error: { message: 'expired' } } } : { content: 'ok' }) });
  const r = await api.chat('default').chat(say().req, say().o);
  assert.equal(r.message.content, 'ok');
  assert.equal(exec.calls.length, 2);
  assert.deepEqual(fetch.calls.map((c) => c.headers.authorization), ['Bearer ya29.old', 'Bearer ya29.new']);
});

test('vertex: 401 after a refresh is AuthLostError (no process.exit), charged $0', async () => {
  const { api, fetch } = setup({ tokens: ['ya29.x', 'ya29.y'], handler: () => ({ status: 401, json: {} }) });
  await assert.rejects(api.chat('default').chat(say().req, say().o), (e: any) => e instanceof AuthLostError && e.http_status === 401 && !String(e.message).includes('ya29'));
  assert.equal(fetch.calls.length, 2);
  assert.equal(api.ledger().usd_list, 0);
});

test('vertex: three failed gcloud tries 5 s apart -> AuthLostError, no request sent', async () => {
  const { api, exec, fetch, sleeps } = setup({ tokens: [{ code: 1 }] });
  await assert.rejects(api.chat('default').chat(say().req, say().o), (e: any) => e instanceof AuthLostError && /after 3 tries/.test(e.message));
  assert.equal(exec.calls.length, 3);
  assert.deepEqual(sleeps.filter((s) => s === 5000), [5000, 5000]);
  assert.equal(fetch.calls.length, 0);
});

test('vertex: a slow-then-ok gcloud (2 failures) is not a lost credential', async () => {
  const { api, exec } = setup({ tokens: [{ code: 1 }, { code: 1 }, 'ya29.third'] });
  const r = await api.chat('default').chat(say().req, say().o);
  assert.equal(r.message.content, 'hello');
  assert.equal(exec.calls.length, 3);
});

test('vertex: thought-signature shim on replayed assistant tool calls; dropped fields removed; params as defaults', async () => {
  const { api, fetch } = setup({ cfg: { default: { provider: 'vertex', model: 'google/gemini-3.8-flash', params: { temperature: 0.3, store: true, user: 'u1', metadata: { a: 1 } } } } });
  const messages: any[] = [
    { role: 'user', content: 'launch it' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'c', arguments: '{}' }, extra_content: { google: { thought_signature: 'REAL' } } }] },
  ];
  await api.chat('default').chat({ messages, temperature: 0 }, { purpose: 'host_sim', salt: 's' });
  const b = fetch.calls[0].body;
  assert.equal(b.messages[1].tool_calls[0].extra_content.google.thought_signature, THOUGHT_SIGNATURE_PLACEHOLDER);
  assert.equal(b.messages[1].tool_calls[1].extra_content, undefined, 'only the first call of a message gets the placeholder');
  assert.equal(b.messages[3].tool_calls[0].extra_content.google.thought_signature, 'REAL', 'a real signature is kept');
  for (const k of ['store', 'user', 'metadata', 'service_tier', 'prompt_cache_key']) assert.equal(k in b, false, `${k} dropped`);
  assert.equal(b.temperature, 0, 'caller value wins over params default');
  assert.equal(typeof b.max_tokens, 'number', 'a max_tokens cap is always sent');
  assert.equal(applyThoughtSignatureShim([{ role: 'user', content: 'x' }])[0].content, 'x');
});

test('vertex: 429 / 5xx / HTML 404 retried with back-off; exhausted 503 surfaces http_status for the classifier', async () => {
  let n = 0;
  const { api, sleeps } = setup({ handler: () => (++n === 1 ? { status: 429, json: {} } : n === 2 ? { status: 404, text: '<!DOCTYPE html><title>404</title>' } : n === 3 ? { status: 500, json: {} } : { content: 'finally' }) });
  const r = await api.chat('default').chat(say().req, say().o);
  assert.equal(r.message.content, 'finally');
  assert.deepEqual(sleeps.filter((s) => s >= 1000), [2000, 4000, 8000], "back-off (RPM-bucket waits excluded)");
  const bad = setup({ handler: () => ({ status: 503, json: {} }), extra: { maxAttempts: 3 } });
  await assert.rejects(bad.api.chat('default').chat(say().req, say().o), (e: any) => e.http_status === 503 && e.origin === 'provider');
});
