import type { IndexEntry } from "../../../scanner/src/records.js";

// Words that say nothing about what a skill is for.
const STOP = new Set(["the", "and", "for", "you", "use", "any", "can", "all", "not", "are", "its", "via", "new", "get", "set", "run", "how", "one", "out", "own", "per", "who", "why", "was", "has", "but", "etc",
  "skill", "skills", "with", "that", "this", "from", "your", "when", "uses", "using", "used", "into", "will", "have", "about", "them", "they", "their", "what", "which", "agent", "claude", "code",
  "help", "helps", "files", "file", "user", "users", "tool", "tools", "like", "also", "such", "only", "more", "make", "other", "work", "based", "guide", "best", "practices", "create", "creating",
  "build", "building", "manage", "management", "support", "provides", "system", "project", "task", "tasks", "workflow", "workflows", "before", "after", "need", "needs", "should", "must", "each",
  "every", "without", "then", "than", "asks", "ask", "mentions", "triggers", "trigger", "request", "requests", "want", "wants"]);
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
// Word weights are idf divided by log(number of low-risk skills), so a word only one skill has weighs 1 at any scale.
// Tuned on the 2026-11-07 data (32,621 low-risk skills): below this, matches were mostly unrelated.
const MIN_SCORE = 1;

interface Candidate { e: IndexEntry; name: Set<string>; all: Set<string> }
let cache: { pools: Map<string, Candidate[]>; idf: (w: string) => number } | null = null;

function prepare(index: IndexEntry[]) {
  const low = index.filter((e) => e.band === "low" && e.status === "ok" && !e.incomplete);
  const df = new Map<string, number>();
  const pools = new Map<string, Candidate[]>();
  for (const e of low) {
    const c = { e, name: words(e.name), all: words(`${e.name} ${e.description}`) };
    for (const w of c.all) df.set(w, (df.get(w) ?? 0) + 1);
    const p = pools.get(e.category);
    if (p) p.push(c); else pools.set(e.category, [c]);
  }
  const scale = Math.log(Math.max(2, low.length));
  return { pools, idf: (w: string) => Math.log(Math.max(2, low.length) / (df.get(w) ?? 1)) / scale };
}

/**
 * Up to 3 low-risk skills from other repos in the same category whose names share a word with this one, ranked by
 * shared words (rare words count more, words in both names double). Empty for low-risk skills, and when nothing is
 * close enough: an unrelated "alternative" would mislead.
 */
export function saferAlternatives(entry: IndexEntry, index: IndexEntry[]): IndexEntry[] {
  if (entry.band === "low") return [];
  cache ??= prepare(index);
  const { pools, idf } = cache;
  const name = words(entry.name), all = words(`${entry.name} ${entry.description}`);
  const repo = `${entry.owner}/${entry.repo}`.toLowerCase();
  const scored = (pools.get(entry.category) ?? [])
    .filter((c) => `${c.e.owner}/${c.e.repo}`.toLowerCase() !== repo && [...c.name].some((w) => name.has(w)))
    .map((c) => ({ e: c.e, s: [...c.all].filter((w) => all.has(w)).reduce((sum, w) => sum + idf(w) * (name.has(w) && c.name.has(w) ? 2 : 1), 0) }))
    .filter((x) => x.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s || b.e.score - a.e.score || b.e.stars - a.e.stars);
  const seen = new Set<string>();
  return scored.filter((x) => !seen.has(x.e.name.toLowerCase()) && seen.add(x.e.name.toLowerCase())).slice(0, 3).map((x) => x.e);
}
