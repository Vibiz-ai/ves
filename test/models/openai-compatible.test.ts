// Models acceptance (§7.5): openai-compatible tool_calls round trip, key from api_key_env, error mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthLostError, HarnessError, UsageError } from '../../src/core/errors.ts';
import type { ChatMessage } from '../../src/core/types.ts';
import { setup } from './helpers.ts';

const cfg = { named: { router: { provider: 'openai-compatible' as const, base_url: 'https://llm.example.test/v1/', model: 'openai/gpt-5-mini', api_key_env: 'ROUTER_KEY' },
                       local: { provider: 'openai-compatible' as const, base_url: 'http://127.0.0.1:11434/v1', model: 'qwen3' } } };
const tools = [{ type: 'function' as const, function: { name: 'issue_refund', description: 'Refund an order', parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } } }];

test('openai-compatible: tool_calls round trip (request tools -> tool_calls -> replay with tool result)', async () => {
  const { api, fetch } = setup({
    cfg, env: { ROUTER_KEY: 'sk-test-123' },
    handler: (body) => body.messages.some((m: any) => m.role === 'tool')
      ? { content: 'Refund issued for A-1.' }
      : { tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'issue_refund', arguments: '{"order_id":"A-1"}' } }] },
  });
  const m = api.chat('router');
  assert.equal(m.family, 'openai');
  const messages: ChatMessage[] = [{ role: 'user', content: 'refund A-1' }];
  const r1 = await m.chat({ messages, tools, tool_choice: 'auto' }, { purpose: 'host_sim', salt: 't1' });
  assert.equal(r1.finish_reason, 'tool_calls');
  assert.deepEqual(r1.message.tool_calls?.map((t) => [t.id, t.function.name, JSON.parse(t.function.arguments)]), [['call_9', 'issue_refund', { order_id: 'A-1' }]]);
  messages.push(r1.message, { role: 'tool', tool_call_id: 'call_9', content: '{"ok":true}' });
  const r2 = await m.chat({ messages, tools }, { purpose: 'host_sim', salt: 't1' });
  assert.equal(r2.message.content, 'Refund issued for A-1.');
  const sent = fetch.calls[1].body;
  assert.equal(fetch.calls[0].url, 'https://llm.example.test/v1/chat/completions');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer sk-test-123');
  assert.deepEqual(fetch.calls[0].body.tools, tools);
  assert.equal(sent.messages[1].tool_calls[0].id, 'call_9');
  assert.equal(sent.messages[1].tool_calls[0].extra_content, undefined, 'no Vertex shim on other providers');
  assert.equal(sent.messages[2].tool_call_id, 'call_9');
  assert.equal(r1.usage.input_tokens > 0 && r1.usage.output_tokens > 0, true);
});

test('openai-compatible: object-valued arguments are normalised to a JSON string; missing ids get one', async () => {
  const { api } = setup({ cfg, env: { ROUTER_KEY: 'k' }, handler: () => ({ tool_calls: [{ type: 'function', function: { name: 'issue_refund', arguments: { order_id: 'B' } } }] }) });
  const r = await api.chat('router').chat({ messages: [{ role: 'user', content: 'x' }], tools }, { purpose: 'host_sim', salt: 's' });
  assert.equal(r.message.tool_calls?.[0].id, 'call_0');
  assert.equal(r.message.tool_calls?.[0].function.arguments, '{"order_id":"B"}');
});

test('openai-compatible: local server needs no key and is priced $0', async () => {
  const { api, fetch } = setup({ cfg, cap: 0 });
  const r = await api.chat('named.local').chat({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'judge', salt: 's' });
  assert.equal(r.usd_list, 0);
  assert.equal('authorization' in fetch.calls[0].headers, false);
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(api.chat('local').family, 'alibaba');
});

test('openai-compatible: missing api key env is a usage error; 401 is AuthLostError; 400 is HarnessError', async () => {
  assert.throws(() => setup({ cfg, env: {} }).api.chat('router'), UsageError);
  const a = setup({ cfg, env: { ROUTER_KEY: 'k' }, handler: () => ({ status: 401, json: { error: 'bad key' } }) });
  await assert.rejects(a.api.chat('router').chat({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'judge', salt: 's' }), AuthLostError);
  assert.equal(a.fetch.calls.length, 1, 'no refresh for API keys');
  const b = setup({ cfg, env: { ROUTER_KEY: 'k' }, handler: () => ({ status: 400, json: { error: 'bad request' } }) });
  await assert.rejects(b.api.chat('router').chat({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'judge', salt: 's' }), HarnessError);
  const c = setup({ cfg: { named: { x: { provider: 'openai-compatible', model: 'm' } } } });
  assert.throws(() => c.api.chat('x'), UsageError, 'base_url required');
});

test('openai-compatible: a network error is retried, then reported as 599 and charged its worst case', async () => {
  const { api } = setup({ cfg, env: { ROUTER_KEY: 'k' }, handler: () => ({ throw: 'ECONNRESET' }), extra: { maxAttempts: 2, prices: { 'openai/gpt-5-mini': { in_per_mtok: 1, out_per_mtok: 1 } } } });
  await assert.rejects(api.chat('router').chat({ messages: [{ role: 'user', content: 'x' }], max_tokens: 1000 }, { purpose: 'host_sim', salt: 's' }), (e: any) => e.http_status === 599);
  const row = api.rows()[0];
  assert.equal(row.status, 'error');
  assert.ok(row.usd_list >= 1000 / 1e6, 'worst case charged');
});
