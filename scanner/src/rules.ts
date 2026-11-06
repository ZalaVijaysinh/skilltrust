import type { RuleId } from "./types.js";

export const RULES_VERSION = "1.0.0";

export interface Rule {
  id: RuleId;
  sentence: string;
  /** Tested against one line (or one markdown code segment); no `g` flag. */
  patterns: RegExp[];
  /** Whole words/phrases (case-insensitive); any one in the prose of SKILL.md/README marks the rule disclosed. */
  disclosureWords: string[];
  /** Findings count only if the skill also has findings for this rule. */
  requires?: RuleId;
}

const HOME = String.raw`(~/|\$HOME|\$\{HOME\}|os\.homedir|Path\.home|expanduser|/etc/|/usr/|/Library/)`;
const WRITE = String.raw`(writeFile\w*|write_text|write_bytes|appendFile\w*|copyFile\w*|shutil\.(copy\w*|move)|os\.(rename|remove|unlink)|\b(cp|mv|tee|ln|rm|mkdir|touch|install)\b)`;
const RC = String.raw`\.(bashrc|zshrc|zprofile|bash_profile|profile)\b`;
const SECRET_VAR = String.raw`\w*(API_KEY|APIKEY|SECRET|TOKEN|PASSWORD)\w*`;

export const RULES: Rule[] = [
  {
    id: "obfuscated",
    sentence: "Contains code that is hidden or hard to read",
    patterns: [
      /\beval\s*\(\s*(atob|Buffer\.from|unescape|decodeURIComponent)\b/,
      /\b(exec|eval)\s*\(\s*(base64\.b64decode|zlib\.decompress|codecs\.decode|marshal\.loads)/,
      /\bbase64\s+(-d|-D|--decode)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
      /\bFunction\s*\(\s*atob\b/,
      /[A-Za-z0-9+/]{200,}={0,2}/,
      /(\\x[0-9a-fA-F]{2}){16,}/,
    ],
    disclosureWords: ["obfuscated", "obfuscation", "minified", "encoded payload"],
  },
  {
    id: "browser-secrets",
    sentence: "Reads your browser cookies or saved passwords",
    patterns: [
      /Application Support\/(Google\/Chrome|BraveSoftware|Microsoft Edge|Firefox|Arc)/i,
      /\.config\/(google-chrome|chromium|BraveSoftware|microsoft-edge)/i,
      /\.mozilla\/firefox|Firefox\/Profiles/i,
      /\b(cookies\.sqlite|logins\.json|key4\.db)\b|\/Default\/(Cookies|Login Data)\b/i,
      /\bsecurity\s+(find|dump)-(generic-password|internet-password|keychain)/,
      /Library\/Keychains|Library\/Cookies/,
      /\b(browser_cookie3|pycookiecheat|rookiepy|chrome-cookies-secure)\b/,
    ],
    disclosureWords: ["cookie", "cookies", "saved password", "saved passwords", "keychain", "browser profile", "login data"],
  },
  {
    id: "reads-secrets",
    sentence: "Reads your API keys or secrets",
    requires: "network",
    patterns: [
      /~\/\.(ssh|aws|gnupg|netrc|npmrc|pypirc|kube|docker\/config)\b/,
      /\.ssh\/(id_\w+|config|known_hosts)|\.aws\/credentials/,
      /\b(open|readFile\w*|read_text|cat|source|load_dotenv|dotenv_values)\b[^\n]*['"/\s]\.env(\.\w+)?(['"\s)]|$)/,
      new RegExp(String.raw`process\.env\.${SECRET_VAR}|process\.env\[\s*['"]${SECRET_VAR}`),
      new RegExp(String.raw`os\.environ(\.get)?\s*[\[(]\s*['"]${SECRET_VAR}|os\.getenv\(\s*['"]${SECRET_VAR}`),
      new RegExp(String.raw`\$\{?${SECRET_VAR}\}?`),
    ],
    disclosureWords: ["api key", "api keys", "secret", "secrets", "credential", "credentials", "ssh key", "ssh keys", ".env file", "environment variable", "environment variables"],
  },
  {
    id: "downloads-code",
    sentence: "Downloads and installs other software",
    patterns: [
      /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
      /\b(ba|z|da)?sh\b\s+(-c\s+)?["']?\$?\(\s*(curl|wget)\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/,
      /\bnpx\s+(-y|--yes)\b/,
      /\buvx\b/,
      /\bpipx\s+(run|install)\b/,
      /\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b/,
      /\bbrew\s+install\b/,
      /\bnpm\s+(i|install|add)\s+(-g|--global)\b|\b(apt|apt-get|yum|dnf|apk)\s+(-y\s+)?install\b/,
      /\b(cargo|go)\s+install\b/,
    ],
    disclosureWords: ["downloads", "installs", "homebrew", "downloads and installs"],
  },
  {
    id: "writes-outside",
    sentence: "Changes files outside its own folder",
    patterns: [
      new RegExp(String.raw`${WRITE}[^\n]*${HOME}`),
      new RegExp(String.raw`>>?\s*["']?(~|\$HOME|\$\{HOME\}|/etc|/usr)/`),
      new RegExp(String.raw`>>?\s*\S*${RC}|\b(echo|tee|sed\s+-i|cat)\b[^\n]*${RC}`),
      new RegExp(String.raw`open\([^\n]*${HOME}[^\n]*,\s*['"][wa]b?\+?['"]`),
      /\.claude\/(skills|settings\.json|hooks)[^\n]*\b(cp|mv|ln|write\w*|mkdir)\b|\b(cp|mv|ln|write\w*|mkdir)\b[^\n]*\.claude\/(skills|settings\.json|hooks)/,
    ],
    disclosureWords: ["writes to", "writes files", "modifies", "home directory", "bashrc", "zshrc", "outside its", "config file"],
  },
  {
    id: "paid-api",
    sentence: "Can call paid AI services billed to you",
    patterns: [
      /\b(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.x\.ai|api\.elevenlabs\.io|api\.replicate\.com|fal\.run|openrouter\.ai|api\.perplexity\.ai)\b/,
    ],
    disclosureWords: ["paid api", "billed", "api key", "api credits", "usage costs", "openai api", "anthropic api", "gemini api", "elevenlabs api", "replicate api", "openrouter"],
  },
  {
    id: "network",
    sentence: "Sends data to these websites: {hosts}",
    // URLs are handled in scan.ts so hosts can be listed and local/namespace hosts ignored.
    patterns: [
      /\bfetch\s*\(/,
      /\brequests\.(get|post|put|patch|delete|head|request|Session)\b/,
      /\b(urllib\.request|urlopen|http\.client|httpx\.|aiohttp\.|axios\b|XMLHttpRequest|new WebSocket|node-fetch)/,
      /\b(curl|wget)\s+-\w/,
    ],
    disclosureWords: ["network", "internet", "sends data", "upload", "uploads", "web request", "api call", "http request"],
  },
  {
    id: "shell",
    sentence: "Runs commands on your computer",
    patterns: [
      /\bsubprocess\./,
      /\bos\.(system|popen|exec\w+|spawn\w+)\s*\(/,
      /\bchild_process\b/,
      /\b(execSync|spawnSync|execFileSync)\s*\(/,
      /\bshell\s*=\s*True\b/,
      /\b(Deno\.Command|Bun\.spawn|Bun\.\$)\b|Runtime\.getRuntime\(\)\.exec/,
      /\b(ba|z)?sh\s+-c\b/,
    ],
    disclosureWords: ["shell", "shell commands", "runs commands", "run commands", "terminal", "executes commands"],
  },
];
