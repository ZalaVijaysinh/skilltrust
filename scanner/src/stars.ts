import { readFile, rename } from "node:fs/promises";
import { writeAtomic } from "./records.js";

export type StarPoint = [string, number] | [string, number, "o"];
export interface StarsFile {
  repos: Record<string, { createdAt: string; points: StarPoint[] }>;
  backfilledAt?: string;
}

const KEEP_DAYS = 40;
const DAY_MS = 86_400_000;

export async function loadStars(file: string, warn: (m: string) => void): Promise<StarsFile> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return { repos: {} }; }
  try {
    const s = JSON.parse(text);
    if (s && typeof s.repos === "object" && s.repos !== null) return s;
    throw new Error("missing repos");
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
