import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RULES } from "../../scanner/src/rules.js";
import { PENALTIES } from "../../scanner/src/score.js";

const root = resolve(import.meta.dirname, "../..");
const fixtures = join(root, "site/test/fixtures/data");

function build(data: string, out: string): void {
  // Vitest sets BASE_URL, MODE, DEV, PROD and SSR in process.env, and Astro would read them instead of its own config.
  const env: NodeJS.ProcessEnv = { ...process.env, SKILLTRUST_DATA: data, SKILLTRUST_OUT: out };
  for (const k of ["BASE_URL", "MODE", "DEV", "PROD", "SSR"]) delete env[k];
  execFileSync("npx", ["astro", "build"], { cwd: root, stdio: "pipe", env });
}
const out = mkdtempSync(join(tmpdir(), "skilltrust-site-"));
const page = (p: string) => readFileSync(join(out, p), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const sha = (c: string) => c.repeat(40);

describe("site build with fixtures", () => {
  beforeAll(() => build(fixtures, out), 120_000);

  it("lists skills in score order with band labels", () => {
    const html = page("index.html");
    const order = ["PDF Helper", "Stale Skill", "Web Fetch", "Sneaky"].map((n) => html.indexOf(n));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('href="/skilltrust/skills/acme__tools__pdf-helper/"');
    expect(html).toContain("Low risk");
    expect(html).toContain("High risk");
  });

  it("skill page shows findings, links, disclosure, install command and history", () => {
    const html = page("skills/bob__stuff__web-fetch/index.html");
    const t = text(html);
    expect(t).toContain("Sends data to these websites: api.example.com, cdn.example.org");
    expect(t).toContain("Connects to the internet");
    expect(t).not.toContain("{hosts}");
    expect(t).toContain("Runs commands on your computer");
    expect(html).toContain(`https://github.com/bob/stuff/blob/${sha("b")}/scripts/get.py#L12`);
    expect(t).toContain("This is disclosed by the author in the skill's SKILL.md or README.");
    expect(t).toContain("runs automatically when the plugin is installed");
    expect(html).toContain("git clone");
    expect(html).toContain(sha("1").slice(0, 7));
    expect(html).toContain(sha("b").slice(0, 7));
    expect((html.match(/<tr class="history-row"/g) ?? []).length).toBe(2);
    expect(html).toContain("2026-10-01");
  });

  it("shows stale and partial-scan notices", () => {
    const t = text(page("skills/old__gone__stale/index.html"));
    expect(t).toContain("no longer available");
    expect(t).toContain("Partially scanned");
    expect(text(page("index.html"))).toContain("Partially scanned");
  });

  it("escapes untrusted text everywhere", () => {
    for (const p of ["index.html", "skills/evil__x__sneaky/index.html", "skills/bob__stuff__web-fetch/index.html"]) {
      const html = page(p);
      expect(html).not.toContain("<script>alert(1)");
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<i>skill</i>");
      expect(html).not.toContain("<b>x</b>");
    }
    const html = page("skills/evil__x__sneaky/index.html");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page("skills/bob__stuff__web-fetch/index.html")).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("how-we-score lists all rules, penalties, bands and limits", () => {
    const t = text(page("how-we-score/index.html"));
    for (const r of RULES) {
      expect(t).toContain(r.sentence.replace(/:?\s*\{hosts\}/, ""));
      expect(t).toContain(`${PENALTIES[r.id]} points`);
    }
    expect(RULES).toHaveLength(8);
    expect(t).toContain("80");
    expect(t).toContain("Review before installing");
    expect(t).toContain("Limits of static scanning");
    expect(t).toContain("If the skill's SKILL.md or README tells you about it");
  });

  it("report page shows the numbers", () => {
    const t = text(page("report/index.html"));
    expect(t).toContain("3 skills");
  });

  it("publishes index.json unchanged", () => {
    expect(readFileSync(join(out, "index.json"), "utf8")).toBe(readFileSync(join(fixtures, "index.json"), "utf8"));
  });
});

describe("site build with no data directory", () => {
  const empty = mkdtempSync(join(tmpdir(), "skilltrust-empty-"));
  const out2 = join(empty, "dist");
  beforeAll(() => build(join(empty, "nope"), out2), 120_000);

  it("still builds with first-scan messages", () => {
    expect(text(readFileSync(join(out2, "index.html"), "utf8"))).toContain("First scan in progress");
    expect(text(readFileSync(join(out2, "report/index.html"), "utf8"))).toContain("First scan in progress");
    expect(existsSync(join(out2, "how-we-score/index.html"))).toBe(true);
  });
});
