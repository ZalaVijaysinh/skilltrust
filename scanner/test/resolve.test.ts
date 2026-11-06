import { describe, it, expect } from "vitest";
import { PLUGIN_MANIFESTS, resolveSkillFiles } from "../src/resolve.js";
import { RateLimitExhausted } from "../src/github.js";
import type { TreeEntry } from "../src/github.js";

const tree = (...paths: string[]): TreeEntry[] => paths.map((path) => ({ path, type: "blob", sha: "x" }));
const reader = (files: Record<string, string>) => async (p: string) => {
  if (!(p in files)) throw new Error("404 " + p);
  return files[p];
};

describe("resolveSkillFiles", () => {
  it("includes the skill dir and follows references transitively, only to existing files", async () => {
    const files = {
      "s/SKILL.md": "See [guide](docs/guide.md) and `scripts/run.js` and `missing.md` and ../shared/util.md and https://x.com/a.md",
      "s/docs/guide.md": "uses ${CLAUDE_SKILL_DIR}/scripts/run.js",
      "s/scripts/run.js": 'import { f } from "./lib"; import "../../lib2/z.mjs"; require("../../../../etc/passwd")',
      "s/scripts/lib.ts": "export const f = 1",
      "lib2/z.mjs": "// ../deep.md",
      "deep.md": "end", "orphan.md": "nobody links here",
      "shared/util.md": "ok",
    };
    const t = tree("s/SKILL.md", "s/docs/guide.md", "s/scripts/run.js", "s/scripts/lib.ts", "lib2/z.mjs", "shared/util.md", "deep.md", "orphan.md");
    const r = await resolveSkillFiles(t, "s", reader(files));
    expect(r.skill).toEqual(["s/SKILL.md", "s/docs/guide.md", "s/scripts/lib.ts", "s/scripts/run.js"]);
    expect(r.referenced).toEqual(["deep.md", "lib2/z.mjs", "shared/util.md"]);
    expect(r.pluginAuto).toEqual([]);
  });

  it("never escapes the repo", async () => {
    const t = tree("s/SKILL.md", "etc/passwd");
    const r = await resolveSkillFiles(t, "s", reader({ "s/SKILL.md": "`../../../../etc/passwd` [x](../../etc/passwd) `/etc/passwd`" }));
    expect(r.referenced).toEqual([]);
  });

  it("terminates on cycles", async () => {
    const t = tree("s/SKILL.md", "o/a.md", "o/b.md");
    const r = await resolveSkillFiles(t, "s", reader({ "s/SKILL.md": "`../o/a.md`", "o/a.md": "`b.md`", "o/b.md": "`a.md`" }));
    expect(r.referenced).toEqual(["o/a.md", "o/b.md"]);
  });

  it("never caps files inside the skill dir", async () => {
    const big = await resolveSkillFiles(tree(...Array.from({ length: 350 }, (_, i) => `s/f${i}.md`)), "s", reader({}));
    expect(big.skill.length).toBe(350);
  });

  it("caps referenced files at 300; pluginAuto is uncapped and not counted", async () => {
    const paths = ["s/SKILL.md", ...Array.from({ length: 400 }, (_, i) => `r/f${i}.md`)];
    const text = Array.from({ length: 400 }, (_, i) => `\`../r/f${i}.md\``).join(" ");
    const r = await resolveSkillFiles(tree(...paths), "s", reader({ "s/SKILL.md": text }));
    expect(r.referenced.length).toBe(300);
    const hooks = Array.from({ length: 320 }, (_, i) => `p/hooks/h${i}.sh`);
    const pr = await resolveSkillFiles(tree("p/.claude-plugin/plugin.json", "p/skills/x/SKILL.md", ...hooks), "p/skills/x", reader({}));
    expect(pr.pluginAuto.length).toBe(321);
  });

  it("returns plugin hooks, .mcp.json and plugin.json for an ancestor plugin", async () => {
    const t = tree("p/.claude-plugin/plugin.json", "p/hooks/hooks.json", "p/hooks/guard.sh", "p/.mcp.json", "p/skills/x/SKILL.md", "p/scripts/h.sh", "p/README.md");
    const r = await resolveSkillFiles(t, "p/skills/x", reader({ "p/hooks/hooks.json": "${CLAUDE_PLUGIN_ROOT}/scripts/h.sh" }));
    expect(r.skill).toEqual(["p/skills/x/SKILL.md"]);
    expect(r.pluginAuto).toEqual(["p/.claude-plugin/plugin.json", "p/.mcp.json", "p/hooks/guard.sh", "p/hooks/hooks.json"]);
    expect(r.referenced).toEqual(["p/scripts/h.sh"]);
  });

  it.each(PLUGIN_MANIFESTS)("treats %s as a plugin manifest and returns the auto-run files", async (m) => {
    const t = tree(`p/${m}`, "p/hooks/hooks.json", "p/mcp.json", "p/config.toml", "p/skills/x/SKILL.md", "p/README.md");
    const r = await resolveSkillFiles(t, "p/skills/x", reader({}));
    expect(r.pluginAuto).toEqual([`p/${m}`, "p/config.toml", "p/hooks/hooks.json", "p/mcp.json"].sort());
  });

  it("handles hostile whitespace runs in linear time", async () => {
    const t = tree("s/SKILL.md", "s/a.js");
    for (const head of ["import", "require(", "from", "](", "`", "./"]) {
      const text = head + " ".repeat(1_000_000 - head.length);
      const start = Date.now();
      await resolveSkillFiles(t, "s", reader({ "s/SKILL.md": text, "s/a.js": text }));
      expect(Date.now() - start).toBeLessThan(1000);
    }
  });

  it("propagates RateLimitExhausted from read but skips other read errors", async () => {
    const t = tree("s/SKILL.md", "s/b.md");
    const r = await resolveSkillFiles(t, "s", async (p) => { if (p === "s/b.md") throw new Error("404"); return "`b.md`"; });
    expect(r.skill).toEqual(["s/SKILL.md", "s/b.md"]);
    await expect(resolveSkillFiles(t, "s", async () => { throw new RateLimitExhausted("x"); })).rejects.toBeInstanceOf(RateLimitExhausted);
  });

  it("follows hook scripts from the plugin root", async () => {
    const t = tree("p/.claude-plugin/plugin.json", "p/hooks/hooks.json", "p/skills/x/SKILL.md", "p/scripts/x.sh", "p/scripts/y.sh");
    const r = await resolveSkillFiles(t, "p/skills/x", reader({
      "p/hooks/hooks.json": '{"a":"${CLAUDE_PLUGIN_ROOT}/scripts/x.sh","b":"./scripts/y.sh"}',
    }));
    expect(r.referenced).toEqual(["p/scripts/x.sh", "p/scripts/y.sh"]);
  });
});
