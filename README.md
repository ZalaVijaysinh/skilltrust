# SkillTrust

TrustMRR for AI agent skills: what every skill can do to your machine, in plain English.

Site: https://zalavijaysinh.github.io/skilltrust/

SkillTrust scans public AI agent skills on GitHub every day and gives each one a score out of 100, plus a plain-English list of what it can do: run commands, read your keys, send data to other websites, and so on.

Early days: the first full scan builds up over several daily runs, so the site will not list every skill on day one.

## Supported agents

Claude Code, Codex, Antigravity, Cursor, Copilot, Gemini CLI and OpenCode. Codex reads `~/.agents/skills` directly and the finder links the skill into the other agents listed; any other agent that reads `~/.agents/skills` works with the skill directly. Installing from Windows is not supported yet.

## Install the finder

The finder is an agent skill. Ask it for a skill and it detects which agent you are in, recommends the safest matches, shows what each can do, and installs one only after you say yes. It installs into the shared `~/.agents/skills` folder and links it into your agent's own skills folder when that agent needs it. It never deletes or replaces anything.

```
npx skills add ZalaVijaysinh/skilltrust
```

Or, in Claude Code:

```
/plugin marketplace add ZalaVijaysinh/skilltrust
/plugin install skilltrust@skilltrust
```

## Trending

The home page ranks skills by stars gained this week and this month, taken from daily star snapshots. Until there is enough history it shows "New and rising" instead. "Most installed" is coming later. Star history is backfilled from [OSS Insight](https://ossinsight.io); the backfill is paused for now.

## How scoring works

A skill starts at 100. Each rule below that matches takes points off, once per rule. If the skill's own text says it does this, the penalty is half, rounded up.

| Rule | What it means | Penalty |
| --- | --- | --- |
| `obfuscated` | Contains code that is hidden or hard to read | 25 |
| `browser-secrets` | Reads your browser cookies or saved passwords | 25 |
| `reads-secrets` | Reads your API keys or secrets | 20 |
| `downloads-code` | Downloads and installs other software | 15 |
| `writes-outside` | Changes files outside its own folder | 10 |
| `paid-api` | Can call paid AI services billed to you | 10 |
| `network` | Sends data to the listed websites | 5 |
| `shell` | Runs commands on your computer | 5 |

Bands:

- 80–100: Low risk
- 50–79: Review before installing
- 0–49: High risk

Each skill has its own page with the exact lines that triggered each rule.

## Limits of static scanning

SkillTrust reads files; it never runs them. It can miss behaviour that is built at run time, fetched later, or hidden in files it could not read (those skills are marked "Partially scanned"). It only looks at what a skill can do, not what its author intends. A high score is not a guarantee. Read what a skill does before you give it access to anything you care about.

## Run the scanner locally

Needs Node 24 or newer and a GitHub token for code search.

```
npm ci
SKILLTRUST_TOKEN=your_token npm run scan
npm test
```

Results are written to `data/`. The site is built with `npm run site:build`.

## Licence

MIT. Author: Vijaysinh Zala.
