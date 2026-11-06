import { posix } from "node:path";
import type { TreeEntry } from "./github.js";

const MAX_FILES = 300;
const MAX_READ = 1_000_000;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp[34]|wasm|lock)$/i;
const PATTERNS = [
  /\]\(\s*<?([^)\s>]+)/g, // markdown links
  /`([^`\n]+)`/g, // backticked paths
  /(?:from|import|require\()\s*\(?\s*["']([^"']+)["']/g, // JS/TS imports
  /(?:^|[\s"'(=])(\.{1,2}\/[\w@./-]+)/g, // bare ./ and ../ paths
  /(\$\{?(?:CLAUDE_SKILL_DIR|CLAUDE_PLUGIN_ROOT)\}?\/[^\s"'`)\]]+)/g, // bare env-var paths
];

export async function resolveSkillFiles(
  tree: TreeEntry[],
  skillDir: string,
  read: (path: string) => Promise<string>,
): Promise<{ skill: string[]; referenced: string[]; pluginAuto: string[] }> {
  const blobs = new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
  const prefix = skillDir ? `${skillDir}/` : "";
  const all = [...blobs.keys()].sort();

  // nearest ancestor (or self) directory holding .claude-plugin/plugin.json
  let pluginRoot: string | null = null;
  for (let d = skillDir; ; d = posix.dirname(d) === "." ? "" : posix.dirname(d)) {
    if (blobs.has(posix.join(d, ".claude-plugin/plugin.json"))) { pluginRoot = d; break; }
    if (d === "") break;
  }

  const skill = all.filter((p) => p.startsWith(prefix)).slice(0, MAX_FILES);
  const inSkill = new Set(skill);
  const pluginAuto: string[] = [];
  if (pluginRoot !== null) {
    const pre = pluginRoot ? `${pluginRoot}/` : "";
    const autos = new Set([`${pre}.mcp.json`, `${pre}.claude-plugin/plugin.json`]);
    for (const p of all) {
      if (inSkill.has(p)) continue;
      if (autos.has(p) || p.startsWith(`${pre}hooks/`)) pluginAuto.push(p);
    }
    pluginAuto.splice(Math.max(0, MAX_FILES - skill.length));
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
    try { text = await read(file); } catch { continue; }
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
        }
        for (const b of bases) {
          const norm = posix.normalize(posix.join(b, tok));
          for (const hit of lookup(norm)) {
            if (taken.has(hit) || skill.length + pluginAuto.length + referenced.length >= MAX_FILES) continue;
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
