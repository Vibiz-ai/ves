// `ves personas list | show <id>`: the project's persona library (<config dir>/personas/*.persona.json) and which
// suite cases use each person. Offline, $0: nothing is simulated. `show` prints the person and the pinned
// user-simulator prompt as the simulator would see it on turn 1 (with a placeholder goal when the person has none).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config/load.ts';
import { loadCaseDirs } from '../cases/load.ts';
import { loadPersonaLibrary, resolvePersona } from '../cases/personas.ts';
import { renderSimUser, USER_SIM_PROMPT_ID, USER_SIM_PROMPT_SHA256, USER_SIM_SYSTEM } from '../models/user-sim.ts';
import { simPersonaOf } from '../runner/persona-loop.ts';
import { type Args, CliUsage, str } from './args.ts';

const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));

export async function cmdPersonas(a: Args, env: Record<string, string | undefined>, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  const sub = a._[0] ?? 'list';
  const cfgPath = resolve(str(a.config) ?? 'ves.config.json');
  if (!existsSync(cfgPath)) throw new CliUsage(`no ${cfgPath}; pass --config <ves.config.json>`);
  const cfg = loadConfig(cfgPath, env);
  const lib = loadPersonaLibrary(join(cfg.dir, 'personas'), cfg.dir);
  const cases = loadCaseDirs(cfg.dir, cfg.suites).v2;
  const usedBy = (id: string) => cases.filter((c) => c.input.persona?.ref === id).map((c) => c.id);
  const inline = cases.filter((c) => c.input.persona && !c.input.persona.ref);
  if (sub === 'list') {
    const rows = [...lib.personas.values()].map(({ p, file }) => ({
      id: p.id, name: p.name ?? null, temperament: ([] as string[]).concat(p.temperament ?? []), languages: p.languages ?? [], file, cases: usedBy(p.id),
    }));
    if (a.json === true) { out(JSON.stringify({ dir: lib.dir, personas: rows, inline: inline.map((c) => ({ case: c.id, id: c.input.persona!.id })), errors: lib.errors }, null, 2) + '\n'); return lib.errors.length ? 3 : 0; }
    for (const e of lib.errors) process.stderr.write(`ERROR ${e}\n`);
    if (!rows.length) out(`no personas in ${lib.dir} (add personas/<id>.persona.json)\n`);
    else {
      out(`${pad('ID', 28)}${pad('NAME', 34)}${pad('TEMPERAMENT', 22)}${pad('LANG', 8)}CASES\n`);
      for (const r of rows) out(`${pad(r.id, 28)}${pad((r.name ?? '—').slice(0, 32), 34)}${pad(r.temperament.join(',') || '—', 22)}${pad(r.languages.join(',') || '—', 8)}${r.cases.length ? r.cases.join(', ') : '(unused)'}\n`);
    }
    if (inline.length) out(`${inline.length} case(s) with an inline persona: ${inline.map((c) => c.id).join(', ')}\n`);
    return lib.errors.length ? 3 : 0;
  }
  if (sub === 'show') {
    const id = a._[1];
    if (!id) throw new CliUsage('usage: ves personas show <id> [--config ves.config.json]');
    const hit = lib.personas.get(id);
    if (!hit) throw new CliUsage(`persona ${id} not found in ${lib.dir}`);
    const r = resolvePersona({ ref: id, ...(hit.p.goal ? {} : { goal: '(the goal comes from each case)' }) }, lib);
    if (!r.persona) throw new CliUsage(r.error ?? `persona ${id} does not resolve`);
    out(`${JSON.stringify(hit.p, null, 2)}\n\nused by: ${usedBy(id).join(', ') || '(no case)'}\n\n`);
    out(`--- ${USER_SIM_PROMPT_ID} (sha256 ${USER_SIM_PROMPT_SHA256.slice(0, 12)}), turn 1 ---\n[system]\n${USER_SIM_SYSTEM}\n\n[user]\n`);
    out(renderSimUser({ persona: simPersonaOf(r.persona), transcript: [], pending: 'none', chat_approval: true, turn_index: 0, max_turns: r.persona.max_user_turns }) + '\n');
    return 0;
  }
  throw new CliUsage('usage: ves personas list [--json] | show <id>   [--config ves.config.json]');
}
