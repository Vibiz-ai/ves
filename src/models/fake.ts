// Deterministic fakes, for tests and offline runs (no network, no money):
//  - createFakeProvider: a Provider whose answers come from a pure function of the effective body, run through the
//    same cache and ledger as real providers (price 0, family 'fake');
//  - defaultFakeResponder: answers by response_format schema name (judge -> unknown, simulator -> approve a pending
//    request or stop, intents -> none), otherwise a hash echo;
//  - fakeOpenAIFetch: an injected FetchLike that behaves like an OpenAI-compatible /chat/completions server and
//    records every request (url, headers, parsed body), so the real HTTP providers are tested end to end;
//  - fakeExec: an injected ExecLike for `gcloud auth application-default print-access-token`.
import { sha256 } from '../lib/hash.ts';
import { canonicalJson } from '../lib/canonicalise.ts';
import type { ExecLike, FetchLike, ModelRef } from '../core/types.ts';
import type { Provider } from './provider.ts';

export type FakeCompletion = { content?: string | null; tool_calls?: unknown[]; finish_reason?: string; usage?: { prompt_tokens: number; completion_tokens: number } };
export type FakeResponder = (body: Record<string, any>) => FakeCompletion;

const lastUserText = (body: Record<string, any>): string => {
  const ms = (body.messages ?? []) as { role: string; content: unknown }[];
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') return String(ms[i].content ?? '');
  return '';
};

export const defaultFakeResponder: FakeResponder = (body) => {
  const name = body.response_format?.json_schema?.name ?? (body.response_format?.type === 'json_object' ? 'json_object' : null);
  if (name === 'ves_judge') return { content: JSON.stringify({ label: 'unknown', explanation: 'fake judge: no judgement' }) };
  if (name === 'ves_user_sim') {
    const u = lastUserText(body);
    if (/## Pending approval request\n(?!none)/.test(u)) return { content: JSON.stringify({ action: 'hitl', decision: 'approve', text: 'yes, go ahead' }) };
    return { content: JSON.stringify({ action: 'stop', reason: 'fake simulator: goal treated as met' }) };
  }
  if (name === 'json_object') return { content: JSON.stringify({ intents: [] }) };
  return { content: `fake:${sha256(canonicalJson(body.messages ?? [])).slice(0, 12)}` };
};

export function completionJson(model: string, c: FakeCompletion, body: Record<string, unknown>): Record<string, unknown> {
  const content = c.content === undefined ? null : c.content;
  const usage = c.usage ?? {
    prompt_tokens: Math.ceil(JSON.stringify(body.messages ?? []).length / 4),
    completion_tokens: Math.ceil(String(content ?? JSON.stringify(c.tool_calls ?? '')).length / 4),
  };
  return {
    id: `chatcmpl-fake-${sha256(canonicalJson(body)).slice(0, 12)}`, object: 'chat.completion', model,
    choices: [{ index: 0, finish_reason: c.finish_reason ?? (c.tool_calls?.length ? 'tool_calls' : 'stop'),
                message: { role: 'assistant', content, ...(c.tool_calls?.length ? { tool_calls: c.tool_calls } : {}) } }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

export function createFakeProvider(ref: ModelRef, responder: FakeResponder = defaultFakeResponder): Provider {
  const model = ref.model || 'fake-1';
  return {
    name: 'fake', model, family: 'fake', local: true,
    effectiveBody: (req) => {
      const b: Record<string, unknown> = { model, messages: req.messages };
      for (const k of ['tools', 'tool_choice', 'temperature', 'max_tokens', 'seed', 'response_format'] as const) if (req[k] !== undefined) b[k] = req[k];
      return b;
    },
    send: async (body) => ({ json: completionJson(model, responder(body), body) }),
  };
}

export type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body: any };
export type FakeHttpAnswer = { status?: number; json?: unknown; text?: string; throw?: string } | FakeCompletion;
/** Handler returns a completion ({content, tool_calls}) for a 200, or {status, json|text} for anything else, or {throw}. */
export function fakeOpenAIFetch(handler: (body: any, req: RecordedRequest, n: number) => FakeHttpAnswer): FetchLike & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const f = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const rec: RecordedRequest = { url, method: init.method, headers: { ...init.headers }, body };
    calls.push(rec);
    const a = handler(body, rec, calls.length) as any;
    if (a && typeof a.throw === 'string') throw new TypeError(a.throw);
    let status = 200;
    let text: string;
    if (a && (a.status !== undefined || a.json !== undefined || a.text !== undefined)) {
      status = a.status ?? 200;
      text = a.text ?? JSON.stringify(a.json ?? {});
    } else text = JSON.stringify(completionJson(body?.model ?? 'fake', a as FakeCompletion, body ?? {}));
    return { status, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => text };
  }) as FetchLike & { calls: RecordedRequest[] };
  f.calls = calls;
  return f;
}

/** Each call to gcloud consumes the next item: a token string, or {code, stderr} for a failure. The last item repeats. */
export function fakeExec(outputs: (string | { code: number; stderr?: string })[]): ExecLike & { calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const f = (async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const o = outputs[Math.min(calls.length - 1, outputs.length - 1)];
    if (typeof o === 'string') return { code: 0, stdout: `${o}\n`, stderr: '' };
    return { code: o.code, stdout: '', stderr: o.stderr ?? 'ERROR: (gcloud.auth.application-default.print-access-token) Reauthentication failed.' };
  }) as ExecLike & { calls: { cmd: string; args: string[] }[] };
  f.calls = calls;
  return f;
}
