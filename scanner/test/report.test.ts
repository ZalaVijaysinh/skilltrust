import { describe, it, expect } from "vitest";
import { buildReport } from "../src/report.js";
import { rec, withScan } from "./fixtures-record.js";

describe("buildReport", () => {
  it("counts duplicates once, ok only, with rule percent and disclosed", () => {
    const r = buildReport([
      rec({ id: "a", contentHash: "h1", rules: [["network", true], ["shell", false]], category: "coding" }),
      rec({ id: "b", repo: "r2", contentHash: "h1", rules: [["network", true]] }),
      withScan(rec({ id: "c", contentHash: "h2", rules: [["network", false]], category: "coding" }), { band: "high", score: 10 }),
      rec({ id: "d", contentHash: "h3", status: "unavailable" }),
    ]);
    expect(r.totalSkills).toBe(2);
    expect(r.totalRepos).toBe(1);
    expect(r.byBand).toEqual({ low: 1, review: 0, high: 1 });
    expect(r.byRule.network).toEqual({ count: 2, percent: 100, disclosed: 1 });
    expect(r.byRule.shell).toEqual({ count: 1, percent: 50, disclosed: 0 });
    expect(r.byRule.obfuscated.count).toBe(0);
    expect(r.byCategory).toEqual({ coding: 2 });
  });
  it("handles empty input", () => {
    expect(buildReport([]).byRule.network.percent).toBe(0);
  });
});
