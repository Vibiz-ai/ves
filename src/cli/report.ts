// `ves gate` (pure, §5.3) and `ves report` (§5.4). Neither ever contacts the agent.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCardModel } from '../report/model.ts';
import { CI_FORMATS, requirePrReport } from '../registry/report.ts';
import { exitCodeFor } from '../gate/gate.ts';
import type { Verdict } from '../types.ts';
import { type Args, CliUsage, list, str } from './args.ts';

const RANK: Record<Verdict, number> = { REPORT_ONLY: 0, PASS: 1, INVALID: 2, BLOCK: 3 };

export async function cmdGate(a: Args, root: string): Promise<number> {
  const runs = list(a.run);
  if (runs.length) {
    // Smoke and release runs of the same SHA combine; the strictest verdict wins.
    const gates = runs.map((d) => JSON.parse(readFileSync(join(resolve(d), 'gate.json'), 'utf8')));
    const shas = new Set(gates.map((g) => g.sha));
    if (shas.size > 1) throw new CliUsage(`--run directories are for different SHAs: ${[...shas].join(', ')}`);
    const worst = gates.reduce((w, g) => (RANK[g.verdict as Verdict] > RANK[w.verdict as Verdict] ? g : w));
    const out = { sha: worst.sha, verdict: worst.verdict, decided_by: worst.decided_by, runs: gates.map((g) => ({ run_ids: g.run_ids, verdict: g.verdict, decided_by: g.decided_by })) };
    process.stdout.write((a.json === true ? JSON.stringify(out, null, 2) : `ves/gate ${out.verdict}${out.decided_by ? ` (${out.decided_by})` : ''} for ${out.sha}`) + '\n');
    return exitCodeFor(worst.verdict);
  }
  const sha = String(str(a.require) ?? '');
  const dir = resolve(String(str(a.results) ?? join(root, 'results')));
  const need = Number(str(a['change-class']) ?? 0);
  const hits = existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith('ves-') && statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, 'gate.json')))
    .map((d) => JSON.parse(readFileSync(join(dir, d, 'gate.json'), 'utf8'))).filter((g) => g.sha === sha && g.change_class >= need) : [];
  const pass = hits.find((g) => g.verdict === 'PASS');
  console.log(pass ? `ves/gate PASS for ${sha} (${pass.run_ids.join(', ')})` : `ves/gate: no PASS for ${sha} at class >= ${need} in ${dir}`);
  return pass ? 0 : 1;
}

export async function cmdReport(a: Args, root: string): Promise<number> {
  const run = str(a.run);
  if (!run) throw new CliUsage('usage: ves report --run <dir> --format md|json|pr|summary|junit|annotations|claims|efficiency [--run-url <url>] [--config ves.config.json] [--json]');
  const dir = resolve(run);
  const format = str(a.format) ?? 'md';
  if (format === 'md') { process.stdout.write(readFileSync(join(dir, 'card.md'), 'utf8')); return 0; }
  if (format === 'claims' || format === 'efficiency') {
    // offline re-read of the stored trajectories (read-only; src/report/offline.ts)
    const off = await import('../report/offline.ts');
    const cfg = str(a.config);
    const s = off.runSettings(dir, cfg ? JSON.parse(readFileSync(resolve(cfg), 'utf8')) : undefined);
    if (format === 'claims') {
      const rows = off.claimsForRun(dir, s);
      process.stdout.write(a.json === true ? JSON.stringify(rows.map((r) => ({ row_id: r.row_id, case_id: r.case_id, surface: r.surface, trial: r.trial, status: r.status, claims_vs_ledger: r.report.unbacked.length ? 'fail' : 'pass', silent_actions: r.report.silent.length ? 'fail' : 'pass', claims: r.claims, silent: r.silent })), null, 2) + '\n' : off.renderClaims(rows));
    } else {
      const e = off.efficiencyForRun(dir, s);
      process.stdout.write(a.json === true ? JSON.stringify(e.byVariant, null, 2) + '\n' : e.markdown + '\n');
    }
    return 0;
  }
  const model = buildCardModel(dir);
  if (format === 'json') { process.stdout.write(JSON.stringify(model, null, 2) + '\n'); return 0; }
  if (!(CI_FORMATS as readonly string[]).includes(format)) throw new CliUsage(`unknown format ${format}`);
  const pr = await requirePrReport(format, root);
  const runUrl = str(a['run-url']);
  if (format === 'pr') process.stdout.write(pr.renderPrComment(model, { runUrl }) + '\n');
  else if (format === 'summary') process.stdout.write(pr.renderJobSummary(model, { runUrl }) + '\n');
  else if (format === 'junit') {
    const rows = readFileSync(join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    process.stdout.write(pr.renderJUnit(model, rows) + '\n');
  } else for (const l of pr.renderAnnotations(model)) process.stdout.write(l + '\n');
  return 0;
}
