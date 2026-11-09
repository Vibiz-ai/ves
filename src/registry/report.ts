// PR/CI report formats (DESIGN-agnostic §5.4, §7.1 item 8): `pr | summary | junit | annotations` are delegated to
// src/report/pr/index.ts (the ci package). Absent -> "format X requires the ci package".
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_ROOT } from '../adapters/profiles.ts';
import { UsageError } from '../core/errors.ts';
import type { PrReportModule } from '../core/types.ts';

export const CI_FORMATS = ['pr', 'summary', 'junit', 'annotations'] as const;
export async function loadPrReport(root: string = HARNESS_ROOT): Promise<PrReportModule | null> {
  const f = join(root, 'src', 'report', 'pr', 'index.ts');
  if (!existsSync(f)) return null;
  const m = await import(pathToFileURL(f).href);
  for (const k of ['renderPrComment', 'renderJobSummary', 'renderJUnit', 'renderAnnotations']) if (typeof m[k] !== 'function') return null;
  return m as PrReportModule;
}
export async function requirePrReport(format: string, root?: string): Promise<PrReportModule> {
  const m = await loadPrReport(root);
  if (!m) throw new UsageError(`format ${format} requires the ci package (src/report/pr/index.ts)`);
  return m;
}
