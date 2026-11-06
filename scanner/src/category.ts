const KEYWORDS: Record<string, string[]> = {
  design: ["ui", "ux", "design", "figma", "css", "frontend", "brand", "logo", "layout", "typography"],
  coding: ["code", "coding", "programming", "developer", "typescript", "javascript", "python", "rust", "refactor", "debug", "testing", "api", "git"],
  research: ["research", "paper", "papers", "literature", "citation", "academic", "survey"],
  writing: ["writing", "writer", "blog", "essay", "copywriting", "editor", "docs", "documentation", "prose"],
  marketing: ["marketing", "seo", "ads", "sales", "social", "newsletter", "growth", "campaign"],
  data: ["data", "sql", "analytics", "csv", "spreadsheet", "excel", "database", "visualization", "pandas"],
  devops: ["devops", "docker", "kubernetes", "terraform", "deploy", "deployment", "ci", "cd", "aws", "infrastructure"],
  security: ["security", "vulnerability", "pentest", "audit", "threat", "owasp", "secrets", "cve"],
  media: ["image", "images", "video", "audio", "music", "photo", "media", "podcast", "animation"],
  productivity: ["productivity", "notes", "calendar", "todo", "email", "planning", "workflow", "meeting", "tasks"],
};

/** Topics count triple; highest score wins, ties go to the earlier category in the map. */
export function categorize(topics: string[], text: string): string {
  const score: Record<string, number> = {};
  const tally = (s: string, w: number) => {
    for (const tok of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!tok) continue;
      for (const [cat, words] of Object.entries(KEYWORDS)) if (words.includes(tok)) score[cat] = (score[cat] ?? 0) + w;
    }
  };
  for (const t of topics) tally(t, 3);
  tally(text, 1);
  let best = "other";
  let top = 0;
  for (const cat of Object.keys(KEYWORDS)) if ((score[cat] ?? 0) > top) { top = score[cat]; best = cat; }
  return best;
}
