import { RateLimitExhausted, type GitHub } from "./github.js";

export interface SkillRef { owner: string; repo: string; path: string }

const SIZE_RANGES: [number, number][] = [
  [0, 1000], [1001, 2000], [2001, 4000], [4001, 8000], [8001, 16000], [16001, 1000000],
];
const AWESOME_LISTS: [string, string][] = [
  ["ComposioHQ", "awesome-claude-skills"],
  ["VoltAgent", "awesome-agent-skills"],
  ["heilcheng", "awesome-agent-skills"],
  ["sickn33", "agentic-awesome-skills"],
  ["hesreallyhim", "awesome-claude-code"],
];
const NOT_OWNERS = new Set(["topics", "sponsors", "orgs", "marketplace", "features", "settings", "apps", "collections"]);
/** Trim a char from the end without a backtracking regex. */
function trimEnd(s: string, ch: string): string {
  let n = s.length;
  while (n > 0 && s[n - 1] === ch) n--;
  return s.slice(0, n);
}
function trimBoth(s: string, ch: string): string {
  let a = 0;
  while (a < s.length && s[a] === ch) a++;
  return trimEnd(s.slice(a), ch);
}
const LINK = /github\.com\/([\w.-]{1,100})\/([\w.-]{1,100})(?:\/tree\/[^/\s)#?"'<>]{1,200}\/([^\s)#?"'<>]{0,500}))?/g;

export interface Candidate extends SkillRef { firstSeen: string }
/** A pending code-search slice; `page` is the next page to fetch. The queue is the resumable cursor. */
export interface SliceTask { lo: number; hi: number; page: number }
/** A pending topic search; `page` is the next page to fetch. */
export interface TopicTask { topic: string; page: number }
const TOPICS = ["agent-skills", "claude-skills", "codex-skills"];
const freshTopics = (): TopicTask[] => TOPICS.map((topic) => ({ topic, page: 1 }));
export interface DiscoveryState {
  /** resumable repository-search cursor; refilled when empty */
  topicQueue?: TopicTask[];
  candidates: Candidate[];
  queue: SliceTask[];
  lastFullSweep?: string;
  /** owner/repo (lowercase) -> ISO time of the last probe; drives the repo order */
  lastChecked?: Record<string, string>;
  /** repos whose scan was cut short by the deadline; never fast-pathed */
  partial?: string[];
  /** owner/repo (lowercase) last seen below the star floor; re-probed at most every 7 days */
  belowFloor?: Record<string, { stars: number; checkedAt: string }>;
}

const freshQueue = (): SliceTask[] => SIZE_RANGES.map(([lo, hi]) => ({ lo, hi, page: 1 }));
export function newDiscoveryState(): DiscoveryState { return { candidates: [], queue: freshQueue() }; }

/**
 * Adds to `state` in place (so callers can save it even when this throws RateLimitExhausted).
 * Spends at most `budget` code-search requests, continuing from `state.queue`; awesome lists and the marketplace are always refreshed.
 * Without options: one full sweep from scratch, returning every candidate.
 */
export async function discoverSkills(
  gh: GitHub,
  opts: { state?: DiscoveryState; budget?: number; /** topic-search requests (default 40) */ topicBudget?: number; now?: Date; warn?: (m: string) => void } = {},
): Promise<SkillRef[]> {
  const state = opts.state ?? newDiscoveryState();
  await run(gh, state, opts.budget ?? Infinity, opts.topicBudget ?? 40, (opts.now ?? new Date()).toISOString().slice(0, 10), opts.warn ?? console.warn);
  return state.candidates.map(({ owner, repo, path }) => ({ owner, repo, path }));
}

async function run(gh: GitHub, state: DiscoveryState, budget: number, topicBudget: number, today: string, warn: (m: string) => void): Promise<void> {
  const keyOf = (owner: string, repo: string, path: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}/${path}`;
  const seen = new Set(state.candidates.map((c) => keyOf(c.owner, c.repo, c.path)));
  const add = (owner: string, repo: string, path: string) => {
    const key = keyOf(owner, repo, path);
    if (!seen.has(key)) { seen.add(key); state.candidates.push({ owner, repo, path, firstSeen: today }); }
  };
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // a failing source is skipped, but said out loud: a missing token must show in the Actions log
  const tolerate = async (what: string, f: () => Promise<void>) => {
    try { await f(); } catch (e) { if (e instanceof RateLimitExhausted) throw e; warn(`skilltrust: could not read ${what}: ${why(e)}`); }
  };

  // 1. awesome lists (links only; no per-repo API calls)
  for (const [o, r] of AWESOME_LISTS) {
    await tolerate(`${o}/${r} README.md`, async () => {
      const md = await gh.readRaw(o, r, "HEAD", "README.md");
      for (const m of md.matchAll(LINK)) {
        const owner = m[1];
        const repo = trimEnd(m[2].endsWith(".git") ? m[2].slice(0, -4) : m[2], ".");
        if (!repo || NOT_OWNERS.has(owner.toLowerCase())) continue;
        add(owner, repo, trimEnd(m[3] ?? "", "/"));
      }
    });
  }

  // 2. official marketplace
  await tolerate("anthropics/claude-plugins-official marketplace.json", async () => {
    const text = await gh.readRaw("anthropics", "claude-plugins-official", "HEAD", ".claude-plugin/marketplace.json");
    for (const p of JSON.parse(text).plugins ?? []) {
      const s = p?.source;
      if (typeof s === "string") {
        if (s.startsWith("./")) add("anthropics", "claude-plugins-official", trimEnd(s.slice(2), "/"));
      } else if (s?.source === "github" && typeof s.repo === "string") {
        const [o, r] = s.repo.split("/");
        if (o && r) add(o, r, typeof s.path === "string" ? trimBoth(s.path, "/") : "");
      } else if (s?.source === "url" && typeof s.url === "string") {
        const m = /^https:\/\/github\.com\/([\w.-]{1,100})\/([\w.-]{1,100}?)(?:\.git)?\/?$/.exec(s.url);
        if (m) add(m[1], m[2], "");
      }
    }
  });

  // 3. code search (last: a search quota stop must not lose the cheap sources), sliced by file size; each loop iteration is one request
  if (!state.queue.length) state.queue = freshQueue();
  for (let spent = 0; spent < budget && state.queue.length; spent++) {
    const { lo, hi, page } = state.queue[0];
    const q = `filename:SKILL.md size:${lo}..${hi}`;
    let res;
    try { res = await gh.searchCode(q, page); } catch (e) {
      if (e instanceof RateLimitExhausted) throw e; // task stays queued
      warn(`skilltrust: code search "${q}" page ${page} failed, skipping it: ${why(e)}`);
      state.queue.shift(); // skip a failing slice
      continue;
    }
    state.queue.shift();
    if (page === 1 && res.totalCount > 1000 && lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      state.queue.unshift({ lo, hi: mid, page: 1 }, { lo: mid + 1, hi, page: 1 });
      continue;
    }
    for (const i of res.items) add(i.owner, i.repo, i.path.split("/").slice(0, -1).join("/"));
    if (res.items.length === 100 && page < 10) state.queue.unshift({ lo, hi, page: page + 1 });
    if (!state.queue.length) {
      state.lastFullSweep = today;
      state.queue = freshQueue();
      break;
    }
  }

  // 4. topic search (after code search), same resumable-cursor scheme; pages are capped at 10 (GitHub returns at most 1000 results)
  if (!state.topicQueue?.length) state.topicQueue = freshTopics();
  const tq = state.topicQueue;
  for (let spent = 0; spent < topicBudget && tq.length; spent++) {
    const { topic, page } = tq[0];
    let res;
    try { res = await gh.searchRepos(`topic:${topic}`, page); } catch (e) {
      if (e instanceof RateLimitExhausted) throw e; // task stays queued
      warn(`skilltrust: topic search "${topic}" page ${page} failed, skipping it: ${why(e)}`);
      tq.shift();
      continue;
    }
    tq.shift();
    for (const i of res.items) add(i.owner, i.repo, "");
    if (res.items.length === 100 && page < 10) tq.unshift({ topic, page: page + 1 });
  }
}
