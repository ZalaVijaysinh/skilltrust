import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (p: string) => readFileSync(new URL(`../../.github/workflows/${p}`, import.meta.url), "utf8");

test("scan workflow: checkout keeps no credentials; only the commit step gets the push token", () => {
  const yml = read("scan.yml");
  expect(yml).toMatch(/actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/);
  const commitStep = yml.slice(yml.indexOf("- name: Commit data"));
  expect(commitStep).toContain("x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}");
  expect(commitStep).toContain("PUSH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  expect(yml.indexOf("PUSH_TOKEN")).toBeGreaterThan(yml.indexOf("- name: Commit data"));
});

test("deploy workflow rebuilds when dependencies change", () => {
  const yml = read("deploy.yml");
  expect(yml).toContain('- "package.json"');
  expect(yml).toContain('- "package-lock.json"');
  for (const f of ["trending", "stars", "records", "rules", "score"]) expect(yml).toContain(`- "scanner/src/${f}.ts"`);
});
