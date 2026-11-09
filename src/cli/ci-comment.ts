// `ves ci comment` (DESIGN-agnostic §6.2, §6.3, §6.5): upsert ONE PR/MR comment per project, identified by its first
// line `<!-- ves:pr-comment project=<p> -->`. GitHub goes through `gh api` (injected exec) when gh is available, else
// the REST API over the injected fetch; GitLab uses the notes API over fetch. Never posts on fork PRs.
import type { CliDeps, ExecLike, FetchLike } from '../core/types.ts';
import { type Env, httpJson, parseJsonStream } from './ci-shared.ts';

export type StoredComment = { id: string; body: string; url: string };
export interface CommentStore {
  readonly kind: string;
  list(): Promise<StoredComment[]>;
  create(body: string): Promise<StoredComment>;
  update(id: string, body: string): Promise<StoredComment>;
  remove(id: string): Promise<void>;
}
export type UpsertResult = { action: 'created' | 'updated'; id: string; url: string; removed_duplicates: number };

/** Find comments whose FIRST line is the marker; update the oldest, delete any duplicates; else create one. */
export async function upsertComment(store: CommentStore, marker: string, body: string): Promise<UpsertResult> {
  const mine = (await store.list()).filter((c) => (c.body ?? '').split('\n', 1)[0].trim() === marker.trim());
  if (!mine.length) { const c = await store.create(body); return { action: 'created', id: c.id, url: c.url, removed_duplicates: 0 }; }
  const [keep, ...dups] = mine;
  const c = await store.update(keep.id, body);
  for (const d of dups) await store.remove(d.id);
  return { action: 'updated', id: c.id, url: c.url || keep.url, removed_duplicates: dups.length };
}

const asComment = (j: any): StoredComment => ({ id: String(j?.id ?? ''), body: String(j?.body ?? ''), url: String(j?.html_url ?? j?.url ?? '') });

/** GitHub through the gh CLI (`gh api`, authenticated by GH_TOKEN). */
export function ghStore(exec: ExecLike, repo: string, pr: number): CommentStore {
  const api = async (args: string[], input?: unknown) => {
    const r = await exec('gh', ['api', ...args, ...(input !== undefined ? ['--input', '-'] : [])], input !== undefined ? { input: JSON.stringify(input) } : undefined);
    if (r.code !== 0) throw new Error(`gh api ${args.join(' ')} failed: ${r.stderr.trim().split('\n')[0]}`);
    return r.stdout;
  };
  return {
    kind: 'gh',
    async list() { return (parseJsonStream(await api([`repos/${repo}/issues/${pr}/comments?per_page=100`, '--paginate'])).flat() as any[]).map(asComment); },
    async create(body) { return asComment(JSON.parse(await api(['-X', 'POST', `repos/${repo}/issues/${pr}/comments`], { body }))); },
    async update(id, body) { return asComment(JSON.parse(await api(['-X', 'PATCH', `repos/${repo}/issues/comments/${id}`], { body }))); },
    async remove(id) { await api(['-X', 'DELETE', `repos/${repo}/issues/comments/${id}`]); },
  };
}

/** GitHub REST over fetch (no gh on the runner). */
export function githubApiStore(fetch: FetchLike, o: { apiUrl: string; token: string; repo: string; pr: number }): CommentStore {
  const h = { authorization: `Bearer ${o.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ves-ci' };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await httpJson(fetch, method, `${o.apiUrl.replace(/\/$/, '')}/${path}`, h, body);
    if (r.status >= 300) throw new Error(`GitHub API ${method} ${path} -> ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json;
  };
  return {
    kind: 'github-api',
    async list() {
      const all: StoredComment[] = [];
      for (let page = 1; page <= 50; page++) {
        const j = await call('GET', `repos/${o.repo}/issues/${o.pr}/comments?per_page=100&page=${page}`);
        const arr = Array.isArray(j) ? j : [];
        all.push(...arr.map(asComment));
        if (arr.length < 100) break;
      }
      return all;
    },
    async create(body) { return asComment(await call('POST', `repos/${o.repo}/issues/${o.pr}/comments`, { body })); },
    async update(id, body) { return asComment(await call('PATCH', `repos/${o.repo}/issues/comments/${id}`, { body })); },
    async remove(id) { await call('DELETE', `repos/${o.repo}/issues/comments/${id}`); },
  };
}

/** GitLab MR notes over fetch (PRIVATE-TOKEN: a project access token with api scope). */
export function gitlabStore(fetch: FetchLike, o: { apiUrl: string; token: string; projectId: string; iid: number; mrUrl: string }): CommentStore {
  const h = { 'private-token': o.token, accept: 'application/json', 'user-agent': 'ves-ci' };
  const base = `projects/${encodeURIComponent(o.projectId)}/merge_requests/${o.iid}/notes`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await httpJson(fetch, method, `${o.apiUrl.replace(/\/$/, '')}/${path}`, h, body);
    if (r.status >= 300) throw new Error(`GitLab API ${method} ${path} -> ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json;
  };
  const note = (j: any): StoredComment => ({ id: String(j?.id ?? ''), body: String(j?.body ?? ''), url: `${o.mrUrl}#note_${j?.id ?? ''}` });
  return {
    kind: 'gitlab',
    async list() {
      const all: StoredComment[] = [];
      for (let page = 1; page <= 50; page++) {
        const arr = await call('GET', `${base}?per_page=100&page=${page}&sort=asc&order_by=created_at`);
        const a = Array.isArray(arr) ? arr : [];
        all.push(...a.filter((n: any) => !n.system).map(note));
        if (a.length < 100) break;
      }
      return all;
    },
    async create(body) { return note(await call('POST', base, { body })); },
    async update(id, body) { return note(await call('PUT', `${base}/${id}`, { body })); },
    async remove(id) { await call('DELETE', `${base}/${id}`); },
  };
}

/** gh when it answers `gh --version`, else the REST API with GH_TOKEN/GITHUB_TOKEN. */
export async function githubStoreFor(deps: Pick<CliDeps, 'exec' | 'fetch'>, env: Env, repo: string, pr: number, transport: 'auto' | 'gh' | 'api' = 'auto'): Promise<CommentStore> {
  if (transport !== 'api') {
    const v = await deps.exec('gh', ['--version']).catch(() => ({ code: 127, stdout: '', stderr: '' }));
    if (v.code === 0) return ghStore(deps.exec, repo, pr);
    if (transport === 'gh') throw new Error('gh is not available on this runner');
  }
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) throw new Error('no GH_TOKEN/GITHUB_TOKEN for the GitHub API');
  return githubApiStore(deps.fetch, { apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com', token, repo, pr });
}
