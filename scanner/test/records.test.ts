import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand, parseFrontmatter, rebuildIndex, writeData, writeRecords } from "../src/records.js";
import { categorize } from "../src/category.js";
import { rec, SHA } from "./fixtures-record.js";

const base = { owner: "acme", repo: "skills", path: "tools/pdf", commit: SHA, name: "pdf" };

const sh = (c: string) => spawnSync("bash", ["-n", "-c", c], { encoding: "utf8" }); // -n: parse only, never runs
const guard = (f: string) => `if [ -e ~/.claude/skills/'${f}' ] || [ -L ~/.claude/skills/'${f}' ]; then echo 'A skill folder named ${f} already exists — not replacing it' >&2; false; else `;

describe("installCommand", () => {
  it("matches the quoted template and never replaces an existing folder", () => {
    const c = installCommand(base);
    expect(c).toBe(
      `${guard("pdf")}d=$(mktemp -d) && git clone --quiet --filter=blob:none --no-checkout 'https://github.com/acme/skills' "$d" && git -C "$d" checkout --quiet '${SHA}' -- 'tools/pdf' && mkdir -p ~/.claude/skills && cp -R "$d"/'tools/pdf' ~/.claude/skills/'pdf' && rm -rf "$d"; fi`,
    );
    expect(sh(c).status).toBe(0);
  });
  it("root skill checks out . and drops .git from the new copy", () => {
    const c = installCommand({ ...base, path: "" });
    expect(c.startsWith(guard("pdf"))).toBe(true);
    expect(c).toContain(`-- '.'`);
    expect(c).toContain(`cp -R "$d/." ~/.claude/skills/'pdf' && rm -rf ~/.claude/skills/'pdf'/.git && rm -rf "$d"; fi`);
    expect(sh(c).status).toBe(0);
  });
  it("only ever removes the temp dir and the new copy's .git", () => {
    for (const c of [installCommand(base), installCommand({ ...base, path: "" })])
      for (const m of c.matchAll(/rm -rf ([^\s;]+)/g)) expect(['"$d"', "~/.claude/skills/'pdf'/.git"]).toContain(m[1]);
  });
  it("turns hostile names into a safe slug", () => {
    const c = installCommand({ ...base, name: "x'; rm -rf ~; echo '" });
    expect(c.includes(`cp -R "$d"/'tools/pdf' ~/.claude/skills/'x-rm-rf-echo'`)).toBe(true);
    expect(c).not.toContain("rm -rf ~;");
    expect(c).toContain("A skill folder named x-rm-rf-echo already exists");
    expect(sh(c).status).toBe(0);
    expect(installCommand({ ...base, name: "$(reboot) `id` ../../etc" })).toContain(`~/.claude/skills/'reboot-id-etc'`);
  });
  it("falls back to the dir basename, then skill", () => {
    expect(installCommand({ ...base, name: "!!!", path: "a/My Dir" })).toContain(`~/.claude/skills/'my-dir'`);
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
    expect(() => installCommand({ ...base, path: "." })).toThrow();
    expect(() => installCommand({ ...base, path: ":(top)x" })).toThrow();
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
  it("collapses a mirror already on disk when the older original arrives later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-"));
    await writeData(dir, [rec({ id: "a_mirror", owner: "m", repo: "m", contentHash: "same", repoCreatedAt: "2025-05-01T00:00:00Z" })]);
    await writeData(dir, [rec({ id: "z_orig", owner: "o", repo: "o", contentHash: "same", repoCreatedAt: "2024-01-01T00:00:00Z" })]);
    const idx = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    expect(idx.map((e: { id: string }) => e.id)).toEqual(["z_orig"]);
    expect(idx[0].alsoFoundIn).toEqual(["m/m/s"]);
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).totalSkills).toBe(1);
    expect((await readdir(join(dir, "skills"))).sort()).toEqual(["a_mirror.json", "z_orig.json"]);
  });
  it("reports corrupt files instead of silently dropping them, and leaves no tmp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-"));
    await mkdir(join(dir, "skills"));
    await writeFile(join(dir, "skills", "bad.json"), '{"id": "tru');
    const warn = vi.fn();
    const res = await writeData(dir, [rec({ id: "good" })], warn);
    expect(res.skipped).toEqual(["bad.json"]);
    expect(warn).toHaveBeenCalled();
    expect((await readdir(join(dir, "skills"))).sort()).toEqual(["bad.json", "good.json"]);
  });
  it("shortens long ids deterministically and skips bad ids without stopping the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-"));
    const long = "a".repeat(400);
    const warn = vi.fn();
    const res = await writeData(dir, [rec({ id: "../evil", contentHash: "x" }), rec({ id: long, contentHash: "y" }), rec({ id: "ok", contentHash: "z" })], warn);
    const files = (await readdir(join(dir, "skills"))).sort();
    expect(files).toHaveLength(2);
    expect(files).toContain("ok.json");
    const longFile = files.find((f) => f !== "ok.json")!;
    expect(longFile).toMatch(/^a{180}-[0-9a-f]{16}\.json$/);
    expect(res.skipped).toEqual(["../evil"]);
    await writeData(dir, [rec({ id: long, contentHash: "y" })], warn);
    expect(await readdir(join(dir, "skills"))).toHaveLength(2);
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toHaveLength(2);
  });
});

describe("writeRecords / rebuildIndex", () => {
  it("writeRecords writes only the record files; rebuildIndex then builds index and report from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "st-"));
    await writeRecords(dir, [rec({ id: "o__a__s", repo: "a", contentHash: "1" })]);
    expect(await readdir(dir)).toEqual(["skills"]);
    await writeRecords(dir, [rec({ id: "o__b__s", repo: "b", contentHash: "2" })]);
    expect(await readdir(dir)).toEqual(["skills"]);
    await writeFile(join(dir, "skills", "junk.json"), "{nope");
    const { skipped } = await rebuildIndex(dir, () => {});
    expect(skipped).toEqual(["junk.json"]);
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toHaveLength(2);
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).totalSkills).toBe(2);
  });
});
