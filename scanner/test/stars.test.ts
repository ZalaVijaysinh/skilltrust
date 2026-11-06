import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStars, recordSnapshot, saveStars, starGain, type StarsFile } from "../src/stars.js";

const c = (stars: number) => new Map([["a/b", { stars, createdAt: "2024-01-01T00:00:00Z" }]]);

describe("stars", () => {
  it("same-day snapshot replaces the point", () => {
    const s: StarsFile = { repos: {} };
    recordSnapshot(s, "2026-11-07", c(20), 10);
    recordSnapshot(s, "2026-11-07", c(25), 10);
    expect(s.repos["a/b"].points).toEqual([["2026-11-07", 25]]);
  });

  it("trims points older than 40 days, keeps sorted", () => {
    const s: StarsFile = { repos: { "a/b": { createdAt: "x", points: [["2026-09-27", 1], ["2026-09-28", 2], ["2026-10-01", 3]] } } };
    recordSnapshot(s, "2026-11-07", c(30), 10); // 09-27 is 41 days old, 09-28 is 40
    expect(s.repos["a/b"].points.map((p) => p[0])).toEqual(["2026-09-28", "2026-10-01", "2026-11-07"]);
  });

  it("drops repos under minStars, including existing ones", () => {
    const s: StarsFile = { repos: { "a/b": { createdAt: "x", points: [["2026-11-06", 50]] } } };
    recordSnapshot(s, "2026-11-07", c(9), 10);
    expect(s.repos["a/b"]).toBeUndefined();
  });

  it.each([
    ["null entry", '{"repos":{"a/b":null}}'],
    ["no points", '{"repos":{"a/b":{"createdAt":"x"}}}'],
    ["repos array", '{"repos":[]}'],
    ["bad createdAt", '{"repos":{"a/b":{"createdAt":1,"points":[]}}}'],
    ["bad point", '{"repos":{"a/b":{"createdAt":"x","points":[["2026-11-07","5"]]}}}'],
    ["bad source", '{"repos":{"a/b":{"createdAt":"x","points":[["2026-11-07",5,"z"]]}}}'],
  ])("invalid shape (%s) -> .bak, warn, empty", async (_n, text) => {
    const dir = await mkdtemp(join(tmpdir(), "stars-"));
    try {
      const f = join(dir, "stars.json");
      await writeFile(f, text);
      const warns: string[] = [];
      expect(await loadStars(f, (m) => warns.push(m))).toEqual({ repos: {} });
      expect(warns).toHaveLength(1);
      expect(await readFile(f + ".bak", "utf8")).toBe(text);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("corrupt file -> .bak, warn, empty; missing -> empty; save round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stars-"));
    try {
      const f = join(dir, "stars.json");
      const warns: string[] = [];
      expect(await loadStars(f, (m) => warns.push(m))).toEqual({ repos: {} });
      expect(warns).toHaveLength(0);
      await writeFile(f, "{bad");
      expect(await loadStars(f, (m) => warns.push(m))).toEqual({ repos: {} });
      expect(warns).toHaveLength(1);
      expect(await readFile(f + ".bak", "utf8")).toBe("{bad");
      const s: StarsFile = { repos: { "a/b": { createdAt: "x", points: [["2026-11-07", 12]] } } };
      await saveStars(f, s);
      expect(await loadStars(f, () => {})).toEqual(s);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("starGain", () => {
  const T = "2026-11-07";
  it("uses an exact 7-day-old point", () => expect(starGain([["2026-10-31", 100], [T, 130]], T, 7)).toBe(30));
  it("uses a 9-day-old point when nothing is nearer", () => expect(starGain([["2026-10-29", 100], [T, 130]], T, 7)).toBe(30));
  it("prefers the nearest point on or before the window", () => expect(starGain([["2026-10-29", 90], ["2026-10-30", 100], ["2026-11-03", 120], [T, 130]], T, 7)).toBe(30));
  it("does not use a 10-day-old point", () => expect(starGain([["2026-10-28", 100], [T, 130]], T, 7)).toBeNull());
  it("30-day window accepts up to 35 days", () => {
    expect(starGain([["2026-10-03", 100], [T, 130]], T, 30)).toBe(30);
    expect(starGain([["2026-10-02", 100], [T, 130]], T, 30)).toBeNull();
  });
  it("is null without a point for today or without a baseline", () => {
    expect(starGain([["2026-10-31", 100]], T, 7)).toBeNull();
    expect(starGain([[T, 130]], T, 7)).toBeNull();
    expect(starGain([], T, 7)).toBeNull();
  });
});
