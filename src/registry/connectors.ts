// Connector discovery (DESIGN-agnostic §7.1 item 8). Every directory under src/connectors/ whose name does not start
// with "_" or "." and that has an index.ts is imported; its `default` export must be a ConnectorFactory. The mock
// connector is built into core. Duplicate kinds are a startup error. Nobody edits a shared file to add a connector.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_ROOT } from '../adapters/profiles.ts';
import { mockFactory } from '../core/mock-agent.ts';
import { HarnessError, UsageError } from '../core/errors.ts';
import type { ConnectionConfig, ConnectionKind, Connector, ConnectorDeps, ConnectorFactory } from '../core/types.ts';

export type ConnectorRegistry = { factories: Map<string, ConnectorFactory>; sources: Record<string, string> };
let cached: Promise<ConnectorRegistry> | null = null;

export async function loadConnectors(root: string = HARNESS_ROOT, fresh = false): Promise<ConnectorRegistry> {
  if (cached && !fresh && root === HARNESS_ROOT) return cached;
  const p = (async () => {
    const factories = new Map<string, ConnectorFactory>([['mock', mockFactory]]);
    const sources: Record<string, string> = { mock: 'src/core/mock-agent.ts' };
    const dir = join(root, 'src', 'connectors');
    if (!existsSync(dir)) return { factories, sources };
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('_') || name.startsWith('.')) continue;
      const d = join(dir, name);
      if (!statSync(d).isDirectory() || !existsSync(join(d, 'index.ts'))) continue;
      const mod = await import(pathToFileURL(join(d, 'index.ts')).href);
      const f = mod.default as ConnectorFactory | undefined;
      if (!f || typeof f.create !== 'function' || typeof f.kind !== 'string' || typeof f.version !== 'string') throw new HarnessError(`src/connectors/${name}/index.ts must default-export a ConnectorFactory {kind, version, create}`);
      if (factories.has(f.kind)) throw new HarnessError(`duplicate connector kind ${f.kind} (src/connectors/${name} and ${sources[f.kind]})`);
      factories.set(f.kind, f);
      sources[f.kind] = `src/connectors/${name}/index.ts`;
    }
    return { factories, sources };
  })();
  if (root === HARNESS_ROOT) cached = p;
  return p;
}

export async function createConnector(cfg: ConnectionConfig, deps: ConnectorDeps, reg?: ConnectorRegistry): Promise<Connector> {
  const r = reg ?? (await loadConnectors());
  const f = r.factories.get(cfg.type as ConnectionKind);
  if (!f) throw new UsageError(`connector ${cfg.type} not installed (installed: ${[...r.factories.keys()].join(', ')})`);
  return f.create(cfg, deps);
}
