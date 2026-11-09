// `ves ci context|baseline|outputs|comment|exit` (ci package, DESIGN-agnostic §6). Loaded by src/registry/commands.ts.
// Machine output goes to stdout ($GITHUB_OUTPUT lines, or `export K='v'` lines with --gitlab); human text to stderr.
// No @actions/* dependency: git and gh through the injected exec, HTTP through the injected fetch.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCardModel } from '../report/model.ts';
import { exitCodeFor } from '../gate/gate.ts';
import { renderJUnit, renderPrComment, markerFor } from '../report/pr/index.ts';
import type { CliCommand, CliDeps, Verdict } from '../core/types.ts';
import { parse, str } from './args.ts';
import { computeContext, contextExports, contextOutputs, rawContext, saveContext } from './ci-context.ts';
import { selectBaseline } from './ci-baseline.ts';
import { githubStoreFor, gitlabStore, upsertComment } from './ci-comment.ts';
import { type CiContext, type Env, githubOutputs, lastJsonLine, readContext, say, shellExports, tempRoot } from './ci-shared.ts';

const VERDICTS: Verdict[] = ['PASS', 'BLOCK', 'INVALID', 'REPORT_ONLY'];
export const FAIL_ON = ['block', 'invalid', 'never'] as const;

/** §6.3 exit mapping. block: BLOCK and INVALID fail; invalid: INVALID only; never: always 0. REPORT_ONLY/PASS: 0.
 *  A missing verdict (the run step crashed) counts as INVALID. */
export function exitFor(verdict: string, failOn: string): { code: number; message: string } {
  const v = (VERDICTS as string[]).includes(verdict) ? (verdict as Verdict) : null;
  const shown = v ?? 'no verdict (the run step failed before writing one)';
  if (failOn === 'never') return { code: 0, message: `VES: ${shown} (fail-on never)` };
  const eff: Verdict = v ?? 'INVALID';
  if (eff === 'PASS' || eff === 'REPORT_ONLY') return { code: 0, message: `VES: ${shown}` };
  if (failOn === 'invalid' && eff === 'BLOCK') return { code: 0, message: `VES: ${shown} (fail-on invalid: not failing the step)` };
  return { code: exitCodeFor(eff), message: `VES: ${shown}: failing the step (fail-on ${failOn})` };
}

function providerOf(a: Record<string, unknown>, env: Env): 'github' | 'gitlab' {
  if (a.gitlab === true) return 'gitlab';
  if (a.github === true) return 'github';
  return env.GITLAB_CI === 'true' && env.GITHUB_ACTIONS !== 'true' ? 'gitlab' : 'github';
}
const emit = (deps: CliDeps, provider: 'github' | 'gitlab', gh: Record<string, string>, gl: Record<string, string>) => deps.stdout(provider === 'github' ? githubOutputs(gh) : shellExports(gl));

async function ctxOrCompute(deps: CliDeps, provider: 'github' | 'gitlab', a: Record<string, unknown>): Promise<CiContext> {
  return readContext(deps.env, str(a.context)) ?? computeContext({ provider, env: deps.env, deps });
}

/** Writes pr-comment.md and junit.xml next to the run's card (§5.2 artifact list) so they travel with the artifact. */
export function writeRunExtras(runDir: string): string[] {
  const written: string[] = [];
  const model = buildCardModel(runDir);
  writeFileSync(join(runDir, 'pr-comment.md'), renderPrComment(model, {}) + '\n'); written.push('pr-comment.md');
  const rf = join(runDir, 'results.jsonl');
  const rows = existsSync(rf) ? readFileSync(rf, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  writeFileSync(join(runDir, 'junit.xml'), renderJUnit(model, rows) + '\n'); written.push('junit.xml');
  return written;
}

export async function ciMain(argv: string[], deps: CliDeps): Promise<number> {
  const [sub, ...rest] = argv;
  const a = parse(rest);
  const env = deps.env;
  const provider = providerOf(a, env);
  switch (sub) {
    case 'context': {
      const c = await computeContext({ provider, env, deps, overrides: { ...(str(a.tier) ? { tier: str(a.tier) } : {}), ...(str(a.trigger) ? { trigger: str(a.trigger) } : {}), ...(str(a['suite-from']) ? { suite_from: str(a['suite-from']) } : {}), ...(str(a.config) ? { config: str(a.config) } : {}), ...(str(a['working-directory']) ? { working_directory: str(a['working-directory']) } : {}) } });
      const f = saveContext(c, env);
      emit(deps, provider, contextOutputs(c), contextExports(c));
      say(deps, `VES context: trigger ${c.trigger}, tier ${c.tier}, class ${c.change_class}, suite from ${c.suite_from}${c.is_fork ? ', fork PR (mock wiring run, REPORT_ONLY, no comment)' : ''}${c.first_run ? ', first run (REPORT_ONLY)' : ''}; harness ${c.harness_sha.slice(0, 17)}; context ${f}`);
      for (const w of c.warnings) say(deps, `VES context warning: ${w}`);
      if (c.degraded?.length && provider === 'github') say(deps, `::error title=VES git context::${c.degraded.join('; ')}. Failing closed: class ${c.change_class}, tier ${c.tier}, no REPORT_ONLY. Use actions/checkout with fetch-depth: 0.`);
      return 0;
    }
    case 'baseline': {
      const c = await ctxOrCompute(deps, provider, a);
      if (str(a.tier)) c.tier = str(a.tier) as CiContext['tier'];
      const r = await selectBaseline({ mode: str(a.mode) ?? 'auto', provider, ctx: c, env, deps, artifact: str(a.artifact) ?? (provider === 'github' ? 'ves-results' : 'ves'), tmp: tempRoot(env) });
      emit(deps, provider, { dir: r.dir, source: r.source, run_id: r.run_id, reason: r.reason }, { VES_BASELINE_DIR: r.dir, VES_BASELINE_SOURCE: r.source, VES_BASELINE_RUN_ID: r.run_id });
      say(deps, `VES baseline: ${r.source}${r.dir ? ` ${r.dir}` : ''} (${r.reason})`);
      for (const t of r.tried) say(deps, `  tried: ${t}`);
      return 0;
    }
    case 'outputs': {
      const from = str(a.from);
      const code = Number(str(a.exit) ?? NaN);
      const j = from && existsSync(from) ? lastJsonLine(readFileSync(from, 'utf8')) : null;
      const runDir = j?.run_dir ? String(j.run_dir) : '';
      const o = { verdict: String(j?.verdict ?? ''), would_be: String(j?.would_be ?? ''), decided_by: String(j?.decided_by ?? ''), run_dir: runDir, run_id: String(j?.run_id ?? ''), conformance: String(j?.conformance ?? ''), exit_code: Number.isNaN(code) ? '' : String(code), error: j ? '' : `ves run printed no result JSON (exit ${Number.isNaN(code) ? '?' : code})` };
      if (runDir && existsSync(join(runDir, 'run.json'))) { try { writeRunExtras(runDir); } catch (e) { say(deps, `VES outputs: could not write pr-comment.md/junit.xml: ${(e as Error).message}`); } }
      emit(deps, provider, o, { VES_VERDICT: o.verdict, VES_WOULD_BE: o.would_be, VES_DECIDED_BY: o.decided_by, VES_RUN_DIR: o.run_dir, VES_RUN_ID: o.run_id, VES_EXIT_CODE: o.exit_code });
      say(deps, o.error ? `VES outputs: ${o.error}` : `VES run: ${o.verdict}${o.decided_by ? ` (${o.decided_by})` : ''} -> ${o.run_dir}`);
      return 0;
    }
    case 'comment': {
      const run = str(a.run);
      if (!run) { say(deps, 'usage: ves ci comment --run <dir> [--run-url <url>] [--gitlab] [--transport auto|gh|api] [--dry-run]'); return 3; }
      const raw = rawContext(provider, env);
      const ctx = readContext(env, str(a.context));
      const fork = ctx?.is_fork ?? raw.is_fork;
      const prNum = Number(str(a.pr) ?? ctx?.pr_number ?? raw.pr_number ?? NaN);
      const skip = (why: string) => { emit(deps, provider, { url: '', action: 'skipped', reason: why }, { VES_COMMENT_URL: '' }); say(deps, `VES comment: skipped (${why})`); return 0; };
      if (fork) return skip('fork PR: no write token');
      if (!Number.isFinite(prNum) || prNum <= 0) return skip('not a pull/merge request');
      const model = buildCardModel(resolve(run));
      const runUrl = str(a['run-url']);
      const body = renderPrComment(model, { runUrl, ...(str(a['artifact-url']) ? { artifactUrl: str(a['artifact-url']) } : {}), ...(str(a['max-chars']) ? { maxChars: Number(str(a['max-chars'])) } : {}) });
      try { writeFileSync(join(resolve(run), 'pr-comment.md'), body + '\n'); } catch { /* read-only run dir: fine */ }
      if (a['dry-run'] === true) { deps.stdout(body + '\n'); return 0; }
      // A comment failure never changes the verdict: report it and let `ci exit` decide the step.
      try {
        const store = provider === 'github'
          ? await githubStoreFor(deps, env, str(a.repo) ?? ctx?.repo ?? raw.repo, prNum, (str(a.transport) ?? 'auto') as 'auto' | 'gh' | 'api')
          : (() => {
            const token = env.GITLAB_TOKEN;
            if (!token || !env.CI_API_V4_URL || !env.CI_PROJECT_ID) throw new Error('GitLab comment needs GITLAB_TOKEN, CI_API_V4_URL and CI_PROJECT_ID');
            return gitlabStore(deps.fetch, { apiUrl: env.CI_API_V4_URL, token, projectId: env.CI_PROJECT_ID, iid: prNum, mrUrl: `${env.CI_MERGE_REQUEST_PROJECT_URL ?? env.CI_PROJECT_URL ?? ''}/-/merge_requests/${prNum}` });
          })();
        const r = await upsertComment(store, markerFor(model.project), body);
        emit(deps, provider, { url: r.url, action: r.action, comment_id: r.id }, { VES_COMMENT_URL: r.url });
        say(deps, `VES comment: ${r.action} ${r.url}${r.removed_duplicates ? ` (removed ${r.removed_duplicates} duplicate${r.removed_duplicates === 1 ? '' : 's'})` : ''} via ${store.kind}`);
        return 0;
      } catch (e) {
        emit(deps, provider, { url: '', action: 'error', reason: (e as Error).message.split('\n')[0] }, { VES_COMMENT_URL: '' });
        say(deps, `VES comment: could not upsert the comment: ${(e as Error).message}`);
        return 0;
      }
    }
    case 'exit': {
      const failOn = str(a['fail-on']) ?? 'block';
      if (!(FAIL_ON as readonly string[]).includes(failOn)) { say(deps, `--fail-on must be ${FAIL_ON.join('|')}`); return 3; }
      const r = exitFor(str(a.verdict) ?? '', failOn);
      say(deps, r.message);
      return r.code;
    }
    default:
      say(deps, ['usage: ves ci <subcommand> [--github|--gitlab]',
        '  context   trigger, tier, change class, suite root (base worktree | head), fork / first run, harness identity',
        '  baseline  --mode auto|artifact|run-base|none|<path> [--artifact name]: the reference run for a PR',
        '  outputs   --from <ves-run.json> --exit <code>: step outputs; writes pr-comment.md and junit.xml into the run dir',
        '  comment   --run <dir> [--run-url url]: upsert the single PR/MR comment (skips forks)',
        '  exit      --verdict V --fail-on block|invalid|never'].join('\n'));
      return 3;
  }
}

const command: CliCommand = { name: 'ci', summary: 'context|baseline|outputs|comment|exit for GitHub Actions and GitLab CI', run: ciMain };
export default command;
