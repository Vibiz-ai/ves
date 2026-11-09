// `openai-chat` connector (DESIGN-agnostic §1.5): drive any OpenAI-compatible /chat/completions endpoint (the team's
// agent server, LiteLLM, vLLM, Ollama, a gateway, or a raw model under test) with NO agent-side code.
//   { "type": "openai-chat", "base_url": "http://127.0.0.1:4000/v1", "model": "support-agent", "api_key_env": "AGENT_KEY",
//     "tools": "harness", "system": "prompts/system.md", "max_steps": 20, "params": { "temperature": 0 },
//     "headers": {}, "hitl": { "request_tool": false } }
// tools "harness" (default): the endpoint returns tool_calls, the harness executes them through HarnessIO.callTool
//   (transport "loop", proxied records). tools "server": the endpoint runs its own tools and returns text only; every
//   call is unobservable, so safety graders `error` (the card says so through diffsFromProd).
// HITL: chat mode by default (the model asks in text; the harness's decision arrives as user text). With
//   hitl.request_tool, one extra function `ves_request_approval({tool, args, prompt})` maps to hitl.request; because it
//   changes the tool list under test it is listed in diffsFromProd.
// HTTP 401/403/429/5xx from the endpoint (or an unreachable endpoint) -> origin "provider" -> INVALID, never FAIL.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { abandonParked, loop, newLoopState, resume, resultContent, toOpenAITools, type LoopOpts, type LoopState, type OpenAITool } from '../_shared/tool-loop.ts';
import { isProviderInfraStatus } from '../_shared/protocol.ts';
import type {
  AgentInfo, ChatMessage, ConnectionConfig, ConnSession, Connector, ConnectorDeps, ConnectorFactory, HarnessIO, Health, HitlDecision, SessionOpen, TurnOutcome, UserTurn,
} from '../../core/types.ts';

export const OPENAI_CHAT_VERSION = '1.0.0';
export const APPROVAL_TOOL = 'ves_request_approval';
const APPROVAL_FN: OpenAITool = { type: 'function', function: {
  name: APPROVAL_TOOL, description: 'Ask the user to approve an action before you perform it. Wait for the decision; perform the action yourself only after an approval.',
  parameters: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' }, prompt: { type: 'string' } }, required: ['tool', 'args'] },
} };

type Sess = ConnSession & { io: HarnessIO; st: LoopState; opts: LoopOpts; open: SessionOpen };
export class ProviderError extends Error {
  http_status?: number; origin: 'provider' | 'agent';
  constructor(msg: string, status?: number, origin?: 'provider' | 'agent') { super(msg); this.http_status = status; this.origin = origin ?? (isProviderInfraStatus(status) ? 'provider' : 'agent'); }
}

export class OpenAIChatConnector implements Connector {
  readonly kind = 'openai-chat' as const;
  readonly version = OPENAI_CHAT_VERSION;
  readonly cfg: ConnectionConfig; readonly deps: ConnectorDeps;
  constructor(cfg: ConnectionConfig, deps: ConnectorDeps) {
    if (typeof cfg.base_url !== 'string' || !cfg.base_url) throw new Error('openai-chat connector needs connection.base_url (e.g. http://127.0.0.1:4000/v1)');
    if (typeof cfg.model !== 'string' || !cfg.model) throw new Error('openai-chat connector needs connection.model');
    this.cfg = cfg; this.deps = deps;
  }
  private get toolsMode(): 'harness' | 'server' { return this.cfg.tools === 'server' ? 'server' : 'harness'; }
  private get requestTool(): boolean { return !!(this.cfg.hitl && typeof this.cfg.hitl === 'object' && (this.cfg.hitl as Record<string, unknown>).request_tool); }
  private key(): string | undefined { return typeof this.cfg.api_key_env === 'string' ? this.deps.env[this.cfg.api_key_env] : undefined; }
  system(): string | undefined {
    const s = this.cfg.system;
    if (typeof s !== 'string' || !s) return undefined;
    for (const base of [this.deps.configDir, this.deps.repoRoot]) {
      const f = resolve(base, s);
      if (/\.(md|txt|prompt)$/i.test(s) && existsSync(f)) return readFileSync(f, 'utf8');
    }
    return s;
  }

  async health(): Promise<Health> {
    if (typeof this.cfg.api_key_env === 'string' && !this.key()) return { ok: false, reason: 'harness_bug', detail: `env ${this.cfg.api_key_env} (connection.api_key_env) is not set` };
    return { ok: true };
  }
  async info(): Promise<AgentInfo> {
    const diffs: string[] = [];
    if (this.toolsMode === 'server') diffs.push('tools: "server" - the endpoint runs its own tools; tool calls are unobservable, so safety graders report error unless a trace or the proxy backend is used');
    if (this.requestTool) diffs.push(`hitl.request_tool adds the function ${APPROVAL_TOOL} to the tool list under test`);
    if (this.cfg.system) diffs.push('system prompt supplied by the connection config, not by the production agent');
    return { name: String(this.cfg.model), framework: 'openai-compatible', model: String(this.cfg.model), protocol: 'openai-chat/1', capabilities: [...this.capabilities()], diffsFromProd: diffs };
  }
  capabilities(): ReadonlySet<string> { return new Set(['multi_turn', 'hitl_chat', ...(this.requestTool ? ['hitl_structured'] : [])]); }
  async routesHash(): Promise<string> {
    return createHash('sha256').update(JSON.stringify({ kind: this.kind, base: this.cfg.base_url, model: this.cfg.model, tools: this.toolsMode, system: this.system() ?? null, params: this.cfg.params ?? null, request_tool: this.requestTool })).digest('hex');
  }

  /** One /chat/completions request (fetch injected). */
  async complete(messages: ChatMessage[], tools: OpenAITool[]): Promise<{ message: ChatMessage; usage?: { input_tokens: number; output_tokens: number } }> {
    const url = `${String(this.cfg.base_url).replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    const k = this.key();
    if (k) headers.authorization = `Bearer ${k}`;
    if (this.cfg.headers && typeof this.cfg.headers === 'object') for (const [h, v] of Object.entries(this.cfg.headers as Record<string, unknown>)) headers[h.toLowerCase()] = String(v);
    const body = { ...((this.cfg.params as Record<string, unknown>) ?? {}), model: this.cfg.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
    let res;
    try { res = await this.deps.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); } catch (e) { throw new ProviderError(`endpoint unreachable: ${(e as Error).message}`, 503, 'provider'); }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new ProviderError(`chat/completions -> HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
    let j: any;
    try { j = JSON.parse(text); } catch { throw new ProviderError('chat/completions returned non-JSON'); }
    const m = j?.choices?.[0]?.message;
    if (!m) throw new ProviderError('chat/completions returned no choices[0].message');
    const tool_calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter((c: any) => c?.function?.name).map((c: any, i: number) => ({ id: String(c.id ?? `call_${i}`), type: 'function' as const, function: { name: String(c.function.name), arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) } })) : [];
    const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? '').join('') : null;
    const u = j.usage;
    return { message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) }, ...(u ? { usage: { input_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0), output_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) } } : {}) };
  }

  async open(o: SessionOpen, io: HarnessIO): Promise<ConnSession> {
    const sys = [this.system(), o.system].filter(Boolean).join('\n\n') || undefined;
    const wire = this.toolsMode === 'harness' ? toOpenAITools(o.tools, this.requestTool ? [APPROVAL_FN] : []) : { tools: [] as OpenAITool[], map: (n: string) => n, unmap: (w: string) => w };
    const s = { id: o.session_id, io, open: o, st: newLoopState(sys) } as Sess;
    s.opts = {
      chat: (m, t) => this.complete(m, t), tools: wire.tools, unmap: wire.unmap,
      maxSteps: typeof this.cfg.max_steps === 'number' ? this.cfg.max_steps : 20,
      onText: (text) => io.report({ type: 'message', session_id: s.id, text }),
      onUsage: (u) => io.report({ type: 'usage', session_id: s.id, model: String(this.cfg.model), input_tokens: u.input_tokens, output_tokens: u.output_tokens }),
      onToolCall: async (c) => {
        if (c.name === APPROVAL_TOOL && this.requestTool) {
          const tool = String(c.args.tool ?? '');
          const args = c.args.args && typeof c.args.args === 'object' && !Array.isArray(c.args.args) ? (c.args.args as Record<string, unknown>) : {};
          io.report({ type: 'hitl.request', session_id: s.id, request_id: c.id, tool: wire.unmap(tool), args, ...(typeof c.args.prompt === 'string' ? { prompt: c.args.prompt } : {}) });
          return { kind: 'park' };
        }
        const r = await io.callTool({ call_id: c.id, name: c.name, args: c.args, transport: 'loop' });
        // Unparseable arguments are still recorded (as {} -> invalid_args in the proxy), and the model is told why.
        return { kind: 'result', content: c.argsError ? JSON.stringify({ error: c.argsError, proxy: r.ok ? 'ok' : r.error }) : resultContent(r) };
      },
    };
    return s;
  }
  private async guard(p: Promise<TurnOutcome>): Promise<TurnOutcome> {
    try { return await p; } catch (e) {
      const err = e as ProviderError;
      return { status: 'error', error: { message: err.message, origin: err.origin ?? 'agent', ...(err.http_status !== undefined ? { http_status: err.http_status } : {}) } };
    }
  }
  turn(sess: ConnSession, t: UserTurn): Promise<TurnOutcome> {
    const s = sess as Sess;
    abandonParked(s.st, 'the user sent a new message instead of a decision');
    s.st.messages.push({ role: 'user', content: t.text });
    return this.guard(loop(s.st, s.opts));
  }
  decide(sess: ConnSession, d: HitlDecision): Promise<TurnOutcome> {
    const s = sess as Sess;
    if (!s.st.parked) return Promise.resolve({ status: 'done' });
    return this.guard(resume(s.st, JSON.stringify({ decision: d.decision, by: d.as, thread: d.thread, ...(d.text ? { note: d.text } : {}) }), s.opts));
  }
  async close(): Promise<void> {}
}

const factory: ConnectorFactory = { kind: 'openai-chat', version: OPENAI_CHAT_VERSION, create: (cfg, deps) => new OpenAIChatConnector(cfg, deps) };
export default factory;
