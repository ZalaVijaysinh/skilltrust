import { RULES, RULES_VERSION } from "./rules.js";
import { scoreFindings } from "./score.js";
import type { Finding, ScanResult, SkillFile } from "./types.js";

export const MAX_FILE_BYTES = 512 * 1024;

const URL_RE = /https?:\/\/([^\s/'"`<>)\]:?#\\]+)/gi;
// Namespace and loopback hosts are not data leaving the machine.
const IGNORED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "www.w3.org"]);
const SHELL_FENCE = /^(bash|sh|shell|zsh)$/i;
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|<!--)/;
// Longer lines skip per-line patterns (regex cost); only the obfuscation rule still looks at them.
const MAX_LINE = 4000;
const JS_LIKE = /\.(m?js|cjs|jsx|tsx?)$/i;

const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/** Per line: the code segments to scan (markdown keeps only code) and the prose left over. */
function segments(file: SkillFile, lines: string[]): { segs: string[][]; prose: string[]; shellFences: Set<number> } {
  const shellFences = new Set<number>();
  if (!/\.(md|markdown)$/i.test(file.path)) return { segs: lines.map((l) => [l]), prose: [], shellFences };
  const prose: string[] = [];
  const isSkillMd = /(^|\/)SKILL\.md$/.test(file.path);
  let fence: string | null = null;
  let firstInFence = -1;
  const segs = lines.map((line, i) => {
    const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/);
    if (fence === null) {
      if (m) { fence = m[1]; firstInFence = isSkillMd && SHELL_FENCE.test(m[2]) ? 0 : -1; prose[i] = ""; return []; }
      if (line.length > MAX_LINE) { prose[i] = ""; return []; }
      prose[i] = line.replace(INLINE_CODE, " ");
      return [...line.matchAll(INLINE_CODE)].map((x) => x[2]);
    }
    prose[i] = "";
    if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2] && line.trim() === m[1]) { fence = null; return []; }
    if (firstInFence === 0 && line.trim()) { shellFences.add(i); firstInFence = -1; }
    return [line];
  });
  return { segs, prose, shellFences };
}

/** Prose of a markdown text: fenced blocks and inline code removed. */
function proseOf(text: string): string {
  return segments({ path: "x.md", text, origin: "skill" }, text.split(/\r?\n/)).prose.join("\n");
}

const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasPhrase = (text: string, w: string) => new RegExp(`(?<![\\w])${esc(w)}(?![\\w])`, "i").test(text);

export function scanFiles(files: SkillFile[], disclosureText: string): ScanResult {
  const disclosure = proseOf(disclosureText);
  const findings: Finding[] = [];
  let filesScanned = 0, filesSkipped = 0;

  for (const file of files) {
    if (Buffer.byteLength(file.text) > MAX_FILE_BYTES || file.text.includes("\u0000")) { filesSkipped++; continue; }
    filesScanned++;
    const lines = file.text.split(/\r?\n/);
    const { segs, shellFences } = segments(file, lines);
    lines.forEach((line, i) => {
      const long = line.length > MAX_LINE;
      if (!long && !segs[i].length && !shellFences.has(i)) return;
      for (const rule of RULES) {
        if (long && rule.id !== "obfuscated") continue;
        let matched = rule.id === "shell" && shellFences.has(i);
        let hosts: string[] = [];
        for (const seg of long ? [line] : segs[i]) {
          if (rule.id === "network" && COMMENT_LINE.test(seg)) continue;
          if (!rule.patterns.some((p) => p.test(seg))) continue;
          matched = true;
          if (rule.id === "network")
            for (const m of seg.matchAll(URL_RE)) {
              const h = m[1].toLowerCase();
              if (!IGNORED_HOSTS.has(h) && !hosts.includes(h)) hosts.push(h);
            }
        }
        // shortcut: minified = very long, almost space-free line in a JS file; tune if it misfires.
        if (rule.id === "obfuscated" && JS_LIKE.test(file.path) && line.length > 1000 && line.split(" ").length < line.length / 40) matched = true;
        if (!matched) continue;
        const finding: Finding = {
          ruleId: rule.id,
          file: file.path,
          line: i + 1,
          excerpt: line.trim().slice(0, 160),
          disclosed: rule.disclosureWords.some((w) => hasPhrase(disclosure, w)),
          automatic: file.origin === "plugin-auto",
        };
        if (rule.id === "network") finding.hosts = hosts;
        findings.push(finding);
      }
    });
  }

  const kept = findings.filter((f) => {
    const req = RULES.find((r) => r.id === f.ruleId)?.requires;
    return !req || findings.some((x) => x.ruleId === req);
  });
  return { findings: kept, ...scoreFindings(kept), rulesVersion: RULES_VERSION, filesScanned, filesSkipped };
}
