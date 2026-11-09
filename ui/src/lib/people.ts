// People (personas) across runs, run titles and the chat view of a trajectory. Pure helpers, no React:
//  - personaAccent / initials / firstName: a stable colour and avatar per person
//  - runTitle: a human title for a run card ("6 personas · eve/imessage", "newuser · 7 cases")
//  - buildPeople: one profile per person, merging the persona library with every conversation seen in the results dir
//  - chatItems: an ATIF trajectory as a messaging-app thread (messages, folded tool runs, approval pills)
// Counting and means only; nothing here gates.
import type { AtifStep, Persona, PersonaConversation, PersonaGoalMet, PersonasResponse } from './types.ts';

// ------------------------------------------------------------------------------------------------ identity

/** Accent colours that read on white: text/solid `fg`, tinted `soft` background, `line` border. */
export type Accent = { key: string; fg: string; soft: string; line: string };
export const ACCENTS: Accent[] = [
  { key: 'indigo', fg: '#4338ca', soft: '#eef0ff', line: '#c7cdfb' },
  { key: 'teal', fg: '#0f766e', soft: '#e7f6f4', line: '#a8ddd6' },
  { key: 'rose', fg: '#be123c', soft: '#fdecef', line: '#f6bccb' },
  { key: 'amber', fg: '#a35a00', soft: '#fdf3e2', line: '#efd09b' },
  { key: 'violet', fg: '#6d28d9', soft: '#f3edfe', line: '#d6c4f8' },
  { key: 'sky', fg: '#0369a1', soft: '#e8f4fb', line: '#acd5ee' },
  { key: 'green', fg: '#2f7d32', soft: '#ebf6ea', line: '#b6dcb3' },
  { key: 'fuchsia', fg: '#a21caf', soft: '#fbecfc', line: '#ecbdf0' },
  { key: 'orange', fg: '#c2410c', soft: '#fdefe7', line: '#f5c5aa' },
  { key: 'slate', fg: '#3b5b7e', soft: '#edf2f7', line: '#c3d1e0' },
  { key: 'cyan', fg: '#0e7490', soft: '#e6f5f8', line: '#a5d8e3' },
  { key: 'wine', fg: '#9f1239', soft: '#fbebef', line: '#efb8c6' },
];

/** FNV-1a 32-bit. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** A stable accent for a person, hashed from their id. */
export function personaAccent(id: string | null | undefined): Accent {
  return ACCENTS[fnv(id || '?') % ACCENTS.length];
}

/** "Inês, owner of Padaria Estrela (Lisbon)" → "Inês". Falls back to the whole label. */
export function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return '';
  return n.split(',')[0].trim() || n;
}

/** "Inês, owner of Padaria Estrela (Lisbon)" → "owner of Padaria Estrela (Lisbon)"; '' when there is no role part. */
export function personaRole(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  const i = n.indexOf(',');
  return i >= 0 ? n.slice(i + 1).trim() : '';
}

/** Avatar initials: the first letters of the first two words of the personal name, or of a kebab id. */
export function initials(name: string | null | undefined, id?: string | null): string {
  const n = firstName(name);
  const words = (n || (id ?? '').replace(/[-_.]+/g, ' ')).split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words.slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join('');
}

/** Display label of a person: library/row name, else the id prettified. */
export function personName(name: string | null | undefined, id: string): string {
  return (name ?? '').trim() || id.replace(/[-_]+/g, ' ');
}

// ------------------------------------------------------------------------------------------------ run titles

/** Case groups by the segment after a shared pack prefix: eve.newuser.x, eve.newuser.y → newuser×2. */
export function caseGroups(caseIds: string[]): { group: string; count: number }[] {
  if (!caseIds.length) return [];
  const parts = caseIds.map((c) => c.split('.'));
  const first = parts[0][0];
  const shared = parts.every((p) => p.length > 2 && p[0] === first);
  const counts = new Map<string, number>();
  for (const p of parts) {
    const g = shared ? p[1] : p.length > 1 ? p[0] : 'cases';
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

type TitleInput = { personas?: { id: string; name: string | null }[]; case_ids?: string[]; surfaces?: string[]; case_count?: number | null; tier?: string | null; trigger?: string | null };

/**
 * A human title for a run, from its content: "6 personas · eve/imessage" when the run is persona cases,
 * else the case groups ("newuser · 7 cases", "bench · memory · xsession · 27 cases"), else tier · trigger.
 */
export function runTitle(r: TitleInput): string {
  const surf = r.surfaces?.length ? (r.surfaces.length <= 2 ? r.surfaces.join(', ') : `${r.surfaces.length} surfaces`) : '';
  const ids = r.case_ids ?? [];
  const n = ids.length || r.case_count || 0;
  const people = r.personas ?? [];
  if (people.length) {
    const nonPersona = ids.filter((c) => !/(?:^|\.)persona\./.test(c)).length;
    const head = people.length === 1 ? firstName(personName(people[0].name, people[0].id)) : `${people.length} personas`;
    return [head, nonPersona ? `+${nonPersona} case${nonPersona === 1 ? '' : 's'}` : '', surf].filter(Boolean).join(' · ');
  }
  const groups = caseGroups(ids);
  if (groups.length) {
    const shown = groups.slice(0, 3).map((g) => g.group);
    const more = groups.length > 3 ? ` +${groups.length - 3}` : '';
    return `${shown.join(' · ')}${more} · ${n} case${n === 1 ? '' : 's'}`;
  }
  return `${r.tier ?? 'run'} · ${r.trigger ?? '—'}`;
}

// ------------------------------------------------------------------------------------------------ outcomes

const GOALS: PersonaGoalMet[] = ['yes', 'partly', 'no', 'unknown'];
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function goalOf(p: Persona | null | undefined): PersonaGoalMet {
  const g = p?.outcome?.goal_met;
  return typeof g === 'string' && (GOALS as string[]).includes(g) ? (g as PersonaGoalMet) : 'unknown';
}

export type ChatTone = 'good' | 'mixed' | 'bad' | 'invalid' | 'skip' | 'unknown';

/** Colour of a conversation chip: green goal met, amber partly, red not met / failed, INVALID and skip on their own. */
export function chatTone(c: { status: string | null | undefined; persona: Persona | null | undefined }): ChatTone {
  if (c.status === 'invalid') return 'invalid';
  if (c.status === 'skip') return 'skip';
  const g = goalOf(c.persona);
  if (g === 'no' || c.status === 'fail') return 'bad';
  if (g === 'partly') return 'mixed';
  if (g === 'yes') return 'good';
  return c.status === 'pass' ? 'good' : 'unknown';
}

export type PersonStats = {
  trials: number; judged: number; yes: number; partly: number; no: number; unknown: number; invalid: number; skipped: number; gaveUp: number;
  meanFrustration: number | null; meanToneFit: number | null; meanUserTurns: number | null;
};

/** Counts and means over a set of conversations; INVALID and skipped trials are counted apart, not judged. */
export function statsOf(convs: { status: string | null; persona: Persona | null }[]): PersonStats {
  const s: PersonStats = { trials: convs.length, judged: 0, yes: 0, partly: 0, no: 0, unknown: 0, invalid: 0, skipped: 0, gaveUp: 0, meanFrustration: null, meanToneFit: null, meanUserTurns: null };
  const fr: number[] = [], tf: number[] = [], ut: number[] = [];
  for (const c of convs) {
    if (c.status === 'invalid') { s.invalid++; continue; }
    if (c.status === 'skip') { s.skipped++; continue; }
    const g = goalOf(c.persona);
    s[g]++;
    if (g !== 'unknown') s.judged++;
    if (c.persona?.outcome?.gave_up === true || c.persona?.stop?.kind === 'gave_up') s.gaveUp++;
    const f = num(c.persona?.outcome?.frustration); if (f !== null) fr.push(f);
    const t = num(c.persona?.outcome?.tone_fit); if (t !== null) tf.push(t);
    const u = num(c.persona?.user_turns) ?? num(c.persona?.metrics?.user_turns); if (u !== null) ut.push(u);
  }
  s.meanFrustration = mean(fr); s.meanToneFit = mean(tf); s.meanUserTurns = mean(ut);
  return s;
}

// ------------------------------------------------------------------------------------------------ people

export type PersonRun = { run_id: string; created: string | null; agent_model: string | null; convs: PersonaConversation[]; stats: PersonStats };
export type PersonProfile = {
  id: string; name: string; background: string | null; languages: string[]; temperament: string[]; goal: string | null;
  opening: string | null; maxUserTurns: number | null; inLibrary: boolean; file: string | null;
  /** Newest first (run date, then trial). */
  conversations: PersonaConversation[];
  /** Newest first. */
  runs: PersonRun[];
  latest: PersonRun | null;
};

const when = (c: PersonaConversation) => c.run_created ?? c.created_at ?? '';
/** Newest run first; within a run, by surface then trial. */
export function sortConversations(cs: PersonaConversation[]): PersonaConversation[] {
  return [...cs].sort((a, b) => when(b).localeCompare(when(a)) || b.run_id.localeCompare(a.run_id) || String(a.surface ?? '').localeCompare(String(b.surface ?? '')) || (a.trial ?? 0) - (b.trial ?? 0));
}

/** One profile per person: library fields, overlaid with the newest row's persona block; conversations grouped by run. */
export function buildPeople(resp: PersonasResponse | null | undefined): PersonProfile[] {
  if (!resp) return [];
  const ids = new Set<string>([...resp.library.map((l) => l.id), ...resp.conversations.map((c) => c.persona_id)]);
  const out: PersonProfile[] = [];
  for (const id of ids) {
    const lib = resp.library.find((l) => l.id === id) ?? null;
    const convs = sortConversations(resp.conversations.filter((c) => c.persona_id === id));
    const block = convs.find((c) => c.persona)?.persona ?? null;
    const byRun = new Map<string, PersonaConversation[]>();
    for (const c of convs) { if (!byRun.has(c.run_id)) byRun.set(c.run_id, []); byRun.get(c.run_id)!.push(c); }
    const runs: PersonRun[] = [...byRun.entries()].map(([run_id, cs]) => ({
      run_id, created: cs[0].run_created, agent_model: cs.find((c) => c.agent_model)?.agent_model ?? null, convs: cs, stats: statsOf(cs),
    }));
    out.push({
      id,
      name: personName(block?.name ?? lib?.name, id),
      background: block?.background ?? lib?.background ?? null,
      languages: block?.languages?.length ? block.languages : lib?.languages ?? [],
      temperament: block?.temperament?.length ? block.temperament : lib?.temperament ?? [],
      goal: block?.goal ?? null,
      opening: lib?.opening ?? null,
      maxUserTurns: block?.max_user_turns ?? lib?.max_user_turns ?? null,
      inLibrary: !!lib,
      file: lib?.file ?? null,
      conversations: convs,
      runs,
      latest: runs[0] ?? null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Trials of the same person in the same run and surface, in trial order (for "Chat 2 of 3"). */
export function siblingTrials<T extends { row_id: string; case_id?: string | null; surface?: string | null; trial?: number | null }>(rows: T[], rowId: string): { list: T[]; index: number } {
  const me = rows.find((r) => r.row_id === rowId);
  if (!me) return { list: [], index: -1 };
  const list = rows.filter((r) => r.case_id === me.case_id && r.surface === me.surface).sort((a, b) => (a.trial ?? 0) - (b.trial ?? 0));
  return { list, index: list.findIndex((r) => r.row_id === rowId) };
}

// ------------------------------------------------------------------------------------------------ chat view

export type ChatTool = { name: string; display: string; stepIndex: number; callIndex: number; id: string | null; source: string | null; duplicate: boolean };
export type Decision = 'approve' | 'reject' | 'timeout' | 'other';
export type ChatItem =
  | { kind: 'user'; text: string; stepIndex: number; turn: number | null; source: string | null }
  | { kind: 'agent'; text: string; stepIndex: number }
  | { kind: 'tools'; calls: ChatTool[]; names: string[]; count: number }
  | { kind: 'approval'; decision: Decision | 'request'; label: string; detail: string; stepIndex: number }
  | { kind: 'system'; text: string; stepIndex: number };

type ApprovalEvt = { seq?: number; kind?: string; canonical?: string; principal?: string };

const extOf = (o: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (o && typeof o === 'object') for (const k of ['vibiz', 'ves', 'extra', 'metadata']) { const v = (o as Record<string, unknown>)[k]; if (v && typeof v === 'object') Object.assign(out, v); }
  return out;
};
export function chatText(m: unknown): string {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  if (typeof m === 'object' && typeof (m as { text?: unknown }).text === 'string') return (m as { text: string }).text;
  return '';
}
const HITL_RE = /^\s*\[hitl:([a-z_]+)\]\s*/i;
const toDecision = (raw: string): Decision => {
  const r = raw.toLowerCase();
  return /^(approve|approved|yes|grant|allow)/.test(r) ? 'approve' : /^(reject|rejected|no|deny|denied|refuse)/.test(r) ? 'reject' : /timeout|expire/.test(r) ? 'timeout' : 'other';
};
const DECISION_LABEL: Record<Decision, string> = { approve: 'Approved', reject: 'Rejected', timeout: 'Approval timed out', other: 'Approval decision' };

/**
 * An ATIF trajectory as a chat thread: user and agent text messages; consecutive tool-call steps folded into one
 * `tools` item; hitl decisions (step.vibiz.hitl_turn or a `[hitl:approve]` prefix), hitl requests and approval
 * events as `approval` pills. Host-reported calls that repeat a server call in the same run of tools are marked
 * `duplicate` and not counted.
 */
export function chatItems(steps: AtifStep[] | null | undefined, approvalEvents: ApprovalEvt[] = []): ChatItem[] {
  const out: ChatItem[] = [];
  let tools: ChatTool[] | null = null;
  const flush = () => {
    if (!tools?.length) { tools = null; return; }
    const server = new Set(tools.filter((t) => t.source !== 'host-reported').map((t) => t.name));
    for (const t of tools) if (t.source === 'host-reported' && server.has(t.display)) t.duplicate = true;
    const names = [...new Set(tools.filter((t) => !t.duplicate).map((t) => t.display))];
    out.push({ kind: 'tools', calls: tools, names, count: tools.filter((t) => !t.duplicate).length });
    tools = null;
  };
  (steps ?? []).forEach((s, i) => {
    const src = String(s.source ?? '');
    const x = extOf(s);
    const text = chatText(s.message);
    const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
    if (calls.length) {
      tools ??= [];
      calls.forEach((c, j) => {
        const cx = extOf(c);
        const source = typeof cx.call_source === 'string' ? cx.call_source : null;
        const name = c.function_name ?? '(tool)';
        const display = source === 'host-reported' && name.includes('.') ? name.slice(name.indexOf('.') + 1) : name;
        tools!.push({ name, display, stepIndex: i, callIndex: j, id: c.tool_call_id ?? null, source, duplicate: false });
      });
    }
    const hr = x.hitl_request as { tool?: string } | undefined;
    if (hr && typeof hr === 'object') {
      flush();
      out.push({ kind: 'approval', decision: 'request', label: `Asked for approval${hr.tool ? `: ${hr.tool}` : ''}`, detail: '', stepIndex: i });
    }
    if (text.trim()) {
      if (src === 'user') {
        const h = (x.hitl_turn as { hitl?: unknown } | undefined)?.hitl;
        const m = HITL_RE.exec(text);
        const raw = typeof h === 'string' ? h : m?.[1];
        flush();
        if (raw) {
          const d = toDecision(raw);
          out.push({ kind: 'approval', decision: d, label: DECISION_LABEL[d], detail: text.replace(HITL_RE, '').trim(), stepIndex: i });
        } else {
          const sp = (x.persona ?? null) as { turn?: number; source?: string } | null;
          out.push({ kind: 'user', text, stepIndex: i, turn: typeof sp?.turn === 'number' ? sp.turn : null, source: typeof sp?.source === 'string' ? sp.source : null });
        }
      } else if (src === 'agent') {
        flush();
        out.push({ kind: 'agent', text, stepIndex: i });
      } else {
        flush();
        out.push({ kind: 'system', text, stepIndex: i });
      }
    }
    for (const e of approvalEvents) {
      if (typeof e.seq === 'number' && Number(s.step_id) === e.seq) {
        flush();
        const d = toDecision(e.kind ?? '');
        out.push({ kind: 'approval', decision: d, label: DECISION_LABEL[d], detail: [e.canonical, e.principal ? `by ${e.principal}` : ''].filter(Boolean).join(' '), stepIndex: i });
      }
    }
  });
  flush();
  return out;
}

/** True when the trajectory has at least one user and one agent text message (a chat is worth drawing). */
export function hasChat(steps: AtifStep[] | null | undefined): boolean {
  const items = chatItems(steps);
  return items.some((i) => i.kind === 'user') && items.some((i) => i.kind === 'agent');
}

/** Agent display name from the surface ("eve/imessage" → "Eve"), else "Agent". */
export function agentName(surface: string | null | undefined): string {
  const s = (surface ?? '').split('/')[0].trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Agent';
}

const PERSONA_CASE_RE = /(?:^|\.)persona\.([A-Za-z0-9_-]+)$/;
/** Who a row's conversation was with: the persona block's id/ref, else `<pack>.persona.<id>` in the case id (INVALID rows can lose the block). */
export function personaIdOf(row: { persona?: Persona | null; case_id?: string | null }): string | null {
  const p = row.persona;
  if (p && typeof p === 'object' && !Array.isArray(p) && (p.id || p.ref)) return String(p.id || p.ref);
  return PERSONA_CASE_RE.exec(row.case_id ?? '')?.[1] ?? null;
}

/** A run's rows grouped by person (persona rows only), people sorted by name, each person's trials by surface then trial. */
export function rowsByPerson<R extends { row_id: string; persona?: Persona | null; case_id?: string | null; surface?: string | null; trial?: number | null }>(rows: R[], names: Map<string, string | null> = new Map()): { id: string; name: string; rows: R[] }[] {
  const by = new Map<string, R[]>();
  for (const r of rows) {
    const id = personaIdOf(r);
    if (!id) continue;
    if (!by.has(id)) by.set(id, []);
    by.get(id)!.push(r);
  }
  return [...by.entries()].map(([id, rs]) => ({
    id,
    name: personName(rs.find((r) => r.persona?.name)?.persona?.name ?? names.get(id), id),
    rows: rs.sort((a, b) => String(a.surface ?? '').localeCompare(String(b.surface ?? '')) || (a.trial ?? 0) - (b.trial ?? 0)),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
