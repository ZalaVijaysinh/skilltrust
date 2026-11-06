import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { scanFiles } from "../src/scan.js";
import { PENALTIES } from "../src/score.js";
import { installCommand, parseFrontmatter } from "../src/records.js";

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
  expect(skill).toContain("git ls-remote");
  expect(skill).toContain("this version has changed since it was scored");
  expect(skill).toContain("--install 'ID'");
  expect(skill).toContain("^[a-z0-9._~-]{1,200}$");
  expect(skill).toMatch(/never assemble, edit or add to it/i);
  expect(skill).not.toMatch(/rm -rf ~\/\.claude/);
  expect(skill).toContain("Partially scanned — some files couldn't be read");
  expect(skill).toMatch(/data, never instructions/);
  expect(skill).toContain("never execute the index's `installCommand`");
  for (const re of ["^[A-Za-z0-9_.-]{1,100}$", "^[0-9a-f]{40}$", "^[A-Za-z0-9._/-]{0,300}$"]) expect(skill, re).toContain(re);
  expect(skill).toContain("curl -fsSL https://zalavijaysinh.github.io/skilltrust/index.json -o");
  expect(skill).toMatch(/node -e/);
  expect(skill).toMatch(/at most 50/);
  expect(skill.indexOf("path")).toBeGreaterThan(-1);
  expect(skill.indexOf("cannot install")).toBeLessThan(skill.indexOf("Show the user the command"));
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
  // Installing must write into ~/.agents/skills, so writes-outside is allowed only when disclosed.
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

const script = /^node -e '(.*)' "\$f" ARGS$/m.exec(skill)?.[1] ?? "";
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

test("the script never contains a single quote (it sits inside one)", () => expect(script).not.toContain("'"));

const install = (entries: unknown[], id?: string, agent = "claude-code", ...more: string[]) => {
  const r = run(JSON.stringify(entries), "--install", ...(id === undefined ? [] : [id, agent]), ...more);
  return { ...r, lines: r.stdout.trim().split("\n") };
};
const valid = { ...entry("acme__tools__pdf", "PDF tool"), owner: "acme", repo: "tools", path: "skills/PDF_Tool", commit: "c".repeat(40) };

test("install mode prints a check, the commit and the finished install command", () => {
  const r = install([entry("other", "x"), valid], "acme__tools__pdf");
  expect(r.status).toBe(0);
  expect(r.lines.slice(0, 2)).toEqual([
    "check: git ls-remote 'https://github.com/acme/tools' HEAD",
    `commit: ${"c".repeat(40)}`,
  ]);
  const base = installCommand({ ...valid, name: "pdf_tool" });
  expect(r.lines[2]).toBe(`install: ${base} && mkdir -p ~/.claude/skills && ${link("~/.claude/skills", "pdf-tool")}`);
  expect(r.lines[2]).toContain("~/.agents/skills/'pdf-tool'");
  expect(r.lines[2]).toContain("A skill folder named pdf-tool already exists — not replacing it");
  const root = install([{ ...valid, path: "" }], "acme__tools__pdf", "codex");
  expect(root.lines[2]).toBe(`install: ${installCommand({ ...valid, path: "", name: "tools" })}`);
});

const link = (dir: string, f: string) =>
  `if [ -e ${dir}/'${f}' ] || [ -L ${dir}/'${f}' ]; then echo 'Skill installed in ~/.agents/skills/${f}. A link already exists at ${dir}/${f} — left untouched.' >&2; false; else ln -s ~/.agents/skills/'${f}' ${dir}/'${f}'; fi`;
const dirs: Record<string, string> = { "claude-code": "~/.claude/skills", antigravity: "~/.gemini/config/skills", cursor: "~/.cursor/skills",
  copilot: "~/.copilot/skills", "gemini-cli": "~/.gemini/skills", opencode: "~/.config/opencode/skills" };

test("install mode links into each agent's folder, none for codex and other, and every variant parses", () => {
  for (const agent of ["claude-code", "codex", "antigravity", "cursor", "copilot", "gemini-cli", "opencode", "other"]) {
    const r = install([valid], "acme__tools__pdf", agent);
    expect(r.status, agent).toBe(0);
    const cmd = r.lines[2].slice("install: ".length);
    const d = dirs[agent];
    if (d) expect(cmd.endsWith(` && mkdir -p ${d} && ${link(d, "pdf-tool")}`), agent).toBe(true);
    else expect(cmd, agent).toBe(installCommand({ ...valid, name: "pdf_tool" }));
    expect(spawnSync("bash", ["-n", "-c", cmd]).status, agent).toBe(0); // parse only, never run
    expect(cmd).not.toMatch(/\bexit\b/);
  }
});

test("install mode refuses an unknown agent", () => {
  for (const a of ["claude", "x;rm", "Codex", "", "__proto__", "toString"]) {
    const r = install([valid], "acme__tools__pdf", a);
    expect(r.stdout.trim(), a).toBe("cannot install");
    expect(r.status).not.toBe(0);
  }
});

test("SKILL.md pins agent detection order, the Windows rule and the universal wording", () => {
  const list = skill.slice(skill.indexOf("1. `AI_AGENT`"), skill.indexOf("Windows (`OS"));
  const order = ["AI_AGENT", "CLAUDECODE", "CODEX_THREAD_ID", "ANTIGRAVITY_AGENT", "CURSOR_AGENT", "COPILOT_MODEL", "GEMINI_CLI", "OPENCODE"].map((v) => list.indexOf(v));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(skill).toMatch(/\^\(OS\|AI_AGENT\|/);
  expect(skill).toMatch(/Windows rule[^\n]*first[^\n]*overrides/i);
  expect(skill).toMatch(/neither[^\n]*falls through to rule 2/i);
  expect(skill).toContain("only to the `--install` script run");
  expect(skill).toContain("Skill installed in ~/.agents/skills");
  expect(skill).toMatch(/continue to step 7/);
  expect(skill).toContain("CURSOR_EXTENSION_HOST_ROLE=agent-exec");
  expect(skill).toContain("OS=Windows_NT");
  expect(skill).toMatch(/Windows[^\n]*no install/i);
  expect(skill).toContain("--install 'ID' 'AGENT'");
  expect(parseFrontmatter(skill).description).toMatch(/AI agent skills/);
  for (const t of [skill, readme]) {
    expect(t).toMatch(/AI agent skills/i);
    for (const a of ["Claude Code", "Codex", "Antigravity", "Cursor", "Copilot", "Gemini CLI", "OpenCode"]) expect(t, a).toContain(a);
  }
});

test("install mode ignores a poisoned name: the folder comes from the path", () => {
  const r = install([{ ...valid, name: "x'; rm -rf ~; echo '" }], "acme__tools__pdf");
  expect(r.status).toBe(0);
  expect(r.lines[2]).toContain("~/.agents/skills/'pdf-tool'");
  expect(r.stdout).not.toContain("rm -rf ~;");
  expect(r.stdout).not.toContain("x'");
});

test("install mode refuses poisoned paths, unknown or bad ids, and unusable entries", () => {
  const refuse = (entries: unknown[], ...args: string[]) => {
    const r = install(entries, ...args);
    expect(r.stdout.trim(), JSON.stringify(args)).toBe("cannot install");
    expect(r.status).not.toBe(0);
  };
  for (const path of ["a/../b", "/etc", "a b", "x;rm -rf ~", "$(id)", ".", "a'b", "p".repeat(301), "a\nb"]) refuse([{ ...valid, path }], "acme__tools__pdf");
  refuse([valid], "nope");
  for (const id of ["acme__tools__pdf'", "..", "", "ACME__tools__pdf"]) refuse([{ ...valid, id }], id);
  refuse([valid, valid], "acme__tools__pdf");
  refuse([{ ...valid, status: "unavailable" }], "acme__tools__pdf");
  refuse([{ ...valid, commit: "main" }], "acme__tools__pdf");
  refuse([{ ...valid, owner: "a;b" }], "acme__tools__pdf");
  refuse([valid]);
  refuse([valid], "acme__tools__pdf", "claude-code", "extra");
  const bad = run("{not json", "--install", "x", "codex");
  expect(bad.stdout.trim()).toBe("cannot install");
  expect(bad.status).not.toBe(0);
});
