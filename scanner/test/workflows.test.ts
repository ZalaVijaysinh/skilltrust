import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (p: string) => readFileSync(new URL(`../../.github/workflows/${p}`, import.meta.url), "utf8");

test("scan workflow: checkout keeps no credentials; only the commit step gets the push token", () => {
  const yml = read("scan.yml");
  expect(yml).toMatch(/actions\/checkout@[0-9a-f]{40} # v4[.\d]*\n\s+with:\n\s+persist-credentials: false/);
  const commitStep = yml.slice(yml.indexOf("- name: Commit data"));
  expect(commitStep).toContain("x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}");
  expect(commitStep).toContain("PUSH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  expect(yml.indexOf("PUSH_TOKEN")).toBeGreaterThan(yml.indexOf("- name: Commit data"));
});

test("scan workflow starts from the latest main, not the commit it was queued on", () => {
  // a queued run (concurrency: scan) otherwise starts without the previous run's data and hits add/add conflicts
  expect(read("scan.yml")).toMatch(/actions\/checkout@[0-9a-f]{40} # v4[.\d]*\n\s+with:\n(\s+(#.*|\w[\w-]*: .*)\n)*\s+ref: main\n/);
});

test("scan workflow keeps this run's data on a conflict and rebuilds the index from the union", () => {
  const commitStep = read("scan.yml").slice(read("scan.yml").indexOf("- name: Commit data"));
  expect(commitStep).toContain("git pull --rebase -X theirs --autostash");
  expect(commitStep).toContain("git rebase --abort");
  const pull = commitStep.indexOf("git pull --rebase");
  const rebuild = commitStep.indexOf("npm run rebuild-index");
  expect(rebuild).toBeGreaterThan(pull);
  expect(commitStep.indexOf("git push")).toBeGreaterThan(rebuild);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts["rebuild-index"]).toBe("tsx scanner/src/rebuild.ts");
});

test("deploy workflow rebuilds when dependencies change", () => {
  const yml = read("deploy.yml");
  expect(yml).toContain('- "package.json"');
  expect(yml).toContain('- "package-lock.json"');
  for (const f of ["trending", "stars", "records", "rules", "score"]) expect(yml).toContain(`- "scanner/src/${f}.ts"`);
});

test("every action is pinned to a full commit, with its version in a comment", () => {
  for (const f of ["scan.yml", "deploy.yml"]) {
    const uses = [...read(f).matchAll(/uses:\s*(\S+)(.*)/g)];
    expect(uses.length, f).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) expect(`${ref}${rest}`, f).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  }
});
