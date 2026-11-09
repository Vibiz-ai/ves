// `ves ci baseline` (DESIGN-agnostic §6.4): find the reference run for a PR.
//   auto      artifact -> (hygiene fails or none) -> run-base -> none
//   artifact  newest successful base-branch run of this workflow, artifact <name>, newest run of the SAME tier
//   run-base  run the same suite against the BASE agent from the base worktree (doubles the cost; the card says so)
//   none      no comparison (a Class 2+ release run is then INVALID at G-1 "no reference", unchanged VES-1)
//   <path>    a local run dir, or a dir holding run dirs
// The pre-run hygiene check uses what is knowable before the candidate exists (valid status, run-2, project, tier,
// harness identity, config hash); the runner repeats the full VES-1 §5.5 comparator hygiene against the candidate.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveConfig } from '../config/load.ts';
import type { CliDeps, Tier, VesConfig } from '../core/types.ts';
import { type CiContext, type Env, findRunDirs, git, lastJsonLine, parseJsonStream, readJson, TIER_RANK } from './ci-shared.ts';

export type BaselineResult = { dir: string; source: 'artifact' | 'run-base' | 'path' | 'none'; run_id: string; reason: string; tried: string[] };
export type Want = { project: string; tier: Tier; harness_sha: string; config_sha256: string | null };

/** Pre-run hygiene of a candidate reference run against what the PR run will be. Returns problems (empty = usable). */
export function preHygiene(runDir: string, w: Want): string[] {
  const m = readJson(join(runDir, 'run.json'));
  if (!m) return ['no run.json'];
  const p: string[] = [];
  if (m.schema_version !== 'ves-run/2') p.push(`schema ${m.schema_version} (need ves-run/2)`);
  if (m.status !== 'valid') p.push(`status ${m.status}`);
  const g = readJson(join(runDir, 'gate.json'));
  if (g?.verdict === 'INVALID') p.push('verdict INVALID');
  if (w.project && m.project !== w.project) p.push(`project ${m.project} != ${w.project}`);
  // exact tier (dogfood fix 2026-11-07): a run of another tier has another suite_version, fixture set and k, so the
  // runner's comparator hygiene would make the PR INVALID at G-1 (main's release run vs a smoke PR)
  if (TIER_RANK[m.tier as Tier] === undefined || m.tier !== w.tier) p.push(`tier ${m.tier} != ${w.tier} (another tier is another suite_version; G-1 would reject it)`);
  if (w.harness_sha && m.harness?.evals_sha && m.harness.evals_sha !== w.harness_sha) p.push(`harness ${String(m.harness.evals_sha).slice(0, 17)} != ${w.harness_sha.slice(0, 17)} (packs/graders may differ)`);
  if (w.config_sha256 && m.config_sha256 && m.config_sha256 !== w.config_sha256) p.push('config_sha256 differs from the suite config');
  return p;
}

/** Newest (by run_id timestamp) usable run under `dir`, or the reasons none is. */
export function pickRun(dir: string, w: Want): { dir: string | null; run_id: string; rejected: string[] } {
  const runs = findRunDirs(dir).map((d) => ({ d, id: String(readJson(join(d, 'run.json'))?.run_id ?? basename(d)) })).sort((a, b) => (a.id < b.id ? 1 : -1));
  const rejected: string[] = [];
  for (const r of runs) {
    const p = preHygiene(r.d, w);
    if (!p.length) return { dir: r.d, run_id: r.id, rejected };
    rejected.push(`${r.id}: ${p.join('; ')}`);
  }
  return { dir: null, run_id: '', rejected: runs.length ? rejected : [`no run directories under ${dir}`] };
}

export function wantFor(ctx: CiContext, env: Env): Want {
  let config_sha256: string | null = null;
  const f = join(ctx.suite_root, ctx.config);
  if (existsSync(f)) { try { config_sha256 = resolveConfig(JSON.parse(readFileSync(f, 'utf8')) as VesConfig, { dir: dirname(f), path: f, env }).config.sha256; } catch { config_sha256 = null; } }
  return { project: ctx.project, tier: ctx.tier, harness_sha: ctx.harness_sha, config_sha256 };
}

/** GitHub: the workflow file name from GITHUB_WORKFLOW_REF (`o/r/.github/workflows/ves.yml@refs/...`). */
export const workflowFile = (env: Env): string => basename(String(env.GITHUB_WORKFLOW_REF ?? 'ves.yml').split('@')[0]) || 'ves.yml';

export async function fromGithubArtifact(ctx: CiContext, env: Env, deps: Pick<CliDeps, 'exec'>, artifact: string, w: Want, dest: string): Promise<{ dir: string | null; run_id: string; tried: string[] }> {
  const tried: string[] = [];
  const list = await deps.exec('gh', ['run', 'list', '--repo', ctx.repo, '--workflow', workflowFile(env), '--branch', ctx.base_ref, '--status', 'success', '-L', '5', '--json', 'databaseId,headSha,createdAt,event']);
  if (list.code !== 0) return { dir: null, run_id: '', tried: [`gh run list failed: ${list.stderr.trim().split('\n')[0]}`] };
  const runs = (parseJsonStream(list.stdout).flat() as { databaseId: number; headSha: string }[]).filter((r) => r && r.databaseId);
  if (!runs.length) return { dir: null, run_id: '', tried: [`no successful ${workflowFile(env)} run on ${ctx.base_ref}`] };
  for (const r of runs) {
    const d = join(dest, String(r.databaseId));
    mkdirSync(d, { recursive: true });
    const dl = await deps.exec('gh', ['run', 'download', String(r.databaseId), '--repo', ctx.repo, '-n', artifact, '-D', d]);
    if (dl.code !== 0) { tried.push(`run ${r.databaseId}: download failed (${dl.stderr.trim().split('\n')[0]})`); continue; }
    const pick = pickRun(d, w);
    if (pick.dir) return { dir: pick.dir, run_id: pick.run_id, tried };
    tried.push(...pick.rejected.map((x) => `run ${r.databaseId}: ${x}`));
  }
  return { dir: null, run_id: '', tried };
}

export async function fromGitlabArtifact(ctx: CiContext, env: Env, deps: Pick<CliDeps, 'exec'>, job: string, w: Want, dest: string): Promise<{ dir: string | null; run_id: string; tried: string[] }> {
  if (!env.CI_API_V4_URL || !env.CI_PROJECT_ID || !env.CI_JOB_TOKEN) return { dir: null, run_id: '', tried: ['CI_API_V4_URL / CI_PROJECT_ID / CI_JOB_TOKEN not set'] };
  mkdirSync(dest, { recursive: true });
  const zip = join(dest, 'artifacts.zip');
  const url = `${env.CI_API_V4_URL}/projects/${encodeURIComponent(env.CI_PROJECT_ID)}/jobs/artifacts/${encodeURIComponent(ctx.base_ref)}/download?job=${encodeURIComponent(job)}`;
  const dl = await deps.exec('curl', ['-sSfL', '--header', `JOB-TOKEN: ${env.CI_JOB_TOKEN}`, '-o', zip, url]);
  if (dl.code !== 0) return { dir: null, run_id: '', tried: [`artifact download failed (${dl.stderr.trim().split('\n')[0] || `exit ${dl.code}`})`] };
  let un = await deps.exec('unzip', ['-q', '-o', zip, '-d', dest]);
  if (un.code !== 0) un = await deps.exec('python3', ['-m', 'zipfile', '-e', zip, dest]);
  if (un.code !== 0) return { dir: null, run_id: '', tried: ['could not unzip the artifact (need unzip or python3)'] };
  const pick = pickRun(dest, w);
  return { dir: pick.dir, run_id: pick.run_id, tried: pick.rejected };
}

/** Runs the base agent from the base worktree (§6.4 run-base). */
export async function runBase(ctx: CiContext, env: Env, deps: Pick<CliDeps, 'exec' | 'harnessRoot'>, out: string): Promise<{ dir: string | null; run_id: string; tried: string[] }> {
  let wt = ctx.base_worktree;
  if (!ctx.base_sha) return { dir: null, run_id: '', tried: ['run-base: no base SHA'] };
  if (!wt || !existsSync(wt)) {
    wt = join(dirname(out), 'ves-base');
    const w = await git(deps.exec, ctx.head_root, ['worktree', 'add', '--detach', '--force', wt, ctx.base_sha]);
    if (!w.ok) return { dir: null, run_id: '', tried: [`run-base: git worktree add failed (${w.err.split('\n')[0]})`] };
  }
  const baseRoot = join(wt, ctx.working_directory);
  if (!existsSync(join(baseRoot, ctx.config))) return { dir: null, run_id: '', tried: [`run-base: ${ctx.config} missing on the base branch`] };
  const tried: string[] = [];
  if (existsSync(join(baseRoot, 'ves', 'setup-base.sh'))) {
    const s = await deps.exec('bash', ['ves/setup-base.sh'], { cwd: baseRoot });
    if (s.code !== 0) return { dir: null, run_id: '', tried: [`run-base: ves/setup-base.sh failed (exit ${s.code})`] };
    tried.push('run-base: ran ves/setup-base.sh');
  }
  const venv = join(baseRoot, '.ves-base-venv');
  const pathEnv: Record<string, string> = existsSync(join(venv, 'bin')) ? { PATH: `${join(venv, 'bin')}:${env.PATH ?? ''}`, VIRTUAL_ENV: venv } : {};
  const r = await deps.exec(process.execPath, [join(deps.harnessRoot, 'bin', 'ves.mjs'), 'run', '--config', ctx.config, '--trigger', 'manual', '--tier', ctx.tier,
    '--target', ctx.base_sha, '--change-class', '1', '--baseline', 'none', '--out', out, '--json'], { cwd: baseRoot, env: { VES_EVALS_SHA: ctx.harness_sha, VES_HARNESS_SOURCE: 'action', ...pathEnv } });
  const j = lastJsonLine(r.stdout);
  if (!j?.run_dir) return { dir: null, run_id: '', tried: [...tried, `run-base: base run produced no result (exit ${r.code})`] };
  if (j.verdict === 'INVALID') return { dir: null, run_id: '', tried: [...tried, `run-base: base run INVALID (${j.decided_by ?? ''})`] };
  return { dir: String(j.run_dir), run_id: String(j.run_id ?? ''), tried };
}

export async function selectBaseline(o: { mode: string; provider: 'github' | 'gitlab'; ctx: CiContext; env: Env; deps: Pick<CliDeps, 'exec' | 'harnessRoot'>; artifact: string; tmp: string }): Promise<BaselineResult> {
  const { mode, ctx, env, deps } = o;
  const none = (reason: string, tried: string[] = []): BaselineResult => ({ dir: '', source: 'none', run_id: '', reason, tried });
  if (mode === 'none') return none('baseline: none');
  if (ctx.is_fork) return none('fork PR: wiring-only mock run, no comparison');
  if (ctx.first_run) return none('first run: the base branch has no ves config yet');
  const w = wantFor(ctx, env);
  if (!['auto', 'artifact', 'run-base'].includes(mode)) {
    const pick = pickRun(mode, { ...w, harness_sha: '', config_sha256: null });
    return pick.dir ? { dir: pick.dir, source: 'path', run_id: pick.run_id, reason: `path ${mode}`, tried: pick.rejected } : none(`no usable run under ${mode}`, pick.rejected);
  }
  const tried: string[] = [];
  if (mode === 'auto' || mode === 'artifact') {
    const a = o.provider === 'github'
      ? await fromGithubArtifact(ctx, env, deps, o.artifact, w, join(o.tmp, 'ves-baseline'))
      : await fromGitlabArtifact(ctx, env, deps, o.artifact, w, join(o.tmp, 'ves-baseline'));
    tried.push(...a.tried);
    if (a.dir) return { dir: a.dir, source: 'artifact', run_id: a.run_id, reason: `artifact ${o.artifact} from ${ctx.base_ref}`, tried };
    if (mode === 'artifact') return none('no hygienic baseline artifact', tried);
    // below Class 2 a reference is optional (G-6/G-7 need Class 2+): do not double the cost with run-base for it
    if (mode === 'auto' && ctx.change_class < 2) return none(`Class ${ctx.change_class} ${ctx.tier} PR: no ${ctx.tier} reference on ${ctx.base_ref}; a comparison is optional below Class 2 (G-6/G-7 need Class 2+)`, tried);
  }
  const rb = await runBase(ctx, env, deps, join(o.tmp, 'ves-baseline-run'));
  tried.push(...rb.tried);
  if (rb.dir) return { dir: rb.dir, source: 'run-base', run_id: rb.run_id, reason: 'ran the base agent (doubles the cost)', tried };
  return none('no reference: merge to main once with the push trigger to produce one', tried);
}
