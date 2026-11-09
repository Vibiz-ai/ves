// `ves cases from-trace` (src/cases/from-trace.ts): a real conversation -> a ves-case/2 regression case file.
// Offline and $0. Never overwrites without --force; the written case is schema-checked (case-2) and, when a config is
// available, checked against the catalog with the runner's own rules.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildCase, conversationFromRun, parseConversation, type TraceFormat } from '../cases/from-trace.ts';
import { schema } from '../cases/load.ts';
import { validate } from '../lib/jsonschema.ts';
import { loadConfig } from '../config/load.ts';
import { buildCatalog } from '../catalog/catalog.ts';
import { storedCatalog } from '../report/offline.ts';
import { checkRules2 } from '../runner/run-v2.ts';
import { CliUsage, type Args, str } from './args.ts';
import type { Catalog, LoadedCase2 } from '../core/types.ts';

const FORMATS: Record<string, TraceFormat> = { atif: 'atif', openai: 'openai', 'openai-chat': 'openai', otel: 'otel', 'otel-genai': 'otel' };

export async function cmdCases(a: Args, root: string, env: Record<string, string | undefined>, o: { out: (s: string) => void; err: (s: string) => void; now?: () => Date } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }): Promise<number> {
  const [sub, file] = a._;
  if (sub !== 'from-trace') throw new CliUsage('usage: ves cases from-trace <trace.json|events.jsonl> | --run <dir> --row <ref>  (ves cases --help)');
  const run = str(a.run), row = str(a.row);
  if (!file && !(run && row)) throw new CliUsage('ves cases from-trace needs a trace file, or --run <dir> --row <row_id|case@variant#trial>');
  if (file && run) throw new CliUsage('give a trace file or --run/--row, not both');
  const fmt = str(a.format);
  if (fmt && !FORMATS[fmt]) throw new CliUsage(`--format ${fmt}: expected atif | openai | otel`);
  const redact = a['no-redact'] !== true;
  const now = o.now?.() ?? new Date();

  // config (optional): the catalog for tool names, the suite dir for the default output, the reported-name settings
  const cfgPath = str(a.config) ?? (existsSync('ves.config.json') ? 'ves.config.json' : undefined);
  const cfg = cfgPath ? loadConfig(cfgPath, env) : null;
  let catalog: Catalog | null = cfg ? buildCatalog(cfg.tools.catalog, { gate_classes: cfg.tools.gate_classes }).catalog : null;
  const conv = run ? conversationFromRun(resolve(run), row!) : parseConversation(readFileSync(resolve(file!), 'utf8'), fmt ? FORMATS[fmt] : undefined);
  if (!catalog && run) catalog = storedCatalog(resolve(run));
  const names = { prefixes: cfg?.tools.reported_prefixes ?? [], aliases: cfg?.tools.reported_aliases ?? {} };

  const sourceRef = run ? `${resolve(run)}#${row}` : resolve(file!);
  const outArg = str(a.out);
  const outDir = outArg && !outArg.endsWith('.json') ? resolve(outArg) : outArg ? dirname(resolve(outArg)) : cfg?.suites[0] ?? resolve('.');
  // the id decides the file name; build once with a provisional path, then re-point the fixture at the final one
  const first = buildCase(conv, { id: str(a.id), owner: str(a.owner), redact, capturedAt: now.toISOString(), sourceRef, outFile: join(outDir, 'x.case.json'), catalog, names });
  const outFile = outArg?.endsWith('.json') ? resolve(outArg) : join(outDir, `${first.kase.id}.case.json`);
  const built = buildCase(conv, { id: first.kase.id, owner: str(a.owner), redact, capturedAt: now.toISOString(), sourceRef, outFile, catalog, names });

  const errs = validate(schema('case-2'), built.kase).map((e) => `case-2 ${e.path} ${e.message}`);
  if (catalog) {
    const loaded = Object.assign(structuredClone(built.kase), { __file: outFile, __sha256: '', __dir: outDir, __fixture_dirs: [] }) as LoadedCase2;
    errs.push(...checkRules2([loaded], catalog, JSON.parse(readFileSync(join(root, 'judges', 'registry.json'), 'utf8'))).filter((e) => !/twin/.test(e)));
  }
  if (errs.length) { for (const e of errs) o.err(`ERROR ${e}\n`); return 3; }
  if (existsSync(outFile) && a.force !== true) { o.err(`ERROR ${outFile} exists; pass --force to overwrite it\n`); return 3; }
  if (a['dry-run'] !== true) {
    if (!existsSync(dirname(outFile))) mkdirSync(dirname(outFile), { recursive: true });
    else if (!statSync(dirname(outFile)).isDirectory()) throw new CliUsage(`${dirname(outFile)} is not a directory`);
    writeFileSync(outFile, JSON.stringify(built.kase, null, 2) + '\n');
  }
  for (const w of built.warnings) o.err(`WARN  ${w}\n`);
  const summary = { file: outFile, id: built.kase.id, written: a['dry-run'] !== true, turns: built.kase.input.turns?.length ?? 0, expected_calls: (built.kase.expect.calls ?? []).map((c) => c.tool),
    gate_graders: (built.kase.graders ?? []).filter((g) => g.role === 'gate').map((g) => g.id), redacted: redact, redactions: built.redactions, warnings: built.warnings };
  if (a.json === true) o.out(JSON.stringify(summary, null, 2) + '\n');
  else o.out(`${summary.written ? 'wrote' : 'would write'} ${outFile}\n  ${summary.turns} turn(s); expect.calls (advisory): ${summary.expected_calls.join(', ') || 'none'}; gate: ${summary.gate_graders.join(', ')}; ${redact ? `${built.redactions} value(s) redacted` : 'NOT redacted'}\n  next: fill the reply_check TODO (mentions/forbid) and the oracle replies, then \`ves validate\`\n`);
  if (a['dry-run'] === true) o.out(JSON.stringify(built.kase, null, 2) + '\n');
  return 0;
}
