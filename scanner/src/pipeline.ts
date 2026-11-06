import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RateLimitExhausted, type GitHub, type RepoMeta, type TreeEntry } from "./github.js";
import { discoverSkills } from "./discover.js";
import { resolveSkillFiles } from "./resolve.js";
import { scanFiles } from "./scan.js";
import { RULES_VERSION } from "./rules.js";
import { categorize } from "./category.js";
import { contentHash, skillDirsInTree, skillId } from "./dedupe.js";
import { parseFrontmatter, writeData, type SkillRecord } from "./records.js";
import type { SkillFile } from "./types.js";

export interface ScanSummary { scanned: number; skipped: number; unavailable: number; stoppedEarly: boolean; writeSkipped: string[] }

const CONCURRENCY = 8;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|wasm|lock)$/i;
const key = (o: string, r: string) => `${o}/${r}`.toLowerCase();

/** Never rejects with anything but RateLimitExhausted; at most CONCURRENCY reads in flight; each path fetched once. */
function cachedReader(fetchOne: (path: string) => Promise<string>) {
  const cache = new Map<string, Promise<string>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  const read = (path: string): Promise<string> => {
    let p = cache.get(path);
    if (!p) {
      p = (async () => {
        while (active >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
        active++;
        try { return await fetchOne(path); } finally { active--; waiting.shift()?.(); }
      })();
      cache.set(path, p);
    }
    return p;
  };
  return read;
}

async function loadExisting(dataDir: string): Promise<SkillRecord[]> {
  let names: string[];
  try { names = (await readdir(join(dataDir, "skills"))).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
  const out: SkillRecord[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(await readFile(join(dataDir, "skills", n), "utf8"));
      if (r && typeof r.id === "string" && typeof r.commit === "string" && r.scan) out.push(r);
    } catch { /* unparseable: leave the file alone */ }
  }
  return out;
}

async function scanRepo(gh: GitHub, meta: RepoMeta, commit: string, tree: TreeEntry[], existing: Map<string, SkillRecord>, now: Date): Promise<SkillRecord[]> {
  const { owner, repo } = meta;
  const read = cachedReader((p) => gh.readRaw(owner, repo, commit, p));
  const readOpt = async (p: string) => {
    try { return await read(p); } catch (e) { if (e instanceof RateLimitExhausted) throw e; return ""; }
  };
  const readme = await readOpt("README.md");
  const out: SkillRecord[] = [];
  for (const dir of skillDirsInTree(tree)) {
    // warm the cache in parallel; the resolver itself reads one file at a time
    const prefix = dir ? `${dir}/` : "";
    await Promise.all(tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !BINARY.test(e.path) && (e.size ?? 0) <= 1_000_000).map((e) => readOpt(e.path)));
    const { skill, referenced, pluginAuto } = await resolveSkillFiles(tree, dir, read);
    const origin = (paths: string[], o: SkillFile["origin"]) => paths.filter((p) => !BINARY.test(p)).map((path) => ({ path, origin: o }));
    const wanted = [...origin(skill, "skill"), ...origin(referenced, "referenced"), ...origin(pluginAuto, "plugin-auto")];
    const files: SkillFile[] = (await Promise.all(wanted.map(async (w) => {
      try { return { ...w, text: await read(w.path) }; } catch (e) { if (e instanceof RateLimitExhausted) throw e; return null; }
    }))).filter((f): f is SkillFile => f !== null);
    const skillMd = await readOpt(dir ? `${dir}/SKILL.md` : "SKILL.md");
    const fm = parseFrontmatter(skillMd);
    const scan = scanFiles(files, `${skillMd}\n${readme}`);
    const path = dir;
    const id = skillId({ owner, repo, path });
    const prev = existing.get(id);
    const history = prev?.history ?? [];
    const changed = !prev || prev.commit !== commit || prev.scan.rulesVersion !== scan.rulesVersion;
    const name = fm.name || (dir ? dir.split("/").pop()! : repo);
    out.push({
      id, owner, repo, path, name, description: fm.description ?? "", stars: meta.stars,
      category: categorize(meta.topics, `${name} ${fm.description ?? ""}`),
      commit, contentHash: contentHash(tree, dir), repoCreatedAt: meta.createdAt, alsoFoundIn: [], status: "ok",
      scannedAt: now.toISOString(), scan,
      history: changed ? [...history, { commit, scannedAt: now.toISOString(), score: scan.score, rulesVersion: scan.rulesVersion }] : history,
    });
  }
  return out;
}

export async function runScan(opts: { gh: GitHub; dataDir: string; now: Date; minStars: number }): Promise<ScanSummary> {
  const { gh, dataDir, now, minStars } = opts;
  const sum: ScanSummary = { scanned: 0, skipped: 0, unavailable: 0, stoppedEarly: false, writeSkipped: [] };
  const existing = new Map((await loadExisting(dataDir)).map((r) => [r.id, r]));
  const byRepo = new Map<string, SkillRecord[]>();
  for (const r of existing.values()) byRepo.set(key(r.owner, r.repo), [...(byRepo.get(key(r.owner, r.repo)) ?? []), r]);

  const write = async (records: SkillRecord[]) => { sum.writeSkipped.push(...(await writeData(dataDir, records)).skipped); };
  const finish = async () => { await write([]); return sum; };

  let refs;
  try { refs = await discoverSkills(gh); } catch (e) {
    if (!(e instanceof RateLimitExhausted)) throw e;
    sum.stoppedEarly = true;
    return finish();
  }
  // discovery paths are only candidates; the tree decides what is a skill
  const repos = new Map<string, { owner: string; repo: string }>();
  for (const r of refs) if (!repos.has(key(r.owner, r.repo))) repos.set(key(r.owner, r.repo), { owner: r.owner, repo: r.repo });
  const oldest = (k: string) => byRepo.get(k)?.reduce((m, r) => (r.scannedAt < m ? r.scannedAt : m), "￿");
  const order = [...repos.entries()].sort(([a], [b]) => {
    const x = oldest(a), y = oldest(b);
    return x === y ? (a < b ? -1 : a > b ? 1 : 0) : x === undefined ? -1 : y === undefined ? 1 : x < y ? -1 : 1;
  });

  for (const [k, { owner, repo }] of order) {
    const known = byRepo.get(k) ?? [];
    try {
      const meta = await gh.getRepo(owner, repo);
      if (!meta) {
        if (!known.length) { sum.skipped++; continue; }
        await write(known.map((r) => ({ ...r, status: "unavailable" as const })));
        sum.unavailable += known.length;
        continue;
      }
      if (meta.stars < minStars) { sum.skipped++; continue; }
      const commit = await gh.getHeadCommit(owner, repo, meta.defaultBranch);
      if (!commit) { sum.skipped++; console.warn(`skilltrust: skipped ${owner}/${repo}: no head commit`); continue; }
      if (known.length && known.every((r) => r.commit === commit && r.status === "ok" && r.scan.rulesVersion === RULES_VERSION)) {
        sum.skipped++;
        if (known.some((r) => r.stars !== meta.stars)) await write(known.map((r) => ({ ...r, stars: meta.stars })));
        continue;
      }
      const tree = await gh.getTree(owner, repo, commit);
      const records = await scanRepo(gh, meta, commit, tree, existing, now);
      await write(records);
      for (const r of records) existing.set(r.id, r);
      sum.scanned += records.length;
    } catch (e) {
      if (e instanceof RateLimitExhausted) { sum.stoppedEarly = true; break; }
      sum.skipped++;
      console.warn(`skilltrust: skipped ${owner}/${repo}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return finish();
}
