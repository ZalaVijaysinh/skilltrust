export type RuleId =
  | "obfuscated" | "browser-secrets" | "reads-secrets" | "downloads-code"
  | "writes-outside" | "paid-api" | "network" | "shell";

export type Band = "low" | "review" | "high";

export interface SkillFile {
  path: string;
  text: string;
  origin: "skill" | "referenced" | "plugin-auto";
}

export interface Finding {
  ruleId: RuleId;
  file: string;
  line: number;
  /** max 160 chars */
  excerpt: string;
  disclosed: boolean;
  /** true when the file's origin is `plugin-auto` */
  automatic: boolean;
  hosts?: string[];
}

export interface ScanResult {
  findings: Finding[];
  score: number;
  band: Band;
  rulesVersion: string;
  filesScanned: number;
  filesSkipped: number;
}
