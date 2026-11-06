import { RULES } from "../../../scanner/src/rules.js";
import type { Finding } from "../../../scanner/src/types.js";

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
