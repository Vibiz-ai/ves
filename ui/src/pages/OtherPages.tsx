import { useMemo, type ReactNode } from 'react';
import { IconListCheck, IconPackage, IconDevices, IconShieldCheck, IconAdjustments, IconPlugConnected, IconBrandGithub, IconBook, IconSearch } from '@tabler/icons-react';
import { useAppData } from '../lib/data.tsx';
import { useApi } from '../lib/api.ts';
import type { RunDetail } from '../lib/types.ts';
import { navigate, type Route } from '../lib/router.ts';
import { ruleId } from '../lib/shape.ts';
import { DASH, show } from '../lib/format.ts';
import type { CaseInfo } from '../lib/types.ts';
import { Badge, Chip, CommandBlock, EmptyState, ErrorState, ICON, PageHeader, Section, Skeleton, Tile, cx } from '../components/ui.tsx';

function Loading() {
  return <div aria-busy="true" className="grid grid-cols-1 gap-4 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
}

function Table({ head, children, minW = 720 }: { head: string[]; children: ReactNode; minW?: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-[14px]" style={{ minWidth: minW }}>
        <thead><tr className="bg-tile text-left">{head.map((h) => <th key={h} scope="col" className="px-4 py-3 font-mono text-[11px] font-medium tracking-[0.06em] text-muted uppercase">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ---- Cases -----------------------------------------------------------------------------------------

export function CasesPage({ route }: { route: Route }) {
  const { cases } = useAppData();
  const q = route.query.get('q') ?? '';
  const suite = route.query.get('suite') ?? 'all';
  const all = cases.data?.cases ?? [];
  const suites = useMemo(() => [...new Set(all.map((c) => c.suite ?? '—'))].sort(), [all]);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(route.query);
    if (!v || v === 'all') p.delete(k); else p.set(k, v);
    navigate(`#/cases${p.toString() ? `?${p}` : ''}`);
  };
  const shown = all.filter((c) => (suite === 'all' || (c.suite ?? '—') === suite) && (!q || `${c.id} ${c.capability} ${c.tags.join(' ')} ${c.safety_suite}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      <PageHeader title="Cases" sub={cases.data ? <>Read from <span className="font-mono text-[13px] text-ink">{cases.data.roots_checked.join(', ')}</span></> : undefined} />
      {cases.error && <ErrorState title="Could not read case files" error={cases.error.message} onRetry={cases.reload} />}
      {!cases.data && !cases.error && <Loading />}
      {cases.data && all.length === 0 && <EmptyState icon={<IconListCheck {...ICON} />} title="No case files found" body={<>Case files (<span className="font-mono text-[13px]">*.case.json</span>) live under <span className="font-mono text-[13px]">packs/&lt;pack&gt;/cases</span> or <span className="font-mono text-[13px]">cases/</span>. Scaffold one with:</>} command="npx ves init" />}
      {all.length > 0 && (
        <>
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="flex h-11 w-full items-center gap-3 rounded-md bg-tile px-4 sm:max-w-sm">
              <IconSearch size={18} stroke={1.75} className="text-muted" aria-hidden />
              <span className="sr-only">Filter cases</span>
              <input value={q} onChange={(e) => set('q', e.target.value)} placeholder="Filter by id, capability, tag" className="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint" />
            </label>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label="Filter by suite">
              <Chip active={suite === 'all'} count={all.length} onClick={() => set('suite', 'all')}>All</Chip>
              {suites.map((s) => <Chip key={s} active={suite === s} count={all.filter((c) => (c.suite ?? '—') === s).length} onClick={() => set('suite', s)}>{s}</Chip>)}
            </div>
          </div>
          {shown.length === 0 ? <EmptyState title="No case matches" body={<>Nothing matches “{q}”. <button type="button" className="underline underline-offset-2" onClick={() => navigate('#/cases')}>Clear filters</button>.</>} /> : (
            <Table head={['Case', 'Suite', 'Capability', 'Surfaces', 'Graders', 'Provenance']} minW={980}>
              {shown.map((c) => <CaseRow key={`${c.file}`} c={c} />)}
            </Table>
          )}
          {cases.data && cases.data.errors.length > 0 && <p className="mt-3 font-mono text-[12px] text-block">{cases.data.errors.length} file(s) could not be parsed: {cases.data.errors.slice(0, 3).join('; ')}</p>}
        </>
      )}
    </>
  );
}

function CaseRow({ c }: { c: CaseInfo }) {
  return (
    <tr className="border-t border-line align-top">
      <th scope="row" className="px-4 py-3 text-left font-normal">
        <div className="font-mono text-[13px] font-medium">{c.id}</div>
        <div className="mt-0.5 font-mono text-[11px] text-faint">v{show(c.version)} · {c.file}</div>
      </th>
      <td className="px-4 py-3"><div className="font-mono text-[13px]">{show(c.suite)}</div>{c.safety_suite && <div className="font-mono text-[11px] text-muted">{c.safety_suite}</div>}</td>
      <td className="px-4 py-3 font-mono text-[13px]">{show(c.capability)}</td>
      <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{c.surfaces.length ? c.surfaces.map((s) => <Badge key={s}>{s}</Badge>) : DASH}</div>{c.requires.length > 0 && <div className="mt-1 font-mono text-[11px] text-muted">requires {c.requires.join(', ')}</div>}</td>
      <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{c.graders.length ? c.graders.map((g) => <Badge key={g.id} tone={g.role === 'gate' ? 'dark' : 'neutral'} title={g.role ?? undefined}>{g.id}</Badge>) : DASH}</div></td>
      <td className="max-w-[260px] px-4 py-3 text-[13px]"><div className="font-mono">{show(c.provenance?.source)}</div>{c.provenance?.source_ref && <div className="mt-0.5 truncate text-muted" title={c.provenance.source_ref}>{c.provenance.source_ref}</div>}</td>
    </tr>
  );
}

// ---- Packs -----------------------------------------------------------------------------------------

export function PacksPage() {
  const { cases } = useAppData();
  const packs = cases.data?.packs ?? [];
  return (
    <>
      <PageHeader title="Packs" />
      {cases.error && <ErrorState title="Could not read packs" error={cases.error.message} onRetry={cases.reload} />}
      {!cases.data && !cases.error && <Loading />}
      {cases.data && packs.length === 0 && <EmptyState icon={<IconPackage {...ICON} />} title="No packs installed" body="A pack bundles cases, fixtures and a tool catalog for one domain (hitl-approval, prompt-injection, data-isolation…). Packs live in packs/<id>/. List the preconfigured ones with:" command="npx ves packs list" />}
      {packs.length > 0 && (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {packs.map((p) => {
            const pc = cases.data!.cases.filter((c) => c.pack === p.id);
            const bySuite = pc.reduce<Record<string, number>>((a, c) => { const k = c.suite ?? '—'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
            return (
              <article key={p.id} className="rounded-lg border border-line bg-sheet shadow-card">
                <div className="flex aspect-[4/3] flex-col justify-between rounded-lg bg-sheet p-6 sm:p-7">
                  <span className="mono-label">{p.schema_version ?? 'pack'}</span>
                  <div className="flex flex-wrap gap-x-8 gap-y-3">
                    {Object.entries(bySuite).map(([s, n]) => (
                      <div key={s}><div className="font-mono text-[40px] leading-none tabular-nums">{n < 10 ? `0${n}` : n}</div><div className="mono-label mt-1">{s} cases</div></div>
                    ))}
                  </div>
                  <p className="line-clamp-3 text-[13px] text-muted">{p.description ?? DASH}</p>
                </div>
                <div className="flex items-end justify-between gap-3 px-3 pt-4 pb-2">
                  <div className="min-w-0">
                    <h2 className="text-[26px] leading-tight font-semibold tracking-[-0.015em]"><a href={`#/cases?q=`} onClick={(e) => { e.preventDefault(); navigate(`#/cases`); }} className="hover:underline">{p.id}</a></h2>
                    <p className="mt-1 truncate font-mono text-[13px] text-muted">{p.dir}</p>
                  </div>
                  <span className="flex shrink-0 items-center gap-1.5 font-mono text-[13px] text-muted"><IconDevices size={18} stroke={1.75} aria-hidden />{p.variants.length}<span className="sr-only">variants</span></span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---- Surfaces / variants ---------------------------------------------------------------------------

export function SurfacesPage() {
  const { config, runs } = useAppData();
  const profiles = config.data?.profiles ?? [];
  const latest = runs.data?.runs[0];
  const variants = profiles.flatMap((p) => Object.entries(p.variants).map(([name, v]) => ({ pack: p.id, name, ...v })));
  const configVariants = config.data?.config?.variants ? Object.keys(config.data.config.variants) : [];
  return (
    <>
      <PageHeader title="Surfaces" sub="Variants an agent is evaluated on. Results are never pooled across them." />
      {config.error && <ErrorState title="Could not read profiles" error={config.error.message} onRetry={config.reload} />}
      {!config.data && !config.error && <Loading />}
      {config.data && variants.length === 0 && configVariants.length === 0 && (
        <EmptyState icon={<IconDevices {...ICON} />} title="No surfaces defined" body="Surfaces (variants) come from ves.config.json `variants` or a pack profile. `ves init` writes a default variant for your agent:" command="npx ves init" />
      )}
      {variants.length > 0 && (
        <Table head={['Surface', 'Family', 'Approval', 'Host', 'Capabilities', 'In latest run']} minW={900}>
          {variants.map((v) => (
            <tr key={`${v.pack}:${v.name}`} className="border-t border-line align-top">
              <th scope="row" className="px-4 py-3 text-left font-mono text-[13px] font-medium">{v.name}<div className="font-mono text-[11px] font-normal text-faint">{v.pack}</div></th>
              <td className="px-4 py-3 font-mono text-[13px]">{show(v.family)}</td>
              <td className="px-4 py-3 font-mono text-[13px]">{show(v.approval)}</td>
              <td className="px-4 py-3 font-mono text-[13px]">{show(v.host)}</td>
              <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{(v.caps ?? []).map((c) => <Badge key={c}>{c}</Badge>)}</div></td>
              <td className="px-4 py-3 font-mono text-[13px]">{latest ? (latest.surfaces.includes(v.name) ? 'yes' : 'no') : DASH}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

// ---- Settings ----------------------------------------------------------------------------------------

export function GateRulesPage() {
  const { runs } = useAppData();
  const latest = runs.data?.runs[0];
  return (
    <>
      <PageHeader title="Gate rules" sub="The deploy gate evaluates G-1…G-12 in order; the first blocking rule decides the verdict (STANDARD §7.2)." />
      {!runs.data && !runs.error && <Loading />}
      {runs.data && !latest && <EmptyState icon={<IconShieldCheck {...ICON} />} title="No gate evaluated yet" body="Each run writes gate.json with every rule's status and evidence. Run the gate once to see them here:" command="npx ves run --tier smoke --connection mock --out results" />}
      {latest && <GateRulesFromRun runId={latest.id} />}
    </>
  );
}

function GateRulesFromRun({ runId }: { runId: string }) {
  const d = useApi<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
  if (d.error) return <ErrorState title="Could not read gate.json" error={d.error.message} />;
  if (!d.data) return <Loading />;
  const rules = d.data.gate?.rules ?? [];
  return (
    <>
      <p className="mb-4 font-mono text-[13px] text-muted">From the latest run: <a className="text-ink underline underline-offset-2" href={`#/runs/${encodeURIComponent(runId)}`}>{runId}</a></p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {rules.map((r, i) => {
          const { id, name } = ruleId(r.rule);
          return (
            <Tile key={i}>
              <div className="flex items-start justify-between gap-3">
                <div><div className="font-mono text-[13px] font-semibold">{id || r.rule}</div><div className="text-[20px] font-semibold tracking-[-0.01em]">{name || r.rule}</div></div>
                <span className={cx('font-mono text-[12px] tracking-[0.06em] uppercase', r.status === 'clear' ? 'text-pass' : r.status === 'not_evaluated' ? 'text-muted' : 'text-block')}>{(r.status ?? DASH).replace(/_/g, ' ')}</span>
              </div>
              <p className="mt-2 text-[14px] text-muted">{r.detail ?? DASH}</p>
            </Tile>
          );
        })}
      </div>
    </>
  );
}

export function ModelsPage() {
  const { config, runs } = useAppData();
  const models = config.data?.config?.models as Record<string, { provider?: string; model?: string; project?: string; location?: string }> | undefined;
  const list = runs.data?.runs ?? [];
  const judge = [...new Set(list.map((r) => r.judge_model ?? 'none'))];
  const sim = [...new Set(list.map((r) => r.user_sim_model ?? 'none'))];
  const agent = [...new Set(list.flatMap((r) => r.agent_models))];
  return (
    <>
      <PageHeader title="Models" sub="Harness-side models: judge, user simulator, MCP host-sim and intent writer. Your agent's own model is not configured here." />
      {!config.data && !config.error && <Loading />}
      {config.error && <ErrorState title="Could not read ves.config.json" error={config.error.message} />}
      {config.data && (
        models && Object.keys(models).length ? (
          <Table head={['Role', 'Provider', 'Model', 'Project', 'Location']}>
            {Object.entries(models).map(([role, m]) => (
              <tr key={role} className="border-t border-line">
                <th scope="row" className="px-4 py-3 text-left font-mono text-[13px] font-medium">{role}</th>
                <td className="px-4 py-3 font-mono text-[13px]">{show(m?.provider)}</td>
                <td className="px-4 py-3 font-mono text-[13px]">{show(m?.model)}</td>
                <td className="px-4 py-3 font-mono text-[13px]">{show(m?.project)}</td>
                <td className="px-4 py-3 font-mono text-[13px]">{show(m?.location)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <Tile inner="p-6">
              <div className="mono-label">Default provider</div>
              <div className="mt-2 text-[28px] font-semibold tracking-[-0.02em]">Google Vertex AI · Gemini</div>
              <p className="mt-2 text-[14px] text-muted">Used when ves.config.json has no <span className="font-mono">models</span> block (DESIGN-agnostic §0.2). Auth is Application Default Credentials; any OpenAI-compatible endpoint can replace it.</p>
              <p className="mt-3 font-mono text-[12px] text-muted">No {config.data.config_path} found in {config.data.repo_dir}</p>
            </Tile>
            <Tile inner="p-6">
              <div className="mono-label">Seen in runs</div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-mono text-[13px]">
                <dt className="text-muted">judge</dt><dd>{judge.join(', ') || DASH}</dd>
                <dt className="text-muted">user simulator</dt><dd>{sim.join(', ') || DASH}</dd>
                <dt className="text-muted">agent (rows)</dt><dd>{agent.join(', ') || DASH}</dd>
              </dl>
              <p className="mt-2 text-[12px] text-muted">From run.json judge_config / user_simulator and results.jsonl agent.model across {list.length} run(s).</p>
              <p className="mt-3 text-[14px] text-muted">Set models explicitly:</p>
              <div className="mt-2"><CommandBlock command={'"models": { "default": { "provider": "vertex", "model": "google/gemini-…" } }'} label="config snippet" /></div>
            </Tile>
          </div>
        )
      )}
    </>
  );
}

export function ConfigPage() {
  const { config } = useAppData();
  return (
    <>
      <PageHeader title="Config" sub="ves.config.json and pack profiles, read-only." />
      {!config.data && !config.error && <Loading />}
      {config.error && <ErrorState title="Could not read config" error={config.error.message} />}
      {config.data && (
        <>
          {config.data.config ? (
            <Section title="ves.config.json" label={config.data.config_path}>
              <pre className="max-h-[60vh] overflow-auto rounded-lg bg-tile p-5 font-mono text-[12px] leading-relaxed">{JSON.stringify(config.data.config, null, 2)}</pre>
            </Section>
          ) : (
            <EmptyState icon={<IconAdjustments {...ICON} />} title="No ves.config.json" body={<>{config.data.config_error ? <span className="text-block">{config.data.config_error}. </span> : null}The config names your agent connection, packs, tool catalog and variants. Without one, runs use a pack profile. Create it with:</>} command="npx ves init" />
          )}
          {config.data.profiles.length > 0 && (
            <Section title="Pack profiles" label="packs/*/profile.json">
              <Table head={['Profile', 'Suites', 'Variants', 'Deploy targets', 'Catalog']}>
                {config.data.profiles.map((p) => (
                  <tr key={p.pack} className="border-t border-line align-top">
                    <th scope="row" className="px-4 py-3 text-left font-mono text-[13px] font-medium">{p.id}</th>
                    <td className="px-4 py-3 font-mono text-[12px]">{Object.keys(p.suites).join(', ') || DASH}</td>
                    <td className="px-4 py-3 font-mono text-[12px]">{Object.keys(p.variants).length}</td>
                    <td className="px-4 py-3 font-mono text-[12px]">{p.deploy_targets.join(', ') || DASH}</td>
                    <td className="px-4 py-3 font-mono text-[12px]">{p.catalog ? `${Object.keys(p.catalog.ids).length} tools · gated: ${p.catalog.gated_classes.join(', ')}` : DASH}</td>
                  </tr>
                ))}
              </Table>
            </Section>
          )}
        </>
      )}
    </>
  );
}

// ---- Connect -----------------------------------------------------------------------------------------

export function AgentsPage() {
  const { config, runs } = useAppData();
  const conns = config.data?.config?.connections ?? config.data?.config?.connection;
  const latest = runs.data?.runs[0];
  return (
    <>
      <PageHeader title="Agents" sub="How the harness talks to your agent: command, http, openai-chat, mcp or trace connectors." />
      {conns ? (
        <pre className="overflow-auto rounded-lg bg-tile p-5 font-mono text-[12px]">{JSON.stringify(conns, null, 2)}</pre>
      ) : (
        <EmptyState icon={<IconPlugConnected {...ICON} />} title="No agent connected" body={<>No <span className="font-mono text-[13px]">connections</span> in ves.config.json{latest?.mock ? ', and the latest run used the mock connection (oracle replay, no agent in the loop)' : ''}. Detect your framework and write a bridge with:</>} command="npx ves init --connection command" />
      )}
    </>
  );
}

const GH_SNIPPET = `name: ves
on:
  pull_request:
  push: { branches: [main] }
permissions: { contents: read, pull-requests: write, actions: read }
jobs:
  ves:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: <org>/ves/integrations/github-action@<40-hex-sha>
        with:
          config: ves.config.json`;

export function CiPage() {
  return (
    <>
      <PageHeader title="CI" sub="Gate pull requests on the VES verdict and comment the results card." />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Tile inner="p-6">
          <div className="flex items-center gap-2"><IconBrandGithub {...ICON} /><span className="mono-label !text-ink">GitHub Actions</span></div>
          <p className="mt-2 text-[14px] text-muted">Write <span className="font-mono">.github/workflows/ves.yml</span> with <span className="font-mono">ves init --ci github</span>, or paste this and pin the action by full SHA (DESIGN-agnostic §6.1).</p>
          <div className="mt-4"><CommandBlock command="npx ves init --ci github" /></div>
        </Tile>
        <Tile inner="p-6">
          <span className="mono-label">.github/workflows/ves.yml</span>
          <div className="mt-3"><CommandBlock command={GH_SNIPPET} label="workflow" /></div>
        </Tile>
      </div>
    </>
  );
}

export function DocsPage() {
  const docs = [
    ['STANDARD.md', 'VES-1: data model, graders, statistics, tiers, deploy gate, safety suite.'],
    ['DESIGN-agnostic.md', 'Framework-agnostic design: connectors, ves.config.json, case/result/run v2, packs, CLI, CI.'],
    ['schemas/', 'JSON Schemas for cases, result rows and run manifests.'],
  ];
  return (
    <>
      <PageHeader title="Docs" sub="The dashboard reads files; these documents define them. Paths are relative to the harness checkout." />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {docs.map(([p, d]) => (
          <Tile key={p} inner="p-6"><div className="flex items-center gap-2"><IconBook size={18} stroke={1.75} aria-hidden /><span className="font-mono text-[14px] font-semibold">{p}</span></div><p className="mt-2 text-[14px] text-muted">{d}</p></Tile>
        ))}
      </div>
      <Section title="Run the UI" label="Local">
        <div className="flex flex-col gap-3">
          <CommandBlock command="cd ui && npm install && npm run dev" />
          <CommandBlock command="node ui/server/index.mjs --results ./results --port 4317" />
        </div>
      </Section>
    </>
  );
}

export function NotFoundPage({ path }: { path: string }) {
  return <EmptyState title="Page not found" body={<>Nothing lives at <span className="font-mono text-[13px]">#{path}</span>. <a href="#/runs" className="underline underline-offset-2">Go to Runs</a>.</>} />;
}

