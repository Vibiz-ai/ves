import { useEffect } from 'react';
import { Shell } from './components/Shell.tsx';
import { AppDataProvider } from './lib/data.tsx';
import { useRoute, type Route } from './lib/router.ts';
import { RunsPage } from './pages/RunsPage.tsx';
import { PersonPage, PersonasPage } from './pages/PersonasPage.tsx';
import { RunDetailPage } from './pages/RunDetailPage.tsx';
import { TrialPage } from './pages/TrialView.tsx';
import { CaseTimelinePage, ComparePage, HistoryPage } from './pages/HistoryPages.tsx';
import { CasePathsPage, PathComparePage } from './pages/PathViews.tsx';
import { AgentsPage, CasesPage, CiPage, ConfigPage, DocsPage, GateRulesPage, ModelsPage, NotFoundPage, PacksPage, SurfacesPage } from './pages/OtherPages.tsx';

const TITLES: Record<string, string> = {
  runs: 'Runs', personas: 'Personas', history: 'History', compare: 'Compare', paths: 'Paths', store: 'Stored trial', cases: 'Cases', packs: 'Packs', surfaces: 'Surfaces', settings: 'Settings', connect: 'Connect', docs: 'Docs',
};

function Page({ route }: { route: Route }) {
  const [a, b, c] = route.segments;
  if (!a || a === 'runs') {
    if (b && c === 'trial') return <TrialPage runId={b} rowId={route.query.get('row')} view={route.query.get('view')} />;
    if (b) return <RunDetailPage key={b} id={b} route={route} />;
    return <RunsPage route={route} />;
  }
  if (a === 'personas') return b ? <PersonPage key={b} id={b} /> : <PersonasPage />;
  if (a === 'history' && b === 'case') return <CaseTimelinePage route={route} />;
  if (a === 'history') return <HistoryPage route={route} />;
  if (a === 'compare') return <ComparePage route={route} />;
  if (a === 'store' && b && c === 'trial') return <TrialPage runId={b} rowId={route.query.get('row')} store view={route.query.get('view')} />;
  if (a === 'paths' && b === 'compare') return <PathComparePage route={route} />;
  if (a === 'paths' && b === 'case') return <CasePathsPage route={route} />;
  if (a === 'cases') return <CasesPage route={route} />;
  if (a === 'packs') return <PacksPage />;
  if (a === 'surfaces') return <SurfacesPage />;
  if (a === 'settings' && b === 'gate') return <GateRulesPage />;
  if (a === 'settings' && b === 'models') return <ModelsPage />;
  if (a === 'settings' && b === 'config') return <ConfigPage />;
  if (a === 'connect' && b === 'agents') return <AgentsPage />;
  if (a === 'connect' && b === 'ci') return <CiPage />;
  if (a === 'docs') return <DocsPage />;
  return <NotFoundPage path={route.path} />;
}

export function App() {
  const route = useRoute();
  useEffect(() => {
    const [a, b] = route.segments;
    const t = b && a === 'runs' ? `Run ${b.replace(/^ves-/, '')}` : TITLES[a ?? 'runs'] ?? 'VES';
    document.title = `${t} · VES`;
  }, [route.path]);
  useEffect(() => { window.scrollTo(0, 0); }, [route.path]);
  return (
    <AppDataProvider>
      <Shell route={route}>
        <Page route={route} />
      </Shell>
    </AppDataProvider>
  );
}
