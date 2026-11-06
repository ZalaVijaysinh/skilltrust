import { RateLimitExhausted, type GitHub } from "./github.js";

export interface SkillRef { owner: string; repo: string; path: string }

const SIZE_RANGES: [number, number][] = [
  [0, 1000], [1001, 2000], [2001, 4000], [4001, 8000], [8001, 16000], [16001, 1000000],
];
const AWESOME_LISTS: [string, string][] = [
  ["ComposioHQ", "awesome-claude-skills"],
  ["VoltAgent", "awesome-agent-skills"],
  ["sickn33", "agentic-awesome-skills"],
  ["hesreallyhim", "awesome-claude-code"],
];
const NOT_OWNERS = new Set(["topics", "sponsors", "orgs", "marketplace", "features", "settings", "apps", "collections"]);
const LINK = /github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/[^/\s)#?"'<>]+\/([^\s)#?"'<>]*))?/g;

export function discoverSkills(gh: GitHub): Promise<SkillRef[]> {
  return run(gh);
}

async function run(gh: GitHub): Promise<SkillRef[]> {
  const seen = new Map<string, SkillRef>();
  const add = (owner: string, repo: string, path: string) => {
    const key = `${owner}/${repo}/${path}`.replace(/^([^/]*)\/([^/]*)/, (_, o, r) => `${o.toLowerCase()}/${r.toLowerCase()}`);
    if (!seen.has(key)) seen.set(key, { owner, repo, path });
  };
  const tolerate = async (f: () => Promise<void>) => {
    try { await f(); } catch (e) { if (e instanceof RateLimitExhausted) throw e; }
  };

  // 1. code search, sliced by file size
  const slice = async (lo: number, hi: number): Promise<void> => {
    const q = `filename:SKILL.md size:${lo}..${hi}`;
    const first = await gh.searchCode(q, 1);
    if (first.totalCount > 1000 && lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      await slice(lo, mid);
      await slice(mid + 1, hi);
      return;
    }
    let items = first.items;
    for (let page = 1; ; page++) {
      for (const i of items) add(i.owner, i.repo, i.path.split("/").slice(0, -1).join("/"));
      if (items.length < 100 || page >= 10) break;
      items = (await gh.searchCode(q, page + 1)).items;
    }
  };
  for (const [lo, hi] of SIZE_RANGES) await tolerate(() => slice(lo, hi));

  // 2. awesome lists (links only; no per-repo API calls)
  for (const [o, r] of AWESOME_LISTS) {
    await tolerate(async () => {
      const md = await gh.readRaw(o, r, "HEAD", "README.md");
      for (const m of md.matchAll(LINK)) {
        const owner = m[1];
        const repo = m[2].replace(/\.git$/, "").replace(/\.+$/, "");
        if (!repo || NOT_OWNERS.has(owner.toLowerCase())) continue;
        add(owner, repo, (m[3] ?? "").replace(/\/+$/, ""));
      }
    });
  }

  // 3. official marketplace
  await tolerate(async () => {
    const text = await gh.readRaw("anthropics", "claude-plugins-official", "HEAD", ".claude-plugin/marketplace.json");
    for (const p of JSON.parse(text).plugins ?? []) {
      const s = p?.source;
      if (typeof s === "string") {
        if (s.startsWith("./")) add("anthropics", "claude-plugins-official", s.slice(2).replace(/\/+$/, ""));
      } else if (s?.source === "github" && typeof s.repo === "string") {
        const [o, r] = s.repo.split("/");
        if (o && r) add(o, r, typeof s.path === "string" ? s.path.replace(/^\/+|\/+$/g, "") : "");
      } else if (s?.source === "url" && typeof s.url === "string") {
        const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s.url);
        if (m) add(m[1], m[2], "");
      }
    }
  });

  return [...seen.values()];
}
