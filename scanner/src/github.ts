export class RateLimitExhausted extends Error {}
/** Recursive tree listing was cut off by GitHub (~100k entries / 7 MB). */
export class TreeTruncated extends Error {}

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
  /** Batched GraphQL lookup, 100 repos per request. Key is lowercase `owner/repo`; missing repos are absent.
   *  A failed batch is skipped and counted; a GraphQL rate limit fails all remaining batches. Core RateLimitExhausted propagates. */
  getStars(repos: { owner: string; repo: string }[]): Promise<{ counts: Map<string, { stars: number; createdAt: string }>; failedBatches: number }>;
  /** Last seen `x-ratelimit-remaining` (Infinity before any API call). */
  remaining(): number;
}

const MAX_RETRIES = 3;
const STARS_BATCH = 100;
/** A stalled socket must fail (and the repo be skipped) instead of hanging the run. */
const FETCH_TIMEOUT_MS = 30_000;
const MAX_WAIT_MS = 60_000;
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export function createGitHub(opts: {
  token?: string;
  fetchImpl?: typeof fetch;
  floor?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** epoch ms: below the floor, wait for the hourly core reset only if it comes before this; otherwise stop */
  deadline?: number;
}): GitHub {
  const doFetch = opts.fetchImpl ?? fetch;
  const floor = opts.floor ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let remaining = Infinity;
  let resetAt = 0; // epoch ms of the next core quota reset, from x-ratelimit-reset

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skilltrust",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  /** Returns the response (any status except retried 403/429); callers handle 404. */
  async function api(path: string, body?: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (remaining < floor) {
        const wakeAt = resetAt + 5000;
        if (!resetAt || opts.deadline === undefined || wakeAt > opts.deadline) throw new RateLimitExhausted(`GitHub quota low: ${remaining} < ${floor}`);
        await sleep(Math.max(wakeAt - now(), 0));
        remaining = Infinity; // quota refilled at reset
      }
      const res = await doFetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(body === undefined ? {} : { method: "POST", body }) });
      const resource = res.headers.get("x-ratelimit-resource") ?? "core";
      const rem = res.headers.get("x-ratelimit-remaining");
      // Only core quota drives remaining()/floor; search has its own small budget.
      if (resource === "core" && rem !== null && !Number.isNaN(Number(rem))) remaining = Number(rem);
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (resource === "core" && reset > 0) resetAt = reset * 1000;
      if (res.status !== 403 && res.status !== 429) return res;
      const ra = res.headers.get("retry-after");
      let waitMs: number;
      if (ra !== null) {
        waitMs = Math.max(Number(ra) || 1, 0) * 1000;
      } else if (rem === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const untilReset = reset * 1000 - Date.now();
        if (!(untilReset <= 120_000)) {
          if (resource === "core") throw new RateLimitExhausted("GitHub quota exhausted");
          throw new Error(`GitHub ${res.status} for ${path}: ${resource} limit exhausted`);
        }
        waitMs = Math.max(untilReset, 0) + 1000;
        if (resource === "core") remaining = Infinity; // quota refills at reset
      } else if (res.status === 429) {
        waitMs = 1000;
      } else {
        throw new Error(`GitHub 403 for ${path}`);
      }
      if (attempt >= MAX_RETRIES) throw new Error(`GitHub ${res.status} for ${path} after ${MAX_RETRIES} retries`);
      await sleep(Math.min(waitMs, MAX_WAIT_MS));
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
      if (d.truncated) throw new TreeTruncated(`tree truncated for ${owner}/${repo}@${commit}`);
      return d.tree
        .filter((t: any) => t.type === "blob" || t.type === "tree")
        .map((t: any) => ({ path: t.path, type: t.type, sha: t.sha, size: t.size }));
    },
    async readRaw(owner, repo, commit, path) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${enc(commit)}/${enc(path)}`;
      const res = await doFetch(url, { headers: { "User-Agent": "skilltrust" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`raw read ${res.status} for ${owner}/${repo}@${commit}:${path}`);
      return res.text();
    },
    async getStars(repos) {
      const counts = new Map<string, { stars: number; createdAt: string }>();
      let failedBatches = 0;
      const nBatches = Math.ceil(repos.length / STARS_BATCH);
      for (let k = 0; k < nBatches; k++) {
        const batch = repos.slice(k * STARS_BATCH, (k + 1) * STARS_BATCH);
        const decl = batch.map((_, j) => `$o${j}: String!, $n${j}: String!`).join(", ");
        const body = batch.map((_, j) => `r${j}: repository(owner: $o${j}, name: $n${j}) { stargazerCount createdAt }`).join(" ");
        const variables: Record<string, string> = {};
        batch.forEach((r, j) => { variables[`o${j}`] = r.owner; variables[`n${j}`] = r.repo; });
        let d: { data?: Record<string, { stargazerCount: number; createdAt: string } | null> | null; errors?: { type?: string }[] } | undefined;
        let stop = false;
        try {
          const res = await api("/graphql", JSON.stringify({ query: `query(${decl}) { ${body} }`, variables }));
          d = (await res.json().catch(() => undefined)) as typeof d;
          // GitHub reports GraphQL rate limits as 200 or 403 with this error type
          stop = !!d?.errors?.some((e) => e.type === "RATE_LIMITED");
          if (!res.ok) d = undefined;
        } catch (e) {
          if (e instanceof RateLimitExhausted) throw e;
          stop = /\b(403|429)\b|limit exhausted/.test(String(e)); // api() gave up on a rate limit
        }
        if (!d?.data) {
          failedBatches += stop ? nBatches - k : 1;
          if (stop) break;
          continue;
        }
        batch.forEach((r, j) => {
          const v = d!.data![`r${j}`];
          if (v) counts.set(`${r.owner}/${r.repo}`.toLowerCase(), { stars: v.stargazerCount, createdAt: v.createdAt });
        });
      }
      return { counts, failedBatches };
    },
    remaining: () => remaining,
  };
}
