import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Band, RuleId, ScanResult } from "./types.js";
import { buildReport } from "./report.js";

export interface SkillRecord {
  id: string;
  owner: string;
  repo: string;
  path: string;
  name: string;
  description: string;
  stars: number;
  category: string;
  commit: string;
  contentHash: string;
  repoCreatedAt: string;
  alsoFoundIn: string[];
  status: "ok" | "unavailable";
  scannedAt: string;
  scan: ScanResult;
  history: { commit: string; scannedAt: string; score: number; rulesVersion: string }[];
}

export interface IndexEntry {
  id: string;
  name: string;
  description: string;
  owner: string;
  repo: string;
  path: string;
  stars: number;
  category: string;
  score: number;
  band: Band;
  commit: string;
  ruleIds: RuleId[];
  status: "ok" | "unavailable";
  installCommand: string;
}

/** Minimal YAML-ish frontmatter reader: name and description only. Never throws. */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {};
  try {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return out;
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    const fm = end < 0 ? lines.slice(1) : lines.slice(1, end);
    for (let i = 0; i < fm.length; i++) {
      const m = /^(name|description):\s*(.*)$/.exec(fm[i]);
      if (!m) continue;
      const key = m[1] as "name" | "description";
      let v = m[2].trim();
      if (/^[>|][+-]?$/.test(v)) {
        const folded = v[0] === ">";
        const parts: string[] = [];
        while (i + 1 < fm.length && (/^\s/.test(fm[i + 1]) || fm[i + 1] === "")) parts.push(fm[++i].trim());
        v = folded ? parts.filter(Boolean).join(" ") : parts.join("\n").trim();
      } else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
        v = v.slice(1, -1).replace(/\\(["\\])/g, "$1");
      } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
        v = v.slice(1, -1).replaceAll("''", "'");
      }
      if (v) out[key] ??= v;
    }
  } catch { /* malformed input: return what we have */ }
  return out;
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");

/** Shell command the finder skill runs. Every value is validated and single-quoted: name is untrusted. */
export function installCommand(e: { owner: string; repo: string; path: string; commit: string; name: string }): string {
  const { owner, repo, path, commit, name } = e;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error("invalid owner/repo");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("invalid commit");
  // eslint-disable-next-line no-control-regex
  if (path.startsWith("/") || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("invalid path");
  const dest = slug(name) || slug(path.split("/").pop() ?? "") || "skill";
  const url = q(`https://github.com/${owner}/${repo}`);
  const base = `d=$(mktemp -d) && git clone --quiet --filter=blob:none --no-checkout ${url} "$d" && git -C "$d" checkout --quiet ${q(commit)} -- ${q(path || ".")} && mkdir -p ~/.claude/skills`;
  const target = `~/.claude/skills/${q(dest)}`;
  return path === ""
    ? `${base} && cp -R "$d/." ${target} && rm -rf ${target}/.git`
    : `${base} && cp -R "$d"/${q(path)} ${target}`;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function toIndexEntry(r: SkillRecord): IndexEntry {
  let cmd = "";
  try { cmd = installCommand(r); } catch { /* still indexed, no install command */ }
  return {
    id: r.id, name: cut(r.name, 100), description: cut(r.description, 500),
    owner: r.owner, repo: r.repo, path: r.path, stars: r.stars, category: r.category,
    score: r.scan.score, band: r.scan.band, commit: r.commit,
    ruleIds: [...new Set(r.scan.findings.map((f) => f.ruleId))],
    status: r.status, installCommand: cmd,
  };
}

/** Writes the given records, then rebuilds index.json and report.json from every record in skills/. Never deletes. */
export async function writeData(dir: string, records: SkillRecord[]): Promise<void> {
  const skills = join(dir, "skills");
  await mkdir(skills, { recursive: true });
  for (const r of records) await writeFile(join(skills, `${r.id}.json`), JSON.stringify(r, null, 2) + "\n");
  const all: SkillRecord[] = [];
  for (const f of (await readdir(skills)).filter((n) => n.endsWith(".json")).sort()) {
    try { all.push(JSON.parse(await readFile(join(skills, f), "utf8"))); } catch { /* unreadable file is left alone, not indexed */ }
  }
  const index = all.map(toIndexEntry).sort((a, b) => b.score - a.score || b.stars - a.stars || (a.id < b.id ? -1 : 1));
  await writeFile(join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  await writeFile(join(dir, "report.json"), JSON.stringify(buildReport(all), null, 2) + "\n");
}
