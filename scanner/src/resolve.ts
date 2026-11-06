import { posix } from "node:path";
import { RateLimitExhausted } from "./github.js";
import type { TreeEntry } from "./github.js";

const MAX_FILES = 300;
const MAX_READ = 1_000_000;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|wasm|lock)$/i;
const PATTERNS = [
  /\]\(\s{0,20}<?([^)\s>]{1,500})/g, // markdown links
  /`([^`\n]{1,500})`/g, // backticked paths
  /\b(?:from|import|require)\s{0,20}\(?\s{0,20}["']([^"'\n]{1,500})["']/g, // JS/TS imports
  /(?:^|[\s"'(=])(\.{1,2}\/[\w@./-]{1,500})/g, // bare ./ and ../ paths
  /(\$\{?(?:CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}?\/[^\s"'`)\]]{1,500})/g, // bare env-var paths
];

export const PLUGIN_MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", ".antigravity-plugin/plugin.json", ".plugin/plugin.json", "gemini-extension.json"];
const PLUGIN_EXTRA = ["hooks.json", ".mcp.json", "mcp.json", "config.toml"];

export async function resolveSkillFiles(
  tree: TreeEntry[],
  skillDir: string,
  read: (path: string) => Promise<string>,
): Promise<{ skill: string[]; referenced: string[]; pluginAuto: string[] }> {
  const blobs = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
  const prefix = skillDir ? `${skillDir}/` : "";
  const all = [...blobs.keys()].sort();

  // nearest ancestor (or self) directory holding any plugin manifest
  let pluginRoot: string | null = null;
  for (let d = skillDir; ; d = posix.dirname(d) === "." ? "" : posix.dirname(d)) {
    if (PLUGIN_MANIFESTS.some((m) => blobs.has(posix.join(d, m)))) { pluginRoot = d; break; }
    if (d === "") break;
  }

  const skill = all.filter((p) => p.startsWith(prefix));
  const inSkill = new Set(skill);
  const pluginAuto: string[] = [];
  if (pluginRoot !== null) {
    const pre = pluginRoot ? `${pluginRoot}/` : "";
    const autos = new Set([...PLUGIN_MANIFESTS, ...PLUGIN_EXTRA].map((m) => `${pre}${m}`));
    for (const p of all) {
      if (inSkill.has(p)) continue;
      if (autos.has(p) || p.startsWith(`${pre}hooks/`)) pluginAuto.push(p);
    }
  }
  const taken = new Set([...skill, ...pluginAuto]);
  const referenced: string[] = [];

  const lookup = (p: string): string[] => {
    if (p.startsWith("/") || p.startsWith("..")) return [];
    const base = p.replace(/\.(js|mjs)$/, "");
    return [p, `${p}.ts`, `${p}.js`, `${p}.mjs`, `${base}.ts`, `${p}/index.ts`, `${p}/index.js`].filter((c) => blobs.has(c));
  };

  const queue = [...skill, ...pluginAuto];
  const visited = new Set<string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (visited.has(file) || BINARY.test(file)) continue;
    visited.add(file);
    const size = blobs.get(file)?.size;
    if (size !== undefined && size > MAX_READ) continue;
    let text: string;
    try { text = await read(file); } catch (e) { if (e instanceof RateLimitExhausted) throw e; continue; }
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        let tok = m[1].split(/[#?]/)[0].trim();
        if (!tok || /^[a-z][a-z0-9+.-]*:/i.test(tok) && !tok.startsWith("${")) continue;
        const bases: string[] = [];
        const env = /^\$\{?(CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}?\/(.*)$/.exec(tok);
        if (env) {
          tok = env[2];
          bases.push(env[1] === "CLAUDE_SKILL_DIR" ? skillDir : (pluginRoot ?? ""));
        } else {
          bases.push(posix.dirname(file) === "." ? "" : posix.dirname(file), skillDir);
          if (pluginRoot !== null && pluginAuto.includes(file)) bases.push(pluginRoot);
        }
        for (const b of bases) {
          const norm = posix.normalize(posix.join(b, tok));
          for (const hit of lookup(norm)) {
            if (taken.has(hit) || referenced.length >= MAX_FILES) continue;
            taken.add(hit);
            referenced.push(hit);
            queue.push(hit);
          }
        }
      }
    }
  }
  return { skill, referenced: referenced.sort(), pluginAuto };
}
