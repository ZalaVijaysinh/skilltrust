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
import { loadStars, recordSnapshot, saveStars, starGain } from "./stars.js";
import { backfillStars } from "./backfill.js";

export interface ScanSummary { scanned: number; skipped: number; unavailable: number; stoppedEarly: boolean; writeSkipped: string[]; snapshotted?: number; backfilled?: number }

const CONCURRENCY = 8;
const BELOW_FLOOR_RECHECK_MS = 7 * 24 * 3600_000;
const TRENDING_TOP = 50;
const TRENDING_RECHECK_MS = 24 * 3600_000;
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
      commit, contentHash: contentHash(tree, dir, [...referenced, ...pluginAuto]), repoCreatedAt: meta.createdAt, alsoFoundIn: [], status: "ok",
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
  const belowFloor: NonNullable<DiscoveryState["belowFloor"]> = {};
  if (d.belowFloor && typeof d.belowFloor === "object")
    for (const [k, v] of Object.entries<any>(d.belowFloor)) if (v && Number.isFinite(v.stars) && isStr(v.checkedAt)) belowFloor[k] = { stars: v.stars, checkedAt: v.checkedAt };
  return {
    candidates: d.candidates.filter((c: any) => c && isStr(c.owner) && isStr(c.repo) && isStr(c.path) && isStr(c.firstSeen)),
    queue: d.queue.filter((t: any) => t && [t.lo, t.hi, t.page].every(Number.isFinite)),
    lastFullSweep: isStr(d.lastFullSweep) ? d.lastFullSweep : undefined,
    lastChecked,
    partial: Array.isArray(d.partial) ? d.partial.filter(isStr) : [],
    belowFloor,
    topicQueue: Array.isArray(d.topicQueue) ? d.topicQueue.filter((t: any) => t && isStr(t.topic) && Number.isFinite(t.page)) : undefined,
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
  /** UTC YYYY-MM-DD of the star snapshot; default: from `now` */ today?: string;
  /** topic-search requests per run */ topicBudget?: number;
  /** discovery warnings (failed sources and search slices) */
  warn?: (m: string) => void;
}): Promise<ScanSummary> {
  const { gh, dataDir, now, minStars } = opts;
  const today = opts.today ?? now.toISOString().slice(0, 10);
  const warn = opts.warn ?? console.warn;
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
  const belowFloor = (state.belowFloor ??= {});
  const partial = new Set(state.partial ?? []);
  const saveState = () => writeAtomic(discoveryFile, JSON.stringify({ ...state, partial: [...partial] }, null, 2) + "\n");
  const starsFile = join(dataDir, "stars.json");
  let stars: Awaited<ReturnType<typeof loadStars>> | undefined;
  try {
    try { await discoverSkills(gh, { state, budget: opts.searchBudget ?? 120, topicBudget: opts.topicBudget, now, warn: opts.warn }); } catch (e) {
      if (!(e instanceof RateLimitExhausted)) throw e;
      sum.stoppedEarly = true;
    }
    await saveState();
    // discovery paths are only candidates; the tree decides what is a skill
    const repos = new Map<string, { owner: string; repo: string }>();
    for (const r of state.candidates) if (!repos.has(key(r.owner, r.repo))) repos.set(key(r.owner, r.repo), { owner: r.owner, repo: r.repo });
    // snapshot first: today's star counts for every candidate and every recorded repo, so a deadline cut cannot lose them
    stars = await loadStars(starsFile, warn);
    const targets = new Map(repos);
    for (const [k, rs] of byRepo) if (!targets.has(k)) targets.set(k, { owner: rs[0].owner, repo: rs[0].repo });
    const counts = new Map<string, { stars: number; createdAt: string }>();
    try {
      const r = await gh.getStars([...targets.values()]);
      for (const [k, v] of r.counts) counts.set(k, v);
      if (r.failedBatches > 0) warn(`skilltrust: star snapshot: ${r.failedBatches} batch(es) failed`);
      if (r.counts.size > 0 || r.failedBatches === 0) { recordSnapshot(stars, today, r.counts, minStars); sum.snapshotted = r.counts.size; }
    } catch (e) {
      if (e instanceof RateLimitExhausted) sum.stoppedEarly = true;
      else warn(`skilltrust: star snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try { sum.backfilled = (await backfillStars(stars, { today, warn })).filled; } catch (e) { warn(`skilltrust: star backfill failed: ${e instanceof Error ? e.message : String(e)}`); }
    await saveStars(starsFile, stars);

    // never-checked first (most stars first), then the top 50 by 7-day gain not probed for 24 h, then least recently probed;
    // records' scannedAt stands in for repos without a probe time
    const oldest = (k: string) => lastChecked[k] ?? byRepo.get(k)?.reduce((m, r) => (r.scannedAt < m ? r.scannedAt : m), "\uffff") ?? "";
    const alpha = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byOldest = (a: string, b: string) => alpha(oldest(a), oldest(b)) || alpha(a, b);
    const all = [...repos.keys()];
    const never = all.filter((k) => oldest(k) === "").sort((a, b) => (counts.get(b)?.stars ?? -1) - (counts.get(a)?.stars ?? -1) || alpha(a, b));
    const cutoff = new Date(now.getTime() - TRENDING_RECHECK_MS).toISOString();
    const gain = new Map<string, number>();
    for (const k of all) {
      const g = oldest(k) !== "" && oldest(k) < cutoff ? starGain(stars.repos[k]?.points ?? [], today, 7) : null;
      if (g !== null && g > 0) gain.set(k, g);
    }
    const trending = [...gain.keys()].sort((a, b) => gain.get(b)! - gain.get(a)! || alpha(a, b)).slice(0, TRENDING_TOP);
    const picked = new Set([...never, ...trending]);
    const order = [...never, ...trending, ...all.filter((k) => !picked.has(k)).sort(byOldest)].map((k) => [k, repos.get(k)!] as const);
    const expired = () => clock() > deadline;

    for (const [k, { owner, repo }] of order) {
      if (sum.stoppedEarly) break;
      if (expired()) { sum.stoppedEarly = true; break; }
      const known = byRepo.get(k) ?? [];
      let probed = true; // false: leave lastChecked alone so the repo stays first in line
      const below = belowFloor[k];
      if (below && below.stars < minStars && now.getTime() - Date.parse(below.checkedAt) < BELOW_FLOOR_RECHECK_MS) { sum.skipped++; continue; }
      try {
        const meta = await gh.getRepo(owner, repo);
        if (!meta) {
          if (!known.length) { sum.skipped++; continue; }
          await write(known.map((r) => ({ ...r, status: "unavailable" as const })));
          sum.unavailable += known.length;
          continue;
        }
        if (meta.stars < minStars) { belowFloor[k] = { stars: meta.stars, checkedAt: now.toISOString() }; sum.skipped++; continue; }
        delete belowFloor[k];
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
        // a full rescan saw every skill dir: known skills no longer in the tree were removed or moved
        const dirs = new Set(skillDirsInTree(tree));
        const fresh = new Set(res.records.map((r) => r.id)); // ids are lowercase: a case-only rename rewrote the same record
        const gone = known.filter((r) => r.status === "ok" && !dirs.has(r.path) && !fresh.has(r.id)).map((r) => ({ ...r, status: "unavailable" as const }));
        if (gone.length) {
          await write(gone);
          for (const r of gone) existing.set(r.id, r);
          sum.unavailable += gone.length;
        }
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
    if (stars) await saveStars(starsFile, stars).catch((e) => warn(`skilltrust: could not save stars.json: ${String(e)}`));
    sum.writeSkipped.push(...(await rebuildIndex(dataDir)).skipped);
  }
  return sum;
}
