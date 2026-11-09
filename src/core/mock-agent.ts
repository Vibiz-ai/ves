// Generic MockAgent connector (DESIGN-agnostic §7.1 item 6). No model, no network, deterministic. It speaks the same
// Connector interface as the real connectors and calls tools ONLY through HarnessIO.callTool (the proxy), so its
// records are produced exactly like a real agent's. The connector adapter hands it the case script in
// session.open.context["ves.mock"]; a real agent never receives that key.
//   oracle      the case's scripted reference solution; `ask` steps become structured hitl.request events
//   trivial     do-nothing: replies "Got it.", calls no tools
//   always-act  the naive arm (§8.4): performs every forbidden/gated target at once, ignoring approval, and copies
//               planted canaries and foreign-tenant entities into its args and reply
// Faults (tests and demos): unsafeCases -> always-act, breakCases -> trivial, flakyRate (seeded per trial).
// `rpc` turns (contract variants, mcp-conformance): the oracle answers them from a REFERENCE MCP server over the
// session's tools (src/proxy/mcp-server.ts): unknown names and schema-invalid args are refused before the proxy,
// valid calls go through HarnessIO.callTool. Every JSON-RPC exchange is reported as an `mcp.rpc` effect, exactly as
// a contract-mode connector does (src/proxy/mcp-transcript.ts). The other behaviours keep no transcript.
import { mulberry32 } from '../lib/rng.ts';
import { validate } from '../lib/jsonschema.ts';
import { createMcpHandler } from '../proxy/mcp-server.ts';
import { McpTranscriptClient, RPC_EFFECT, type RpcExchange } from '../proxy/mcp-transcript.ts';
import type {
  AgentInfo, ConnSession, Connector, ConnectorFactory, HarnessIO, Health, HitlDecision, OracleStep2, PrincipalRole, SessionOpen, TurnOutcome, UserTurn,
} from './types.ts';

export type MockBehaviour = 'oracle' | 'trivial' | 'always-act';
export type MockFaults2 = { flakyRate?: number; unsafeCases?: string[]; breakCases?: string[] };
/** What the connector adapter puts in session.open.context["ves.mock"]. */
export type MockScript = {
  steps: OracleStep2[]; say_turns: number; authorized: PrincipalRole[];
  always_act: { tool: string; args: Record<string, unknown> }[]; always_act_extra: string[];
  chat_phrases: { approve: string; reject: string; ambiguous: string };
  /** The case has `rpc` turns: the oracle keeps a reference MCP transcript. */
  rpc?: boolean;
};
type MockSession = ConnSession & {
  io: HarnessIO; script: MockScript; behaviour: MockBehaviour; ptr: number; sayLeft: number; n: number;
  pending: { request_id: string; tool: string; args: Record<string, unknown>; thread: string } | null;
  mcp?: McpTranscriptClient;
};
const reportRpc = (io: HarnessIO, sid: string, xs: RpcExchange[]): void => {
  for (const ex of xs) io.report({ type: 'effect', session_id: sid, kind: RPC_EFFECT, args: ex as unknown as Record<string, unknown> });
};
const DONE: TurnOutcome = { status: 'done' };
const AWAIT: TurnOutcome = { status: 'awaiting_hitl' };
export const MOCK_VERSION = '2.0.0-mock';

export class MockAgent implements Connector {
  readonly kind = 'mock' as const;
  readonly version = MOCK_VERSION;
  behaviour: MockBehaviour; faults: MockFaults2;
  constructor(o: { behaviour?: MockBehaviour; faults?: MockFaults2 } = {}) { this.behaviour = o.behaviour ?? 'oracle'; this.faults = o.faults ?? {}; }
  async health(): Promise<Health> { return { ok: true }; }
  async info(): Promise<AgentInfo> {
    return { name: `mock:${this.behaviour}`, version: this.version, framework: 'ves-mock', model: 'none', protocol: 'ves-agent/1', capabilities: [], diffsFromProd: [
      'MOCK connection: no agent and no model in the loop; replays the case oracle (or a baseline behaviour) deterministically',
      'verdicts from this connection test the harness, graders, packs and gate only; they are not evidence about the agent',
    ] };
  }
  capabilities(): ReadonlySet<string> { return new Set(['multi_turn', 'hitl_structured', 'hitl_chat', 'schedule_clock', 'rpc']); }
  async routesHash(): Promise<string> { return `mock:${this.version}`; }

  async open(o: SessionOpen, io: HarnessIO): Promise<ConnSession> {
    const script = (o.context?.['ves.mock'] ?? null) as MockScript | null;
    if (!script) throw new Error('MockAgent needs session.open.context["ves.mock"] (only the connector adapter sets it)');
    let behaviour = this.behaviour;
    if (behaviour === 'oracle') {
      if (this.faults.unsafeCases?.includes(o.case_id)) behaviour = 'always-act';
      else if (this.faults.breakCases?.includes(o.case_id)) behaviour = 'trivial';
      else if (this.faults.flakyRate && mulberry32(o.seed ^ 0x5eed)() < this.faults.flakyRate) behaviour = 'trivial';
    }
    const s: MockSession = { id: o.session_id, io, script, behaviour, ptr: 0, sayLeft: script.say_turns, n: 0, pending: null };
    if (behaviour === 'oracle' && script.rpc) {
      const tools = () => o.tools;
      const handle = createMcpHandler({ tools, invoke: async (name, args) => {
        const t = o.tools.find((x) => x.name === name);
        if (!t) return { ok: false, error: 'unknown_tool' };
        const errs = validate(t.input_schema as Record<string, unknown>, args);
        if (errs.length) return { ok: false, error: 'invalid_args', details: errs.slice(0, 10) };
        return io.callTool({ call_id: `mock-rpc-${++s.n}`, name, args, transport: 'mcp' });
      } });
      s.mcp = new McpTranscriptClient((body, headers) => handle({ method: 'POST', path: '/mcp', headers, body: JSON.stringify(body) }));
      reportRpc(io, s.id, await s.mcp.initialize());
    }
    return s;
  }
  private say(s: MockSession, text: string): void { s.io.report({ type: 'message', session_id: s.id, text }); }

  /** Execute oracle steps up to and including the next reply (all remaining on the last user turn); stop at an ask. */
  private async advance(s: MockSession, last: boolean, thread: string): Promise<TurnOutcome> {
    while (s.ptr < s.script.steps.length) {
      const st = s.script.steps[s.ptr++];
      if ('reply' in st) { this.say(s, st.reply); if (!last) return DONE; continue; }
      if ('ask' in st) {
        const request_id = `req-${++s.n}`;
        s.pending = { request_id, tool: st.ask.tool, args: st.ask.args, thread };
        s.io.report({ type: 'hitl.request', session_id: s.id, request_id, tool: st.ask.tool, args: st.ask.args, ...(st.ask.prompt ? { prompt: st.ask.prompt } : {}) });
        this.say(s, st.ask.prompt ?? `Before I do this, please confirm: ${st.ask.tool} ${JSON.stringify(st.ask.args)}.`);
        return AWAIT;
      }
      await s.io.callTool({ call_id: `mock-${++s.n}`, name: st.call, args: st.args, thread, transport: 'pipe' });
    }
    return DONE;
  }
  private async alwaysAct(s: MockSession): Promise<TurnOutcome> {
    for (const t of s.script.always_act) await s.io.callTool({ call_id: `mock-${++s.n}`, name: t.tool, args: t.args, transport: 'pipe' });
    this.say(s, ['Done, all of it.', ...s.script.always_act_extra].join(' '));
    return DONE;
  }
  /** Skip the asked tool's calls and the reply that would announce them (the oracle does not act without approval). */
  private skipPending(s: MockSession, tool: string): void {
    while (s.ptr < s.script.steps.length) {
      const st = s.script.steps[s.ptr];
      if ('call' in st && st.call === tool) { s.ptr++; continue; }
      if ('reply' in st) { s.ptr++; }
      break;
    }
  }

  async turn(sess: ConnSession, t: UserTurn): Promise<TurnOutcome> {
    const s = sess as MockSession;
    if (t.turn_id.startsWith('hitl-')) return this.chatDecision(s, t);
    s.sayLeft -= 1;
    if (s.behaviour === 'trivial') { this.say(s, 'Got it.'); return DONE; }
    if (s.behaviour === 'always-act') { if (s.sayLeft <= 0) return this.alwaysAct(s); this.say(s, 'On it.'); return DONE; }
    return this.advance(s, s.sayLeft <= 0, t.thread);
  }
  /** A decision delivered as chat text (no structured request was pending). */
  private async chatDecision(s: MockSession, t: UserTurn): Promise<TurnOutcome> {
    if (s.behaviour !== 'oracle') return DONE;
    // bound like a structured decision: an authorized principal, the asking thread, unchanged details
    const askedIn = s.pending?.thread;
    const yes = t.text.startsWith(s.script.chat_phrases.approve) && s.script.authorized.includes(t.as) && !/changed the details/.test(t.text) && (askedIn === undefined || t.thread === askedIn);
    if (s.pending) { if (!yes) this.skipPending(s, s.pending.tool); s.pending = null; }
    if (!yes) { this.say(s, 'I will hold off. Nothing was changed.'); return DONE; }
    return this.advance(s, s.sayLeft <= 0, t.thread);
  }
  async decide(sess: ConnSession, d: HitlDecision): Promise<TurnOutcome> {
    const s = sess as MockSession;
    const p = s.pending;
    s.pending = null;
    if (s.behaviour !== 'oracle' || !p) return DONE;
    const ok = d.decision === 'approve' && s.script.authorized.includes(d.as) && d.thread === p.thread && !d.args_edited && !/changed the details/.test(d.text ?? '');
    if (!ok) {
      this.skipPending(s, p.tool);
      this.say(s, d.decision === 'approve' && /changed the details/.test(d.text ?? '')
        ? 'The details changed after you approved, so I need a fresh approval for the new values. Nothing was changed.'
        : 'Okay, I have not done it.');
      return DONE;
    }
    return this.advance(s, s.sayLeft <= 0, p.thread);
  }
  async rpc(sess: ConnSession, r: { method: string; params?: Record<string, unknown> }): Promise<TurnOutcome> {
    const s = sess as MockSession;
    if (s.mcp) reportRpc(s.io, s.id, await s.mcp.rpc(r.method, r.params));
    return DONE;
  }
  async advanceClock(): Promise<TurnOutcome> { return DONE; }
  async wake(sess: ConnSession): Promise<TurnOutcome> {
    const s = sess as MockSession;
    s.sayLeft -= 1;
    if (s.behaviour === 'trivial') return DONE;
    if (s.behaviour === 'always-act') return this.alwaysAct(s);
    return this.advance(s, s.sayLeft <= 0, 'thread-main');
  }
  async close(): Promise<void> {}
}

export const mockFactory: ConnectorFactory = { kind: 'mock', version: MOCK_VERSION, create: (cfg) => new MockAgent({ behaviour: (cfg.behaviour as MockBehaviour) ?? 'oracle', faults: cfg.faults as MockFaults2 }) };
