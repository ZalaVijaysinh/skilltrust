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

/**
 * sha256 over sorted `path:blobSha` lines of every scanned file: files under skillDir (path relative to it)
 * and `outside` files such as referenced scripts and plugin hooks (path relative to the repo root).
 */
export function contentHash(tree: TreeEntry[], skillDir: string, outside: string[] = []): string {
  const prefix = skillDir ? `${skillDir}/` : "";
  const extra = new Set(outside);
  const lines = tree
    .filter((e) => e.type === "blob" && (e.path.startsWith(prefix) || extra.has(e.path)))
    .map((e) => `${e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path}:${e.sha}`)
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

/**
 * One entry per repo + skill name (the same skill copied into several folders of one repo): the lowest-scoring copy
 * stands for the group, so the list never hides risk; the others go to `copies`. Only ok records with a name group.
 */
export function groupSameName(records: SkillRecord[]): SkillRecord[] {
  const groups = new Map<string, SkillRecord[]>();
  const out: SkillRecord[] = [];
  for (const r of records) {
    const name = String(r.name ?? "").trim().toLowerCase();
    if (r.status !== "ok" || !name) { out.push({ ...r, copies: r.copies ?? [] }); continue; }
    const k = `${r.owner}/${r.repo}/${name}`.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.scan.score - b.scan.score || a.path.length - b.path.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [keep, ...rest] = g;
    const copies = [...(keep.copies ?? []), ...rest.flatMap((r) => [{ path: r.path, score: r.scan.score, band: r.scan.band }, ...(r.copies ?? [])])];
    out.push({ ...keep, copies: copies.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1)) });
  }
  return out;
}
