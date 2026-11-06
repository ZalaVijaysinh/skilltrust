import { readFile, rename } from "node:fs/promises";
import { writeAtomic } from "./records.js";

export type StarPoint = [string, number] | [string, number, "o"];
export interface StarsFile {
  repos: Record<string, { createdAt: string; points: StarPoint[] }>;
  backfilledAt?: string;
}

const KEEP_DAYS = 40;
const DAY_MS = 86_400_000;

const validPoint = (p: unknown) =>
  Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "number" &&
  (p.length === 2 || (p.length === 3 && p[2] === "o"));

function valid(s: any): s is StarsFile {
  const r = s?.repos;
  return !!r && typeof r === "object" && !Array.isArray(r) &&
    Object.values(r).every((e: any) => typeof e?.createdAt === "string" && Array.isArray(e.points) && e.points.every(validPoint));
}

export async function loadStars(file: string, warn: (m: string) => void): Promise<StarsFile> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return { repos: {} }; }
  try {
    const s = JSON.parse(text);
    if (!valid(s)) throw new Error("unexpected shape");
    return s;
  } catch (e) {
    await rename(file, `${file}.bak`);
    warn(`skilltrust: ${file} unreadable (${String(e)}); moved to ${file}.bak and starting empty`);
    return { repos: {} };
  }
}

export function recordSnapshot(
  s: StarsFile, today: string, counts: Map<string, { stars: number; createdAt: string }>, minStars: number,
): void {
  const cutoff = new Date(Date.parse(today) - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const [key, { stars, createdAt }] of counts) {
    const e = (s.repos[key] ??= { createdAt, points: [] });
    e.createdAt = createdAt;
    e.points = e.points.filter((p) => p[0] !== today);
    e.points.push([today, stars]);
  }
  for (const [key, e] of Object.entries(s.repos)) {
    e.points = e.points.filter((p) => p[0] >= cutoff).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if ((e.points.at(-1)?.[1] ?? 0) < minStars) delete s.repos[key];
  }
}

export const saveStars = (file: string, s: StarsFile): Promise<void> => writeAtomic(file, JSON.stringify(s) + "\n");

/** Stars gained over `window` days, anchored on the latest point (at most 2 days before `today`): its stars minus the nearest point on or before latest-window (at most 9 / 35 days before latest); null if either is missing. */
export function starGain(points: StarPoint[], today: string, window: 7 | 30): number | null {
  const day = (d: string) => Date.parse(d) / DAY_MS;
  const latest = points.reduce<StarPoint | undefined>((m, p) => (!m || p[0] > m[0] ? p : m), undefined);
  if (!latest || day(latest[0]) < day(today) - 2) return null;
  const t = day(latest[0]);
  const maxAge = window === 7 ? 9 : 35;
  let base: StarPoint | undefined;
  for (const p of points) if (day(p[0]) <= t - window && day(p[0]) >= t - maxAge && (!base || p[0] > base[0])) base = p;
  return base ? latest[1] - base[1] : null;
}
