import { describe, it, expect } from "vitest";
import { createGitHub, RateLimitExhausted } from "../src/github.js";

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
});
