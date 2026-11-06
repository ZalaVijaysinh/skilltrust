import { describe, it, expect } from "vitest";
import { resolveSkillFiles } from "../src/resolve.js";
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

  it("caps at 300 files", async () => {
    const paths = ["s/SKILL.md", ...Array.from({ length: 400 }, (_, i) => `r/f${i}.md`)];
    const text = Array.from({ length: 400 }, (_, i) => `\`../r/f${i}.md\``).join(" ");
    const r = await resolveSkillFiles(tree(...paths), "s", reader({ "s/SKILL.md": text }));
    expect(r.skill.length + r.referenced.length + r.pluginAuto.length).toBe(300);
    const big = await resolveSkillFiles(tree(...Array.from({ length: 400 }, (_, i) => `s/f${i}.md`)), "s", reader({}));
    expect(big.skill.length).toBe(300);
  });

  it("returns plugin hooks, .mcp.json and plugin.json for an ancestor plugin", async () => {
    const t = tree("p/.claude-plugin/plugin.json", "p/hooks/hooks.json", "p/hooks/guard.sh", "p/.mcp.json", "p/skills/x/SKILL.md", "p/scripts/h.sh", "p/README.md");
    const r = await resolveSkillFiles(t, "p/skills/x", reader({ "p/hooks/hooks.json": "${CLAUDE_PLUGIN_ROOT}/scripts/h.sh" }));
    expect(r.skill).toEqual(["p/skills/x/SKILL.md"]);
    expect(r.pluginAuto).toEqual(["p/.claude-plugin/plugin.json", "p/.mcp.json", "p/hooks/guard.sh", "p/hooks/hooks.json"]);
    expect(r.referenced).toEqual(["p/scripts/h.sh"]);
  });
});
