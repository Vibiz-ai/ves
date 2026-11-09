import type { CanonicalMap } from '../lib/canonical.ts';
import type { SurfaceAdapter } from '../types.ts';
import { MockAdapter, type MockBehaviour, type MockFaults } from './mock.ts';
import { McpContractAdapter, type FetchLike } from './mcp.ts';
import { StubAdapter } from './stubs.ts';
import { profileOf, VIBIZ_PROFILE } from './profiles.ts';

export type AdapterMode = 'mock' | 'real';
const MCP_REAL = new Set(VIBIZ_PROFILE.mcp_real);

export function createAdapter(surface: string, mode: AdapterMode, o: {
  repoRoot: string; canonical: CanonicalMap; behaviour?: MockBehaviour; faults?: MockFaults; env?: Record<string, string | undefined>; fetch?: FetchLike;
}): SurfaceAdapter {
  profileOf(surface); // throws on unknown surface ids
  if (mode === 'mock') return new MockAdapter({ surface, behaviour: o.behaviour, faults: o.faults, repoRoot: o.repoRoot, canonical: o.canonical });
  if (MCP_REAL.has(surface)) return new McpContractAdapter({ surface, canonical: o.canonical, env: o.env, fetch: o.fetch });
  return new StubAdapter(surface);
}
