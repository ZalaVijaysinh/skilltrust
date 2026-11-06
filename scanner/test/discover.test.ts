import { describe, it, expect } from "vitest";
import { discoverSkills } from "../src/discover.js";
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
});
