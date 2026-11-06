import { describe, it, expect } from "vitest";
import { discoverSkills, newDiscoveryState } from "../src/discover.js";
import { RateLimitExhausted, type GitHub } from "../src/github.js";

function fake(opts: {
  search?: (q: string, page: number) => { totalCount: number; items: { owner: string; repo: string; path: string }[] };
  raw?: Record<string, string>;
}) {
  const queries: string[] = [];
  const reads: string[] = [];
  const gh = {
    searchCode: async (q: string, page: number) => {
      queries.push(`${q}#${page}`);
      return opts.search ? opts.search(q, page) : { totalCount: 0, items: [] };
    },
    readRaw: async (o: string, r: string, _ref: string, p: string) => {
      reads.push(`${o}/${r}/${p}`);
      const k = `${o}/${r}/${p}`;
      if (!(k in (opts.raw ?? {}))) throw new Error("404");
      return opts.raw![k];
    },
    getRepo: async () => { throw new Error("must not be called"); },
    getTree: async () => { throw new Error("must not be called"); },
    getHeadCommit: async () => { throw new Error("must not be called"); },
    remaining: () => Infinity,
  } as unknown as GitHub;
  return { gh, queries, reads };
}

describe("discoverSkills", () => {
  it("slices by size, splits oversized ranges, paginates, and dedupes", async () => {
    const { gh, queries } = fake({
      search: (q, page) => {
        if (q.endsWith("size:0..1000")) return { totalCount: 1500, items: [] };
        if (q.endsWith("size:0..500")) return { totalCount: 1, items: [{ owner: "A", repo: "r", path: "s/SKILL.md" }] };
        if (q.endsWith("size:501..1000")) return { totalCount: 1, items: [{ owner: "a", repo: "R", path: "s/SKILL.md" }] };
        if (q.endsWith("size:1001..2000"))
          return page === 1
            ? { totalCount: 101, items: Array.from({ length: 100 }, (_, i) => ({ owner: "o", repo: "p", path: `d${i}/SKILL.md` })) }
            : { totalCount: 101, items: [{ owner: "o", repo: "p", path: "SKILL.md" }] };
        return { totalCount: 0, items: [] };
      },
    });
    const out = await discoverSkills(gh);
    expect(queries.some((q) => q.includes("filename:SKILL.md size:16001..1000000"))).toBe(true);
    expect(out.filter((r) => r.owner.toLowerCase() === "a")).toEqual([{ owner: "A", repo: "r", path: "s" }]);
    expect(out.filter((r) => r.repo === "p").length).toBe(101);
    expect(out).toContainEqual({ owner: "o", repo: "p", path: "" });
  });

  it("reads awesome lists and the marketplace, skipping failures and non-repos", async () => {
    const { gh, reads } = fake({
      raw: {
        "ComposioHQ/awesome-claude-skills/README.md":
          "[a](https://github.com/Foo/bar) [b](https://github.com/foo/Bar.git) [c](https://github.com/x/y/tree/main/skills/z/) [t](https://github.com/topics/ai) [s](https://github.com/sponsors/me) https://github.com/q/w#readme.",
        "anthropics/claude-plugins-official/.claude-plugin/marketplace.json": JSON.stringify({
          plugins: [
            { source: "./plugins/x" },
            { source: { source: "github", repo: "m/n", path: "sub" } },
            { source: { source: "github", repo: "m/k" } },
            { source: { source: "url", url: "https://github.com/u/v.git" } },
            { source: { source: "url", url: "https://gitlab.com/u/v.git" } },
          ],
        }),
      },
    });
    const out = await discoverSkills(gh);
    expect(reads).toContain("VoltAgent/awesome-agent-skills/README.md");
    expect(out).toEqual([
      { owner: "Foo", repo: "bar", path: "" },
      { owner: "x", repo: "y", path: "skills/z" },
      { owner: "q", repo: "w", path: "" },
      { owner: "anthropics", repo: "claude-plugins-official", path: "plugins/x" },
      { owner: "m", repo: "n", path: "sub" },
      { owner: "m", repo: "k", path: "" },
      { owner: "u", repo: "v", path: "" },
    ]);
  });

  it("skips a failing search slice but propagates RateLimitExhausted", async () => {
    const { gh } = fake({
      search: (q) => {
        if (q.includes("size:0..1000")) throw new Error("search limit");
        return { totalCount: 1, items: [{ owner: "o", repo: "r", path: "SKILL.md" }] };
      },
    });
    expect((await discoverSkills(gh)).length).toBe(1);
    const { gh: bad } = fake({ search: () => { throw new RateLimitExhausted("x"); } });
    await expect(discoverSkills(bad)).rejects.toBeInstanceOf(RateLimitExhausted);
  });

  it("parses hostile README link runs in linear time", async () => {
    const evil = "https://github.com/o/a" + ".".repeat(300_000) + "b https://github.com/o/c/tree/main/" + "/".repeat(300_000) + "x";
    const { gh } = fake({ raw: { "ComposioHQ/awesome-claude-skills/README.md": evil } });
    const start = Date.now();
    await discoverSkills(gh);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  describe("incremental", () => {
    const hit = (n: number) => () => ({ totalCount: 1, items: [{ owner: "o", repo: `r${n}`, path: "SKILL.md" }] });

    it("stops after the budget, saves the cursor, and resumes from it without duplicates", async () => {
      let n = 0;
      const a = fake({ search: () => { n++; return { totalCount: 1, items: [{ owner: "o", repo: `r${Math.min(n, 4)}`, path: "SKILL.md" }] }; } });
      const state = newDiscoveryState();
      await discoverSkills(a.gh, { state, budget: 2, now: new Date("2026-11-06T00:00:00Z") });
      expect(a.queries).toHaveLength(2);
      expect(state.queue[0]).toMatchObject({ lo: 2001, hi: 4000, page: 1 });
      expect(state.candidates.map((c) => c.repo)).toEqual(["r1", "r2"]);
      expect(state.candidates[0].firstSeen).toBe("2026-11-06");
      const saved = JSON.parse(JSON.stringify(state));
      const b = fake({ search: hit(2) });
      const out = await discoverSkills(b.gh, { state: saved, budget: 2 });
      expect(b.queries).toEqual(["filename:SKILL.md size:2001..4000#1", "filename:SKILL.md size:4001..8000#1"]);
      expect(out.map((r) => r.repo)).toEqual(["r1", "r2"]);
    });

    it("records lastFullSweep and wraps to the start when a sweep completes", async () => {
      const f = fake({ search: hit(1) });
      const state = newDiscoveryState();
      await discoverSkills(f.gh, { state, budget: 100, now: new Date("2026-11-06T00:00:00Z") });
      expect(f.queries).toHaveLength(6);
      expect(state.lastFullSweep).toBe("2026-11-06");
      expect(state.queue[0]).toMatchObject({ lo: 0, hi: 1000, page: 1 });
    });

    it("remembers recursive splits in the cursor", async () => {
      const f = fake({ search: (q) => (q.endsWith("size:0..1000") ? { totalCount: 1500, items: [] } : { totalCount: 0, items: [] }) });
      const state = newDiscoveryState();
      await discoverSkills(f.gh, { state, budget: 1 });
      expect(state.queue.slice(0, 3).map((t) => [t.lo, t.hi])).toEqual([[0, 500], [501, 1000], [1001, 2000]]);
    });

    it("refreshes awesome lists and the marketplace before code search, so a search quota stop keeps them", async () => {
      const f = fake({ search: () => { throw new RateLimitExhausted("x"); }, raw: { "ComposioHQ/awesome-claude-skills/README.md": "[a](https://github.com/Foo/bar)" } });
      const state = newDiscoveryState();
      await expect(discoverSkills(f.gh, { state })).rejects.toBeInstanceOf(RateLimitExhausted);
      expect(state.candidates.map((c) => c.repo)).toEqual(["bar"]);
    });

    it("keeps the state when RateLimitExhausted propagates", async () => {
      const f = fake({ search: () => { throw new RateLimitExhausted("x"); } });
      const state = newDiscoveryState();
      await expect(discoverSkills(f.gh, { state })).rejects.toBeInstanceOf(RateLimitExhausted);
      expect(state.queue[0]).toMatchObject({ lo: 0, hi: 1000, page: 1 });
    });
  });
});
