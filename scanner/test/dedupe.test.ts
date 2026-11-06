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

  it("builds lowercase ids", () => {
    expect(skillId({ owner: "Foo", repo: "Bar", path: "a/B" })).toBe("foo__bar__a~b");
    expect(skillId({ owner: "o", repo: "r", path: "" })).toBe("o__r___root");
  });
});
