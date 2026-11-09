// Per-surface profile used by the v1 mock adapter, the baselines and the stubs: capabilities, approval channel,
// host family and the delivery formatter stand-in. The DATA now lives in the Vibiz pack (packs/vibiz/profile.json,
// DESIGN-agnostic §4.9); only the formatter implementations stay here because they are code.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityFlag, HostFamily } from '../types.ts';
import type { ApprovalMode } from '../sim/sim.ts';

export type Formatter = (t: string) => { parts: string[]; cards: number };
export type SurfaceProfile = {
  family: 'vibiz-agent' | 'tool-surface' | 'contract';
  caps: CapabilityFlag[];
  approval: ApprovalMode;
  host: HostFamily;
  clientInfo?: string;
  views?: boolean;
  formatter: Formatter;
  /** Real code the surface drives (for routesHash in real adapters; documentation for mock/stubs). */
  routes: string[];
  modelInLoop: boolean;
};

/** The harness checkout root (where src/, schemas/ and packs/ live). */
export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** packs/vibiz relative to a harness root. */
export const vibizPackDir = (root: string = HARNESS_ROOT): string => join(root, 'packs', 'vibiz');

export type VibizProfileFile = {
  schema_version: 'ves-profile/1'; id: 'vibiz'; fixture_root: string; catalog: string;
  suites: Record<string, string[]>; deploy_targets: string[];
  gate: { safety_observation: 'ledger' | 'proxied' }; harness: { require_commit_sha: boolean };
  class_map: Record<string, { classes: string[]; gated?: boolean }>;
  plant_locations: Record<string, string>; principal_map: Record<string, string>; explicit_only: string[];
  variants: Record<string, Omit<SurfaceProfile, 'formatter'> & { formatter: string }>;
  auto_expand: Record<string, Record<string, string[]>>; mcp_real: string[];
  change_classes: Record<'1' | '2', string[]>; surfaces_for: { re: string; surfaces: string[] }[];
  stub_plans: Record<string, string>;
};
export const VIBIZ_PROFILE: VibizProfileFile = JSON.parse(readFileSync(join(vibizPackDir(), 'profile.json'), 'utf8'));
/** v1 fixture root (sim orgs, plants, tenant entity lists) for a harness root. */
export const vibizFixtureRoot = (root: string = HARNESS_ROOT): string => join(vibizPackDir(root), VIBIZ_PROFILE.fixture_root);
/** v1 canonical-id catalog (byte copy of the old canonical-ids.json). */
export const vibizCatalogPath = (root: string = HARNESS_ROOT): string => join(vibizPackDir(root), VIBIZ_PROFILE.catalog);

const plain: Formatter = (t) => ({ parts: [t], cards: /\[card:/.test(t) ? 1 : 0 });
/** Stand-in for a Slack mrkdwn formatter: **bold** -> *bold*, [x](u) -> <u|x>. Not the real formatter. */
const slack: Formatter = (t) => ({ parts: [t.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')], cards: 0 });
/** Stand-in for a chat reply splitter (iMessage/WhatsApp): split on blank lines, cap 1000 chars a part. */
const split = (cap: number): Formatter => (t) => {
  const parts: string[] = [];
  for (const para of t.replace(/\*\*(.+?)\*\*/g, '*$1*').split(/\n{2,}/)) {
    for (let i = 0; i < para.length; i += cap) parts.push(para.slice(i, i + cap));
  }
  return { parts: parts.length ? parts : [''], cards: 0 };
};
export const FORMATTERS: Record<string, Formatter> = { plain, 'slack-mrkdwn': slack, 'split-1000': split(1000) };

export const PROFILES: Record<string, SurfaceProfile> = Object.fromEntries(Object.entries(VIBIZ_PROFILE.variants).map(([id, v]) => {
  const f = FORMATTERS[v.formatter];
  if (!f) throw new Error(`packs/vibiz/profile.json: variant ${id} names unknown formatter ${v.formatter}`);
  return [id, { ...v, formatter: f }];
}));
export const KNOWN_SURFACES = Object.keys(PROFILES);
export function profileOf(surface: string): SurfaceProfile {
  const p = PROFILES[surface];
  if (!p) throw new Error(`unknown surface ${surface}; known: ${KNOWN_SURFACES.join(', ')}`);
  return p;
}
