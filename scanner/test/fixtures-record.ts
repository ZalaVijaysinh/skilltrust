import type { SkillRecord } from "../src/records.js";
import type { Finding, RuleId } from "../src/types.js";

export const SHA = "a".repeat(40);
export function rec(o: Partial<SkillRecord> & { rules?: [RuleId, boolean][] } = {}): SkillRecord {
  const { rules = [], ...rest } = o;
  const findings: Finding[] = rules.map(([ruleId, disclosed]) => ({ ruleId, file: "SKILL.md", line: 1, excerpt: "x", disclosed, automatic: false }));
  return {
    id: "o__r__s", owner: "o", repo: "r", path: "s", name: "s", description: "d", stars: 1, category: "other",
    commit: SHA, contentHash: "h1", repoCreatedAt: "2025-01-01T00:00:00Z", alsoFoundIn: [], status: "ok",
    scannedAt: "2026-01-01T00:00:00Z",
    scan: { findings, score: 100, band: "low", rulesVersion: "1.0.0", filesScanned: 1, filesSkipped: 0 },
    history: [], ...rest,
  };
}
export function withScan(r: SkillRecord, scan: Partial<SkillRecord["scan"]>): SkillRecord {
  return { ...r, scan: { ...r.scan, ...scan } };
}
