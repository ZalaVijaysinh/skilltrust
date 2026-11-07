import { RULES } from "../../../scanner/src/rules.js";
import type { Band, Finding, RuleId } from "../../../scanner/src/types.js";

export const base = import.meta.env.BASE_URL.replace(/\/$/, "");
export const skillHref = (id: string) => `${base}/skills/${encodeURIComponent(id)}/`;
export const PARTIAL = "Partially scanned — some files couldn't be read; we'll retry on the next scan";

/** Plain-English sentence for one finding. Hosts come from scanned text: the caller renders this through Astro's escaping only. */
export function sentence(f: Finding): string {
  const rule = RULES.find((r) => r.id === f.ruleId);
  if (!rule) return "Does something we do not recognise";
  if (!rule.sentence.includes("{hosts}")) return rule.sentence;
  const hosts = (f.hosts ?? []).filter((h) => typeof h === "string");
  if (hosts.length === 0) return "Connects to the internet";
  const shown = hosts.slice(0, 10).join(", ");
  return rule.sentence.replace("{hosts}", hosts.length > 10 ? `${shown} and ${hosts.length - 10} more` : shown);
}

/** Sentence for a rule when no finding is at hand (trending cards): hosts are unknown, so the network rule reads "Connects to the internet". */
export const ruleSentence = (ruleId: RuleId): string => sentence({ ruleId } as Finding);

/** YYYY-MM-DD "today" for the trending lists; SKILLTRUST_TODAY (tests) counts only when well-formed. */
export const siteToday = (env: string | undefined = process.env.SKILLTRUST_TODAY, now = new Date()): string =>
  env && /^\d{4}-\d{2}-\d{2}$/.test(env) ? env : now.toISOString().slice(0, 10);

export const repoHref = (owner: string, repo: string) => `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/`;
export const SITE = "https://zalavijaysinh.github.io/skilltrust";

/** One-line verdict per band. */
export const VERDICT: Record<Band, string> = {
  low: "Fine to try",
  review: "Check before installing",
  high: "Only if you trust the author",
};

/** Abilities a skill of this category usually needs, with the reason shown next to them. */
export const EXPECTED: Record<string, { rules: RuleId[]; why: string }> = {
  media: { rules: ["paid-api", "network", "reads-secrets"], why: "a media skill usually calls an AI service over the internet with your API key" },
  research: { rules: ["network"], why: "a research skill usually looks things up on the internet" },
  marketing: { rules: ["network", "reads-secrets"], why: "a marketing skill usually talks to online services with your API key" },
  data: { rules: ["network", "reads-secrets"], why: "a data skill usually connects to databases or online services with your credentials" },
  coding: { rules: ["shell"], why: "a coding skill usually runs build and test commands" },
  devops: { rules: ["shell", "network", "downloads-code", "reads-secrets"], why: "a devops skill usually runs commands, installs tools and uses cloud credentials" },
  security: { rules: ["shell", "network"], why: "a security skill usually runs scanners and checks websites" },
  productivity: { rules: ["network", "reads-secrets"], why: "a productivity skill usually connects to your mail, calendar or notes with an API key" },
};
export const expected = (category: string, ruleId: RuleId) => EXPECTED[category]?.rules.includes(ruleId) ?? false;
