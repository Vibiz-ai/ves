// `trace` connector (DESIGN-agnostic §1.8): grade recorded traces instead of a live agent.
//   { "type": "trace", "format": "otel-genai" | "atif" | "openai-agents", "files": "traces/**/*.json" }
// A trace case has `input.trace: {file, format}` and no turns; core calls `ingest()` instead of turns. Every tool call
// is reported at level `traced`: it can FAIL a safety grader (a gated write with no harness approval), never PASS one.
// HITL decisions inside a trace are agent-reported, so G1 can fail but cannot pass on traces.
// Uses: offline regression on recorded runs, online sampling (VES-1 §9.3), teams that cannot run their agent in CI.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { globFiles } from '../_shared/routes.ts';
import { HarnessError, FixtureError } from '../../core/errors.ts';
import { parseTrace, verifySignature, type ParsedTrace } from './parsers.ts';
import type { AgentInfo, ConnectionConfig, ConnSession, ConnectorDeps, ConnectorFactory, HarnessIO, Health, SessionOpen, TraceConnector, TurnOutcome } from '../../core/types.ts';

export const TRACE_VERSION = '1.0.0';
type Sess = ConnSession & { io: HarnessIO; parsed?: ParsedTrace; signed?: boolean };

export class TraceConnectorImpl implements TraceConnector {
  readonly kind = 'trace' as const;
  readonly version = TRACE_VERSION;
  readonly cfg: ConnectionConfig; readonly deps: ConnectorDeps;
  constructor(cfg: ConnectionConfig, deps: ConnectorDeps) { this.cfg = cfg; this.deps = deps; }
  private get format(): string { return typeof this.cfg.format === 'string' ? this.cfg.format : 'otel-genai'; }
  files(): string[] {
    const g = this.cfg.files;
    const globs = Array.isArray(g) ? g.map(String) : typeof g === 'string' ? [g] : [];
    return globs.length ? globFiles(this.deps.configDir, globs) : [];
  }
  resolveFile(f: string): string | null {
    if (isAbsolute(f)) return existsSync(f) ? f : null;
    for (const base of [this.deps.configDir, this.deps.repoRoot]) { const p = resolve(base, f); if (existsSync(p)) return p; }
    return null;
  }
  async health(): Promise<Health> {
    if (!['otel-genai', 'atif', 'openai-agents'].includes(this.format)) return { ok: false, reason: 'harness_bug', detail: `unknown trace format ${this.format}` };
    return { ok: true };
  }
  async info(): Promise<AgentInfo> {
    return { name: `trace:${this.format}`, framework: 'trace', protocol: `trace/${this.format}`, capabilities: [], diffsFromProd: [
      'recorded traces, no live agent: tool calls are traced evidence (can fail a safety check, never pass one)',
      'HITL decisions inside a trace are agent-reported; G1 cannot pass on traces',
    ] };
  }
  capabilities(): ReadonlySet<string> { return new Set(); }
  async routesHash(): Promise<string> {
    const h = createHash('sha256').update(JSON.stringify({ kind: this.kind, format: this.format }));
    for (const f of this.files()) h.update(`${f}:${createHash('sha256').update(readFileSync(resolve(this.deps.configDir, f))).digest('hex')}`);
    return h.digest('hex');
  }
  async open(o: SessionOpen, io: HarnessIO): Promise<ConnSession> { return { id: o.session_id, io } as Sess; }
  async turn(): Promise<TurnOutcome> { throw new HarnessError('the trace connector has no live agent: only cases with input.trace (and no turns) run on a trace variant'); }
  async decide(): Promise<TurnOutcome> { throw new HarnessError('the trace connector cannot take HITL decisions (decisions inside a trace are agent-reported)'); }

  async ingest(sess: ConnSession, trace: { file: string; format: string }): Promise<TurnOutcome> {
    const s = sess as Sess;
    const f = this.resolveFile(trace.file);
    if (!f) throw new FixtureError(`trace file ${trace.file} not found (looked in ${this.deps.configDir}, ${this.deps.repoRoot})`);
    const text = readFileSync(f, 'utf8');
    const p = parseTrace(trace.format || this.format, text);
    s.parsed = p;
    try { s.signed = trace.format !== 'openai-agents' && verifySignature(JSON.parse(text), this.deps.env.VES_TRACE_KEY); } catch { s.signed = false; }
    for (const w of p.warnings) this.deps.log('warn', `[trace] ${trace.file}: ${w}`);
    let n = 0;
    for (const e of p.events) {
      if (e.kind === 'tool') s.io.report({ type: 'tool_event', session_id: s.id, call_id: e.call_id ?? `tr-${++n}`, name: e.name, args: e.args, ok: e.ok, ...(e.result !== undefined ? { result: e.result } : {}) }, 'traced');
      else if (e.kind === 'message') s.io.report({ type: 'message', session_id: s.id, text: e.text }, 'traced');
      else if (e.kind === 'hitl') s.io.report({ type: 'hitl.request', session_id: s.id, request_id: e.request_id, tool: e.tool, args: e.args, ...(e.prompt ? { prompt: e.prompt } : {}) }, 'traced');
      else s.io.report({ type: 'usage', session_id: s.id, ...(e.model ? { model: e.model } : {}), input_tokens: e.input_tokens, output_tokens: e.output_tokens }, 'traced');
    }
    return { status: 'done' };
  }
  async close(): Promise<void> {}
}

const factory: ConnectorFactory = { kind: 'trace', version: TRACE_VERSION, create: (cfg, deps) => new TraceConnectorImpl(cfg, deps) };
export default factory;
