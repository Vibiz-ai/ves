// `ves store push|list|verify|pull`, `ves compare`, `ves history` and the post-run push of `ves run --store`.
// Exit codes: 0 ok; 1 verify found a problem / push refused (tamper); 2 compare refused (suite_version differs) or a
// store I/O error; 3 usage.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { caseHistory, compareRunDirs, renderCompareMd, renderHistoryMd, suiteLabels } from '../store/compare.ts';
import { openStore, resolveStoreUrl, type StoreDeps } from '../store/resolve.ts';
import { detectBranch, type IndexView, type RunStore } from '../store/store.ts';
import { StoreError } from '../store/types.ts';
import { type Args, CliUsage, list, str } from './args.ts';

export type StoreCliDeps = StoreDeps & { out: (s: string) => void; err: (s: string) => void };

function gitAt(cwd: string): { branch: string; head: string } | null {
  try {
    const o = { cwd, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    return { branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], o).trim(), head: execFileSync('git', ['rev-parse', 'HEAD'], o).trim() };
  } catch { return null; }
}

function storeFor(a: Args, d: StoreCliDeps): { store: RunStore; url: string } {
  const r = resolveStoreUrl({ arg: typeof a.store === 'string' ? a.store : undefined, config: str(a.config), env: d.env, cwd: d.cwd });
  return { store: openStore(r, d), url: r.url };
}

/** `7d`, `12h`, `30m`, `P7D`, or an ISO date/time -> the earliest ISO timestamp to keep. */
export function parseSince(s: string, now: Date): string {
  const rel = /^(\d+)\s*([dhm])$/.exec(s.trim());
  if (rel) return new Date(now.getTime() - Number(rel[1]) * { d: 86400e3, h: 3600e3, m: 60e3 }[rel[2] as 'd' | 'h' | 'm']).toISOString();
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s.trim());
  if (iso && s.trim() !== 'P') return new Date(now.getTime() - ((Number(iso[1] ?? 0) * 24 + Number(iso[2] ?? 0)) * 60 + Number(iso[3] ?? 0)) * 60e3).toISOString();
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new CliUsage(`--since: want 7d, 12h, 30m, P7D or a date, got ${s}`);
  return new Date(t).toISOString();
}

export function filterEntries(es: IndexView[], a: Args, now: Date): IndexView[] {
  const branch = str(a.branch), tier = str(a.tier), variant = str(a.variant), sha = str(a.sha);
  const since = str(a.since) ? parseSince(String(str(a.since)), now) : null;
  return es.filter((e) => (!branch || e.target.branch === branch) && (!tier || e.tier === tier) && (!variant || e.variants.includes(variant))
    && (!sha || String(e.target.sha ?? '').startsWith(sha)) && (!since || String(e.created ?? '') >= since));
}

const short = (s: string | null | undefined) => (s ? s.replace(/^tree:/, '').slice(0, 8) : '—');
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');

export async function cmdStore(a: Args, d: StoreCliDeps): Promise<number> {
  const sub = a._[0];
  const { store, url } = storeFor(a, d);
  try {
    if (sub === 'push') {
      const dirs = a._.slice(1);
      if (!dirs.length) throw new CliUsage('usage: ves store push <run-dir>... [--store <url>] [--branch <b>]');
      let bad = 0;
      const results = [];
      for (const dir of dirs.map((x) => resolve(d.cwd, x))) {
        try {
          const m = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
          const branch = detectBranch({ arg: str(a.branch), manifestBranch: m.target?.branch, targetSha: m.target?.sha, env: d.env, git: () => gitAt(d.cwd) });
          const r = await store.push(dir, { branch });
          results.push(r);
          d.err(`${r.status === 'stored' ? 'stored   ' : 'unchanged'} ${r.run_id}  ${r.files} files, ${r.new_objects} new object(s)${r.entry?.target.branch ? `, branch ${r.entry.target.branch}` : ''}${r.indexed && r.status === 'unchanged' ? ' (index entry added)' : ''}\n`);
        } catch (e) {
          bad++;
          d.err(`refused   ${dir}: ${(e as Error).message}\n`);
        }
      }
      if (a.json === true) d.out(JSON.stringify({ store: url, results }) + '\n');
      else d.err(`store: ${url}\n`);
      return bad ? 1 : 0;
    }
    if (sub === 'list') {
      const { entries, problems } = await store.index();
      const es = filterEntries(entries, a, d.now?.() ?? new Date());
      const lim = Number(str(a.limit) ?? 0);
      const shown = lim > 0 ? es.slice(-lim) : es;
      const labels = suiteLabels(entries);
      if (a.json === true) { d.out(JSON.stringify({ store: url, entries: shown.map((e) => ({ ...e, suite_label: labels.get(e.suite_version ?? '') ?? null })), problems }, null, 2) + '\n'); return 0; }
      const L = [`store ${url}: ${shown.length} of ${entries.length} run(s)`, ''];
      L.push(['#', 'run_id', 'created', 'branch', 'sha', 'tier', 'verdict', 'suite', 'pass^1 by surface', 'usd'].join('\t'));
      for (const e of shown) {
        const surf = Object.entries(e.surfaces).map(([s, v]) => `${s}=${pct(v.pass1)}/${v.n_cases}`).join(' ');
        L.push([e.seq, e.run_id, (e.created ?? '—').replace(/\.\d+Z$/, 'Z'), e.target.branch ?? '—', short(e.target.sha), e.tier ?? '—', `${e.verdict ?? '—'}${e.decided_by ? ` (${e.decided_by})` : ''}`, labels.get(e.suite_version ?? '') ?? '—', surf, e.cost.actual_usd ?? '—'].join('\t'));
      }
      for (const p of problems) L.push(`problem: ${p}`);
      d.out(L.join('\n') + '\n');
      return 0;
    }
    if (sub === 'verify') {
      const r = await store.verify();
      if (a.json === true) d.out(JSON.stringify({ store: url, ...r }, null, 2) + '\n');
      else {
        d.out(`store ${url}: ${r.runs} run(s), ${r.objects_checked} object(s) re-hashed: ${r.ok ? 'OK' : `${r.errors.length} PROBLEM(S)`}\n`);
        for (const e of r.errors) d.out(`  error: ${e}\n`);
        for (const w of r.warnings) d.out(`  warning: ${w}\n`);
      }
      return r.ok ? 0 : 1;
    }
    if (sub === 'pull') {
      const id = a._[1];
      if (!id) throw new CliUsage('usage: ves store pull <run_id> --out <dir>');
      const dest = await store.pull(id, resolve(d.cwd, String(str(a.out) ?? '.')));
      d.out(`${dest}\n`);
      return 0;
    }
    throw new CliUsage('usage: ves store push <run-dir>... | list [--branch --tier --variant --since --sha --limit --json] | verify | pull <run_id> --out <dir>   [--store <path|gs://bucket/prefix>]');
  } catch (e) {
    if (e instanceof StoreError) { d.err(`store ${url}: ${e.message}\n`); return e.code === 'tamper' ? 1 : 2; }
    throw e;
  }
}

// ------------------------------------------------------------------------------------------ run refs

type Resolved = { dir: string; info: { source: string; branch?: string | null; created?: string | null; suite_label?: string | null }; entry: IndexView | null };

async function resolveRef(ref: string, ctx: { store: RunStore; entries: IndexView[]; tmp: string; cwd: string; labels: Map<string, string>; near?: IndexView | null; exclude?: string; tier?: string }): Promise<Resolved> {
  const local = resolve(ctx.cwd, ref);
  if (existsSync(join(local, 'run.json'))) {
    const m = JSON.parse(readFileSync(join(local, 'run.json'), 'utf8'));
    const e = ctx.entries.find((x) => x.run_id === m.run_id) ?? null;
    return { dir: local, info: { source: `dir ${local}`, branch: e?.target.branch, created: e?.created, suite_label: ctx.labels.get(m.suite?.version) ?? null }, entry: e };
  }
  const fromEntry = async (e: IndexView): Promise<Resolved> => ({
    dir: await ctx.store.materialise(e.run_id, join(ctx.tmp, e.run_id), ['run.json', 'results.jsonl', 'run-extra.json', 'gate.json']),
    info: { source: 'store', branch: e.target.branch, created: e.created, suite_label: ctx.labels.get(e.suite_version ?? '') ?? null }, entry: e,
  });
  const exact = ctx.entries.find((e) => e.run_id === ref);
  if (exact) return fromEntry(exact);
  const pre = ctx.entries.filter((e) => e.run_id.startsWith(ref) || e.run_id.replace(/^ves-/, '').startsWith(ref));
  if (ref.length >= 6 && pre.length === 1) return fromEntry(pre[0]);
  // a SHA or a branch: the newest matching run of the same tier as the other side
  const tier = ctx.tier ?? ctx.near?.tier ?? undefined;
  const pool = ctx.entries.filter((e) => e.run_id !== ctx.exclude && (!tier || e.tier === tier));
  const bySha = /^[a-f0-9]{7,40}$/.test(ref) ? pool.filter((e) => String(e.target.sha ?? '').startsWith(ref)) : [];
  const cands = bySha.length ? bySha : pool.filter((e) => e.target.branch === ref);
  if (!cands.length) throw new CliUsage(`no stored run matches ${JSON.stringify(ref)} (not a run dir, run id, sha${tier ? ` of tier ${tier}` : ''} or branch with runs)`);
  // relative to the other side: prefer its suite_version, then runs created at or before it (what it branched from)
  const near = ctx.near;
  const prefer = (xs: IndexView[], f: (e: IndexView) => boolean) => (xs.some(f) ? xs.filter(f) : xs);
  const picked = near ? prefer(prefer(cands, (e) => e.suite_version === near.suite_version), (e) => String(e.created ?? '') <= String(near.created ?? '')) : cands;
  return fromEntry(picked[picked.length - 1]);
}

export async function cmdCompare(a: Args, d: StoreCliDeps): Promise<number> {
  const { store, url } = storeFor(a, d);
  const tmp = mkdtempSync(join(tmpdir(), 'ves-compare-'));
  try {
    const { entries } = await store.index();
    const labels = suiteLabels(entries);
    const ctxBase = { store, entries, tmp, cwd: d.cwd, labels, tier: str(a.tier) };
    let baseRef = str(a.base), headRef = str(a.head);
    if (a._.length >= 2) { baseRef = a._[0]; headRef = a._[1]; }
    else if (a._.length === 1) headRef = a._[0];
    // defaults: head = newest run; base = newest run on main of the same tier (other than head)
    const head = headRef ? await resolveRef(headRef, ctxBase) : entries.length ? await resolveRef(entries[entries.length - 1].run_id, ctxBase) : null;
    if (!head) throw new CliUsage(`the store ${url} has no runs; push some with \`ves store push <run-dir>\``);
    const base = await resolveRef(baseRef ?? 'main', { ...ctxBase, near: head.entry, exclude: head.entry?.run_id });
    const r = compareRunDirs(base.dir, head.dir, { base: base.info, head: head.info, variants: list(a.variant) });
    d.out(a.json === true ? JSON.stringify(r, null, 2) + '\n' : renderCompareMd(r));
    return r.refused ? 2 : 0;
  } catch (e) {
    if (e instanceof StoreError) { d.err(`store ${url}: ${e.message}\n`); return 2; }
    throw e;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function cmdHistory(a: Args, d: StoreCliDeps): Promise<number> {
  const caseId = a._[0];
  if (!caseId) throw new CliUsage('usage: ves history <case_id> [--variant v] [--branch b] [--tier t] [--since 30d] [--json]');
  const { store, url } = storeFor(a, d);
  try {
    const { entries } = await store.index();
    const labels = suiteLabels(entries);
    const { variant: _v, ...noVariant } = a;
    void _v;
    const es = filterEntries(entries, noVariant as Args, d.now?.() ?? new Date());
    const runs = [];
    for (const e of es) {
      const rb = await store.readFile(e.run_id, 'results.jsonl');
      if (!rb) continue;
      const rows = new TextDecoder().decode(rb).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      if (!rows.some((r) => r.case_id === caseId)) { runs.push({ info: null, seq: e.seq, rows: [], retry: new Set<string>() }); continue; }
      const xb = await store.readFile(e.run_id, 'run-extra.json');
      const retry = new Set<string>(xb ? JSON.parse(new TextDecoder().decode(xb)).retry_row_ids ?? [] : []);
      const gb = await store.readFile(e.run_id, 'gate.json');
      const g = gb ? JSON.parse(new TextDecoder().decode(gb)) : {};
      runs.push({
        info: { run_id: e.run_id, created: e.created, sha: e.target.sha, branch: e.target.branch, tier: e.tier, trigger: e.trigger, suite_version: e.suite_version, suite_label: labels.get(e.suite_version ?? '') ?? null, verdict: g.verdict ?? e.verdict, decided_by: g.decided_by ?? e.decided_by, source: 'store' },
        seq: e.seq, rows, retry,
      });
    }
    const h = caseHistory(caseId, runs.filter((r) => r.info) as never, { variant: str(a.variant) });
    h.runs_scanned = es.length;
    d.out(a.json === true ? JSON.stringify(h, null, 2) + '\n' : renderHistoryMd(h));
    return 0;
  } catch (e) {
    if (e instanceof StoreError) { d.err(`store ${url}: ${e.message}\n`); return 2; }
    throw e;
  }
}

/** After `ves run`: push when --store is given or the config says store.auto_push. Never changes the run's exit code. */
export async function pushAfterRun(runDir: string, a: Args, d: StoreCliDeps, configPath?: string): Promise<{ pushed: boolean; url?: string; run_id?: string; status?: string; error?: string } | null> {
  if (a['no-store'] === true) return null;
  const r = resolveStoreUrl({ arg: typeof a.store === 'string' ? a.store : undefined, config: configPath ?? str(a.config), env: d.env, cwd: d.cwd });
  if (a.store === undefined && !r.auto_push) return null;
  try {
    const m = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    const branch = detectBranch({ arg: str(a.branch), manifestBranch: m.target?.branch, targetSha: m.target?.sha, env: d.env, git: () => gitAt(d.cwd) });
    const p = await openStore(r, d).push(runDir, { branch });
    d.err(`store:   ${p.status === 'stored' ? 'pushed' : 'already stored'} ${p.run_id} -> ${r.url}\n`);
    return { pushed: true, url: r.url, run_id: p.run_id, status: p.status };
  } catch (e) {
    d.err(`store:   PUSH FAILED to ${r.url}: ${(e as Error).message}\n`);
    return { pushed: false, url: r.url, error: (e as Error).message };
  }
}
