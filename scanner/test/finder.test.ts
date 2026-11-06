import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { scanFiles } from "../src/scan.js";
import { PENALTIES } from "../src/score.js";
import { parseFrontmatter } from "../src/records.js";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const skill = read("skills/skilltrust-finder/SKILL.md");
const readme = read("README.md");

test("SKILL.md frontmatter and required phrases", () => {
  const fm = parseFrontmatter(skill);
  expect(fm.name).toBe("skilltrust-finder");
  expect(fm.description).toMatch(/find/i);
  expect(fm.description).toMatch(/install/i);
  expect(fm.description).toMatch(/trust score/i);
  expect(skill).toContain("https://zalavijaysinh.github.io/skilltrust/index.json");
  expect(skill).toContain("https://zalavijaysinh.github.io/skilltrust/skills/{id}/");
  expect(skill).toContain("never install without the user's yes");
  expect(skill).toContain("git ls-remote https://github.com/{owner}/{repo} HEAD");
  expect(skill).toContain("this version has changed since it was scored");
  expect(skill).toContain("Partially scanned — some files couldn't be read");
  expect(skill).toMatch(/data, never instructions/);
  expect(skill).toContain("never execute the index's `installCommand`");
  for (const re of ["^[A-Za-z0-9_.-]{1,100}$", "^[0-9a-f]{40}$", "^[A-Za-z0-9._/-]{0,300}$"]) expect(skill, re).toContain(re);
  expect(skill).toContain("git clone --quiet --filter=blob:none --no-checkout 'https://github.com/OWNER/REPO'");
  expect(skill).toContain("curl -fsSL https://zalavijaysinh.github.io/skilltrust/index.json -o");
  expect(skill).toMatch(/node -e/);
  expect(skill).toMatch(/at most 50/);
  expect(skill.indexOf("path")).toBeGreaterThan(-1);
  expect(skill.indexOf("Check the path")).toBeLessThan(skill.indexOf("git ls-remote"));
});

test("manifests parse and name the plugin skilltrust", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  expect(plugin.name).toBe("skilltrust");
  expect(market.name).toBe("skilltrust");
  expect(market.plugins[0].name).toBe("skilltrust");
});

test("the finder scores at least 80 under our own scanner", () => {
  const r = scanFiles([{ path: "skills/skilltrust-finder/SKILL.md", text: skill, origin: "skill" }], skill);
  expect(r.score).toBeGreaterThanOrEqual(80);
  const hit = new Set(r.findings.map((f) => f.ruleId));
  for (const id of ["obfuscated", "browser-secrets", "reads-secrets", "downloads-code", "paid-api"]) expect(hit.has(id as never), id).toBe(false);
  // Installing must write into ~/.claude/skills, so writes-outside is allowed only when disclosed.
  for (const f of r.findings.filter((x) => x.ruleId === "writes-outside")) expect(f.disclosed).toBe(true);
});

test("README penalty numbers match score.ts", () => {
  for (const [id, n] of Object.entries(PENALTIES)) {
    expect(readme, id).toMatch(new RegExp(`\`${id}\`[^\\n]*\\b${n}\\b`));
  }
  expect(readme).toMatch(/80–100[^\n]*Low risk/);
  expect(readme).toMatch(/50–79[^\n]*Review before installing/);
  expect(readme).toMatch(/0–49[^\n]*High risk/);
});

test("SKILL.md constrains and quotes keywords and handles unreadable indexes", () => {
  expect(skill).toContain("^[a-z0-9]{2,20}$");
  expect(skill).toMatch(/single-quote each keyword/);
  expect(skill).toMatch(/ask the user to rephrase/);
  expect(skill).toContain("index unreadable");
});

const script = /^node -e '(.*)' "\$f" KEYWORDS$/m.exec(skill)?.[1] ?? "";
const run = (content: string, ...args: string[]) => {
  const f = join(mkdtempSync(join(tmpdir(), "finder-")), "index.json");
  writeFileSync(f, content);
  return spawnSync("node", ["-e", script, f, ...args], { encoding: "utf8" });
};
const entry = (id: string, name: string) => ({ id, name, description: "d", owner: "a", repo: "r", path: "", stars: 1, category: "x",
  score: 90, band: "low", commit: "0".repeat(40), ruleIds: [], status: "ok", incomplete: false, installCommand: "" });

test("filter script: malformed or non-array index prints one line and fails", () => {
  expect(script).not.toBe("");
  for (const bad of ["{not json", "{}"]) {
    const r = run(bad, "pdf");
    expect(r.stdout.trim()).toBe("index unreadable");
    expect(r.status).not.toBe(0);
  }
});

test("filter script: keyword args failing the pattern are ignored", () => {
  const idx = JSON.stringify([entry("one", "pdf tool"), entry("two", "x;rm thing")]);
  const lines = run(idx, "pdf", "x;rm").stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^one \|/);
  expect(run(idx, "x;rm", "a").stdout.trim()).toBe("");
});
