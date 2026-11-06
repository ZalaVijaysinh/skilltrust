import { describe, it, expect } from "vitest";
import { createGitHub, RateLimitExhausted, TreeTruncated } from "../src/github.js";

type Call = { url: string; headers: Record<string, string> };
function fake(responses: Response[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses.shift();
    if (!r) throw new Error("no more fake responses");
    return r;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const noSleep = async () => {};

describe("github client", () => {
  it("returns null on 404 getRepo", async () => {
    const { fetchImpl } = fake([json({}, 404)]);
    const gh = createGitHub({ fetchImpl });
    expect(await gh.getRepo("a", "b")).toBeNull();
  });

  it("maps repo metadata incl. createdAt", async () => {
    const { fetchImpl, calls } = fake([
      json({ stargazers_count: 7, default_branch: "main", topics: ["x"], description: null, archived: false, fork: true, created_at: "2024-01-02T00:00:00Z" }),
    ]);
    const gh = createGitHub({ fetchImpl });
    expect(await gh.getRepo("a", "b")).toEqual({
      owner: "a", repo: "b", stars: 7, defaultBranch: "main", topics: ["x"], description: "",
      archived: false, fork: true, createdAt: "2024-01-02T00:00:00Z",
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/a/b");
  });

  it("retries on 429 with retry-after then succeeds, waiting capped", async () => {
    const { fetchImpl, calls } = fake([
      json({}, 429, { "retry-after": "1" }),
      json({}, 403, { "retry-after": "999" }),
      json({ stargazers_count: 1, default_branch: "m", created_at: "t" }),
    ]);
    const waits: number[] = [];
    const gh = createGitHub({ fetchImpl, sleep: async (ms) => void waits.push(ms) });
    expect((await gh.getRepo("a", "b"))?.stars).toBe(1);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 60000]);
  });

  it("gives up after 3 retries", async () => {
    const r = () => json({}, 429, { "retry-after": "1" });
    const { fetchImpl, calls } = fake([r(), r(), r(), r()]);
    const gh = createGitHub({ fetchImpl, sleep: noSleep });
    await expect(gh.getRepo("a", "b")).rejects.toThrow(/429/);
    expect(calls).toHaveLength(4);
  });

  it("throws RateLimitExhausted once remaining drops below floor", async () => {
    const { fetchImpl, calls } = fake([
      json({ stargazers_count: 1, default_branch: "m", created_at: "t" }, 200, { "x-ratelimit-remaining": "99" }),
    ]);
    const gh = createGitHub({ fetchImpl });
    await gh.getRepo("a", "b");
    expect(gh.remaining()).toBe(99);
    await expect(gh.getRepo("a", "c")).rejects.toBeInstanceOf(RateLimitExhausted);
    expect(calls).toHaveLength(1);
  });

  it("below the floor, sleeps until the hourly reset (+5 s) when it comes before the deadline, then continues", async () => {
    const t0 = 1_800_000_000_000;
    const resetSecs = t0 / 1000 + 1800;
    const { fetchImpl, calls } = fake([
      json({ sha: "abc" }, 200, { "x-ratelimit-remaining": "50", "x-ratelimit-reset": String(resetSecs) }),
      json({ sha: "def" }, 200, { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(resetSecs + 3600) }),
    ]);
    const waits: number[] = [];
    const gh = createGitHub({ fetchImpl, sleep: async (ms) => void waits.push(ms), now: () => t0, deadline: t0 + 3 * 3600_000 });
    expect(await gh.getHeadCommit("a", "b", "main")).toBe("abc");
    expect(await gh.getHeadCommit("a", "b", "main")).toBe("def");
    expect(waits).toEqual([1800_000 + 5000]);
    expect(calls).toHaveLength(2);
    expect(gh.remaining()).toBe(4999);
  });

  it("below the floor, stops when the reset comes after the deadline", async () => {
    const t0 = 1_800_000_000_000;
    const { fetchImpl } = fake([json({ sha: "abc" }, 200, { "x-ratelimit-remaining": "50", "x-ratelimit-reset": String(t0 / 1000 + 1800) })]);
    const waits: number[] = [];
    const gh = createGitHub({ fetchImpl, sleep: async (ms) => void waits.push(ms), now: () => t0, deadline: t0 + 1000_000 });
    await gh.getHeadCommit("a", "b", "main");
    await expect(gh.getHeadCommit("a", "b", "main")).rejects.toBeInstanceOf(RateLimitExhausted);
    expect(waits).toEqual([]);
  });

  it("respects custom floor", async () => {
    const { fetchImpl } = fake([
      json({ sha: "abc" }, 200, { "x-ratelimit-remaining": "5" }),
      json({ sha: "def" }, 200, { "x-ratelimit-remaining": "4" }),
    ]);
    const gh = createGitHub({ fetchImpl, floor: 5 });
    expect(await gh.getHeadCommit("a", "b", "main")).toBe("abc");
    expect(await gh.getHeadCommit("a", "b", "main")).toBe("def");
    await expect(gh.getHeadCommit("a", "b", "main")).rejects.toBeInstanceOf(RateLimitExhausted);
  });

  it("sends bearer token only when given", async () => {
    const a = fake([json({}, 404)]);
    await createGitHub({ fetchImpl: a.fetchImpl, token: "tok" }).getRepo("a", "b");
    expect(a.calls[0].headers.Authorization).toBe("Bearer tok");
    const b = fake([json({}, 404)]);
    await createGitHub({ fetchImpl: b.fetchImpl }).getRepo("a", "b");
    expect(b.calls[0].headers.Authorization).toBeUndefined();
  });

  it("searchCode maps items", async () => {
    const { fetchImpl, calls } = fake([
      json({ total_count: 2, items: [
        { path: "skills/x/SKILL.md", repository: { name: "r1", owner: { login: "o1" } } },
        { path: "SKILL.md", repository: { name: "r2", owner: { login: "o2" } } },
      ] }),
    ]);
    const gh = createGitHub({ fetchImpl });
    expect(await gh.searchCode("filename:SKILL.md", 2)).toEqual({
      totalCount: 2,
      items: [
        { owner: "o1", repo: "r1", path: "skills/x/SKILL.md" },
        { owner: "o2", repo: "r2", path: "SKILL.md" },
      ],
    });
    expect(calls[0].url).toBe("https://api.github.com/search/code?q=filename%3ASKILL.md&per_page=100&page=2");
  });

  it("getHeadCommit returns null on 404", async () => {
    const { fetchImpl } = fake([json({}, 404)]);
    expect(await createGitHub({ fetchImpl }).getHeadCommit("a", "b", "x")).toBeNull();
  });

  it("getTree is recursive and keeps blobs/trees only", async () => {
    const { fetchImpl, calls } = fake([
      json({ tree: [
        { path: "a", type: "tree", sha: "1" },
        { path: "a/b.md", type: "blob", sha: "2", size: 5 },
        { path: "sub", type: "commit", sha: "3" },
      ] }),
    ]);
    const t = await createGitHub({ fetchImpl }).getTree("o", "r", "deadbeef");
    expect(t).toEqual([
      { path: "a", type: "tree", sha: "1", size: undefined },
      { path: "a/b.md", type: "blob", sha: "2", size: 5 },
    ]);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/trees/deadbeef?recursive=1");
  });

  it("readRaw encodes path segments, skips quota, throws on 404", async () => {
    const { fetchImpl, calls } = fake([
      new Response("hello", { headers: { "x-ratelimit-remaining": "1" } }),
      new Response("nope", { status: 404 }),
    ]);
    const gh = createGitHub({ fetchImpl });
    expect(await gh.readRaw("o", "r", "main", "my dir/a#b.md")).toBe("hello");
    expect(calls[0].url).toBe("https://raw.githubusercontent.com/o/r/main/my%20dir/a%23b.md");
    expect(gh.remaining()).toBe(Infinity);
    await expect(gh.readRaw("o", "r", "main", "x.md")).rejects.toThrow(/404/);
  });

  const reset = (secs: number) => String(Math.floor(Date.now() / 1000) + secs);

  it("waits for reset on search-resource 403 and leaves core remaining alone", async () => {
    const { fetchImpl, calls } = fake([
      json({}, 200, { "x-ratelimit-remaining": "4000" }),
      json({}, 403, { "x-ratelimit-resource": "code_search", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(30) }),
      json({ total_count: 0, items: [] }, 200, { "x-ratelimit-resource": "code_search", "x-ratelimit-remaining": "29" }),
    ]);
    const waits: number[] = [];
    const gh = createGitHub({ fetchImpl, sleep: async (ms) => void waits.push(ms) });
    await gh.getRepo("a", "b");
    expect((await gh.searchCode("q", 1)).totalCount).toBe(0);
    expect(calls).toHaveLength(3);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(29_000);
    expect(waits[0]).toBeLessThanOrEqual(31_000);
    expect(gh.remaining()).toBe(4000);
  });

  it("throws RateLimitExhausted on core 403 with distant reset", async () => {
    const { fetchImpl } = fake([
      json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(3600) }),
    ]);
    const gh = createGitHub({ fetchImpl, sleep: noSleep });
    await expect(gh.getRepo("a", "b")).rejects.toBeInstanceOf(RateLimitExhausted);
  });

  it("throws a normal error on non-core 403 with distant reset", async () => {
    const { fetchImpl } = fake([
      json({}, 403, { "x-ratelimit-resource": "search", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset(3600) }),
    ]);
    const gh = createGitHub({ fetchImpl, sleep: noSleep });
    const err = await gh.searchCode("q", 1).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RateLimitExhausted);
  });

  it("search remaining does not trip the core floor", async () => {
    const { fetchImpl } = fake([
      json({ total_count: 0, items: [] }, 200, { "x-ratelimit-resource": "search", "x-ratelimit-remaining": "5" }),
      json({}, 404),
    ]);
    const gh = createGitHub({ fetchImpl });
    await gh.searchCode("q", 1);
    expect(gh.remaining()).toBe(Infinity);
    expect(await gh.getRepo("a", "b")).toBeNull();
  });

  it("getTree throws TreeTruncated when GitHub truncates", async () => {
    const { fetchImpl } = fake([json({ truncated: true, tree: [{ path: "a", type: "blob", sha: "1" }] })]);
    const err = await createGitHub({ fetchImpl }).getTree("o", "r", "abc").catch((e) => e);
    expect(err).toBeInstanceOf(TreeTruncated);
    expect(err.message).toContain("o/r@abc");
  });

  it("getTree returns entries when truncated is false", async () => {
    const { fetchImpl } = fake([json({ truncated: false, tree: [{ path: "a", type: "blob", sha: "1", size: 2 }] })]);
    expect(await createGitHub({ fetchImpl }).getTree("o", "r", "abc")).toHaveLength(1);
  });
  describe("getStars", () => {
    const repos = (n: number) => Array.from({ length: n }, (_, i) => ({ owner: `O${i}`, repo: `r${i}` }));
    const gql = (data: Record<string, unknown>, errors?: unknown[]) =>
      json({ data, ...(errors ? { errors } : {}) }, 200, { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "3" });

    it("batches 250 repos into 3 POSTs of at most 100 aliases, keyed lowercase", async () => {
      const bodies: any[] = [];
      const fetchImpl = (async (_u: string, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body));
        bodies.push({ method: init?.method, ...b });
        const data: Record<string, unknown> = {};
        for (const k of Object.keys(b.variables).filter((k) => k.startsWith("o"))) {
          data["r" + k.slice(1)] = { stargazerCount: 5, createdAt: "2024-01-01T00:00:00Z" };
        }
        return gql(data);
      }) as unknown as typeof fetch;
      const gh = createGitHub({ fetchImpl });
      const { counts: m, failedBatches } = await gh.getStars(repos(250));
      expect(failedBatches).toBe(0);
      expect(bodies).toHaveLength(3);
      expect(bodies.every((b) => b.method === "POST")).toBe(true);
      expect(bodies.map((b) => Object.keys(b.variables).length / 2)).toEqual([100, 100, 50]);
      expect(bodies[0].query).not.toContain("O0"); // names go through variables
      expect(m.size).toBe(250);
      expect(m.get("o7/r7")).toEqual({ stars: 5, createdAt: "2024-01-01T00:00:00Z" });
      expect(gh.remaining()).toBe(Infinity); // graphql must not trip the core floor
    });

    it("skips null aliases when errors accompany data", async () => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < 10; i++) data["r" + i] = i === 7 ? null : { stargazerCount: i, createdAt: "t" };
      const { fetchImpl } = fake([gql(data, [{ type: "NOT_FOUND", path: ["r7"] }])]);
      const { counts: m } = await createGitHub({ fetchImpl }).getStars(repos(10));
      expect(m.size).toBe(9);
      expect(m.has("o7/r7")).toBe(false);
    });

    const okBatch = (n: number) => gql(Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, { stargazerCount: 1, createdAt: "t" }])));

    it("a failed batch is skipped and counted; others kept", async () => {
      const { fetchImpl } = fake([okBatch(100), json({}, 500), okBatch(50)]);
      const r = await createGitHub({ fetchImpl }).getStars(repos(250));
      expect(r.failedBatches).toBe(1);
      expect(r.counts.size).toBe(150);
    });

    it("a body with no data counts as failed", async () => {
      const { fetchImpl } = fake([json({ errors: [{ type: "X" }] })]);
      const r = await createGitHub({ fetchImpl }).getStars(repos(1));
      expect(r).toEqual({ counts: new Map(), failedBatches: 1 });
    });

    it("RATE_LIMITED (200) stops remaining batches, keeps earlier ones", async () => {
      const { fetchImpl, calls } = fake([okBatch(100), json({ data: null, errors: [{ type: "RATE_LIMITED" }] })]);
      const r = await createGitHub({ fetchImpl }).getStars(repos(250));
      expect(calls).toHaveLength(2);
      expect(r.failedBatches).toBe(2);
      expect(r.counts.size).toBe(100);
    });

    it("RATE_LIMITED as HTTP 403 stops remaining batches", async () => {
      const { fetchImpl, calls } = fake([okBatch(100), json({ errors: [{ type: "RATE_LIMITED" }] }, 403)]);
      const r = await createGitHub({ fetchImpl }).getStars(repos(250));
      expect(calls).toHaveLength(2);
      expect(r.failedBatches).toBe(2);
      expect(r.counts.size).toBe(100);
    });

    it("core RateLimitExhausted still propagates", async () => {
      const { fetchImpl } = fake([json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" })]);
      await expect(createGitHub({ fetchImpl }).getStars(repos(1))).rejects.toBeInstanceOf(RateLimitExhausted);
    });
  });
});
