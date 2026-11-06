import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexEntry, SkillRecord } from "../../../scanner/src/records.js";
import type { Report } from "../../../scanner/src/report.js";
import { validStars, type StarsFile } from "../../../scanner/src/stars.js";

export interface SiteData {
  index: IndexEntry[];
  /** records by id; every index entry listed here has one */
  records: Map<string, SkillRecord>;
  report: Report | null;
  /** star history for the trending lists; null before the first snapshot */
  stars: StarsFile | null;
}

const SAFE_ID = /^[a-z0-9._~-]+$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

/** Everything a GitHub link is built from must pass this; the scanned data is untrusted. */
export function safeSource(e: { id: string; owner: string; repo: string; commit: string }): boolean {
  return SAFE_ID.test(e.id) && !/^\.+$/.test(e.id) && SAFE_NAME.test(e.owner) && SAFE_NAME.test(e.repo) && SHA.test(e.commit);
}

/** GitHub blob link for a file inside a scanned commit. Returns null if any part is unsafe. */
export function fileUrl(r: { owner: string; repo: string; commit: string }, file: string, line?: number): string | null {
  if (!safeSource({ id: "x", ...r }) || !file || file.startsWith("/") || file.split("/").includes("..")) return null;
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${r.owner}/${r.repo}/blob/${r.commit}/${path}${Number.isInteger(line) && line! > 0 ? `#L${line}` : ""}`;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}

/** A missing or empty data directory is normal before the first scan: returns empty data. */
export function loadData(dir: string = process.env.SKILLTRUST_DATA ?? "data"): SiteData {
  const index = readJson<IndexEntry[]>(join(dir, "index.json")) ?? [];
  const report = readJson<Report>(join(dir, "report.json"));
  let stars = readJson<StarsFile>(join(dir, "stars.json"));
  if (stars && !validStars(stars)) { console.warn("skilltrust site: stars.json is malformed; trending lists are omitted"); stars = null; }
  const records = new Map<string, SkillRecord>();
  const skills = join(dir, "skills");
  if (existsSync(skills)) {
    for (const f of readdirSync(skills).filter((n) => n.endsWith(".json"))) {
      const r = readJson<SkillRecord>(join(skills, f));
      if (r && typeof r.id === "string") records.set(r.id, r);
    }
  }
  const usable = index.filter((e) => {
    const ok = safeSource(e) && records.has(e.id);
    if (!ok) console.warn(`skilltrust site: skipping ${String(e.id)} (unsafe id or no record)`);
    return ok;
  });
  return { index: usable, records, report, stars };
}
