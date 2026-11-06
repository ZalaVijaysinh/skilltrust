import type { Band, Finding, RuleId } from "./types.js";

export const PENALTIES: Record<RuleId, number> = {
  obfuscated: 25,
  "browser-secrets": 25,
  "reads-secrets": 20,
  "downloads-code": 15,
  "writes-outside": 10,
  "paid-api": 10,
  network: 5,
  shell: 5,
};

export function scoreFindings(findings: Finding[]): { score: number; band: Band } {
  // A rule counts once; it is disclosed only if every finding for it is disclosed.
  const disclosed = new Map<RuleId, boolean>();
  for (const x of findings) disclosed.set(x.ruleId, (disclosed.get(x.ruleId) ?? true) && x.disclosed);
  let score = 100;
  for (const [rule, d] of disclosed) score -= d ? Math.ceil(PENALTIES[rule] / 2) : PENALTIES[rule];
  score = Math.max(0, score);
  return { score, band: score >= 80 ? "low" : score >= 50 ? "review" : "high" };
}

export function bandLabel(band: Band): string {
  return { low: "Low risk", review: "Review before installing", high: "High risk" }[band];
}
