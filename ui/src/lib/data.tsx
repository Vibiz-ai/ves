import { createContext, useContext, type ReactNode } from 'react';
import { useApi, type FetchState } from './api.ts';
import type { CasesResponse, ConfigResponse, RunsResponse } from './types.ts';

type AppData = { runs: FetchState<RunsResponse>; cases: FetchState<CasesResponse>; config: FetchState<ConfigResponse> };

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  // The server watches the results dir; the client simply re-polls the run list so new runs appear.
  const runs = useApi<RunsResponse>('/api/runs', 5000);
  const cases = useApi<CasesResponse>('/api/cases', 30000);
  const config = useApi<ConfigResponse>('/api/config', 30000);
  return <Ctx.Provider value={{ runs, cases, config }}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData outside provider');
  return v;
}

/** Project name: target.repo from the newest run, else "local". */
export function projectName(runs: RunsResponse | null): string {
  const r = runs?.runs.find((x) => x.repo);
  return r?.repo ?? 'local';
}
