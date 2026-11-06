import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
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
const run = (gh: GitHub, dataDir: string, minStars = 10, extra: Partial<Parameters<typeof runScan>[0]> = {}) => runScan({ gh, dataDir, now: NOW, minStars, ...extra });

describe("runScan", () => {
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

  it("scans several skills in one repo with README disclosure and referenced files", async () => {
    const dir = await mk();
    const { gh } = fake({
      "a/multi": {
        files: {
          "README.md": "This skill uses the network.",
          "x/SKILL.md": "---\nname: x\n---\nrun `./run.sh`",
          "x/run.sh": "curl https://example.com/a",
          "y/SKILL.md": "no frontmatter",
        },
      },
    });
    const r = await run(gh, dir);
    expect(r.scanned).toBe(2);
    const recs = await load(dir);
    const x = recs.find((q) => q.path === "x")!;
    expect(x.scan.findings.some((f) => f.ruleId === "network" && f.disclosed)).toBe(true);
    expect(recs.find((q) => q.path === "y")!.name).toBe("y");
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
    const r = await run(gh, dir, 10, { maxMinutes: 5, clock: () => (t += 3 * 60_000) });
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
});
