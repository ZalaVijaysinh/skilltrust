import type { Band, RuleId } from "./types.js";
import { PENALTIES } from "./score.js";
import type { SkillRecord } from "./records.js";
import { groupSameName, mergeDuplicates } from "./dedupe.js";

export interface Report {
  generatedAt: string;
  totalSkills: number;
  totalRepos: number;
  byBand: Record<Band, number>;
  byRule: Record<RuleId, { count: number; percent: number; disclosed: number }>;
  byCategory: Record<string, number>;
}

/** Counts ok records only, once per contentHash (oldest repo wins) and once per repo + skill name. percent is of totalSkills, one decimal. */
export function buildReport(records: SkillRecord[]): Report {
  const skills = groupSameName(mergeDuplicates(records)).filter((r) => r.status === "ok");
  const byBand: Record<Band, number> = { low: 0, review: 0, high: 0 };
  const byRule = Object.fromEntries(
    (Object.keys(PENALTIES) as RuleId[]).map((id) => [id, { count: 0, percent: 0, disclosed: 0 }]),
  ) as Report["byRule"];
  const byCategory: Record<string, number> = {};
  for (const s of skills) {
    byBand[s.scan.band]++;
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
    const seen = new Map<RuleId, boolean>();
    for (const f of s.scan.findings) seen.set(f.ruleId, (seen.get(f.ruleId) ?? true) && f.disclosed);
    for (const [id, d] of seen) { byRule[id].count++; if (d) byRule[id].disclosed++; }
  }
  for (const id of Object.keys(byRule) as RuleId[])
    byRule[id].percent = skills.length ? Math.round((byRule[id].count / skills.length) * 1000) / 10 : 0;
  return {
    generatedAt: new Date().toISOString(),
    totalSkills: skills.length,
    totalRepos: new Set(skills.map((s) => `${s.owner}/${s.repo}`.toLowerCase())).size,
    byBand, byRule, byCategory,
  };
}
