import type { IndexEntry } from "./records.js";
import { gainPoints, type StarsFile } from "./stars.js";
import type { Band, RuleId } from "./types.js";

export interface TrendingCard {
  owner: string;
  repo: string;
  gained: number;
  stars: number;
  band: Band;
  skills: { id: string; name: string; score: number; band: Band; incomplete: boolean }[];
  moreSkills: number;
  riskiest: { id: string; ruleIds: RuleId[] };
}
export interface TrendingList { kind: "trending" | "rising"; window: 7 | 30; cards: TrendingCard[]; backfilled: boolean }

const DAY_MS = 86_400_000;
const LIST_SIZE = 10;
const RISING_MAX_AGE_DAYS = 60;
const RISK: Record<Band, number> = { low: 0, review: 1, high: 2 };

function card(owner: string, repo: string, gained: number, stars: number, skills: IndexEntry[]): TrendingCard {
  const byScore = [...skills].sort((a, b) => b.score - a.score);
  const riskiest = skills.reduce((m, s) => (s.score < m.score ? s : m));
  return {
    owner, repo, gained, stars,
    band: skills.reduce<Band>((m, s) => (RISK[s.band] > RISK[m] ? s.band : m), "low"),
    skills: byScore.slice(0, 3).map(({ id, name, score, band, incomplete }) => ({ id, name, score, band, incomplete })),
    moreSkills: Math.max(0, byScore.length - 3),
    riskiest: { id: riskiest.id, ruleIds: riskiest.ruleIds },
  };
}

export function computeTrending(stars: StarsFile, entries: IndexEntry[], today: string): { week: TrendingList; month: TrendingList } {
  const byRepo = new Map<string, IndexEntry[]>();
  for (const e of entries) if (e.status === "ok") {
    const k = `${e.owner}/${e.repo}`.toLowerCase();
    byRepo.set(k, [...(byRepo.get(k) ?? []), e]);
  }

  const build = (window: 7 | 30): TrendingList => {
    const ranked: { c: TrendingCard; low: number; key: string }[] = [];
    const usedO: boolean[] = [];
    for (const [key, skills] of byRepo) {
      const r = stars.repos[key];
      const g = r && gainPoints(r.points, today, window);
      if (!g) continue;
      const gained = g.latest[1] - g.base[1];
      if (gained <= 0) continue;
      ranked.push({ c: card(skills[0].owner, skills[0].repo, gained, g.latest[1], skills), low: Math.min(...skills.map((s) => s.score)), key });
      usedO.push(g.latest[2] === "o" || g.base[2] === "o");
    }
    const order = ranked.map((_, i) => i).sort((a, b) => ranked[b].c.gained - ranked[a].c.gained || ranked[a].low - ranked[b].low || (ranked[a].key < ranked[b].key ? -1 : 1));
    const top = order.slice(0, LIST_SIZE);
    if (ranked.length >= LIST_SIZE) {
      return { kind: "trending", window, cards: top.map((i) => ranked[i].c), backfilled: top.some((i) => usedO[i]) };
    }
    return rising(window);
  };

  const rising = (window: 7 | 30): TrendingList => {
    const rows: { c: TrendingCard; score: number; key: string; o: boolean }[] = [];
    for (const [key, skills] of byRepo) {
      const r = stars.repos[key];
      const latest = r?.points.reduce<(typeof r.points)[number] | undefined>((m, p) => (!m || p[0] > m[0] ? p : m), undefined);
      if (!r || !latest) continue;
      const age = (Date.parse(today) - Date.parse(r.createdAt)) / DAY_MS;
      if (age > RISING_MAX_AGE_DAYS) continue;
      rows.push({ c: card(skills[0].owner, skills[0].repo, latest[1], latest[1], skills), score: latest[1] / Math.max(1, age), key, o: latest[2] === "o" });
    }
    rows.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
    const top = rows.slice(0, LIST_SIZE);
    return { kind: "rising", window, cards: top.map((r) => r.c), backfilled: top.some((r) => r.o) };
  };

  return { week: build(7), month: build(30) };
}
