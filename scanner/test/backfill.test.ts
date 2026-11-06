import { describe, expect, it, vi } from "vitest";
import { backfillStars } from "../src/backfill.js";
import type { StarsFile } from "../src/stars.js";

describe("backfillStars (skipped: no usable OSS Insight endpoint)", () => {
  it("warns, makes no requests, leaves the file untouched", async () => {
    const s: StarsFile = { repos: { "a/b": { createdAt: "2026-01-01", points: [["2026-11-07", 5]] } } };
    const before = JSON.stringify(s);
    const fetchImpl = vi.fn();
    const warn = vi.fn();
    const r = await backfillStars(s, { fetchImpl: fetchImpl as any, today: "2026-11-07", warn });
    expect(r).toEqual({ filled: 0, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(s)).toBe(before);
  });
});
