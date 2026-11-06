import { createHash } from "node:crypto";
import type { TreeEntry } from "./github.js";
import type { SkillRef } from "./discover.js";
import type { SkillRecord } from "./records.js";

/** Every directory holding a SKILL.md ("" for repo root), sorted. */
export function skillDirsInTree(tree: TreeEntry[]): string[] {
  const dirs = new Set<string>();
  for (const e of tree) {
    if (e.type !== "blob") continue;
    if (e.path === "SKILL.md") dirs.add("");
    else if (e.path.endsWith("/SKILL.md")) dirs.add(e.path.slice(0, -"/SKILL.md".length));
  }
  return [...dirs].sort();
}

/** sha256 over sorted `relativePath:blobSha` lines of files under skillDir. */
export function contentHash(tree: TreeEntry[], skillDir: string): string {
  const prefix = skillDir ? `${skillDir}/` : "";
  const lines = tree
    .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
    .map((e) => `${e.path.slice(prefix.length)}:${e.sha}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function skillId(ref: SkillRef): string {
  return `${ref.owner}__${ref.repo}__${ref.path.replaceAll("/", "~") || "_root"}`.toLowerCase();
}

/** Collapse ok-records sharing a contentHash into the oldest repo's record; others go to alsoFoundIn. */
export function mergeDuplicates(records: SkillRecord[]): SkillRecord[] {
  const groups = new Map<string, SkillRecord[]>();
  const out: SkillRecord[] = [];
  for (const r of records) {
    if (r.status !== "ok") { out.push(r); continue; }
    groups.set(r.contentHash, [...(groups.get(r.contentHash) ?? []), r]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (a.repoCreatedAt < b.repoCreatedAt ? -1 : a.repoCreatedAt > b.repoCreatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [keep, ...rest] = g;
    const also = new Set([...keep.alsoFoundIn, ...rest.flatMap((r) => [`${r.owner}/${r.repo}/${r.path}`, ...r.alsoFoundIn])]);
    out.push({ ...keep, alsoFoundIn: [...also].sort() });
  }
  return out;
}
