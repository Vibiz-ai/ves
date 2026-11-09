// mcp-conformance pack module (DESIGN-agnostic §4.8): S0 for teams whose product is an MCP server. Model-free; runs
// only on variants with role "contract". It expands one case per check plus per-tool cases, all restricted to the
// config's contract variants, and registers the `mcp-conformance/*` graders.
//
// Two kinds of evidence:
//   * transcript checks (cases `requires: ["rpc"]`): the JSON-RPC exchanges the harness had with the server, reported
//     as `mcp.rpc` effects (see transcript.ts for the exact contract);
//   * call checks (no `requires`): proxied tool calls, the case oracle's `call` steps replayed by the contract
//     connector through HarnessIO.callTool. These are also what the MockAgent oracle replays in the baselines.
// Annotations never decide gating (VES-1 §8.2 G6): `annotations_consistent` only flags a read-only hint on a write.
// Not shipped: `official-conformance` (the pinned @modelcontextprotocol/conformance runner and Inspector CLI need
// npx and the network, which this build and its tests must not touch).
import { synthArgs } from '../../src/catalog/synth-args.ts';
import { nameOnVariant, selectTools } from '../../src/catalog/catalog.ts';
import { validate } from '../../src/lib/jsonschema.ts';
import { PACK_CLOCK as CLOCK, finishCase } from '../../src/cases/expand.ts';
import { listedTools, MAX_PAGES, transcriptOf, type RpcExchange } from './transcript.ts';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Case2, CatalogTool, ExpandCtx, GradeCtx2, GraderOut, GraderRegistration, PackModule } from '../../src/core/types.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
const tx = (x: GradeCtx2): RpcExchange[] => transcriptOf(x.c.sideEffects);
const ids = (x: GradeCtx2, pred: (e: RpcExchange) => boolean): string[] =>
  x.c.sideEffects.filter((e) => e.kind === 'mcp.rpc' && pred(e.args as RpcExchange)).map((e) => e.id);
const NO_TX: GraderOut = { pass: false, explanation: 'no MCP transcript recorded (the contract connector reports each exchange as an `mcp.rpc` effect); a check not run counts as not met' };
/** Name of the tool on this variant: params.names[variant] ?? params.tool. */
const nameFor = (x: GradeCtx2, p: Record<string, unknown>): string => ((p.names as Record<string, string> | undefined)?.[x.variant] ?? String(p.tool ?? ''));
const isRpcError = (e: RpcExchange): boolean => !!e.response?.error || e.response?.result?.isError === true || e.status >= 400;
const listed = (x: GradeCtx2, p: Record<string, unknown>): { tool: any | null; out?: GraderOut } => {
  const t = tx(x);
  if (!t.length) return { tool: null, out: NO_TX };
  const name = nameFor(x, p);
  const l = listedTools(t);
  if (!l.pages.length) return { tool: null, out: { pass: false, explanation: 'tools/list was never answered' } };
  const tool = l.tools.find((y) => y?.name === name);
  return tool ? { tool } : { tool: null, out: { pass: false, explanation: `${name} is not in tools/list (${l.tools.length} tools listed)` } };
};
/** A coarse, value-free shape of a result (keys and types), for idempotence. */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 8) return '…';
  if (Array.isArray(v)) return v.length ? ['array', [...new Set(v.map((x) => JSON.stringify(shapeOf(x, depth + 1))))].sort()] : ['array'];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k], depth + 1)]));
  return v === null ? 'null' : typeof v;
}

const G: Record<string, (x: GradeCtx2, p: Record<string, unknown>) => GraderOut> = {
  handshake: (x) => {
    const t = tx(x);
    if (!t.length) return NO_TX;
    const init = t.find((e) => e.method === 'initialize');
    const note = t.find((e) => e.method === 'notifications/initialized');
    const r = init?.response?.result;
    const bad: string[] = [];
    if (!init) bad.push('initialize was not sent');
    else if (!r) bad.push(`initialize failed (${init.response?.error?.message ?? `http ${init.status}`})`);
    else {
      if (typeof r.protocolVersion !== 'string') bad.push('initialize result has no protocolVersion');
      if (!r.capabilities || typeof r.capabilities !== 'object') bad.push('initialize result has no capabilities');
      if (!r.serverInfo || typeof r.serverInfo.name !== 'string') bad.push('initialize result has no serverInfo.name');
    }
    if (!note) bad.push('notifications/initialized was not sent');
    else if (note.status >= 400) bad.push(`notifications/initialized answered http ${note.status}`);
    return { pass: !bad.length, explanation: bad.length ? bad.join('; ') : `protocol ${r.protocolVersion} negotiated with ${r.serverInfo.name}`, evidence: ids(x, (e) => e.method === 'initialize' || e.method === 'notifications/initialized') };
  },
  tools_list_paging: (x) => {
    const t = tx(x);
    if (!t.length) return NO_TX;
    const l = listedTools(t);
    const bad: string[] = [];
    if (!l.pages.length) bad.push('tools/list was never answered');
    if (l.pages.some((p) => !Array.isArray(p.response?.result?.tools))) bad.push('a tools/list page has no tools array');
    if (l.pages.length && !l.terminated) bad.push(`cursor paging did not terminate within ${MAX_PAGES} pages`);
    const names = l.tools.map((y) => y?.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) bad.push(`duplicate tool names: ${[...new Set(dup)].join(', ')}`);
    return { pass: !bad.length, explanation: bad.length ? bad.join('; ') : `${l.tools.length} tools in ${l.pages.length} page(s), names unique`, evidence: ids(x, (e) => e.method === 'tools/list') };
  },
  tool_schema_valid: (x, p) => {
    const { tool, out } = listed(x, p);
    if (!tool) return out!;
    const s = tool.inputSchema;
    const bad: string[] = [];
    if (!s || typeof s !== 'object' || Array.isArray(s)) bad.push('inputSchema is not a JSON object');
    else {
      if (s.type !== 'object') bad.push(`inputSchema.type is ${JSON.stringify(s.type)}, not "object"`);
      if (s.properties !== undefined && (typeof s.properties !== 'object' || Array.isArray(s.properties))) bad.push('inputSchema.properties is not an object');
      if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r: unknown) => typeof r !== 'string'))) bad.push('inputSchema.required is not a string array');
      try { validate(s, {}); } catch (e) { bad.push(`inputSchema is not usable: ${(e as Error).message}`); }
    }
    return { pass: !bad.length, explanation: bad.length ? `${tool.name}: ${bad.join('; ')}` : `${tool.name}: inputSchema is a valid object schema` };
  },
  tool_description: (x, p) => {
    const { tool, out } = listed(x, p);
    if (!tool) return out!;
    const ok = typeof tool.description === 'string' && tool.description.trim().length > 0;
    return { pass: ok, explanation: ok ? `${tool.name}: has a description` : `${tool.name}: no description (models choose tools by it)` };
  },
  annotations_consistent: (x, p) => {
    const { tool, out } = listed(x, p);
    if (!tool) return out!;
    const cat = x.catalog.byName[String(p.tool ?? '')];
    if (!cat) return { pass: null, error: true, explanation: `${String(p.tool)} is not in the catalog` };
    const ro = tool.annotations?.readOnlyHint === true;
    const isWrite = !cat.classes.includes('read');
    if (ro && isWrite) return { pass: false, explanation: `${tool.name}: readOnlyHint true, but the catalog classes it as ${cat.classes.join('+')} (a host may auto-run it without asking)` };
    return { pass: true, explanation: `${tool.name}: annotations do not contradict the catalog (${cat.classes.join('+')})` };
  },
  destructive_hint: (x, p) => {
    const { tool, out } = listed(x, p);
    if (!tool) return out!;
    const cat = x.catalog.byName[String(p.tool ?? '')];
    if (!cat?.classes.includes('destructive')) return { pass: true, explanation: `${tool.name}: not destructive in the catalog` };
    const ok = tool.annotations?.destructiveHint === true;
    return { pass: ok, explanation: ok ? `${tool.name}: destructiveHint set` : `${tool.name}: destructive in the catalog but destructiveHint is absent` };
  },
  unknown_tool: (x, p) => {
    const t = tx(x);
    if (!t.length) return NO_TX;
    const name = String(p.name ?? '');
    const c = t.filter((e) => e.method === 'tools/call' && e.params?.name === name);
    if (!c.length) return { pass: false, explanation: `tools/call ${name} was not sent` };
    const ok = c.every(isRpcError);
    return { pass: ok, explanation: ok ? `unknown tool ${name} answered with an error` : `unknown tool ${name} answered as a success`, evidence: ids(x, (e) => e.method === 'tools/call' && e.params?.name === name) };
  },
  invalid_args: (x, p) => {
    const t = tx(x);
    if (!t.length) return NO_TX;
    const name = nameFor(x, p);
    const c = t.filter((e) => e.method === 'tools/call' && e.params?.name === name);
    if (!c.length) return { pass: false, explanation: `tools/call ${name} with missing required args was not sent` };
    const ok = c.every(isRpcError);
    return { pass: ok, explanation: ok ? `${name}: missing required args rejected` : `${name}: a call with missing required args succeeded`, evidence: ids(x, (e) => e.method === 'tools/call' && e.params?.name === name) };
  },
  read_idempotent: (x, p) => {
    const tool = String(p.tool ?? '');
    const calls = x.c.serverCalls.filter((c) => c.call_source === 'server' && c.canonical === tool);
    if (calls.length < 2) return { pass: false, explanation: `${tool} was called ${calls.length}× (needs 2 identical calls)`, evidence: calls.map((c) => c.id) };
    const shapes = calls.map((c) => JSON.stringify([c.result.ok, shapeOf(c.result.body)]));
    const ok = shapes.every((s) => s === shapes[0]);
    return { pass: ok, explanation: ok ? `${calls.length} identical calls of ${tool} gave the same result shape` : `${tool}: identical calls gave different result shapes`, evidence: calls.map((c) => c.id) };
  },
  gated_without_approval: (x, p) => {
    const tool = String(p.tool ?? '');
    const calls = x.c.serverCalls.filter((c) => c.call_source === 'server' && c.canonical === tool);
    if (!calls.length) return { pass: false, explanation: `${tool} was not called without approval, so the guard was not exercised` };
    const executed = calls.filter((c) => c.result.ok && !c.guard_fired);
    const writes = x.c.upstreamWrites.filter((w) => w.canonical === tool);
    const ok = !executed.length && !writes.length;
    return { pass: ok, explanation: ok ? `${tool}: refused without approval (${calls.map((c) => (c.guard_fired ? 'guard' : c.result.error ?? 'error')).join(', ')})` : `${tool}: executed without approval (${executed.length} ok call(s), ${writes.length} upstream write(s))`, evidence: [...calls.map((c) => c.id), ...writes.map((w) => w.id)] };
  },
  structured_output: (x, p) => {
    const tool = String(p.tool ?? '');
    const schema = x.catalog.byName[tool]?.output_schema;
    if (!schema || typeof schema !== 'object') return { pass: null, error: true, explanation: `${tool} has no output_schema in the catalog` };
    const calls = x.c.serverCalls.filter((c) => c.call_source === 'server' && c.canonical === tool && c.result.ok);
    if (!calls.length) return { pass: false, explanation: `${tool} returned no successful result to validate` };
    const bad = calls.flatMap((c) => validate(schema as Record<string, unknown>, c.result.body).map((e) => `${e.path} ${e.message}`));
    return { pass: !bad.length, explanation: bad.length ? `${tool}: structured output violates output_schema: ${bad.slice(0, 5).join('; ')}` : `${tool}: ${calls.length} result(s) validate against output_schema`, evidence: calls.map((c) => c.id) };
  },
};
export const GRADERS: GraderRegistration[] = Object.entries(G).map(([n, grade]) => ({ id: `mcp-conformance/${n}` as const, version: '1.0.0', kind: 'code' as const, grade }));

/** Expansion: one case per protocol check, per-tool cases, all on the contract variants only. */
export function expandConformance(ctx: ExpandCtx): Case2[] {
  const variants = Object.values(ctx.config.variants).filter((v) => v.role === 'contract').map((v) => v.name).sort();
  if (!variants.length) return [];
  const out: Case2[] = [];
  const names = (t: CatalogTool) => Object.fromEntries(variants.map((v) => [v, nameOnVariant(ctx.catalog, t.name, v)]));
  const g = (id: string, params?: Record<string, unknown>, role: 'gate' | 'advisory' = 'gate') => ({ id: `mcp-conformance/${id}`, role, ...(params ? { params } : {}) });
  const add = (template: string, tool: CatalogTool | null, body: Record<string, unknown>) => {
    const bs = tool ? [{ key: 'tool', tool }] : [];
    const seed = ctx.seedOf([ctx.pack.id, template, bs.map((b) => `${b.key}=${b.tool.name}`).join(',')]);
    out.push(finishCase({ manifest: ctx.pack, dir: DIR }, ctx, { template, version: 1, file: `pack.ts#${template}`, bindings: bs, body: {
      capability: `mcp.${template.replace(/-/g, '_')}`, tags: ['mcp-conformance'], variants, ...body,
      fixture: { seed, clock: CLOCK, ...((body.fixture as object) ?? {}) },
      oracle: body.oracle ?? { kind: 'scripted', steps: [] },
    } }));
  };
  const listTurn = { rpc: { method: 'tools/list' } };
  add('handshake', null, { requires: ['rpc'], input: { turns: [{ rpc: { method: 'ping' } }] }, expect: { calls: [] }, graders: [g('handshake')] });
  add('tools-list-paging', null, { requires: ['rpc'], input: { turns: [listTurn] }, expect: { calls: [] }, graders: [g('tools_list_paging')] });
  const unknown = `ves_no_such_tool_${ctx.canary(ctx.seedOf([ctx.pack.id, 'unknown-tool']), 1).slice(-10)}`;
  add('unknown-tool', null, { requires: ['rpc'], input: { turns: [{ rpc: { method: 'tools/call', params: { name: unknown, arguments: {} } } }] }, expect: { calls: [] }, graders: [g('unknown_tool', { name: unknown })] });
  for (const t of ctx.catalog.tools) {
    add('tool-schema-valid', t, { requires: ['rpc'], input: { turns: [listTurn] }, expect: { calls: [] }, graders: [g('tool_schema_valid', { tool: t.name, names: names(t) }), g('tool_description', { tool: t.name, names: names(t) }, 'advisory')] });
    add('annotations-consistent', t, { requires: ['rpc'], input: { turns: [listTurn] }, expect: { calls: [] }, graders: [g('annotations_consistent', { tool: t.name, names: names(t) }), g('destructive_hint', { tool: t.name, names: names(t) }, 'advisory')] });
  }
  for (const t of selectTools(ctx.catalog, { has_required_args: true })) {
    // One rpc per contract variant name (aliases can differ per variant); each grader looks up its own variant's name.
    const turns = [...new Set(Object.values(names(t)))].map((n) => ({ rpc: { method: 'tools/call', params: { name: n, arguments: {} } } }));
    add('invalid-args', t, { requires: ['rpc'], input: { turns }, expect: { calls: [] }, graders: [g('invalid_args', { tool: t.name, names: names(t) })] });
  }
  const argsOf = (t: CatalogTool) => t.examples?.[0]?.args ?? synthArgs(t.input_schema, ctx.seedOf([ctx.pack.id, 'args', t.name]), { clock: CLOCK });
  for (const t of selectTools(ctx.catalog, { classes_any: ['read'] })) {
    const args = argsOf(t);
    if (!args) continue;
    add('read-idempotent', t, { input: { turns: [{ say: `Call ${t.name} twice with the same arguments.` }] }, expect: { calls: [{ tool: t.name, min: 2 }] },
      graders: [g('read_idempotent', { tool: t.name }), { id: 'call_match', role: 'gate' }],
      oracle: { kind: 'scripted', steps: [{ call: t.name, args }, { call: t.name, args }, { reply: 'Both calls returned.' }] } });
  }
  for (const t of selectTools(ctx.catalog, { gated: true })) {
    const args = argsOf(t);
    if (!args) continue;
    add('gated-without-approval', t, { input: { turns: [{ say: `Call ${t.name} without any approval.` }] }, expect: { calls: [{ tool: t.name, min: 1 }] },
      fixture: { tool_overrides: { [t.name]: { fail_always: { error: 'approval_required' } } } },
      graders: [g('gated_without_approval', { tool: t.name }), { id: 'call_match', role: 'gate' }],
      oracle: { kind: 'scripted', steps: [{ call: t.name, args }, { reply: 'The server refused, as it should.' }] } });
  }
  for (const t of selectTools(ctx.catalog, { gated: false }).filter((x) => x.output_schema && typeof x.output_schema === 'object')) {
    const args = argsOf(t);
    const sample = synthArgs(t.output_schema, ctx.seedOf([ctx.pack.id, 'output', t.name]), { clock: CLOCK });
    if (!args || !sample) continue;
    add('structured-output', t, { input: { turns: [{ say: `Call ${t.name} once.` }] }, expect: { calls: [{ tool: t.name, min: 1 }] },
      fixture: { tool_overrides: { [t.name]: { returns: sample } } },
      graders: [g('structured_output', { tool: t.name }), { id: 'call_match', role: 'gate' }],
      oracle: { kind: 'scripted', steps: [{ call: t.name, args }, { reply: 'It returned.' }] } });
  }
  return out;
}

const mod: PackModule = { graders: GRADERS, expand: expandConformance };
export default mod;
