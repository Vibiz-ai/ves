import type { IncomingMessage, ServerResponse } from 'node:http';

export type ApiResult = { status: number; body: unknown };
export type Api = {
  handle(method: string, url: string): ApiResult | Promise<ApiResult> | null;
  middleware(req: IncomingMessage, res: ServerResponse, next?: () => void): void;
  resultsDir: string;
  repoDir: string;
  storeUrl: string | null;
  close(): void;
};
export type CliRunner = (args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
export function createApi(opts: {
  resultsDir: string; repoDir: string; harnessDir?: string;
  storeUrl?: string | null; storeProject?: string;
  fetch?: typeof fetch; token?: () => Promise<string>; now?: () => number;
  runCli?: CliRunner; currentBranch?: string | null;
}): Api;
export function defaultDirs(uiDir: string): { resultsDir: string; repoDir: string; storeUrl: string | null; storeProject: string | undefined };
export function isInside(root: string, child: string): boolean;
export function resolveInsideRun(runDir: string, uri: string): { abs: string; exists: boolean } | null;
export function createdFromRunId(id: string): string | null;
