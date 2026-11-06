import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadData } from "../src/lib/data.js";
import { siteToday } from "../src/lib/view.js";

it("a malformed stars.json gives stars null and a build warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "skilltrust-bad-stars-"));
  writeFileSync(join(dir, "stars.json"), JSON.stringify({ repos: { "a/b": { createdAt: 5, points: "x" } } }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(loadData(dir).stars).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("stars.json"));
  warn.mockRestore();
  writeFileSync(join(dir, "stars.json"), JSON.stringify({ repos: { "a/b": { createdAt: "2026-01-01T00:00:00Z", points: [["2026-11-07", 3]] } } }));
  expect(loadData(dir).stars).not.toBeNull();
});

it("siteToday ignores an empty or malformed SKILLTRUST_TODAY", () => {
  const now = new Date("2026-11-07T10:00:00Z");
  expect(siteToday("2026-10-01", now)).toBe("2026-10-01");
  for (const bad of ["", "tomorrow", "2026-1-1", undefined]) expect(siteToday(bad, now)).toBe("2026-11-07");
});
