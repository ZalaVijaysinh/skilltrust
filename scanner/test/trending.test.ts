import { describe, expect, it } from "vitest";
import type { IndexEntry } from "../src/records.js";
import type { StarPoint, StarsFile } from "../src/stars.js";
import { computeTrending } from "../src/trending.js";

const TODAY = "2026-11-07";
const day = (n: number) => new Date(Date.parse(TODAY) - n * 86_400_000).toISOString().slice(0, 10);
const OLD = "2025-01-01T00:00:00Z";

function entry(owner: string, repo: string, o: Partial<IndexEntry> = {}): IndexEntry {
  const name = o.name ?? "s";
  return {
    id: `${owner}__${repo}__${name}`, name, description: "", owner, repo, path: name, stars: 0, category: "other",
    score: 90, band: "low", commit: "a", ruleIds: [], status: "ok", incomplete: false, installCommand: "", alsoFoundIn: [], ...o,
  };
}
const file = (repos: Record<string, { createdAt?: string; points: StarPoint[] }>): StarsFile => ({
  repos: Object.fromEntries(Object.entries(repos).map(([k, v]) => [k, { createdAt: v.createdAt ?? OLD, points: v.points }])),
});
const gain = (g: number, base = 1000, ago = 7): StarPoint[] => [[day(ago), base], [day(0), base + g]];

// Pads to 10+ qualifying repos (tiny gain, ranked last) so lists stay "trending"; fillers are owned by "z".
function trend(s: StarsFile, es: IndexEntry[]) {
  for (let i = 0; i < 10; i++) { s.repos[`z/f${i}`] = { createdAt: OLD, points: gain(1) }; es.push(entry("z", `f${i}`)); }
  const { week } = computeTrending(s, es, TODAY);
  return { ...week, cards: week.cards.filter((c) => c.owner !== "z") };
}

describe("computeTrending", () => {
  it("uses a 9-day-old point when no 7-day point exists, not a 10-day-old one", () => {
    const s = file({ "a/nine": { points: gain(50, 1000, 9) }, "a/ten": { points: gain(50, 1000, 10) } });
    const week = trend(s, [entry("a", "nine"), entry("a", "ten")]);
    expect(week.cards.map((c) => c.repo)).toEqual(["nine"]);
    expect(week.cards[0].gained).toBe(50);
    expect(week.cards[0].stars).toBe(1050);
  });

  it("excludes zero and negative gain and repos with only unavailable skills", () => {
    const s = file({ "a/down": { points: gain(-5) }, "a/flat": { points: gain(0) }, "a/gone": { points: gain(99) }, "a/up": { points: gain(3) } });
    const es = [entry("a", "down"), entry("a", "flat"), entry("a", "gone", { status: "unavailable" }), entry("a", "up")];
    expect(trend(s, es).cards.map((c) => c.repo)).toEqual(["up"]);
  });

  it("caps skills at 3 by score, counts the rest, picks riskiest and lowest band", () => {
    const s = file({ "a/r": { points: gain(10) } });
    const es = [
      entry("a", "r", { name: "s1", score: 95 }), entry("a", "r", { name: "s2", score: 80, band: "review" }),
      entry("a", "r", { name: "s3", score: 60, band: "high", ruleIds: ["exec"] as any }), entry("a", "r", { name: "s4", score: 90 }),
      entry("a", "r", { name: "s5", score: 20, band: "high", status: "unavailable" }),
    ];
    const c = trend(s, es).cards[0];
    expect(c.skills.map((x) => x.name)).toEqual(["s1", "s4", "s2"]);
    expect(c.moreSkills).toBe(1);
    expect(c.band).toBe("high");
    expect(c.riskiest).toEqual({ id: "a__r__s3", ruleIds: ["exec"] });
  });

  it("ranks ties by gained, then lowest score, then owner/repo", () => {
    const s = file({ "b/x": { points: gain(10) }, "a/y": { points: gain(10) }, "c/z": { points: gain(10) }, "d/big": { points: gain(20) } });
    const es = [entry("b", "x", { score: 50 }), entry("a", "y", { score: 70 }), entry("c", "z", { score: 50 }), entry("d", "big", { score: 99 })];
    expect(trend(s, es).cards.map((c) => `${c.owner}/${c.repo}`)).toEqual(["d/big", "b/x", "c/z", "a/y"]);
  });

  it("joins stars to entries case-insensitively", () => {
    const s = file({ "own/repo": { points: gain(5) } });
    expect(trend(s, [entry("Own", "Repo")]).cards).toHaveLength(1);
  });

  it("falls back to rising per list independently", () => {
    const repos: Record<string, { points: StarPoint[] }> = {};
    const es: IndexEntry[] = [];
    for (let i = 0; i < 12; i++) {
      repos[`a/r${i}`] = { points: [[day(30), 100], [day(7), 100], [day(0), 100 + 10 + i]] };
      es.push(entry("a", `r${i}`));
    }
    for (let i = 4; i < 12; i++) repos[`a/r${i}`].points = [[day(7), 100], [day(0), 120 + i]]; // no 30-day base
    const { week, month } = computeTrending(file(repos), es, TODAY);
    expect(week.kind).toBe("trending");
    expect(week.cards).toHaveLength(10);
    expect(month.kind).toBe("rising");
    expect(month.window).toBe(30);
  });

  it("rising ranks stars per day of age and only includes repos under 60 days old", () => {
    const s = file({
      "a/new": { createdAt: `${day(2)}T00:00:00Z`, points: [[day(0), 400]] },
      "a/mid": { createdAt: `${day(50)}T00:00:00Z`, points: [[day(0), 5000]] },
      "a/old": { createdAt: `${day(61)}T00:00:00Z`, points: [[day(0), 99999]] },
    });
    const es = [entry("a", "new"), entry("a", "mid"), entry("a", "old"), entry("a", "ghost")];
    const { week } = computeTrending(s, es, TODAY);
    expect(week.kind).toBe("rising");
    expect(week.window).toBe(7);
    expect(week.cards.map((c) => c.repo)).toEqual(["new", "mid"]);
    expect(week.cards[0].gained).toBe(400);
  });

  it("backfilled only when an o point was used", () => {
    const real = file({ "a/x": { points: gain(5) } });
    expect(trend(real, [entry("a", "x")]).backfilled).toBe(false);
    const bf = file({ "a/x": { points: [[day(7), 1000, "o"], [day(0), 1005]] } });
    expect(trend(bf, [entry("a", "x")]).backfilled).toBe(true);
    const unused = file({ "a/x": { points: [[day(20), 900, "o"], [day(7), 1000], [day(0), 1005]] } });
    expect(trend(unused, [entry("a", "x")]).backfilled).toBe(false);
  });
});
