import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "../src/pipeline.js";
import { writeData, type SkillRecord } from "../src/records.js";
import { RateLimitExhausted, TreeTruncated, type GitHub, type RepoMeta, type TreeEntry } from "../src/github.js";
import { rec } from "./fixtures-record.js";

const NOW = new Date("2026-11-06T00:00:00Z");
const sha = (c: string) => c.repeat(40);

interface FakeRepo {
  stars?: number;
  commit?: string;
  files: Record<string, string>;
  getTreeThrows?: Error;
  missing?: boolean;
}

function fake(repos: Record<string, FakeRepo>) {
  const calls = { getTree: [] as string[], getRepo: [] as string[] };
  const gh: GitHub = {
    async getStars() { return { counts: new Map(), failedBatches: 0 }; },
    async searchCode() {
      const items = Object.entries(repos).flatMap(([k, r]) =>
        Object.keys(r.files).filter((p) => p.endsWith("SKILL.md")).map((p) => ({ owner: k.split("/")[0], repo: k.split("/")[1], path: p })));
      return { totalCount: items.length, items };
    },
    async getRepo(o, r): Promise<RepoMeta | null> {
      calls.getRepo.push(`${o}/${r}`);
      const x = repos[`${o}/${r}`];
      if (x?.missing) return null;
      if (!x) throw new Error("boom");
      return { owner: o, repo: r, stars: x.stars ?? 100, defaultBranch: "main", topics: [], description: "", archived: false, fork: false, createdAt: "2025-01-01T00:00:00Z" };
    },
    async getHeadCommit(o, r) { return repos[`${o}/${r}`].commit ?? sha("b"); },
    async getTree(o, r): Promise<TreeEntry[]> {
      calls.getTree.push(`${o}/${r}`);
      const x = repos[`${o}/${r}`];
      if (x.getTreeThrows) throw x.getTreeThrows;
      return Object.entries(x.files).map(([path, t]) => ({ path, type: "blob" as const, sha: sha(String(t.length % 10)), size: t.length }));
    },
    async readRaw(o, r, _c, path) {
      const f = repos[`${o}/${r}`]?.files[path];
      if (f === undefined) throw new Error("404");
      return f;
    },
    remaining: () => Infinity,
  };
  return { gh, calls };
}

const skill = (name: string, extra = "") => ({ "SKILL.md": `---\nname: ${name}\ndescription: does ${name}\n---\nbody ${extra}\n` });
const mk = async () => mkdtemp(join(tmpdir(), "st-"));
const load = async (dir: string): Promise<SkillRecord[]> =>
  Promise.all((await readdir(join(dir, "skills"))).sort().map(async (f) => JSON.parse(await readFile(join(dir, "skills", f), "utf8"))));
const run = (gh: GitHub, dataDir: string, minStars = 10, extra: Partial<Parameters<typeof runScan>[0]> = {}) => runScan({ gh, dataDir, now: NOW, minStars, warn: () => {}, ...extra });

describe("runScan", () => {
  const seqClock = (vals: number[]) => () => vals.shift() ?? 5 * 60_000;
  const discovery = async (dir: string) => JSON.parse(await readFile(join(dir, "discovery.json"), "utf8"));
  it("records skills and writes index/report; skips repos below minStars", async () => {
    const dir = await mk();
    const { gh } = fake({ "a/big": { stars: 50, files: skill("big") }, "a/small": { stars: 2, files: skill("small") } });
    const r = await run(gh, dir);
    expect(r).toMatchObject({ scanned: 1, skipped: 1, unavailable: 0, stoppedEarly: false });
    const recs = await load(dir);
    expect(recs.map((x) => x.id)).toEqual(["a__big___root"]);
    expect(recs[0]).toMatchObject({ name: "big", description: "does big", commit: sha("b"), scannedAt: NOW.toISOString() });
    expect(recs[0].history).toEqual([{ commit: sha("b"), scannedAt: NOW.toISOString(), score: recs[0].scan.score, rulesVersion: recs[0].scan.rulesVersion }]);
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    expect(index).toHaveLength(1);
    expect(index[0].installCommand).toContain("git clone");
  });

  it("remembers repos below minStars and re-probes them at most every 7 days", async () => {
    const dir = await mk();
    const repos = { "a/small": { stars: 2, files: skill("small") } };
    const r1 = fake(repos);
    await run(r1.gh, dir);
    expect(r1.calls.getRepo).toEqual(["a/small"]);
    expect((await discovery(dir)).belowFloor).toEqual({ "a/small": { stars: 2, checkedAt: NOW.toISOString() } });
    const r2 = fake(repos);
    const s2 = await run(r2.gh, dir, 10, { now: new Date("2026-11-12T00:00:00Z") });
    expect(r2.calls.getRepo).toEqual([]);
    expect(s2.skipped).toBe(1);
    // a lower minStars re-probes at once
    const r3 = fake(repos);
    await run(r3.gh, dir, 1, { now: new Date("2026-11-12T00:00:00Z") });
    expect(r3.calls.getRepo).toEqual(["a/small"]);
    expect((await discovery(dir)).belowFloor).toEqual({});
    await writeFile(join(dir, "discovery.json"), JSON.stringify({ ...(await discovery(dir)), belowFloor: { "a/small": { stars: 2, checkedAt: NOW.toISOString() } } }));
    const r4 = fake({ "a/small": { stars: 50, files: skill("small") } });
    const s4 = await run(r4.gh, dir, 10, { now: new Date("2026-11-14T00:00:00Z") });
    expect(r4.calls.getRepo).toEqual(["a/small"]);
    expect(s4.scanned).toBe(0); // already scanned by the minStars=1 run, same commit
    expect((await discovery(dir)).belowFloor).toEqual({});
  });

  it("does not re-fetch a repo whose head commit is unchanged", async () => {
    const dir = await mk();
    const { gh } = fake({ "a/r": { files: skill("r") } });
    await run(gh, dir);
    const second = fake({ "a/r": { files: skill("r") } });
    const r = await run(second.gh, dir);
    expect(second.calls.getTree).toEqual([]);
    expect(r.scanned).toBe(0);
    expect((await load(dir))).toHaveLength(1);
  });

  it("rescans a changed repo and appends history", async () => {
    const dir = await mk();
    await run(fake({ "a/r": { files: skill("r") } }).gh, dir);
    const next = fake({ "a/r": { commit: sha("c"), files: skill("r", "changed") } });
    const r = await run(next.gh, dir);
    expect(r.scanned).toBe(1);
    const [x] = await load(dir);
    expect(x.commit).toBe(sha("c"));
    expect(x.history.map((h) => h.commit)).toEqual([sha("b"), sha("c")]);
  });

  it("processes least-recently-scanned first, new repos before known ones", async () => {
    const dir = await mk();
    await writeData(dir, [
      rec({ id: "a__old___root", owner: "a", repo: "old", path: "", commit: sha("1"), scannedAt: "2026-01-01T00:00:00Z", contentHash: "x1" }),
      rec({ id: "a__newer___root", owner: "a", repo: "newer", path: "", commit: sha("1"), scannedAt: "2026-06-01T00:00:00Z", contentHash: "x2" }),
    ]);
    const { gh, calls } = fake({
      "a/newer": { files: skill("newer") }, "a/old": { files: skill("old") }, "a/fresh": { files: skill("fresh") },
    });
    await run(gh, dir);
    expect(calls.getRepo).toEqual(["a/fresh", "a/old", "a/newer"]);
  });

  it("marks a vanished repo unavailable, keeping its scan, and drops it from report counts", async () => {
    const dir = await mk();
    await run(fake({ "a/r": { files: skill("r") }, "a/keep": { files: skill("keep", "z") } }).gh, dir);
    const before = (await load(dir)).find((x) => x.repo === "r")!;
    const { gh } = fake({ "a/r": { files: skill("r"), missing: true }, "a/keep": { files: skill("keep", "z") } });
    const r = await run(gh, dir);
    expect(r.unavailable).toBe(1);
    const after = (await load(dir)).find((x) => x.repo === "r")!;
    expect(after.status).toBe("unavailable");
    expect(after.scan).toEqual(before.scan);
    const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
    expect(report.totalSkills).toBe(1);
  });

  it("marks a skill removed or moved at a new commit unavailable, keeping its last scan", async () => {
    const dir = await mk();
    const v1 = { "x/SKILL.md": "---\nname: x\n---\n1", "y/SKILL.md": "---\nname: y\n---\n22" };
    await run(fake({ "a/m": { files: v1 } }).gh, dir);
    const before = (await load(dir)).find((q) => q.path === "y")!;
    const v2 = { "x/SKILL.md": "---\nname: x\n---\n1", "moved/y/SKILL.md": "---\nname: y\n---\n22" };
    const r = await run(fake({ "a/m": { commit: sha("c"), files: v2 } }).gh, dir);
    expect(r.unavailable).toBe(1);
    const recs = await load(dir);
    expect(recs.map((q) => [q.path, q.status])).toEqual([["moved/y", "ok"], ["x", "ok"], ["y", "unavailable"]]);
    const y = recs.find((q) => q.path === "y")!;
    expect(y.scan).toEqual(before.scan);
    expect(y.commit).toBe(sha("b"));
    const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    expect(index.find((e: { path: string }) => e.path === "y").status).toBe("unavailable");
  });

  it("a case-only rename keeps the skill ok", async () => {
    const dir = await mk();
    await run(fake({ "a/m": { files: { "Y/SKILL.md": "---\nname: y\n---\n1" } } }).gh, dir);
    await run(fake({ "a/m": { commit: sha("c"), files: { "y/SKILL.md": "---\nname: y\n---\n1" } } }).gh, dir);
    expect((await load(dir)).map((q) => [q.path, q.status])).toEqual([["y", "ok"]]);
  });

  it("a deadline-cut rescan does not mark unscanned skills unavailable", async () => {
    const dir = await mk();
    const files = { "x/SKILL.md": "---\nname: x\n---\n1", "y/SKILL.md": "---\nname: y\n---\n22" };
    await run(fake({ "a/m": { files } }).gh, dir);
    await run(fake({ "a/m": { commit: sha("c"), files } }).gh, dir, 10, { maxMinutes: 1, clock: seqClock([0, 0, 0]) });
    expect((await load(dir)).map((q) => q.status)).toEqual(["ok", "ok"]);
  });

  it("stops cleanly on RateLimitExhausted without losing any record", async () => {
    const dir = await mk();
    await writeData(dir, [rec({ id: "z__old___root", owner: "z", repo: "old", path: "", scannedAt: "2026-01-01T00:00:00Z", contentHash: "q" })]);
    const { gh } = fake({
      "a/one": { files: skill("one") },
      "b/two": { files: skill("two"), getTreeThrows: new RateLimitExhausted("quota") },
      "c/three": { files: skill("three") },
    });
    const r = await run(gh, dir);
    expect(r.stoppedEarly).toBe(true);
    expect(r.scanned).toBe(1);
    const ids = (await load(dir)).map((x) => x.id);
    expect(ids).toEqual(["a__one___root", "z__old___root"]);
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toHaveLength(2);
  });

  it("skips repos that error, leaving their records untouched", async () => {
    const dir = await mk();
    const { gh } = fake({
      "a/trunc": { files: skill("t"), getTreeThrows: new TreeTruncated("big") },
      "a/bad": { files: skill("b"), getTreeThrows: new Error("500") },
      "a/ok": { files: skill("ok") },
    });
    const r = await run(gh, dir);
    expect(r).toMatchObject({ scanned: 1, skipped: 2, unavailable: 0, stoppedEarly: false });
  });

  it("scans several skills in one repo; disclosure comes from the skill's own SKILL.md and README only", async () => {
    const dir = await mk();
    const { gh } = fake({
      "a/multi": {
        files: {
          "README.md": "This skill uses the network.",
          "x/SKILL.md": "---\nname: x\n---\nrun `./run.sh`",
          "x/README.md": "Sends data over the network.",
          "x/run.sh": "curl https://example.com/a",
          "y/SKILL.md": "no frontmatter\nrun `./run.sh`",
          "y/run.sh": "curl https://example.com/b",
        },
      },
    });
    const r = await run(gh, dir);
    expect(r.scanned).toBe(2);
    const recs = await load(dir);
    const x = recs.find((q) => q.path === "x")!;
    expect(x.scan.findings.some((f) => f.ruleId === "network" && f.disclosed)).toBe(true);
    const y = recs.find((q) => q.path === "y")!;
    expect(y.name).toBe("y");
    // the repo-root README speaks for root skills only
    expect(y.scan.findings.find((f) => f.ruleId === "network")?.disclosed).toBe(false);
  });

  it("the repo-root README discloses for a root skill", async () => {
    const dir = await mk();
    await run(fake({ "a/r": { files: { "SKILL.md": "---\nname: r\n---\nrun `./run.sh`", "README.md": "This skill uses the network.", "run.sh": "curl https://example.com/a" } } }).gh, dir);
    expect((await load(dir))[0].scan.findings.find((f) => f.ruleId === "network")?.disclosed).toBe(true);
  });

  it("per-repo saves do not touch index.json; one rebuild at the end covers everything", async () => {
    const dir = await mk();
    const f = fake({ "a/one": { files: skill("one") }, "b/two": { files: skill("twooo") } });
    const seen: boolean[] = [];
    const origTree = f.gh.getTree;
    f.gh.getTree = async (...a) => { seen.push(await stat(join(dir, "index.json")).then(() => true, () => false)); return origTree(...a); };
    await run(f.gh, dir);
    expect(seen).toEqual([false, false]);
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toHaveLength(2);
  });

  it("stops cleanly when the time budget is exceeded, still rebuilding the index", async () => {
    const dir = await mk();
    const { gh, calls } = fake({ "a/one": { files: skill("one") }, "b/two": { files: skill("two") }, "c/three": { files: skill("three") } });
    let t = 0;
    const r = await run(gh, dir, 10, { maxMinutes: 5, clock: () => (t += 2 * 60_000) });
    expect(r.stoppedEarly).toBe(true);
    expect(calls.getTree.length).toBeLessThan(3);
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8")).length).toBe(calls.getTree.length);
  });

  it("counts unread files (binary, huge, failed reads) in filesSkipped", async () => {
    const dir = await mk();
    const { gh } = fake({ "a/r": { files: { ...skill("r"), "logo.png": "x", "big.md": "y".repeat(1_100_000), "tool.sh": "echo hi" } } });
    const origRead = gh.readRaw;
    gh.readRaw = async (o, r, c, p) => { if (p === "tool.sh") throw new Error("timeout"); return origRead(o, r, c, p); };
    await run(gh, dir);
    const [x] = await load(dir);
    expect(x.scan.filesSkipped).toBe(3);
    expect(x.scan.filesScanned).toBe(1);
  });

  it("persists discovery state and spends at most the search budget", async () => {
    const dir = await mk();
    const f = fake({ "a/r": { files: skill("r") } });
    let searches = 0;
    const inner = f.gh.searchCode;
    f.gh.searchCode = async (q, p) => { searches++; return inner(q, p); };
    await run(f.gh, dir, 10, { searchBudget: 2 });
    expect(searches).toBe(2);
    const d = JSON.parse(await readFile(join(dir, "discovery.json"), "utf8"));
    expect(d.queue.length).toBeGreaterThan(0);
    expect(d.candidates[0]).toMatchObject({ owner: "a", repo: "r" });
    // candidates found earlier are still scanned when the next run finds nothing new
    f.gh.searchCode = async () => ({ totalCount: 0, items: [] });
    expect((await run(f.gh, dir, 10, { searchBudget: 1 })).scanned).toBe(0); // unchanged commit
    expect((await load(dir)).map((x) => x.repo)).toEqual(["r"]);
  });


  it("an unchanged repo checked this run goes behind one that was not checked", async () => {
    const dir = await mk();
    await writeData(dir, [
      rec({ id: "a__a___root", owner: "a", repo: "a", path: "", commit: sha("b"), scannedAt: "2026-01-01T00:00:00Z", contentHash: "h-a" }),
      rec({ id: "a__b___root", owner: "a", repo: "b", path: "", commit: sha("1"), scannedAt: "2026-06-01T00:00:00Z", contentHash: "h-b" }),
    ]);
    const repos = { "a/a": { files: skill("a") }, "a/b": { files: skill("bbbb") } };
    // run 1 stops after the first repo (a/a, unchanged)
    await run(fake(repos).gh, dir, 10, { maxMinutes: 1, clock: seqClock([0, 0]) });
    expect(Object.keys((await discovery(dir)).lastChecked)).toEqual(["a/a"]);
    const second = fake(repos);
    await run(second.gh, dir);
    expect(second.calls.getRepo).toEqual(["a/b", "a/a"]);
  });

  it("stops inside a repo at the deadline, keeps finished skills, and finishes the repo next run", async () => {
    const dir = await mk();
    const files = { "x/SKILL.md": "---\nname: x\n---\n1", "y/SKILL.md": "---\nname: y\n---\n22", "z/SKILL.md": "---\nname: z\n---\n333" };
    const r = await run(fake({ "a/m": { files } }).gh, dir, 10, { maxMinutes: 1, clock: seqClock([0, 0, 0]) });
    expect(r.stoppedEarly).toBe(true);
    expect((await load(dir)).map((x) => x.path)).toEqual(["x"]);
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toHaveLength(1);
    expect((await discovery(dir)).lastChecked?.["a/m"]).toBeUndefined();
    const r2 = await run(fake({ "a/m": { files } }).gh, dir);
    expect(r2.stoppedEarly).toBe(false);
    expect((await load(dir)).map((x) => x.path)).toEqual(["x", "y", "z"]);
  });

  const flaky = (gh: GitHub, path: string, failures: number) => {
    let left = failures;
    const orig = gh.readRaw;
    gh.readRaw = async (o, r, c, p) => { if (p === path && left-- > 0) throw new Error("timeout"); return orig(o, r, c, p); };
  };

  it("retries a failed read once; a persistent failure marks the record incomplete", async () => {
    const files = { ...skill("r"), "tool.sh": "echo hi" };
    const d1 = await mk();
    const f1 = fake({ "a/r": { files } });
    flaky(f1.gh, "tool.sh", 1);
    await run(f1.gh, d1);
    expect((await load(d1))[0]).toMatchObject({ incomplete: false });
    expect((await load(d1))[0].scan.filesSkipped).toBe(0);
    const d2 = await mk();
    const f2 = fake({ "a/r": { files } });
    flaky(f2.gh, "tool.sh", 99);
    await run(f2.gh, d2);
    expect((await load(d2))[0]).toMatchObject({ incomplete: true });
    expect((await load(d2))[0].scan.filesSkipped).toBe(1);
    expect(JSON.parse(await readFile(join(d2, "index.json"), "utf8"))[0].incomplete).toBe(true);
  });

  it("a failing README or SKILL.md read is incomplete; an absent README or a binary file is not", async () => {
    const d1 = await mk();
    const f1 = fake({ "a/r": { files: { ...skill("r"), "README.md": "hello" } } });
    flaky(f1.gh, "README.md", 99);
    await run(f1.gh, d1);
    expect((await load(d1))[0]).toMatchObject({ incomplete: true });
    expect((await load(d1))[0].scan.filesSkipped).toBeGreaterThan(0);
    const d2 = await mk();
    const f2 = fake({ "a/r": { files: { ...skill("r"), "logo.png": "x" } } });
    await run(f2.gh, d2);
    expect((await load(d2))[0]).toMatchObject({ incomplete: false });
    const d3 = await mk();
    const f3 = fake({ "a/r": { files: skill("r") } });
    flaky(f3.gh, "SKILL.md", 99);
    await run(f3.gh, d3);
    expect((await load(d3))[0]).toMatchObject({ incomplete: true });
  });

  it("never fast-paths an incomplete record, even at the same commit", async () => {
    const dir = await mk();
    const files = { ...skill("r"), "tool.sh": "echo hi" };
    const f1 = fake({ "a/r": { files } });
    flaky(f1.gh, "tool.sh", 99);
    await run(f1.gh, dir);
    const f2 = fake({ "a/r": { files } });
    await run(f2.gh, dir);
    expect(f2.calls.getTree).toEqual(["a/r"]);
    expect((await load(dir))[0]).toMatchObject({ incomplete: false });
  });

  it("a code-search limit error does not stop scanning", async () => {
    const dir = await mk();
    const f = fake({
      "a/r": { files: skill("r") },
      "ComposioHQ/awesome-claude-skills": { files: { "README.md": "[x](https://github.com/a/r)" } },
    });
    f.gh.searchCode = async () => { throw new Error("GitHub 403 for /search/code: search limit exhausted"); };
    const r = await run(f.gh, dir);
    expect(r).toMatchObject({ scanned: 1, stoppedEarly: false });
  });

  it("warns, backs up a corrupt discovery.json and starts fresh", async () => {
    const dir = await mk();
    await writeData(dir, []);
    await writeFile(join(dir, "discovery.json"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run(fake({ "a/r": { files: skill("r") } }).gh, dir);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(await readFile(join(dir, "discovery.json.bak"), "utf8")).toBe("{not json");
    expect((await discovery(dir)).candidates[0]).toMatchObject({ repo: "r" });
  });

  it("still rebuilds the index and saves discovery when the run throws", async () => {
    const dir = await mk();
    await writeData(dir, [rec({ id: "z__old___root", owner: "z", repo: "old", path: "" })]);
    let n = 0;
    await expect(run(fake({ "a/r": { files: skill("r") } }).gh, dir, 10, { clock: () => { if (n++ > 0) throw new Error("clock"); return 0; } })).rejects.toThrow("clock");
    expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8"))).toHaveLength(1);
    expect((await discovery(dir)).candidates).toHaveLength(1);
  });
});
