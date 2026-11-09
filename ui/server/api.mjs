// VES UI read-only JSON API. Dependency-free, shared by the standalone server (server/index.mjs)
// and the Vite dev plugin (vite.config.ts). It only ever READS files under the results dir, the
// repo's case/pack/config files and (when configured) a run store (server/store.mjs). Nothing here
// writes to disk or runs an eval. /api/compare and /api/history shell out to the harness CLI
// (`node ../src/cli.ts compare|history --json`, both read-only) so the comparison statistics live
// in exactly one place and the UI never imports ../src.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, watch } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStoreReader } from './store.mjs';

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/** True when `child` is `root` itself or strictly inside it (after resolving symlinks). */
export function isInside(root, child) {
  const rel = relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a run-relative URI (e.g. a row's trace.atif_uri) to an absolute path inside runDir.
 * Returns null for anything that escapes the run dir: absolute paths, `..` segments, URL schemes,
 * NUL bytes, or symlinks pointing outside.
 */
export function resolveInsideRun(runDir, uri) {
  if (typeof uri !== 'string' || !uri || uri.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) {
    // file:// URIs are accepted only when they point inside the run dir
    if (!uri.startsWith('file://')) return null;
    try { uri = decodeURIComponent(new URL(uri).pathname); } catch { return null; }
  }
  if (isAbsolute(uri)) return null;
  const abs = resolve(runDir, uri);
  if (!isInside(runDir, abs) || abs === runDir) return null;
  if (!existsSync(abs)) return { abs, exists: false };
  let real;
  try { real = realpathSync(abs); } catch { return null; }
  let realRoot;
  try { realRoot = realpathSync(runDir); } catch { return null; }
  if (!isInside(realRoot, real)) return null;
  return { abs: real, exists: true };
}

function readJson(path) {
  if (!existsSync(path)) return { value: null, error: null };
  try { return { value: JSON.parse(readFileSync(path, 'utf8')), error: null }; }
  catch (e) { return { value: null, error: `${basename(path)}: ${e.message}` }; }
}

function readText(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function readJsonl(path) {
  const rows = [];
  let parseErrors = 0;
  const text = readText(path);
  if (text == null) return { rows, parseErrors, missing: true };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') rows.push(r); else parseErrors++; }
    catch { parseErrors++; }
  }
  return { rows, parseErrors, missing: false };
}

/** ves-YYYYMMDDTHHMMSSZ-xxxxxxxx -> ISO timestamp, or null. */
export function createdFromRunId(id) {
  const m = /^ves-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(id ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

function mtimeKey(dir) {
  let k = '';
  for (const f of ['run.json', 'gate.json', 'run-extra.json', 'results.jsonl', 'card.md']) {
    try { const s = statSync(join(dir, f)); k += `${f}:${s.mtimeMs}:${s.size};`; } catch { k += `${f}:-;`; }
  }
  return k;
}

function countStatuses(rows) {
  const c = { pass: 0, fail: 0, invalid: 0, skip: 0, other: 0 };
  for (const r of rows) {
    if (r.status in c && r.status !== 'other') c[r.status]++;
    else c.other++;
  }
  return c;
}

const PERSONA_CASE_RE = /(?:^|\.)persona\.([A-Za-z0-9_-]+)$/;

/**
 * The persona a row belongs to: its `persona` block (id, else ref), else the case id when it reads `<pack>.persona.<id>`
 * (INVALID trials can lose the persona block; the case id still says who it was). Null for non-persona rows.
 */
export function personaIdOfRow(row) {
  const p = row?.persona;
  if (p && typeof p === 'object' && !Array.isArray(p) && (p.id || p.ref)) return String(p.id || p.ref);
  const m = PERSONA_CASE_RE.exec(row?.case_id ?? '');
  return m ? m[1] : null;
}

const msgText = (m) => {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('\n');
  if (typeof m === 'object' && typeof m.text === 'string') return m.text;
  return '';
};
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The opening exchange of a trajectory: the first user message and the agent's first text reply after it. */
export function firstExchange(atif, n = 220) {
  const steps = Array.isArray(atif?.steps) ? atif.steps : [];
  let user = null, agent = null, turns = 0;
  for (const s of steps) {
    const t = msgText(s?.message);
    if (s?.source === 'user' && t.trim()) { turns++; if (user === null) user = clip(t, n); }
    else if (s?.source === 'agent' && t.trim() && user !== null && agent === null) agent = clip(t, n);
  }
  return { user, agent, user_messages: turns };
}

/** Persona library files (`*.persona.json`) under <repo>/packs, keyed by id. */
function readPersonaLibrary(repoDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.persona.json')) {
        const j = readJson(p).value;
        if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue;
        out.push({
          id: j.id, name: typeof j.name === 'string' ? j.name : null, background: j.background ?? null,
          languages: Array.isArray(j.languages) ? j.languages : [], temperament: Array.isArray(j.temperament) ? j.temperament : [],
          style: j.style && typeof j.style === 'object' ? j.style : null, opening: typeof j.opening === 'string' ? j.opening : null,
          max_user_turns: typeof j.max_user_turns === 'number' ? j.max_user_turns : null, notes: j.notes ?? null, file: relative(repoDir, p),
        });
      }
    }
  };
  walk(join(repoDir, 'packs'), 0);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Summary of one run dir, built from the files only. Counted numbers are flagged as such. */
function summarize(id, dir, libNames = new Map()) {
  const errors = [];
  const run = readJson(join(dir, 'run.json'));
  const gate = readJson(join(dir, 'gate.json'));
  if (run.error) errors.push(run.error);
  if (gate.error) errors.push(gate.error);
  if (!run.value && !run.error) errors.push('run.json missing');
  const { rows, parseErrors } = readJsonl(join(dir, 'results.jsonl'));
  if (parseErrors) errors.push(`results.jsonl: ${parseErrors} unparsable line(s)`);
  const r = run.value ?? {};
  const g = gate.value ?? {};
  const counts = countStatuses(rows);
  const surfaces = Array.isArray(r.surfaces) ? r.surfaces : [...new Set(rows.map((x) => x.surface).filter(Boolean))].sort();
  const perSurface = {};
  for (const s of surfaces) perSurface[s] = { pass: 0, fail: 0, invalid: 0, skip: 0 };
  let usd = 0;
  let usdSeen = false;
  for (const row of rows) {
    const s = row.surface;
    if (s && !perSurface[s]) perSurface[s] = { pass: 0, fail: 0, invalid: 0, skip: 0 };
    if (s && row.status in perSurface[s]) perSurface[s][row.status]++;
    const u = row.usage?.usd_list;
    if (typeof u === 'number' && Number.isFinite(u)) { usd += u; usdSeen = true; }
  }
  // pass^1 per surface = mean over cases of passes/counted trials (counted: not a smoke retry, not skip, not INVALID),
  // the card's definition; used only for the "vs previous comparable run" point delta on the Runs page.
  const extraJ = readJson(join(dir, 'run-extra.json')).value;
  const retry = new Set(Array.isArray(extraJ?.retry_row_ids) ? extraJ.retry_row_ids : []);
  const pass1 = {};
  for (const s of Object.keys(perSurface)) {
    const byCase = new Map();
    for (const row of rows) {
      if (row.surface !== s || retry.has(row.row_id) || row.status === 'skip' || row.status === 'invalid') continue;
      const x = byCase.get(row.case_id) ?? { c: 0, n: 0 };
      x.n++; if (row.status === 'pass') x.c++;
      byCase.set(row.case_id, x);
    }
    const cs = [...byCase.values()];
    pass1[s] = cs.length ? { pass1: cs.reduce((a, x) => a + x.c / x.n, 0) / cs.length, n_cases: cs.length } : null;
  }
  const graded = counts.pass + counts.fail;
  const created = createdFromRunId(r.run_id ?? id) ?? rows.map((x) => x.created_at).filter(Boolean).sort()[0] ?? null;
  const adapters = Array.isArray(r.adapters) ? r.adapters : [];
  const personas = new Map();
  for (const row of rows) {
    const pid = personaIdOfRow(row);
    if (!pid) continue;
    const nm = typeof row.persona?.name === 'string' ? row.persona.name : null;
    if (!personas.has(pid) || (!personas.get(pid).name && nm)) personas.set(pid, { id: pid, name: nm ?? libNames.get(pid) ?? null });
  }
  return {
    id,
    schema_version: r.schema_version ?? null,
    tier: r.tier ?? null,
    trigger: r.trigger ?? null,
    status: r.status ?? null,
    sha: r.target?.sha ?? g.sha ?? null,
    branch: r.target?.branch ?? null,
    repo: r.target?.repo ?? r.target?.repository ?? null,
    change_class: r.target?.change_class ?? g.change_class ?? null,
    created,
    verdict: g.verdict ?? r.verdict ?? null,
    would_be: g.would_be ?? null,
    decided_by: g.decided_by ?? null,
    surfaces,
    case_count: r.suite?.case_count ?? (rows.length ? new Set(rows.map((x) => x.case_id)).size : null),
    suite_version: r.suite?.version ?? null,
    pass1,
    row_count: rows.length,
    counts,
    per_surface: perSurface,
    // Counted, not a VES statistic: passing trials / (passing + failing trials). Skips and INVALID excluded.
    trial_pass_rate: graded ? counts.pass / graded : null,
    usd_rows: usdSeen ? usd : null,
    usd_actual: typeof r.cost?.actual_usd === 'number' ? r.cost.actual_usd : null,
    usd_cap: typeof r.cost?.cap_usd === 'number' ? r.cost.cap_usd : typeof r.cost?.cap === 'number' ? r.cost.cap : null,
    judge_model: r.judge_config?.model ?? null,
    user_sim_model: r.user_simulator?.model ?? null,
    agent_models: [...new Set(rows.map((x) => x.agent?.model).filter((x) => typeof x === 'string'))],
    mock: adapters.some((a) => /mock|stub/i.test(a?.version ?? '')),
    case_ids: [...new Set(rows.map((x) => x.case_id).filter((x) => typeof x === 'string'))].sort(),
    // People an AI user-simulator played in this run (persona rows, or <pack>.persona.<id> cases), for the run title.
    personas: [...personas.values()].sort((a, b) => a.id.localeCompare(b.id)),
    errors,
  };
}


const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,200}$/;

/**
 * The slice of a run's catalog.json / config.snapshot.json / expanded case the path canvas needs: tool classes, how
 * host-reported names map to catalog tools, per-variant reply format, and the case's scripted turns. `read(path)`
 * returns the parsed JSON of a run-relative file, or null.
 */
async function pathContext(id, caseId, read) {
  const cat = await read('catalog.json');
  const cfg = await read('config.snapshot.json');
  const kase = caseId ? await read(`expanded-cases/${caseId}.case.json`) : null;
  const tools = Array.isArray(cat?.tools) ? cat.tools : Array.isArray(cfg?.tools?.catalog) ? cfg.tools.catalog : [];
  const variants = {};
  for (const [k, v] of Object.entries(cfg?.variants ?? {})) variants[k] = { format: v?.format ?? null, capabilities: Array.isArray(v?.capabilities) ? v.capabilities : [], host: v?.host ?? null };
  return {
    id,
    catalog: tools.length ? {
      gate_classes: cat?.gate_classes ?? cfg?.tools?.gate_classes ?? [],
      tools: tools.filter((t) => t && typeof t.name === 'string').map((t) => ({ name: t.name, classes: Array.isArray(t.classes) ? t.classes : [], gated: t.gated ?? null, risk: typeof t.risk === 'number' ? t.risk : null })),
    } : null,
    config: cfg ? { reported_prefixes: cfg.tools?.reported_prefixes ?? [], reported_aliases: cfg.tools?.reported_aliases ?? {}, gate_classes: cfg.tools?.gate_classes ?? [], variants } : null,
    case: kase && typeof kase === 'object' ? { id: kase.id ?? caseId, version: kase.version ?? null, input: kase.input ?? null, expect: kase.expect ?? null, graders: kase.graders ?? null, format: kase.format ?? null, limits: kase.limits ?? null } : null,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default CLI runner: `node <harness>/src/cli.ts <args>` (read-only commands only: compare, history). */
function nodeCli(harnessDir) {
  return (args, env) => new Promise((res) => {
    execFile(process.execPath, [join(harnessDir, 'src', 'cli.ts'), ...args], { cwd: harnessDir, env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

function gitBranchOf(dir) {
  try { const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return b && b !== 'HEAD' ? b : null; } catch { return null; }
}

/** A run-relative file path from a row (atif_uri / snapshot_uri): relative, no `..`, no scheme. */
function storeRelPath(uri) {
  if (typeof uri !== 'string' || !uri || uri.includes('\0') || uri.includes('\\') || isAbsolute(uri) || /^[a-z][a-z0-9+.-]*:/i.test(uri)) return null;
  const parts = uri.replace(/^\.\//, '').split('/');
  if (parts.some((x) => x === '..' || x === '' || x === '.')) return null;
  return parts.join('/');
}

export function createApi(opts) {
  const resultsDir = resolve(opts.resultsDir);
  const repoDir = resolve(opts.repoDir);
  const harnessDir = resolve(opts.harnessDir ?? join(HERE, '..', '..'));
  const storeUrl = opts.storeUrl ? (opts.storeUrl.startsWith('gs://') ? opts.storeUrl : resolve(opts.storeUrl)) : null;
  const store = storeUrl ? openStoreReader(storeUrl, { fetch: opts.fetch, token: opts.token, project: opts.storeProject, now: opts.now }) : null;
  const runCli = opts.runCli ?? nodeCli(harnessDir);
  const currentBranch = opts.currentBranch !== undefined ? opts.currentBranch : gitBranchOf(repoDir);
  const cliCache = new Map(); // compare/history results for immutable stored runs
  const cache = new Map(); // id -> { key, summary }
  let version = 0;
  let watcher = null;

  const listRunDirs = () => {
    if (!existsSync(resultsDir)) return [];
    let ents;
    try { ents = readdirSync(resultsDir, { withFileTypes: true }); } catch { return []; }
    return ents
      .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
      .filter((e) => existsSync(join(resultsDir, e.name, 'run.json')) || existsSync(join(resultsDir, e.name, 'results.jsonl')))
      .map((e) => e.name);
  };

  const runDirOf = (id) => {
    if (!RUN_ID_RE.test(id ?? '')) return null;
    const dir = resolve(resultsDir, id);
    if (!isInside(resultsDir, dir) || dir === resultsDir) return null;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    return dir;
  };

  const getSummary = (id) => {
    const dir = runDirOf(id);
    if (!dir) return null;
    const key = mtimeKey(dir);
    const hit = cache.get(id);
    if (hit && hit.key === key) return hit.summary;
    const summary = summarize(id, dir, libraryNames());
    cache.set(id, { key, summary });
    return summary;
  };

  // Persona library (packs/**/personas/*.persona.json): re-read at most every 5s.
  let lib = { at: 0, list: [] };
  const library = () => {
    const t = Date.now();
    if (t - lib.at > 5000) lib = { at: t, list: readPersonaLibrary(repoDir) };
    return lib.list;
  };
  const libraryNames = () => new Map(library().filter((p) => p.name).map((p) => [p.id, p.name]));
  const convCache = new Map(); // run id -> { key, list }

  /** Every persona conversation in one run dir, with the opening exchange read from its ATIF (cached by mtime). */
  const conversationsOf = (id) => {
    const dir = runDirOf(id);
    if (!dir) return [];
    const key = mtimeKey(dir);
    const hit = convCache.get(id);
    if (hit && hit.key === key) return hit.list;
    const { rows } = readJsonl(join(dir, 'results.jsonl'));
    const created = getSummary(id)?.created ?? null;
    const list = [];
    for (const row of rows) {
      const pid = personaIdOfRow(row);
      if (!pid) continue;
      let preview = { user: null, agent: null, user_messages: 0 };
      const p = row.trace?.atif_uri ? resolveInsideRun(dir, row.trace.atif_uri) : null;
      if (p?.exists) preview = firstExchange(readJson(p.abs).value);
      const persona = row.persona && typeof row.persona === 'object' && !Array.isArray(row.persona) ? row.persona : null;
      list.push({
        run_id: id, run_created: created, created_at: row.created_at ?? null, row_id: row.row_id, case_id: row.case_id ?? null,
        surface: row.surface ?? null, trial: typeof row.trial === 'number' ? row.trial : null, status: row.status ?? null,
        invalid_reason: row.invalid_reason ?? null, skip_reason: row.skip_reason ?? null, agent_model: row.agent?.model ?? null,
        persona_id: pid, persona, preview,
      });
    }
    convCache.set(id, { key, list });
    return list;
  };

  /** /api/personas: the persona library plus every persona conversation in the results dir (newest run first). */
  function getPersonas() {
    const runs = listRuns().runs;
    const conversations = runs.flatMap((r) => conversationsOf(r.id));
    return {
      library: library(),
      runs: runs.filter((r) => r.personas?.length).map((r) => ({ id: r.id, created: r.created, verdict: r.verdict, status: r.status, agent_models: r.agent_models, surfaces: r.surfaces })),
      conversations,
    };
  }

  try {
    if (existsSync(resultsDir)) {
      watcher = watch(resultsDir, { recursive: false }, () => { version++; });
      watcher.on('error', () => {});
    }
  } catch { /* polling from the client still works */ }

  function listRuns() {
    const runs = listRunDirs().map(getSummary).filter(Boolean);
    runs.sort((a, b) => String(b.created ?? b.id).localeCompare(String(a.created ?? a.id)));
    return { results_dir: resultsDir, exists: existsSync(resultsDir), version, runs };
  }

  function getRun(id) {
    const dir = runDirOf(id);
    if (!dir) return null;
    const run = readJson(join(dir, 'run.json'));
    const gate = readJson(join(dir, 'gate.json'));
    const extra = readJson(join(dir, 'run-extra.json'));
    const files = [];
    try { for (const e of readdirSync(dir, { withFileTypes: true })) files.push(e.isDirectory() ? `${e.name}/` : e.name); } catch {}
    return {
      id,
      run: run.value,
      gate: gate.value,
      extra: extra.value,
      card: readText(join(dir, 'card.md')),
      files: files.sort(),
      summary: getSummary(id),
      errors: [run.error, gate.error, extra.error].filter(Boolean),
    };
  }

  function getRows(id) {
    const dir = runDirOf(id);
    if (!dir) return null;
    const { rows, parseErrors, missing } = readJsonl(join(dir, 'results.jsonl'));
    return { id, rows, parse_errors: parseErrors, missing };
  }

  function getTrajectory(id, rowId) {
    const dir = runDirOf(id);
    if (!dir) return { status: 404, body: { error: `run ${id} not found` } };
    if (!rowId) return { status: 400, body: { error: 'missing ?row=<row_id>' } };
    const { rows } = readJsonl(join(dir, 'results.jsonl'));
    const row = rows.find((r) => r.row_id === rowId);
    if (!row) return { status: 404, body: { error: `row ${rowId} not in ${id}/results.jsonl` } };
    const uri = row.trace?.atif_uri;
    const out = { row_id: rowId, atif_uri: uri ?? null, atif: null, snapshot_uri: row.trace?.snapshot_uri ?? null, snapshot_sim: null, notes: [] };
    if (!uri) {
      out.notes.push(row.status === 'skip' ? 'skipped trial: no trajectory was recorded' : 'row has no trace.atif_uri');
      return { status: 200, body: out };
    }
    const p = resolveInsideRun(dir, uri);
    if (!p) return { status: 403, body: { error: `trace.atif_uri "${uri}" resolves outside the run directory; refusing to read it` } };
    if (!p.exists) return { status: 404, body: { error: `trajectory file ${uri} not found in ${id}` } };
    const atif = readJson(p.abs);
    if (atif.error) return { status: 422, body: { error: atif.error } };
    out.atif = atif.value;
    const snap = row.trace?.snapshot_uri ? resolveInsideRun(dir, row.trace.snapshot_uri) : null;
    if (snap?.exists) {
      const s = readJson(snap.abs).value;
      // Only the harness-side ledger (writes / effects) is useful here; the fixture state is large.
      if (s && typeof s === 'object' && s.sim) out.snapshot_sim = s.sim;
    }
    return { status: 200, body: out };
  }

  /** Path-canvas context of a results-dir run (read-only; see pathContext). */
  function getContext(id, caseId) {
    const dir = runDirOf(id);
    if (!dir) return { status: 404, body: { error: `run ${id} not found` } };
    if (caseId && !CASE_ID_RE.test(caseId)) return { status: 400, body: { error: 'bad case id' } };
    const read = (rel) => { const p = resolveInsideRun(dir, rel); return p?.exists ? readJson(p.abs).value : null; };
    return pathContext(id, caseId, read).then((body) => ({ status: 200, body }));
  }

  function walkCases(root, acc, depth = 0) {
    if (depth > 8 || !existsSync(root)) return;
    let ents;
    try { ents = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(root, e.name);
      if (e.isDirectory()) walkCases(p, acc, depth + 1);
      else if (e.name.endsWith('.json')) acc.push(p);
    }
  }

  function getCases() {
    const roots = [];
    const packsDir = join(repoDir, 'packs');
    const packs = [];
    if (existsSync(packsDir)) {
      for (const e of readdirSync(packsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const pdir = join(packsDir, e.name);
        const manifest = readJson(join(pdir, 'pack.json')).value ?? readJson(join(pdir, 'profile.json')).value;
        packs.push({
          id: manifest?.id ?? e.name,
          dir: relative(repoDir, pdir),
          schema_version: manifest?.schema_version ?? null,
          version: manifest?.version ?? null,
          description: manifest?.description ?? manifest?.$comment ?? null,
          suites: manifest?.suites ?? null,
          variants: manifest?.variants ? Object.keys(manifest.variants) : [],
          case_count: 0,
        });
        roots.push({ dir: join(pdir, 'cases'), pack: manifest?.id ?? e.name });
      }
    }
    roots.push({ dir: join(repoDir, 'cases'), pack: null });
    const cases = [];
    const errors = [];
    for (const { dir, pack } of roots) {
      const files = [];
      walkCases(dir, files);
      for (const f of files) {
        const j = readJson(f);
        if (j.error) { errors.push(relative(repoDir, f) + ': ' + j.error); continue; }
        const c = j.value;
        if (!c || typeof c !== 'object' || typeof c.id !== 'string') continue;
        if (c.schema_version && !String(c.schema_version).startsWith('ves-case/')) continue;
        cases.push({
          id: c.id,
          version: c.version ?? null,
          schema_version: c.schema_version ?? null,
          suite: c.suite ?? null,
          safety_suite: c.safety_suite ?? c.safety ?? null,
          capability: c.capability ?? null,
          tags: Array.isArray(c.tags) ? c.tags : [],
          surfaces: Array.isArray(c.surfaces) ? c.surfaces : Array.isArray(c.variants) ? c.variants : [],
          requires: Array.isArray(c.requires) ? c.requires : [],
          graders: Array.isArray(c.graders) ? c.graders.map((g) => (typeof g === 'string' ? { id: g } : { id: g?.id ?? '?', role: g?.role ?? null })) : [],
          provenance: c.provenance ?? null,
          owner: c.owner ?? null,
          pack: pack ?? c.pack?.id ?? null,
          file: relative(repoDir, f),
        });
        const p = packs.find((x) => x.id === pack);
        if (p) p.case_count++;
      }
    }
    cases.sort((a, b) => a.id.localeCompare(b.id));
    return { repo_dir: repoDir, roots_checked: roots.map((r) => relative(repoDir, r.dir) || '.'), packs, cases, errors };
  }

  function getConfig() {
    const cfgPath = join(repoDir, 'ves.config.json');
    const cfg = readJson(cfgPath);
    const profiles = [];
    const packsDir = join(repoDir, 'packs');
    if (existsSync(packsDir)) {
      for (const e of readdirSync(packsDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const pdir = join(packsDir, e.name);
        const prof = readJson(join(pdir, 'profile.json')).value;
        if (!prof) continue;
        let catalog = null;
        if (typeof prof.catalog === 'string') {
          const cp = resolve(pdir, prof.catalog);
          if (isInside(pdir, cp)) {
            const c = readJson(cp).value;
            if (c && typeof c === 'object') {
              const ids = {};
              for (const [k, v] of Object.entries(c.ids ?? {})) ids[k] = { class: v?.class ?? null, classes: v?.classes ?? null, gated: v?.gated ?? null };
              catalog = { schema_version: c.schema_version ?? null, gated_classes: c.gated_classes ?? [], ids };
            }
          }
        }
        profiles.push({ pack: e.name, id: prof.id ?? e.name, variants: prof.variants ?? {}, class_map: prof.class_map ?? {}, deploy_targets: prof.deploy_targets ?? [], suites: prof.suites ?? {}, catalog });
      }
    }
    return {
      repo_dir: repoDir,
      config_path: relative(repoDir, cfgPath),
      config: cfg.value,
      config_error: cfg.error,
      profiles,
    };
  }

  // ------------------------------------------------------------------------------------------ run store

  const noStore = () => ({ status: 404, body: { error: 'no run store configured: start the server with --store <dir|gs://bucket/prefix> (or set VES_STORE)', configured: false } });
  const storeInfo = () => ({ configured: !!store, url: store?.url ?? null, kind: store?.kind ?? null, exists: store ? store.exists() : false, current_branch: currentBranch });

  async function storeRuns() {
    if (!store) return { status: 200, body: { ...storeInfo(), entries: [], problems: [] } };
    const { entries, problems } = await store.index();
    return { status: 200, body: { ...storeInfo(), entries, problems } };
  }

  async function storeRun(id) {
    const rec = await store.record(id);
    if (!rec) return { status: 404, body: { error: `run ${id} not in the store` } };
    const j = async (p) => { const b = await store.readFile(id, p); try { return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; } };
    const card = await store.readFile(id, 'card.md');
    const { entries } = await store.index();
    return { status: 200, body: { id, record: { tree_sha256: rec.tree_sha256, files: rec.files.length }, run: await j('run.json'), gate: await j('gate.json'), extra: await j('run-extra.json'), card: card ? card.toString('utf8') : null, entry: entries.find((e) => e.run_id === id) ?? null } };
  }

  async function storeRowsOf(id) {
    const b = await store.readFile(id, 'results.jsonl');
    if (!b) return null;
    const rows = [];
    let parseErrors = 0;
    for (const line of b.toString('utf8').split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { parseErrors++; } }
    return { id, rows, parse_errors: parseErrors, missing: false };
  }

  async function storeTrajectory(id, rowId) {
    if (!rowId) return { status: 400, body: { error: 'missing ?row=<row_id>' } };
    const rr = await storeRowsOf(id);
    if (!rr) return { status: 404, body: { error: `run ${id} not in the store` } };
    const row = rr.rows.find((r) => r.row_id === rowId);
    if (!row) return { status: 404, body: { error: `row ${rowId} not in ${id}/results.jsonl` } };
    const uri = row.trace?.atif_uri;
    const out = { row_id: rowId, atif_uri: uri ?? null, atif: null, snapshot_uri: row.trace?.snapshot_uri ?? null, snapshot_sim: null, notes: [] };
    if (!uri) { out.notes.push(row.status === 'skip' ? 'skipped trial: no trajectory was recorded' : 'row has no trace.atif_uri'); return { status: 200, body: out }; }
    const p = storeRelPath(uri);
    if (!p) return { status: 403, body: { error: `trace.atif_uri "${uri}" is not a path inside the run; refusing to read it` } };
    const b = await store.readFile(id, p);
    if (!b) return { status: 404, body: { error: `trajectory file ${uri} not found in stored run ${id}` } };
    try { out.atif = JSON.parse(b.toString('utf8')); } catch (e) { return { status: 422, body: { error: `${p}: ${e.message}` } }; }
    const sp = row.trace?.snapshot_uri ? storeRelPath(row.trace.snapshot_uri) : null;
    const sb = sp ? await store.readFile(id, sp) : null;
    if (sb) { try { const sj = JSON.parse(sb.toString('utf8')); if (sj && typeof sj === 'object' && sj.sim) out.snapshot_sim = sj.sim; } catch { /* ignore */ } }
    return { status: 200, body: out };
  }

  /** Shell out to the harness CLI; exit 0 and 2 (compare refused) both carry the JSON result on stdout. */
  async function viaCli(key, args) {
    if (cliCache.has(key)) return cliCache.get(key);
    const env = opts.storeProject ? { VES_STORE_PROJECT: opts.storeProject } : {};
    const r = await runCli([...args, '--store', storeUrl, '--json'], env);
    let body = null;
    try { body = JSON.parse(r.stdout); } catch { body = null; }
    if ((r.code === 0 || r.code === 2) && body) { const out = { status: 200, body }; cliCache.set(key, out); return out; }
    const msg = (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-3).join(' ').slice(0, 600);
    return { status: r.code === 3 ? 400 : 500, body: { error: msg } };
  }

  async function handleStore(path, u) {
    if (path === '/api/store') return { status: 200, body: storeInfo() };
    if (path === '/api/store/runs') return storeRuns();
    if (!store) return noStore();
    const m = /^\/api\/store\/runs\/([^/]+)(?:\/(rows|trajectory|context))?\/?$/.exec(path);
    if (m) {
      let id;
      try { id = decodeURIComponent(m[1]); } catch { return { status: 400, body: { error: 'bad run id' } }; }
      if (!RUN_ID_RE.test(id)) return { status: 400, body: { error: 'bad run id' } };
      if (m[2] === 'trajectory') return storeTrajectory(id, u.searchParams.get('row'));
      if (m[2] === 'context') {
        const c = u.searchParams.get('case');
        if (c && !CASE_ID_RE.test(c)) return { status: 400, body: { error: 'bad case id' } };
        if (!(await store.record(id))) return { status: 404, body: { error: `run ${id} not in the store` } };
        const read = async (p) => { const b = await store.readFile(id, p); try { return b ? JSON.parse(b.toString('utf8')) : null; } catch { return null; } };
        return { status: 200, body: await pathContext(id, c, read) };
      }
      if (m[2] === 'rows') { const r = await storeRowsOf(id); return r ? { status: 200, body: r } : { status: 404, body: { error: `run ${id} not in the store` } }; }
      return storeRun(id);
    }
    if (path === '/api/compare') {
      const a = u.searchParams.get('a'), b = u.searchParams.get('b'), v = u.searchParams.get('variant');
      if (!a || !b || !RUN_ID_RE.test(a) || !RUN_ID_RE.test(b) || (v && !/^[A-Za-z0-9._/:-]{1,100}$/.test(v))) return { status: 400, body: { error: 'want ?a=<base run_id>&b=<head run_id>[&variant=v]' } };
      return viaCli(`c|${a}|${b}|${v ?? ''}`, ['compare', a, b, ...(v ? ['--variant', v] : [])]);
    }
    if (path === '/api/history') {
      const c = u.searchParams.get('case'), v = u.searchParams.get('variant');
      if (!c || !/^[A-Za-z0-9._:@/-]{1,200}$/.test(c) || c.startsWith('-') || (v && !/^[A-Za-z0-9._/:-]{1,100}$/.test(v))) return { status: 400, body: { error: 'want ?case=<case_id>[&variant=v]' } };
      // history changes as runs are pushed: key on the index size
      const n = (await store.index()).entries.length;
      return viaCli(`h|${c}|${v ?? ''}|${n}`, ['history', c, ...(v ? ['--variant', v] : [])]);
    }
    return { status: 404, body: { error: `no such endpoint ${path}` } };
  }

  /** Route an API request. Returns { status, body } (a Promise for store endpoints) or null when the path is not an API path. */
  function handle(method, url) {
    const u = new URL(url, 'http://127.0.0.1');
    const path = u.pathname;
    if (!path.startsWith('/api/')) return null;
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: { error: 'read-only API: GET only' } };
    if (path === '/api/health') return { status: 200, body: { ok: true, results_dir: resultsDir, results_exists: existsSync(resultsDir), repo_dir: repoDir, version } };
    if (path === '/api/runs') return { status: 200, body: listRuns() };
    if (path === '/api/cases') return { status: 200, body: getCases() };
    if (path === '/api/config') return { status: 200, body: getConfig() };
    if (path === '/api/personas') return { status: 200, body: getPersonas() };
    if (path === '/api/store' || path.startsWith('/api/store/') || path === '/api/compare' || path === '/api/history') {
      return handleStore(path, u).catch((e) => ({ status: 502, body: { error: `store: ${String(e?.message ?? e).slice(0, 400)}` } }));
    }
    const m = /^\/api\/runs\/([^/]+)(?:\/(rows|trajectory|context))?\/?$/.exec(path);
    if (m) {
      let id;
      try { id = decodeURIComponent(m[1]); } catch { return { status: 400, body: { error: 'bad run id' } }; }
      if (!RUN_ID_RE.test(id)) return { status: 400, body: { error: 'bad run id' } };
      if (m[2] === 'trajectory') return getTrajectory(id, u.searchParams.get('row'));
      if (m[2] === 'context') return getContext(id, u.searchParams.get('case'));
      const body = m[2] === 'rows' ? getRows(id) : getRun(id);
      if (!body) return { status: 404, body: { error: `run ${id} not found in ${resultsDir}` } };
      return { status: 200, body };
    }
    return { status: 404, body: { error: `no such endpoint ${path}` } };
  }

  /** Node http middleware: (req, res, next) */
  function middleware(req, res, next) {
    let out;
    try { out = handle(req.method ?? 'GET', req.url ?? '/'); }
    catch (e) { out = { status: 500, body: { error: String(e?.message ?? e) } }; }
    if (!out) return next ? next() : undefined;
    const send = (o) => {
      const json = JSON.stringify(o.body);
      res.writeHead(o.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : json);
    };
    if (typeof out.then === 'function') out.then(send, (e) => send({ status: 500, body: { error: String(e?.message ?? e) } }));
    else send(out);
  }

  return { handle, middleware, resultsDir, repoDir, storeUrl, close: () => watcher?.close() };
}

export const defaultDirs = (uiDir) => {
  const repoDir = process.env.VES_REPO ? resolve(process.env.VES_REPO) : resolve(uiDir, '..');
  const localStore = join(repoDir, '.ves', 'store');
  return {
    resultsDir: process.env.VES_RESULTS ? resolve(process.env.VES_RESULTS) : resolve(uiDir, '..', 'results'),
    repoDir,
    // --store / VES_STORE, else <repo>/.ves/store when it exists, else none (the History pages explain how to add one)
    storeUrl: process.env.VES_STORE ?? (existsSync(localStore) ? localStore : null),
    storeProject: process.env.VES_STORE_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? undefined,
  };
};

