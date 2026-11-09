// `ves cases from-trace`: turn a real (failed) conversation into a ves-case/2 regression case.
//
// Inputs (one conversation each):
//   atif      an ATIF trajectory (trajectories/*.atif.json in a run directory, or any ATIF v1.x file)
//   run row   --run <dir> --row <row_id | case@variant#trial>: the row's trajectory, its expanded case (exact turns,
//             fixture, variants, limits) and its failed graders
//   openai    OpenAI-chat messages: [{role, content, tool_calls}] (or {messages: [...]}), `role: tool` results
//   otel      OTel GenAI events JSONL (gen_ai.user.message / gen_ai.assistant.message / gen_ai.tool.message /
//             gen_ai.choice, or events carrying gen_ai.input.messages / gen_ai.output.messages), or OTLP spans
// Output: a case that replays the user turns, keeps the fixture reference, and derives expectations conservatively:
//   - every tool the original called successfully -> `expect.calls` with `call_match` ADVISORY (a hint, not a bar);
//   - every safety grader (and claims_vs_ledger) that failed on the original row -> listed as a GATE grader;
//   - a `reply_check` GATE placeholder whose `mentions` is the literal TODO_REPLY_CHECK: the scripted oracle says it,
//     a do-nothing agent and a real agent do not, so the case passes `ves validate` (oracle 100%, trivial fails) and
//     cannot silently pass a real run until a human writes the real regexes (and the oracle reply) in;
//   - an oracle that replays the original's successful calls to ungated tools, then the TODO reply;
//   - provenance {source: production-failure, source_ref, run_id, row_id, captured_at, redacted: true}.
// PII is redacted by default (emails, phone numbers, tokens and keys, long digit runs), with stable placeholders so
// the same value maps to the same placeholder everywhere in the case. The project's own fixture is not rewritten.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseOtel } from '../connectors/trace/parsers.ts';
import { reportedName, type ReportedNames } from '../graders/claims.ts';
import { canonicalJson } from '../lib/canonicalise.ts';
import type { Case2, Catalog, Fixture2, GraderSpec2, Turn2 } from '../core/types.ts';

export type TraceFormat = 'atif' | 'openai' | 'otel';
export type ConvCall = { tool: string; args: Record<string, unknown>; ok: boolean; source: 'server' | 'host-reported' | 'traced' };
export type ConvSeg = { user: Turn2 | null; replies: string[]; calls: ConvCall[] };
export type Conversation = {
  format: TraceFormat | 'run-row'; segs: ConvSeg[];
  /** From a run row: the original case (turns, fixture, variants, limits), its failed graders and ids. */
  original?: { case: Record<string, any>; caseFile?: string; failed: { grader_id: string; safety: boolean; explanation: string }[]; run_id: string; row_id: string; created_at?: string };
  startedAt?: string; warnings: string[];
};

// ------------------------------------------------------------------------------------------------ redaction
export type Redactor = { (s: string): string; count: number };
const SECRET = String.raw`(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?<=\b(?:bearer|token|api[_-]?key|secret|password)[\s:=]+["']?)[A-Za-z0-9._~+/=-]{12,}|\b[a-f0-9]{32,}\b|\b(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{32,}={0,2}`;
const EMAIL = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;
const PHONE = String.raw`\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b`;
const DIGITS = String.raw`\b\d{7,}\b`;
const PII = new RegExp(`(${SECRET})|(${EMAIL})|(${PHONE})|(${DIGITS})`, 'giu');

/** One redactor per case: each distinct value gets a stable placeholder (user1@example.com, +1-555-0100-1, …). */
export function makeRedactor(): Redactor {
  const seen = new Map<string, string>();
  const n = { secret: 0, email: 0, phone: 0, number: 0 };
  const f = ((s: string) => s.replace(PII, (m, sec, em, ph) => {
    const hit = seen.get(m);
    if (hit) return hit;
    const kind = sec ? 'secret' : em ? 'email' : ph ? 'phone' : 'number';
    const i = ++n[kind];
    const out = kind === 'secret' ? `<redacted-secret-${i}>` : kind === 'email' ? `redacted${i}@example.com` : kind === 'phone' ? `+1-555-0100-${i}` : `<redacted-number-${i}>`;
    seen.set(m, out); f.count++;
    return out;
  })) as Redactor;
  f.count = 0;
  return f;
}
/** Apply a string transform to every string inside a JSON value (keys untouched). */
export function mapStrings<T>(v: T, fn: (s: string) => string): T {
  if (typeof v === 'string') return fn(v) as T;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) as T;
  return v;
}

// --------------------------------------------------------------------------------------------------- parsers
const asObj = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') { try { const j = JSON.parse(v); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch { /* not JSON */ } }
  return {};
};
const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).join('') : '';
const resultFailed = (c: unknown): boolean => {
  const o = asObj(c);
  if (o.ok === false || o.error || o.isError === true) return true;
  return typeof c === 'string' && /^\s*(?:error|exception)\b/i.test(c);
};
/** A user step's text as a case turn (`[hitl:approve]` and `[wake:<id>]` markers are what the proxy writes). */
function userTurn(text: string, ext?: Record<string, any>): Turn2 {
  const ht = ext?.hitl_turn;
  if (ht && typeof ht.hitl === 'string') return { hitl: ht.hitl, ...(ht.as ? { as: ht.as } : {}), ...(ht.thread ? { thread: ht.thread } : {}), ...(ht.text ? { text: ht.text } : {}) } as Turn2;
  const h = /^\[hitl:(approve|reject|timeout|ambiguous)\]$/.exec(text.trim());
  if (h) return { hitl: h[1] as 'approve' };
  const w = /^\[wake:(.+)\]$/.exec(text.trim());
  if (w) return { wake: w[1] };
  return { say: text, ...(ext?.as ? { as: ext.as } : {}) } as Turn2;
}

export function parseAtifConversation(doc: any): Conversation {
  const segs: ConvSeg[] = [{ user: null, replies: [], calls: [] }];
  const warnings: string[] = [];
  if (!Array.isArray(doc?.steps)) return { format: 'atif', segs: [], warnings: ['no steps[] (expected ATIF v1.x)'] };
  let startedAt: string | undefined;
  for (const s of doc.steps) {
    startedAt ??= typeof s.timestamp === 'string' ? s.timestamp : undefined;
    if (s.source === 'user') { segs.push({ user: userTurn(textOf(s.message), s.vibiz), replies: [], calls: [] }); continue; }
    const cur = segs[segs.length - 1];
    if (s.vibiz?.hitl_request) continue;
    if (typeof s.message === 'string' && s.message && !s.tool_calls?.length) cur.replies.push(s.message);
    const res = new Map<string, unknown>((s.observation?.results ?? []).map((r: any) => [String(r.source_call_id), r.content]));
    for (const tc of s.tool_calls ?? []) {
      const src = tc.vibiz?.call_source;
      cur.calls.push({ tool: String(tc.vibiz?.canonical_id ?? tc.function_name ?? tc.name ?? ''), args: asObj(tc.arguments), ok: !resultFailed(res.get(String(tc.tool_call_id))), source: src === 'server' ? 'server' : src === 'host-reported' ? 'host-reported' : 'traced' });
    }
  }
  return { format: 'atif', segs: trimLead(segs), ...(startedAt ? { startedAt } : {}), warnings };
}
const trimLead = (segs: ConvSeg[]): ConvSeg[] => (segs[0] && !segs[0].user && !segs[0].replies.length && !segs[0].calls.length ? segs.slice(1) : segs);

export function parseOpenAIConversation(doc: any): Conversation {
  const msgs: any[] = Array.isArray(doc) ? doc : Array.isArray(doc?.messages) ? doc.messages : [];
  const segs: ConvSeg[] = [{ user: null, replies: [], calls: [] }];
  const pending = new Map<string, ConvCall>();
  for (const m of msgs) {
    if (m?.role === 'user') { segs.push({ user: { say: textOf(m.content) }, replies: [], calls: [] }); continue; }
    const cur = segs[segs.length - 1];
    if (m?.role === 'assistant') {
      const t = textOf(m.content);
      if (t.trim()) cur.replies.push(t);
      for (const tc of m.tool_calls ?? []) {
        const c: ConvCall = { tool: String(tc.function?.name ?? tc.name ?? ''), args: asObj(tc.function?.arguments ?? tc.arguments), ok: true, source: 'traced' };
        cur.calls.push(c);
        if (tc.id) pending.set(String(tc.id), c);
      }
    } else if (m?.role === 'tool') {
      const c = pending.get(String(m.tool_call_id ?? ''));
      if (c && resultFailed(maybeJson(m.content))) c.ok = false;
    }
  }
  return { format: 'openai', segs: trimLead(segs), warnings: msgs.length ? [] : ['no messages (expected [{role, content, tool_calls}])'] };
}
const maybeJson = (v: unknown): unknown => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

/** OTel GenAI events, one JSON object per line (or one OTLP export). */
export function parseOtelConversation(text: string): Conversation {
  const lines = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
  const docs = lines.length === 1 && Array.isArray(lines[0]) ? lines[0] : lines;
  const warnings: string[] = [];
  const segs: ConvSeg[] = [{ user: null, replies: [], calls: [] }];
  const pending = new Map<string, ConvCall>();
  const cur = () => segs[segs.length - 1];
  const addAssistant = (msg: any) => {
    const t = textOf(msg?.content ?? msg?.parts?.filter((p: any) => p?.type === 'text'));
    if (t.trim()) cur().replies.push(t);
    for (const tc of msg?.tool_calls ?? (msg?.parts ?? []).filter((p: any) => p?.type === 'tool_call')) {
      const c: ConvCall = { tool: String(tc.function?.name ?? tc.name ?? ''), args: asObj(tc.function?.arguments ?? tc.arguments), ok: true, source: 'traced' };
      cur().calls.push(c);
      if (tc.id) pending.set(String(tc.id), c);
    }
  };
  const seenUser = new Set<string>();
  const spanDocs = docs.filter((d) => d?.resourceSpans);
  for (const d of docs) {
    if (d?.resourceSpans) continue;
    const name = String(d?.name ?? d?.event_name ?? d?.['event.name'] ?? d?.attributes?.['event.name'] ?? '');
    const body = d?.body && typeof d.body === 'object' ? d.body : asObj(d?.body);
    const attrs = d?.attributes ?? {};
    if (name === 'gen_ai.user.message') { segs.push({ user: { say: textOf(body.content) }, replies: [], calls: [] }); continue; }
    if (name === 'gen_ai.assistant.message') { addAssistant(body); continue; }
    if (name === 'gen_ai.choice') { addAssistant(body.message ?? body); continue; }
    if (name === 'gen_ai.tool.message') { const c = pending.get(String(body.id ?? body.tool_call_id ?? '')); if (c && resultFailed(maybeJson(body.content))) c.ok = false; continue; }
    const input = maybeJson(attrs['gen_ai.input.messages'] ?? body['gen_ai.input.messages']);
    const output = maybeJson(attrs['gen_ai.output.messages'] ?? body['gen_ai.output.messages']);
    if (Array.isArray(input) || Array.isArray(output)) {
      for (const m of Array.isArray(input) ? input : []) if (m?.role === 'user') { const t = textOf(m.content ?? m.parts); if (t && !seenUser.has(t)) { seenUser.add(t); segs.push({ user: { say: t }, replies: [], calls: [] }); } }
      for (const m of Array.isArray(output) ? output : []) addAssistant(m);
    }
  }
  if (spanDocs.length) {
    // OTLP spans: user text from chat spans' gen_ai.input.messages, tools and the final answer via the trace parser
    for (const d of spanDocs) for (const rs of d.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) {
      const a = Object.fromEntries((sp.attributes ?? []).map((x: any) => [x.key, x.value?.stringValue]));
      const input = maybeJson(a['gen_ai.input.messages']);
      for (const m of Array.isArray(input) ? input : []) if (m?.role === 'user') { const t = textOf(m.content ?? m.parts); if (t && !seenUser.has(t)) { seenUser.add(t); segs.push({ user: { say: t }, replies: [], calls: [] }); } }
    }
    const p = parseOtel(spanDocs);
    warnings.push(...p.warnings);
    for (const e of p.events) {
      if (e.kind === 'tool') cur().calls.push({ tool: e.name, args: e.args, ok: e.ok, source: 'traced' });
      if (e.kind === 'message') cur().replies.push(e.text);
    }
  }
  if (!docs.length) warnings.push('no events (expected OTel GenAI events JSONL)');
  return { format: 'otel', segs: trimLead(segs), warnings };
}

export function detectFormat(text: string): TraceFormat {
  let doc: any;
  try { doc = JSON.parse(text); } catch { return 'otel'; }
  if (Array.isArray(doc)) return doc.some((m) => m && typeof m === 'object' && 'role' in m) ? 'openai' : 'otel';
  if (Array.isArray(doc?.steps)) return 'atif';
  if (Array.isArray(doc?.messages)) return 'openai';
  return 'otel';
}
export function parseConversation(text: string, format?: TraceFormat): Conversation {
  const f = format ?? detectFormat(text);
  if (f === 'atif') return parseAtifConversation(JSON.parse(text));
  if (f === 'openai') return parseOpenAIConversation(JSON.parse(text));
  if (f === 'otel') return parseOtelConversation(text);
  throw new Error(`unknown trace format ${String(f)} (atif | openai | otel)`);
}

// ---------------------------------------------------------------------------------------------- run rows
/** Resolve `--row` (a row_id, or `case_id@variant#trial`, or `case_id#trial`) in a run directory. */
export function findRow(runDir: string, ref: string): any {
  const rows = readFileSync(join(runDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const exact = rows.find((r) => r.row_id === ref);
  if (exact) return exact;
  const m = /^(.+?)(?:@([^#]+))?(?:#(\d+))?$/.exec(ref);
  if (!m) throw new Error(`--row ${ref}: expected a row_id or case@variant#trial`);
  const [, cid, variant, trial] = m;
  const hits = rows.filter((r) => r.case_id === cid && (!variant || r.surface === variant) && (trial === undefined || r.trial === Number(trial)));
  if (!hits.length) throw new Error(`--row ${ref}: no such row in ${join(runDir, 'results.jsonl')}`);
  if (hits.length > 1) throw new Error(`--row ${ref} matches ${hits.length} rows (${hits.slice(0, 4).map((h) => `${h.case_id}@${h.surface}#${h.trial}`).join(', ')}…): add @variant and #trial`);
  return hits[0];
}
const slugOf = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export function conversationFromRun(runDir: string, ref: string): Conversation {
  const row = findRow(runDir, ref);
  if (!row.trace?.atif_uri) throw new Error(`row ${row.row_id} has no trajectory (status ${row.status}${row.invalid_reason ? `, ${row.invalid_reason}` : ''})`);
  const conv = parseAtifConversation(JSON.parse(readFileSync(join(runDir, row.trace.atif_uri), 'utf8')));
  const caseFile = join(runDir, 'expanded-cases', `${slugOf(row.case_id)}.case.json`);
  const kase = existsSync(caseFile) ? JSON.parse(readFileSync(caseFile, 'utf8')) : null;
  const extra = existsSync(join(runDir, 'run-extra.json')) ? JSON.parse(readFileSync(join(runDir, 'run-extra.json'), 'utf8')) : {};
  if (!kase) conv.warnings.push(`no expanded case for ${row.case_id} in ${runDir}/expanded-cases: turns come from the trajectory, no fixture reference`);
  const failed = (row.scores ?? []).filter((s: any) => (s.label === 'fail' || s.label === 'error') && (s.safety === true || s.grader_id === 'claims_vs_ledger'))
    .map((s: any) => ({ grader_id: String(s.grader_id), safety: s.safety === true, explanation: String(s.explanation ?? '') }));
  return { ...conv, format: 'run-row', original: { case: kase ?? {}, ...(extra.case_files?.[row.case_id] ? { caseFile: extra.case_files[row.case_id] } : {}), failed, run_id: row.run_id, row_id: row.row_id, created_at: row.created_at } };
}

// -------------------------------------------------------------------------------------------- case build
export type BuildOptions = {
  id?: string; owner?: string; redact: boolean; capturedAt: string; sourceRef: string; outFile: string;
  catalog?: Catalog | null; names?: ReportedNames;
};
export type Built = { kase: Case2; warnings: string[]; redactions: number };

export const TODO_MARK = 'TODO_REPLY_CHECK';
const ID_RE = /^[a-z0-9][a-z0-9._+-]{2,119}$/;

export function buildCase(conv: Conversation, o: BuildOptions): Built {
  const warnings = [...conv.warnings];
  const red = o.redact ? makeRedactor() : Object.assign((s: string) => s, { count: 0 }) as Redactor;
  const R = <T>(v: T): T => mapStrings(v, red);
  const orig = conv.original?.case ?? {};
  const cat = o.catalog ?? null;
  // tool names: the catalog name a call most likely is (prefix stripped / alias applied for self-reports)
  const nameOf = (c: ConvCall) => {
    if (!cat) return c.tool;
    if (cat.byName[c.tool]) return c.tool;
    const n = reportedName(c.tool, o.names ?? {});
    return cat.byName[n] ? n : c.tool;
  };
  const trusted = conv.segs.some((s) => s.calls.some((c) => c.source === 'server')) ? (c: ConvCall) => c.source === 'server' : (c: ConvCall) => c.source !== 'host-reported';
  const unknown = new Set<string>();
  const usable = (c: ConvCall) => { const n = nameOf(c); if (cat && !cat.byName[n]) { unknown.add(c.tool); return false; } return true; };
  // turns: the original case's (exact replay) when known, else the conversation's user steps
  const turns: Turn2[] = Array.isArray(orig.input?.turns) && orig.input.turns.length ? orig.input.turns : conv.segs.map((s) => s.user).filter((t): t is Turn2 => !!t);
  if (!turns.length) throw new Error('the conversation has no user turn to replay');
  const sayN = turns.filter((t) => 'say' in t || 'wake' in t).length;
  // expectations (conservative): what the original did, advisory
  const called: string[] = [];
  for (const s of conv.segs) for (const c of s.calls) if (c.ok && trusted(c) && usable(c) && !called.includes(nameOf(c))) called.push(nameOf(c));
  if (unknown.size) warnings.push(`tool(s) not in the catalog, left out of expect.calls and the oracle: ${[...unknown].join(', ')}`);
  if (!cat) warnings.push('no catalog (pass --config): tool names are not checked, gated tools cannot be told apart, the oracle replays no call');
  // oracle: per say turn (a `say` or `wake`; hitl decisions stay with the say turn before them), the successful calls
  // to ungated catalog tools (each tool+args once), then the TODO reply. The MockAgent runs one bucket per say turn.
  const buckets: ConvCall[][] = Array.from({ length: Math.max(1, sayN) }, () => []);
  let b = 0;
  for (const s of conv.segs) {
    if (s.user && ('say' in s.user || 'wake' in s.user)) b++;
    buckets[Math.min(Math.max(b, 1), buckets.length) - 1].push(...s.calls);
  }
  const steps: NonNullable<Case2['oracle']['steps']> = [];
  const replayed = new Set<string>();
  buckets.forEach((calls, i) => {
    if (cat) for (const c of calls) {
      const n = nameOf(c);
      const k = `${n}|${canonicalJson(c.args)}`;
      if (!c.ok || !trusted(c) || !cat.byName[n] || cat.byName[n].gated || replayed.has(k)) continue;
      replayed.add(k);
      steps.push({ call: n, args: R(c.args) });
    }
    steps.push({ reply: `${TODO_MARK}: replace with the correct reply for turn ${i + 1}, and the reply_check mentions/forbid` });
  });
  // graders: call_match advisory, the TODO reply_check gate, every failed safety / claims grader as a gate
  const originalReplies = conv.segs.map((s) => s.replies.join('\n')).filter((t) => t.trim()).map((t) => (t.length > 600 ? `${t.slice(0, 597)}...` : t));
  const graders: GraderSpec2[] = [
    ...(called.length ? [{ id: 'call_match', role: 'advisory' as const }] : []),
    { id: 'reply_check', role: 'gate', params: R({ todo: 'Write regexes a correct reply must match (mentions) and must not match (forbid), then replace the oracle replies. The original replies are below for reference.', mentions: [TODO_MARK], forbid: [], original_replies: originalReplies }) },
  ];
  for (const f of conv.original?.failed ?? []) {
    if (graders.some((g) => g.id === f.grader_id)) continue;
    const listed = (orig.graders ?? []).find((g: GraderSpec2) => g.id === f.grader_id); // keep a pack grader's params
    graders.push({ id: f.grader_id, role: 'gate', ...(listed?.params ? { params: listed.params } : {}) });
  }
  const expect: Case2['expect'] = called.length ? { calls: called.map((tool) => ({ tool, min: 1 })) } : { forbid: [] };
  // fixture: the original's (its state path re-pointed at the new file's directory), else seed + clock only
  let fixture: Fixture2;
  if (orig.fixture) {
    fixture = structuredClone(orig.fixture);
    if (typeof fixture.state === 'string' && !isAbsolute(fixture.state) && conv.original?.caseFile) {
      const abs = resolve(dirname(conv.original.caseFile), fixture.state);
      if (existsSync(abs)) fixture.state = relative(dirname(resolve(o.outFile)), abs) || fixture.state;
      else warnings.push(`fixture state ${fixture.state} not found next to ${conv.original.caseFile}; check the path`);
    }
  } else {
    const clock = /^\d{4}-\d{2}-\d{2}T/.test(conv.startedAt ?? '') ? new Date(conv.startedAt!).toISOString().replace(/\.\d{3}Z$/, 'Z') : o.capturedAt.replace(/\.\d{3}Z$/, 'Z');
    fixture = { seed: parseInt(createHash('sha256').update(o.sourceRef).digest('hex').slice(0, 7), 16), clock };
  }
  const base = o.id ?? `regress.${(conv.original ? String(orig.id ?? 'case') : 'trace').toLowerCase().replace(/[^a-z0-9._+-]+/g, '-').replace(/^[^a-z0-9]+/, '')}.${createHash('sha256').update(`${o.sourceRef}|${conv.original?.row_id ?? ''}`).digest('hex').slice(0, 6)}`;
  const id = base.slice(0, 120);
  if (!ID_RE.test(id)) throw new Error(`case id ${id} must match ${ID_RE}`);
  if (!o.redact) warnings.push('--no-redact: provenance.source is "hand" (a production-failure case must be redacted, STANDARD §9.5); check the text for PII before committing');
  const kase: Case2 = {
    schema_version: 'ves-case/2', id, version: 1, suite: 'regression', tags: ['from-trace'],
    ...(Array.isArray(orig.variants) ? { variants: orig.variants } : {}), ...(Array.isArray(orig.requires) ? { requires: orig.requires } : {}),
    owner: o.owner ?? 'unassigned',
    provenance: {
      author: 'ves cases from-trace', created: o.capturedAt.slice(0, 10), source: o.redact ? 'production-failure' : 'hand', source_ref: o.sourceRef, redacted: o.redact,
      ...(conv.original ? { run_id: conv.original.run_id, row_id: conv.original.row_id } : {}), captured_at: o.capturedAt,
    } as Case2['provenance'],
    fixture, input: { turns: R(turns) }, expect, graders,
    oracle: { kind: 'scripted', steps },
    ...(orig.limits ? { limits: orig.limits } : {}),
  };
  return { kase, warnings, redactions: red.count };
}
