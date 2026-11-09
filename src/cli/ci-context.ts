// `ves ci context --github|--gitlab` (DESIGN-agnostic §6.2, §6.4, §6.5): decides trigger, tier, change class, the
// suite source (base worktree or PR head), fork / first-run handling and the harness identity, from the CI
// environment alone. git runs through the injected exec. The result is printed for $GITHUB_OUTPUT (or as shell
// exports for GitLab) and persisted to $RUNNER_TEMP/ves-context.json so later steps agree with it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { resolveConfig } from '../config/load.ts';
import { classifyByGlobs } from '../gate/classify-change.ts';
import { treeHash } from '../runner/run.ts';
import type { CliDeps, Tier, VesConfig } from '../core/types.ts';
import { type CiContext, contextFile, type Env, git, HEX40, isTier, tempRoot } from './ci-shared.ts';

const ZERO = /^0+$/;
export const posix = (p: string): string => normalize(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';

export type Raw = {
  provider: 'github' | 'gitlab' | 'local'; event: string; trigger: string; head_sha: string; base_sha: string; base_ref: string;
  is_fork: boolean; repo: string; pr_number: number | null; workspace: string;
};

function githubRaw(env: Env): Raw {
  const event = env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  let payload: any = {};
  if (env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) { try { payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch { payload = {}; } }
  const pr = payload.pull_request;
  const isPr = ['pull_request', 'pull_request_target', 'merge_group'].includes(event) && !!pr;
  const defaultBranch = payload.repository?.default_branch ?? 'main';
  const trigger = isPr ? 'pr' : event === 'push' ? (env.GITHUB_REF_NAME === defaultBranch ? 'deploy' : 'manual') : event === 'schedule' ? 'nightly' : 'manual';
  const headRepo = pr?.head?.repo?.full_name ?? null;
  const baseRepo = pr?.base?.repo?.full_name ?? env.GITHUB_REPOSITORY ?? '';
  return {
    provider: 'github', event, trigger,
    head_sha: isPr ? pr.head?.sha ?? env.GITHUB_SHA ?? '' : env.GITHUB_SHA ?? '',
    base_sha: isPr ? pr.base?.sha ?? '' : event === 'push' && payload.before && !ZERO.test(payload.before) ? payload.before : '',
    base_ref: isPr ? env.GITHUB_BASE_REF ?? pr.base?.ref ?? defaultBranch : defaultBranch,
    is_fork: isPr ? pr.head?.repo?.fork === true || headRepo === null || headRepo !== baseRepo : false,
    repo: env.GITHUB_REPOSITORY ?? baseRepo, pr_number: isPr ? Number(pr.number) : null, workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
  };
}

function gitlabRaw(env: Env): Raw {
  const src = env.CI_PIPELINE_SOURCE ?? 'push';
  const isMr = src === 'merge_request_event' || !!env.CI_MERGE_REQUEST_IID;
  const trigger = isMr ? 'pr' : src === 'schedule' ? 'nightly' : src === 'push' && env.CI_COMMIT_BRANCH && env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH ? 'deploy' : 'manual';
  return {
    provider: 'gitlab', event: src, trigger,
    head_sha: env.CI_COMMIT_SHA ?? '',
    base_sha: isMr ? env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? '' : env.CI_COMMIT_BEFORE_SHA && !ZERO.test(env.CI_COMMIT_BEFORE_SHA) ? env.CI_COMMIT_BEFORE_SHA : '',
    base_ref: isMr ? env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? env.CI_DEFAULT_BRANCH ?? 'main' : env.CI_DEFAULT_BRANCH ?? 'main',
    is_fork: isMr && !!env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID && env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID !== env.CI_PROJECT_ID,
    repo: env.CI_PROJECT_PATH ?? '', pr_number: isMr ? Number(env.CI_MERGE_REQUEST_IID) : null, workspace: env.CI_PROJECT_DIR ?? process.cwd(),
  };
}

/** The CI facts before any git call (also used by `ves ci comment` to skip forks without a context file). */
export const rawContext = (provider: 'github' | 'gitlab', env: Env): Raw => (provider === 'github' ? githubRaw(env) : gitlabRaw(env));

/** Harness identity (§6.4): the action ref when it is a full SHA, else the tree hash the runner would compute. */
export function harnessSha(env: Env, harnessRoot: string): string {
  const ref = env.VES_ACTION_REF ?? '';
  if (HEX40.test(ref)) return ref;
  if (env.VES_EVALS_SHA && (HEX40.test(env.VES_EVALS_SHA) || /^tree:[a-f0-9]{64}$/.test(env.VES_EVALS_SHA))) return env.VES_EVALS_SHA;
  return `tree:${treeHash(harnessRoot)}`;
}

/** Tier when `auto` (§6.4): PR -> smoke, or release for Class 2+; pushes to main and nightly -> release. */
export function autoTier(trigger: string, changeClass: number): Tier {
  if (trigger === 'pr') return changeClass >= 2 ? 'release' : 'smoke';
  if (trigger === 'deploy' || trigger === 'nightly' || trigger === 'pre_release') return 'release';
  if (trigger === 'research') return 'research';
  return 'smoke';
}

export type ContextInput = { provider: 'github' | 'gitlab'; env: Env; deps: Pick<CliDeps, 'exec' | 'harnessRoot'>; overrides?: Partial<Record<'tier' | 'trigger' | 'suite_from' | 'config' | 'working_directory', string>> };

export async function computeContext(i: ContextInput): Promise<CiContext> {
  const { env, deps } = i;
  const raw = i.provider === 'github' ? githubRaw(env) : gitlabRaw(env);
  const warnings: string[] = [];
  const inTrigger = i.overrides?.trigger ?? env.INPUT_TRIGGER ?? 'auto';
  const trigger = inTrigger && inTrigger !== 'auto' ? inTrigger : raw.trigger;
  const wd = posix(i.overrides?.working_directory ?? env.INPUT_WORKING_DIRECTORY ?? '.');
  const configRel = posix(i.overrides?.config ?? env.INPUT_CONFIG ?? 'ves.config.json');
  const ws = resolve(raw.workspace);
  const headRoot = resolve(ws, wd);
  const repoPath = (p: string) => posix(wd === '.' ? p : `${wd}/${p}`);
  const suiteFrom = ((i.overrides?.suite_from ?? env.INPUT_SUITE_FROM ?? 'base') === 'head' ? 'head' : 'base') as 'base' | 'head';
  const isPr = trigger === 'pr';
  const baseSha = raw.base_sha;

  // ---- first run: the base branch has no config yet -> run head, REPORT_ONLY (the PR adding VES never blocks itself).
  // Fail closed (dogfood fix 2026-11-07): "first run" needs POSITIVE evidence, i.e. the base commit is readable and
  // the config is absent from it. A broken git context (no git, shallow clone without the base, a missing base SHA)
  // is not a first run: it would turn the gate into REPORT_ONLY and let any PR go green. It is `degraded` instead:
  // no REPORT_ONLY, change class raised to >= 2 (release tier, a reference run is required) and an error annotation.
  let firstRun = false;
  const degraded: string[] = [];
  if (isPr && baseSha) {
    const commit = await git(deps.exec, ws, ['cat-file', '-e', `${baseSha}^{commit}`]);
    if (!commit.ok) degraded.push(`base commit ${baseSha.slice(0, 12)} is not readable (${commit.err.split('\n')[0] || 'git failed'}); check out with fetch-depth: 0`);
    else {
      const has = await git(deps.exec, ws, ['cat-file', '-e', `${baseSha}:${repoPath(configRel)}`]);
      if (!has.ok) firstRun = true;
    }
  } else if (isPr && !baseSha) degraded.push('no base SHA in the event');

  // ---- suite root: base worktree (default for PRs) or the PR head
  let suiteRoot = headRoot, baseWorktree = '';
  if (isPr && suiteFrom === 'base' && !firstRun && !degraded.length) {
    baseWorktree = join(tempRoot(env), 'ves-base');
    if (!existsSync(join(baseWorktree, '.git'))) {
      mkdirSync(dirname(baseWorktree), { recursive: true });
      const w = await git(deps.exec, ws, ['worktree', 'add', '--detach', '--force', baseWorktree, baseSha]);
      if (!w.ok) { warnings.push(`git worktree add failed (${w.err.split('\n')[0]}): suite from head (self-gating)`); baseWorktree = ''; }
    }
    if (baseWorktree) suiteRoot = resolve(baseWorktree, wd);
  }
  const effectiveSuiteFrom = suiteRoot === headRoot ? 'head' : 'base';
  if (isPr && suiteFrom === 'base' && effectiveSuiteFrom === 'head' && !firstRun) warnings.push('suite from PR head (self-gating)');

  // ---- config (from the suite root): project, globs, suite dirs
  let project = '', changeClasses: Record<string, string[]> = {}, suiteDirs: string[] = ['evals/cases'];
  const cfgFile = isAbsolute(configRel) ? configRel : join(suiteRoot, configRel);
  if (existsSync(cfgFile)) {
    try {
      const rawCfg = JSON.parse(readFileSync(cfgFile, 'utf8')) as VesConfig;
      const r = resolveConfig(rawCfg, { dir: dirname(cfgFile), path: cfgFile, env });
      project = r.config.project; changeClasses = r.config.change_classes as Record<string, string[]>;
      suiteDirs = r.config.suites.map((s) => posix(s.startsWith(r.config.dir) ? s.slice(r.config.dir.length + 1) : s));
    } catch (e) { warnings.push(`could not read ${configRel}: ${(e as Error).message.split('\n')[0]}`); }
  } else warnings.push(`${configRel} not found under ${suiteRoot}`);

  // ---- change class: git diff base...head through the config globs (no base -> class 1, §5.2)
  let changeClass = 1;
  let reasons: string[] = ['no base ref: class 1'];
  let changed: string[] = [];
  if (baseSha && raw.head_sha && !degraded.length) {
    const d = await git(deps.exec, ws, ['diff', '--name-only', `${baseSha}...${raw.head_sha}`]);
    if (d.ok) {
      changed = d.out.split('\n').filter(Boolean);
      const rel = changed.map((p) => (wd === '.' ? p : p.startsWith(`${wd}/`) ? p.slice(wd.length + 1) : `../${p}`));
      const c = classifyByGlobs(rel, changeClasses as never, {}, suiteDirs);
      changeClass = c.change_class; reasons = c.reasons;
      if (!changed.length) reasons = ['no changed paths: class 0'];
    } else degraded.push(`git diff ${baseSha.slice(0, 12)}...${raw.head_sha.slice(0, 12)} failed (${d.err.split('\n')[0] || 'git failed'})`);
  }
  if (isPr && degraded.length) {
    // the change class is unknown: assume the stricter class (never the laxer smoke tier)
    if (changeClass < 2) { changeClass = 2; reasons = [`git context unavailable: class 2 (fail closed): ${degraded.join('; ')}`]; }
    for (const x of degraded) warnings.push(`${x}: failing closed (class >= 2, no REPORT_ONLY)`);
  }

  // ---- new or changed case files in this PR (advisory until merged)
  const newCaseFiles: string[] = [], newCases: string[] = [];
  if (isPr) {
    const dirs = suiteDirs.map((s) => repoPath(s));
    const added = baseSha && raw.head_sha ? await git(deps.exec, ws, ['diff', '--name-only', '--diff-filter=AMR', `${baseSha}...${raw.head_sha}`]) : { ok: false, out: '', err: '' };
    for (const p of (added.ok ? added.out.split('\n') : []).filter((x) => x.endsWith('.case.json') && dirs.some((d) => x.startsWith(`${d}/`)))) {
      newCaseFiles.push(p);
      try { const id = JSON.parse(readFileSync(join(ws, p), 'utf8')).id; if (typeof id === 'string') newCases.push(id); } catch { /* unreadable: listed by file only */ }
    }
  }

  const inTier = i.overrides?.tier ?? env.INPUT_TIER ?? 'auto';
  const tier: Tier = isTier(inTier) ? inTier : autoTier(trigger, changeClass);
  return {
    provider: raw.provider, event: raw.event, trigger, tier, change_class: changeClass, change_reasons: reasons,
    base_sha: baseSha, head_sha: raw.head_sha, base_ref: raw.base_ref, suite_from: effectiveSuiteFrom, suite_root: suiteRoot, head_root: headRoot,
    base_worktree: baseWorktree, is_fork: raw.is_fork, first_run: firstRun, harness_sha: harnessSha(env, deps.harnessRoot), config: configRel,
    working_directory: wd, new_cases: newCases, new_case_files: newCaseFiles, project, repo: raw.repo, pr_number: raw.pr_number, warnings,
    ...(degraded.length ? { degraded } : {}),
  };
}

/** The keys `ves ci context` emits to $GITHUB_OUTPUT (the action lint test checks action.yml against these). */
export function contextOutputs(c: CiContext): Record<string, string> {
  return {
    trigger: c.trigger, tier: c.tier, change_class: String(c.change_class), base_sha: c.base_sha, head_sha: c.head_sha, base_ref: c.base_ref,
    suite_root: c.suite_root, suite_from: c.suite_from, is_fork: String(c.is_fork), first_run: String(c.first_run), harness_sha: c.harness_sha,
    new_cases: c.new_cases.join(','), new_case_files: c.new_case_files.map((p) => (isAbsolute(p) ? p : join(c.head_root, p))).join(','), project: c.project, pr_number: c.pr_number === null ? '' : String(c.pr_number),
  };
}

/** GitLab: `source ves.env` variables. */
export function contextExports(c: CiContext): Record<string, string> {
  return {
    VES_TRIGGER: c.trigger, VES_TIER: c.tier, VES_CHANGE_CLASS: String(c.change_class), VES_BASE_SHA: c.base_sha, VES_HEAD_SHA: c.head_sha,
    VES_SUITE_ROOT: c.suite_root, VES_IS_FORK: String(c.is_fork), VES_FIRST_RUN: String(c.first_run), VES_HARNESS_SHA: c.harness_sha,
    VES_NEW_CASES: c.new_cases.join(','), VES_NEW_CASE_FILES: c.new_case_files.map((p) => (isAbsolute(p) ? p : join(c.head_root, p))).join(','), VES_REPORT_ONLY: c.is_fork || c.first_run ? '1' : '', VES_CONNECTION: c.is_fork ? 'mock' : '',
  };
}

export function saveContext(c: CiContext, env: Env): string {
  const f = contextFile(env);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 2));
  return f;
}
