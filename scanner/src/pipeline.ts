import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { RateLimitExhausted, type GitHub, type RepoMeta, type TreeEntry } from "./github.js";
import { discoverSkills, newDiscoveryState, type DiscoveryState } from "./discover.js";
import { resolveSkillFiles } from "./resolve.js";
import { scanFiles } from "./scan.js";
import { RULES_VERSION } from "./rules.js";
import { categorize } from "./category.js";
import { contentHash, skillDirsInTree, skillId } from "./dedupe.js";
import { parseFrontmatter, rebuildIndex, writeAtomic, writeRecords, type SkillRecord } from "./records.js";
import type { SkillFile } from "./types.js";

export interface ScanSummary { scanned: number; skipped: number; unavailable: number; stoppedEarly: boolean; writeSkipped: string[] }

const CONCURRENCY = 8;
const MAX_READ = 1_000_000;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|wasm|lock)$/i;
const key = (o: string, r: string) => `${o}/${r}`.toLowerCase();

/** At most CONCURRENCY reads in flight; each path fetched once, with one retry. Rejections are cached. */
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
        try {
          try { return await fetchOne(path); } catch (e) { if (e instanceof RateLimitExhausted) throw e; return await fetchOne(path); } // one retry
        } finally { active--; waiting.shift()?.(); }
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

/** Scans every skill dir until `expired()`; `partial` means the deadline cut the repo short. */
async function scanRepo(gh: GitHub, meta: RepoMeta, commit: string, tree: TreeEntry[], existing: Map<string, SkillRecord>, now: Date, expired: () => boolean): Promise<{ records: SkillRecord[]; partial: boolean }> {
  const { owner, repo } = meta;
  const read = cachedReader((p) => gh.readRaw(owner, repo, commit, p));
  const sizes = new Map(tree.map((e) => [e.path, e.size]));
  const readText = async (p: string): Promise<{ text: string; failed: boolean }> => {
    try { return { text: await read(p), failed: false }; } catch (e) { if (e instanceof RateLimitExhausted) throw e; return { text: "", failed: true }; }
  };
  const out: SkillRecord[] = [];
  for (const dir of skillDirsInTree(tree)) {
    if (expired()) return { records: out, partial: true };
    // warm the cache in parallel; the resolver itself reads one file at a time
    const prefix = dir ? `${dir}/` : "";
    // disclosure: the skill's own SKILL.md and README (the repo-root README only for a root skill).
    // A missing README is fine (""); one that exists but cannot be read is not.
    const readme = tree.some((e) => e.path === `${prefix}README.md`) ? await readText(`${prefix}README.md`) : { text: "", failed: false };
    const unreadable = (p: string) => BINARY.test(p) || (sizes.get(p) ?? 0) > MAX_READ;
    await Promise.all(tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !unreadable(e.path)).map((e) => read(e.path).catch((err) => { if (err instanceof RateLimitExhausted) throw err; })));
    const { skill, referenced, pluginAuto } = await resolveSkillFiles(tree, dir, read);
    const wanted = [...skill.map((path) => ({ path, origin: "skill" as const })), ...referenced.map((path) => ({ path, origin: "referenced" as const })), ...pluginAuto.map((path) => ({ path, origin: "plugin-auto" as const }))];
    let skippedFiles = 0, failedReads = readme.failed ? 1 : 0;
    const files: SkillFile[] = (await Promise.all(wanted.map(async (w) => {
      if (unreadable(w.path)) { skippedFiles++; return null; }
      const r = await readText(w.path);
      if (r.failed) { failedReads++; return null; }
      return { ...w, text: r.text };
    }))).filter((f): f is SkillFile => f !== null);
    const skillMd = (await readText(dir ? `${dir}/SKILL.md` : "SKILL.md")).text;
    const fm = parseFrontmatter(skillMd);
    const scan = scanFiles(files, `${skillMd}\n${readme.text}`);
    scan.filesSkipped += skippedFiles + failedReads;
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
      incomplete: failedReads > 0,
      scannedAt: now.toISOString(), scan,
      history: changed ? [...history, { commit, scannedAt: now.toISOString(), score: scan.score, rulesVersion: scan.rulesVersion }] : history,
    });
  }
  return { records: out, partial: false };
}

const isStr = (x: unknown): x is string => typeof x === "string";
/** Valid parts of a saved discovery state; null when the file is not usable at all. */
function validState(d: any): DiscoveryState | null {
  if (!d || !Array.isArray(d.candidates) || !Array.isArray(d.queue)) return null;
  const lastChecked: Record<string, string> = {};
  if (d.lastChecked && typeof d.lastChecked === "object") for (const [k, v] of Object.entries(d.lastChecked)) if (isStr(v)) lastChecked[k] = v;
  return {
    candidates: d.candidates.filter((c: any) => c && isStr(c.owner) && isStr(c.repo) && isStr(c.path) && isStr(c.firstSeen)),
    queue: d.queue.filter((t: any) => t && [t.lo, t.hi, t.page].every(Number.isFinite)),
    lastFullSweep: isStr(d.lastFullSweep) ? d.lastFullSweep : undefined,
    lastChecked,
    partial: Array.isArray(d.partial) ? d.partial.filter(isStr) : [],
  };
}

async function loadState(file: string): Promise<DiscoveryState> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return newDiscoveryState(); }
  let state: DiscoveryState | null = null;
  try { state = validState(JSON.parse(text)); } catch { /* corrupt */ }
  if (state) return state;
  console.warn(`skilltrust: ${file} is corrupt; moved to ${file}.bak, starting discovery afresh`);
  await rename(file, `${file}.bak`);
  return newDiscoveryState();
}

export async function runScan(opts: {
  gh: GitHub; dataDir: string; now: Date; minStars: number;
  /** code-search requests per run */ searchBudget?: number;
  /** wall-clock limit for the repo loop */ maxMinutes?: number;
  clock?: () => number;
}): Promise<ScanSummary> {
  const { gh, dataDir, now, minStars } = opts;
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.maxMinutes ?? 240) * 60_000;
  const sum: ScanSummary = { scanned: 0, skipped: 0, unavailable: 0, stoppedEarly: false, writeSkipped: [] };
  const existing = new Map((await loadExisting(dataDir)).map((r) => [r.id, r]));
  const byRepo = new Map<string, SkillRecord[]>();
  for (const r of existing.values()) byRepo.set(key(r.owner, r.repo), [...(byRepo.get(key(r.owner, r.repo)) ?? []), r]);

  const write = async (records: SkillRecord[]) => { sum.writeSkipped.push(...(await writeRecords(dataDir, records)).skipped); };

  const discoveryFile = join(dataDir, "discovery.json");
  await mkdir(dataDir, { recursive: true });
  const state = await loadState(discoveryFile);
  const lastChecked = (state.lastChecked ??= {});
  const partial = new Set(state.partial ?? []);
  const saveState = () => writeAtomic(discoveryFile, JSON.stringify({ ...state, partial: [...partial] }, null, 2) + "\n");
  try {
    try { await discoverSkills(gh, { state, budget: opts.searchBudget ?? 120, now }); } catch (e) {
      if (!(e instanceof RateLimitExhausted)) throw e;
      sum.stoppedEarly = true;
    }
    await saveState();
    // discovery paths are only candidates; the tree decides what is a skill
    const repos = new Map<string, { owner: string; repo: string }>();
    for (const r of state.candidates) if (!repos.has(key(r.owner, r.repo))) repos.set(key(r.owner, r.repo), { owner: r.owner, repo: r.repo });
    // never-checked first, then least recently probed; records' scannedAt stands in for repos without a probe time
    const oldest = (k: string) => lastChecked[k] ?? byRepo.get(k)?.reduce((m, r) => (r.scannedAt < m ? r.scannedAt : m), "\uffff") ?? "";
    const order = [...repos.entries()].sort(([a], [b]) => {
      const x = oldest(a), y = oldest(b);
      return x === y ? (a < b ? -1 : a > b ? 1 : 0) : x < y ? -1 : 1;
    });
    const expired = () => clock() > deadline;

    for (const [k, { owner, repo }] of order) {
      if (sum.stoppedEarly) break;
      if (expired()) { sum.stoppedEarly = true; break; }
      const known = byRepo.get(k) ?? [];
      let probed = true; // false: leave lastChecked alone so the repo stays first in line
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
        if (!partial.has(k) && known.length && known.every((r) => r.commit === commit && r.status === "ok" && !r.incomplete && r.scan.rulesVersion === RULES_VERSION)) {
          sum.skipped++;
          if (known.some((r) => r.stars !== meta.stars)) await write(known.map((r) => ({ ...r, stars: meta.stars })));
          continue;
        }
        const tree = await gh.getTree(owner, repo, commit);
        const res = await scanRepo(gh, meta, commit, tree, existing, now, expired);
        await write(res.records);
        for (const r of res.records) existing.set(r.id, r);
        sum.scanned += res.records.length;
        if (res.partial) { partial.add(k); probed = false; sum.stoppedEarly = true; break; }
        partial.delete(k);
      } catch (e) {
        if (e instanceof RateLimitExhausted) { probed = false; sum.stoppedEarly = true; break; }
        sum.skipped++;
        console.warn(`skilltrust: skipped ${owner}/${repo}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (probed) lastChecked[k] = now.toISOString();
      }
    }
  } finally {
    // index.json and report.json are rebuilt once per run, from everything on disk
    await saveState();
    sum.writeSkipped.push(...(await rebuildIndex(dataDir)).skipped);
  }
  return sum;
}
