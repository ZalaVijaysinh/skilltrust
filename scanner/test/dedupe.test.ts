import { describe, it, expect } from "vitest";
import { contentHash, skillDirsInTree, skillId } from "../src/dedupe.js";
import type { TreeEntry } from "../src/github.js";

const b = (path: string, sha: string): TreeEntry => ({ path, type: "blob", sha });

describe("dedupe", () => {
  it("finds every dir with a SKILL.md", () => {
    const t = [b("SKILL.md", "1"), b("a/b/SKILL.md", "2"), b("a/README.md", "3"), b("x/NOT_SKILL.md", "4"), { path: "a", type: "tree" as const, sha: "5" }];
    expect(skillDirsInTree(t)).toEqual(["", "a/b"]);
  });

  it("hashes equal for same files in different repos/locations, differs on blob change", () => {
    const t1 = [b("s/SKILL.md", "a"), b("s/run.sh", "b"), b("other/x", "z")];
    const t2 = [b("deep/s/run.sh", "b"), b("deep/s/SKILL.md", "a")];
    expect(contentHash(t1, "s")).toBe(contentHash(t2, "deep/s"));
    expect(contentHash(t1, "s")).not.toBe(contentHash([b("s/SKILL.md", "a"), b("s/run.sh", "c")], "s"));
  });

  it("covers referenced and plugin files outside the skill dir, by repo-root path", () => {
    const skillFiles = [b("s/SKILL.md", "a"), b("s/run.sh", "b")];
    const plain = contentHash(skillFiles, "s");
    expect(contentHash([...skillFiles, b("hooks/hooks.json", "h")], "s", [])).toBe(plain);
    const withHook = contentHash([...skillFiles, b("hooks/hooks.json", "h")], "s", ["hooks/hooks.json"]);
    expect(withHook).not.toBe(plain);
    expect(contentHash([b("x/s/SKILL.md", "a"), b("x/s/run.sh", "b"), b("hooks/hooks.json", "h")], "x/s", ["hooks/hooks.json"])).toBe(withHook);
    expect(contentHash([...skillFiles, b("hooks/hooks.json", "h2")], "s", ["hooks/hooks.json"])).not.toBe(withHook);
  });

  it("builds lowercase ids", () => {
    expect(skillId({ owner: "Foo", repo: "Bar", path: "a/B" })).toBe("foo__bar__a~b");
    expect(skillId({ owner: "o", repo: "r", path: "" })).toBe("o__r___root");
  });
});

import { groupSameName, mergeDuplicates } from "../src/dedupe.js";
import type { SkillRecord } from "../src/records.js";
import { rec, withScan } from "./fixtures-record.js";

describe("mergeDuplicates", () => {
  it("keeps the oldest repo's record and lists the others", () => {
    const out = mergeDuplicates([
      rec({ id: "new", owner: "n", repo: "r", path: "s", repoCreatedAt: "2025-06-01T00:00:00Z" }),
      rec({ id: "old", owner: "o", repo: "r", path: "x", repoCreatedAt: "2024-01-01T00:00:00Z", alsoFoundIn: ["z/z/z"] }),
      rec({ id: "u", contentHash: "other", status: "unavailable" }),
      rec({ id: "u2", contentHash: "h1", status: "unavailable" }),
    ]);
    expect(out.map((r) => r.id).sort()).toEqual(["old", "u", "u2"]);
    expect(out.find((r) => r.id === "old")!.alsoFoundIn).toEqual(["n/r/s", "z/z/z"]);
  });
  it("breaks ties by smallest id", () => {
    const out = mergeDuplicates([rec({ id: "b" }), rec({ id: "a" })]);
    expect(out.map((r) => r.id)).toEqual(["a"]);
    expect(out[0].alsoFoundIn).toEqual(["o/r/s"]);
  });
});

describe("groupSameName", () => {
  const r = (id: string, path: string, score: number, o: Partial<SkillRecord> = {}) =>
    withScan(rec({ id, path, name: "Tool", contentHash: id, ...o }), { score, band: score >= 80 ? "low" : score >= 50 ? "review" : "high" });
  it("keeps one entry per repo + name: the lowest-scoring copy, the others listed with their scores", () => {
    const out = groupSameName([r("a", "skills/tool", 100), r("b", ".agents/skills/tool", 95), r("c", "x/tool", 95, { name: "tool" }), r("d", "y", 40, { repo: "other" })]);
    // equal scores: the shortest path stands for the group
    expect(out.map((x) => x.id).sort()).toEqual(["c", "d"]);
    expect(out.find((x) => x.id === "c")!.copies).toEqual([{ path: ".agents/skills/tool", score: 95, band: "low" }, { path: "skills/tool", score: 100, band: "low" }]);
    expect(out.find((x) => x.id === "d")!.copies).toEqual([]);
  });
  it("never groups unavailable records or nameless ones, and is idempotent", () => {
    const once = groupSameName([r("a", "p", 90, { status: "unavailable" }), r("b", "q", 90), r("c", "s", 90, { name: "" }), r("d", "t", 90, { name: "" })]);
    expect(once.map((x) => x.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(groupSameName(once)).toEqual(once);
  });
});
