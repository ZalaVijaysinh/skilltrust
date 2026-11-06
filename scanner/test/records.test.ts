import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, parseFrontmatter, writeData } from "../src/records.js";
import { categorize } from "../src/category.js";
import { rec, SHA } from "./fixtures-record.js";

const base = { owner: "acme", repo: "skills", path: "tools/pdf", commit: SHA, name: "pdf" };

describe("installCommand", () => {
  it("matches the quoted template", () => {
    expect(installCommand(base)).toBe(
      `d=$(mktemp -d) && git clone --quiet --filter=blob:none --no-checkout 'https://github.com/acme/skills' "$d" && git -C "$d" checkout --quiet '${SHA}' -- 'tools/pdf' && mkdir -p ~/.claude/skills && cp -R "$d"/'tools/pdf' ~/.claude/skills/'pdf'`,
    );
  });
  it("root skill checks out . and drops .git", () => {
    const c = installCommand({ ...base, path: "" });
    expect(c).toContain(`-- '.'`);
    expect(c).toContain(`cp -R "$d/." ~/.claude/skills/'pdf' && rm -rf ~/.claude/skills/'pdf'/.git`);
  });
  it("turns hostile names into a safe slug", () => {
    const c = installCommand({ ...base, name: "x'; rm -rf ~; echo '" });
    expect(c.endsWith(`~/.claude/skills/'x-rm-rf-echo'`)).toBe(true);
    expect(c).not.toContain("rm -rf ~");
    expect(installCommand({ ...base, name: "$(reboot) `id` ../../etc" })).toMatch(/skills\/'reboot-id-etc'$/);
  });
  it("falls back to the dir basename, then skill", () => {
    expect(installCommand({ ...base, name: "!!!", path: "a/My Dir" })).toMatch(/skills\/'my-dir'$/);
    expect(installCommand({ ...base, name: "!!!", path: "" })).toContain(`~/.claude/skills/'skill'`);
  });
  it("caps slug at 64 chars", () => {
    expect(installCommand({ ...base, name: "a".repeat(200) })).toContain(`'${"a".repeat(64)}'`);
  });
  it("quotes a path containing a single quote", () => {
    expect(installCommand({ ...base, path: "it's" })).toContain(`'it'\\''s'`);
  });
  it("rejects invalid inputs", () => {
    expect(() => installCommand({ ...base, commit: "main" })).toThrow();
    expect(() => installCommand({ ...base, commit: "A".repeat(40) })).toThrow();
    expect(() => installCommand({ ...base, path: "a/../b" })).toThrow();
    expect(() => installCommand({ ...base, path: "/abs" })).toThrow();
    expect(() => installCommand({ ...base, path: "a\nb" })).toThrow();
    expect(() => installCommand({ ...base, owner: "a b" })).toThrow();
    expect(() => installCommand({ ...base, repo: "x;y" })).toThrow();
  });
});

describe("parseFrontmatter", () => {
  it("reads plain, quoted and block values", () => {
    expect(parseFrontmatter(`---\nname: "My Skill"\ndescription: 'It''s fine'\n---\nbody`)).toEqual({ name: "My Skill", description: "It's fine" });
    expect(parseFrontmatter(`---\nname: a\ndescription: >\n  one\n  two\n\n  three\nother: x\n---`)).toEqual({ name: "a", description: "one two three" });
    expect(parseFrontmatter(`---\ndescription: |\n  l1\n  l2\n---`)).toEqual({ description: "l1\nl2" });
  });
  it("leaves name undefined when missing and never throws", () => {
    expect(parseFrontmatter(`---\ndescription: d\n---`).name).toBeUndefined();
    expect(parseFrontmatter("no frontmatter")).toEqual({});
    expect(parseFrontmatter(`---\nname: "unterminated`)).toEqual({ name: '"unterminated' });
    expect(parseFrontmatter("")).toEqual({});
  });
});

describe("categorize", () => {
  it("maps keywords", () => {
    expect(categorize(["ui", "design"], "")).toBe("design");
    expect(categorize([], "Deploy with docker and kubernetes")).toBe("devops");
    expect(categorize([], "nothing relevant")).toBe("other");
  });
});

describe("writeData", () => {
  it("writes records, sorted index, report; keeps existing records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-"));
    const a = rec({ id: "a", contentHash: "ha", stars: 5 });
    const b = rec({ id: "b", contentHash: "hb", stars: 50 });
    const c = rec({ id: "c", contentHash: "hc", stars: 1, scan: { ...rec().scan, score: 60, band: "review" } });
    await writeData(dir, [a, c]);
    await writeData(dir, [b]);
    expect((await readdir(join(dir, "skills"))).sort()).toEqual(["a.json", "b.json", "c.json"]);
    const idx = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    expect(idx.map((e: { id: string }) => e.id)).toEqual(["b", "a", "c"]);
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).totalSkills).toBe(3);
  });
  it("caps name/description and blanks a bad installCommand", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-"));
    await writeData(dir, [rec({ name: "n".repeat(300), description: "d".repeat(900), commit: "bad" })]);
    const [e] = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    expect(e.name).toHaveLength(100);
    expect(e.name.endsWith("…")).toBe(true);
    expect(e.description).toHaveLength(500);
    expect(e.installCommand).toBe("");
  });
});
