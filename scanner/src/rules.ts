import type { RuleId } from "./types.js";

export const RULES_VERSION = "1.1.0";

export interface Rule {
  id: RuleId;
  sentence: string;
  /** Tested against one line (or one markdown code segment); no `g` flag. */
  patterns: RegExp[];
  /** Whole words/phrases (case-insensitive); any one in the prose of the skill's SKILL.md/README marks the rule disclosed. Specific phrases only: a bare "installs" or "secret" says nothing. */
  disclosureWords: string[];
  /** Findings count only if the skill also has findings for this rule. */
  requires?: RuleId;
}

const HOME = String.raw`(~/|\$HOME|\$\{HOME\}|os\.homedir|Path\.home|expanduser|/etc/|/usr/|/Library/)`;
const WRITE = String.raw`(writeFile\w{0,40}|write_text|write_bytes|appendFile\w{0,40}|copyFile\w{0,40}|shutil\.(copy\w{0,40}|move)|os\.(rename|remove|unlink)|\b(cp|mv|tee|ln|rm|mkdir|touch|install)\b)`;
// Not preceded by a word char or dot, so `u.profile` (JS property access) is not a shell rc file.
const RC = String.raw`(?<![\w.])\.(bashrc|zshrc|zprofile|bash_profile|profile)\b`;
// Whole name segments, so MAX_TOKENS does not match but GITHUB_TOKEN and OPENAI_API_KEY do.
const SECRET_VAR = String.raw`([A-Z0-9]{1,30}_){0,10}(API_KEY|APIKEY|SECRET|SECRET_KEY|ACCESS_KEY|TOKEN|PASSWORD)(_[A-Z0-9]{1,30}){0,10}(?![A-Za-z0-9])`;
const B64 = String.raw`[A-Za-z0-9+/=]{200,4000}`;

// Paid AI SDKs as imported. Python: `import x` / `from x import` at line start (not `import x from '...'`, which is JS).
const PY_SDK = String.raw`openai|anthropic|google\.genai|google\.generativeai|elevenlabs|replicate|fal_client`;
const JS_SDK = String.raw`openai|anthropic|@anthropic-ai/sdk|@google/genai|@google/generative-ai|elevenlabs|@elevenlabs/[\w.-]{1,50}|replicate|@fal-ai/[\w.-]{1,50}`;
export const SDK_IMPORTS: RegExp[] = [
  new RegExp(String.raw`^\s{0,40}(import|from)\s{1,20}(?<mod>${PY_SDK})(?!\w|\s{1,20}from\b)`),
  /^\s{0,40}from\s{1,20}google\s{1,20}import\s{1,20}(?<mod>genai|generativeai)\b/,
  new RegExp(String.raw`(\bfrom|\bimport|\brequire\s{0,20}\()\s{0,20}["'](?<mod>${JS_SDK})(/[^"'\s]{0,100})?["']`),
];
const SDK_HOSTS: [RegExp, string][] = [
  [/openai/, "api.openai.com"], [/anthropic/, "api.anthropic.com"], [/google|genai|generativeai/, "generativelanguage.googleapis.com"],
  [/elevenlabs/, "api.elevenlabs.io"], [/replicate/, "api.replicate.com"], [/fal/, "fal.run"],
];
/** The API host an SDK module (the `mod` group of SDK_IMPORTS) calls. */
export const sdkHost = (mod: string): string => SDK_HOSTS.find(([re]) => re.test(mod))?.[1] ?? mod;
/** Files whose `"command"` entries an agent runs: plugin hooks, MCP servers, plugin manifests. */
export const COMMAND_JSON = /(^|\/)(hooks\/.*\.json|hooks\.json|\.?mcp\.json|plugin\.json|gemini-extension\.json)$/i;
/** Plugin-root config.toml (Codex), where a `command =` line is run. */
export const COMMAND_TOML = /(^|\/)config\.toml$/i;
export const TOML_COMMAND_LINE = /^\s{0,20}command\s{0,20}=/;
export const COMMAND_KEY = /"command"\s{0,20}:/;

export const RULES: Rule[] = [
  {
    id: "obfuscated",
    sentence: "Contains code that is hidden or hard to read",
    patterns: [
      /\beval\s{0,20}\(\s{0,20}(atob|Buffer\.from|unescape|decodeURIComponent)\b/,
      /\b(exec|eval)\s{0,20}\(\s{0,20}(base64\.b64decode|zlib\.decompress|codecs\.decode|marshal\.loads)/,
      /\bbase64\s{1,20}(-d|-D|--decode)\b[^\n]{0,200}\|\s{0,20}(sudo\s{1,20})?(ba|z|da)?sh\b/,
      /\bFunction\s{0,20}\(\s{0,20}atob\b/,
      // A long base64 blob counts only with a decode/execute context; data: URIs and plain blobs do not.
      new RegExp(String.raw`\b(eval|exec|Function|atob|b64decode)\s{0,20}\(\s{0,20}[bru]{0,2}["'\`]${B64}`),
      new RegExp(String.raw`Buffer\.from\(\s{0,20}["']${B64}["']\s{0,20},\s{0,20}["']base64`),
      new RegExp(String.raw`(?<![A-Za-z0-9+/=])${B64}["']?\s{0,20}\)?\s{0,20}\|\s{0,20}(base64\s{1,20}(-d|-D|--decode)|(ba|z|da)?sh\b)`),
      /(\\x[0-9a-fA-F]{2}){16,100}/,
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
      /\bsecurity\s{1,20}(find|dump)-(generic-password|internet-password|keychain)/,
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
      /\.ssh\/(id_\w{1,40}|config|known_hosts)|\.aws\/credentials/,
      /\b(open|readFile\w{0,40}|read_text|cat|source|load_dotenv|dotenv_values)\b[^\n]{0,200}['"/\s]\.env(\.\w{1,20})?(['"\s)]|$)/,
      new RegExp(String.raw`process\.env\.${SECRET_VAR}|process\.env\[\s{0,20}['"]${SECRET_VAR}`),
      new RegExp(String.raw`os\.environ(\.get)?\s{0,20}[\[(]\s{0,20}['"]${SECRET_VAR}|os\.getenv\(\s{0,20}['"]${SECRET_VAR}`),
      new RegExp(String.raw`\$\{?${SECRET_VAR}\}?`),
    ],
    disclosureWords: ["reads your api key", "uses your api key", "reads your api keys", "uses your api keys", "credential", "credentials", "ssh key", "ssh keys", ".env file", "environment variable", "environment variables"],
  },
  {
    id: "downloads-code",
    sentence: "Downloads and installs other software",
    patterns: [
      /\b(curl|wget)\b[^\n|]{0,200}\|\s{0,20}(sudo\s{1,20})?(ba|z|da)?sh\b/,
      /\b(ba|z|da)?sh\b\s{1,20}(-c\s{1,20})?["']?\$?\(\s{0,20}(curl|wget)\b|\b(ba|z)?sh\s{1,20}<\(\s{0,20}(curl|wget)\b/,
      /\b(npx|bunx)\s{1,20}[@\w-]|\bpnpm\s{1,20}dlx\b/,
      /"command"\s{0,20}:\s{0,20}"(npx|uvx|bunx|pnpm|docker)\b/,
      /\buvx\b/,
      /\bpipx\s{1,20}(run|install)\b/,
      /\bpip3?\s{1,20}install\b|\bpython3?\s{1,20}-m\s{1,20}pip\s{1,20}install\b/,
      /\bbrew\s{1,20}install\b/,
      /\bnpm\s{1,20}(i|install|add)\s{1,20}(-g|--global)\b|\b(apt|apt-get|yum|dnf|apk)\s{1,20}(-y\s{1,20})?install\b/,
      /\b(cargo|go)\s{1,20}install\b/,
    ],
    disclosureWords: ["downloads and installs", "installs dependencies", "homebrew"],
  },
  {
    id: "writes-outside",
    sentence: "Changes files outside its own folder",
    patterns: [
      new RegExp(String.raw`${WRITE}[^\n]{0,200}${HOME}`),
      new RegExp(String.raw`>>?\s{0,20}["']?(~|\$HOME|\$\{HOME\}|/etc|/usr)/`),
      new RegExp(String.raw`>>?\s{0,20}\S{0,100}${RC}|\b(echo|tee|sed\s{1,20}-i|cat)\b[^\n]{0,200}${RC}`),
      new RegExp(String.raw`open\([^\n]{0,200}${HOME}[^\n]{0,200},\s{0,20}['"][wa]b?\+?['"]`),
      /\.claude\/(skills|settings\.json|hooks)[^\n]{0,200}\b(cp|mv|ln|write\w{0,40}|mkdir)\b|\b(cp|mv|ln|write\w{0,40}|mkdir)\b[^\n]{0,200}\.claude\/(skills|settings\.json|hooks)/,
    ],
    disclosureWords: ["writes to", "writes files", "modifies", "home directory", "bashrc", "zshrc", "outside its", "config file"],
  },
  {
    id: "paid-api",
    sentence: "Can call paid AI services billed to you",
    patterns: [
      /\b(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.x\.ai|api\.elevenlabs\.io|api\.replicate\.com|fal\.run|openrouter\.ai|api\.perplexity\.ai)\b/,
      ...SDK_IMPORTS,
    ],
    disclosureWords: ["paid api", "billed", "api credits", "usage costs", "openai api", "anthropic api", "gemini api", "elevenlabs api", "replicate api", "openrouter"],
  },
  {
    id: "network",
    sentence: "Sends data to these websites: {hosts}",
    // A call pattern is required; scan.ts then lists hosts from URLs on the same line.
    patterns: [
      /\bfetch\s{0,20}\(/,
      /\brequests\.(get|post|put|patch|delete|head|request|Session)\b/,
      /\b(urllib\.request|urlopen|http\.client|httpx\.|aiohttp\.|axios\b|XMLHttpRequest|new WebSocket|node-fetch)/,
      /\bhttps?\.(get|request)\s{0,20}\(/,
      /\b(Invoke-WebRequest|Invoke-RestMethod|WebFetch|WebSearch)\b/,
      /\b(curl|wget)\s{1,20}(-\w|https?:|["'$])/,
      ...SDK_IMPORTS,
    ],
    disclosureWords: ["network", "internet", "sends data", "upload", "uploads", "web request", "api call", "http request"],
  },
  {
    id: "shell",
    sentence: "Runs commands on your computer",
    patterns: [
      /\bsubprocess\./,
      /\bos\.(system|popen|exec\w{1,40}|spawn\w{1,40})\s{0,20}\(/,
      /\bchild_process\b/,
      /\b(execSync|spawnSync|execFileSync)\s{0,20}\(/,
      /\bshell\s{0,20}=\s{0,20}True\b/,
      /\b(Deno\.Command|Bun\.spawn|Bun\.\$)\b|Runtime\.getRuntime\(\)\.exec/,
      /\b(ba|z)?sh\s{1,20}-c\b/,
    ],
    disclosureWords: ["shell", "shell commands", "runs commands", "run commands", "terminal", "executes commands"],
  },
];
