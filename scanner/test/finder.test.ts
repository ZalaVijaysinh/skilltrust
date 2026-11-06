import { readFileSync } from "node:fs";
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
});

test("README penalty numbers match score.ts", () => {
  for (const [id, n] of Object.entries(PENALTIES)) {
    expect(readme, id).toMatch(new RegExp(`\`${id}\`[^\\n]*\\b${n}\\b`));
  }
  expect(readme).toMatch(/80–100[^\n]*Low risk/);
  expect(readme).toMatch(/50–79[^\n]*Review before installing/);
  expect(readme).toMatch(/0–49[^\n]*High risk/);
});
