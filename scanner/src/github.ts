export class RateLimitExhausted extends Error {}

export interface RepoMeta {
  owner: string;
  repo: string;
  stars: number;
  defaultBranch: string;
  topics: string[];
  description: string;
  archived: boolean;
  fork: boolean;
  /** ISO timestamp from the API's `created_at` */
  createdAt: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

export interface GitHub {
  searchCode(q: string, page: number): Promise<{ totalCount: number; items: { owner: string; repo: string; path: string }[] }>;
  getRepo(owner: string, repo: string): Promise<RepoMeta | null>;
  getHeadCommit(owner: string, repo: string, branch: string): Promise<string | null>;
  getTree(owner: string, repo: string, commit: string): Promise<TreeEntry[]>;
  /** `commit` is any git ref (branch or SHA). Not counted against API quota. */
  readRaw(owner: string, repo: string, commit: string, path: string): Promise<string>;
  /** Last seen `x-ratelimit-remaining` (Infinity before any API call). */
  remaining(): number;
}

const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function createGitHub(opts: {
  token?: string;
  fetchImpl?: typeof fetch;
  floor?: number;
  sleep?: (ms: number) => Promise<void>;
}): GitHub {
  const doFetch = opts.fetchImpl ?? fetch;
  const floor = opts.floor ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let remaining = Infinity;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skilltrust",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  /** Returns the response (any status except retried 403/429); callers handle 404. */
  async function api(path: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (remaining < floor) throw new RateLimitExhausted(`GitHub quota low: ${remaining} < ${floor}`);
      const res = await doFetch(`https://api.github.com${path}`, { headers });
      const rem = res.headers.get("x-ratelimit-remaining");
      if (rem !== null && !Number.isNaN(Number(rem))) remaining = Number(rem);
      if (res.status !== 403 && res.status !== 429) return res;
      const ra = res.headers.get("retry-after");
      if (res.status === 403 && ra === null) {
        // Plain 403 (no retry-after): quota gone or forbidden; retrying won't help.
        if (remaining === 0) throw new RateLimitExhausted("GitHub quota exhausted");
        throw new Error(`GitHub 403 for ${path}`);
      }
      if (attempt >= MAX_RETRIES) throw new Error(`GitHub ${res.status} for ${path} after ${MAX_RETRIES} retries`);
      await sleep(Math.min(Math.max(Number(ra ?? 1) || 1, 0) * 1000, MAX_WAIT_MS));
    }
  }

  async function json<T>(path: string, allow404 = false): Promise<T | null> {
    const res = await api(path);
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  const repoPath = (o: string, r: string) => `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`;

  return {
    async searchCode(q, page) {
      const d = await json<any>(`/search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
      return {
        totalCount: d.total_count,
        items: d.items.map((i: any) => ({ owner: i.repository.owner.login, repo: i.repository.name, path: i.path })),
      };
    },
    async getRepo(owner, repo) {
      const d = await json<any>(repoPath(owner, repo), true);
      if (!d) return null;
      return {
        owner, repo,
        stars: d.stargazers_count,
        defaultBranch: d.default_branch,
        topics: d.topics ?? [],
        description: d.description ?? "",
        archived: !!d.archived,
        fork: !!d.fork,
        createdAt: d.created_at,
      };
    },
    async getHeadCommit(owner, repo, branch) {
      const d = await json<any>(`${repoPath(owner, repo)}/commits/${enc(branch)}`, true);
      return d ? d.sha : null;
    },
    async getTree(owner, repo, commit) {
      const d = await json<any>(`${repoPath(owner, repo)}/git/trees/${enc(commit)}?recursive=1`);
      return d.tree
        .filter((t: any) => t.type === "blob" || t.type === "tree")
        .map((t: any) => ({ path: t.path, type: t.type, sha: t.sha, size: t.size }));
    },
    async readRaw(owner, repo, commit, path) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${enc(commit)}/${enc(path)}`;
      const res = await doFetch(url, { headers: { "User-Agent": "skilltrust" } });
      if (!res.ok) throw new Error(`raw read ${res.status} for ${owner}/${repo}@${commit}:${path}`);
      return res.text();
    },
    remaining: () => remaining,
  };
}
