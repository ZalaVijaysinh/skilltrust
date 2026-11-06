import { COMMAND_JSON, COMMAND_KEY, RULES, RULES_VERSION, SDK_IMPORTS, sdkHost } from "./rules.js";
import { scoreFindings } from "./score.js";
import type { Finding, ScanResult, SkillFile } from "./types.js";

export const MAX_FILE_BYTES = 512 * 1024;

const URL_RE = /https?:\/\/([^\s/'"`<>)\]:?#\\]+)/gi;
// Namespace and loopback hosts are not data leaving the machine.
const IGNORED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "www.w3.org"]);
const SHELL_FENCE = /^(bash|sh|shell|zsh)$/i;
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|<!--)/;
// Long lines are scanned in overlapping windows; every rule quantifier is bounded well under the overlap.
const WINDOW = 4000, OVERLAP = 400;
function* windows(text: string): Generator<string> {
  if (text.length <= WINDOW) { yield text; return; }
  for (let at = 0; ; at += WINDOW - OVERLAP) {
    yield text.slice(at, at + WINDOW);
    if (at + WINDOW >= text.length) return;
  }
}
const JS_LIKE = /\.(m?js|cjs|jsx|tsx?)$/i;

/** Linear inline-code splitter: a span is a backtick run closed by the next run of the same length. */
function inlineCode(line: string): { code: string[]; prose: string } {
  const runs = [...line.matchAll(/`+/g)];
  const code: string[] = [];
  const noMore = new Set<number>();
  let prose = "", pos = 0, i = 0;
  while (i < runs.length) {
    const n = runs[i][0].length;
    let j = i + 1;
    if (!noMore.has(n)) while (j < runs.length && runs[j][0].length !== n) j++;
    if (noMore.has(n) || j >= runs.length) { noMore.add(n); i++; continue; }
    code.push(line.slice(runs[i].index + n, runs[j].index));
    prose += line.slice(pos, runs[i].index) + " ";
    pos = runs[j].index + n;
    i = j + 1;
  }
  return { code, prose: prose + line.slice(pos) };
}

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
      const spans = inlineCode(line);
      prose[i] = spans.prose;
      return spans.code;
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
    const commandJson = COMMAND_JSON.test(file.path);
    lines.forEach((line, i) => {
      if (!segs[i].length && !shellFences.has(i)) return;
      for (const rule of RULES) {
        let matched = rule.id === "shell" && shellFences.has(i);
        const hosts: string[] = [];
        const addHost = (h: string) => { if (!IGNORED_HOSTS.has(h) && !hosts.includes(h)) hosts.push(h); };
        for (const seg of segs[i]) {
          if (rule.id === "network" && COMMENT_LINE.test(seg)) continue;
          for (const win of windows(seg)) {
            if (!rule.patterns.some((p) => p.test(win))) continue;
            matched = true; // one finding per rule per line, so overlapping windows cannot double-report
            if (rule.id === "network") {
              for (const m of win.matchAll(URL_RE)) addHost(m[1].toLowerCase());
              for (const p of SDK_IMPORTS) { const mod = p.exec(win)?.groups?.mod; if (mod) addHost(sdkHost(mod)); }
            }
          }
        }
        // Claude Code runs every "command" in hook, MCP and plugin.json files.
        if (rule.id === "shell" && commandJson && COMMAND_KEY.test(line)) matched = true;
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
