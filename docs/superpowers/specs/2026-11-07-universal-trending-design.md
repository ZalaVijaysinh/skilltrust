# SkillTrust: every agent, trending first — design

Date: 2026-11-07 · Owner: Vijaysinh Zala (`ZalaVijaysinh`) · Status: draft for approval
Builds on: `2026-11-06-skilltrust-design.md` (phase 1, live at https://zalavijaysinh.github.io/skilltrust/).
Everything in the phase 1 design still holds unless this document changes it.

## Intent and the why

Phase 1 framed SkillTrust as "for Claude skills". The `SKILL.md` format is now an open standard (Agent Skills,
agentskills.io) read by about 50 coding agents: Claude Code, OpenAI Codex, Google Antigravity, Cursor, GitHub
Copilot, Gemini CLI, OpenCode, Cline, Windsurf, Goose and more. People install the same skills into all of them.
The owner wants SkillTrust to be the trust layer for **all** of them, and to lead with **what people are actually
installing right now**: the skills trending on GitHub this week and this month, and (later) the most-installed
ones, each with its trust score. "Is the thing everyone is installing safe?" is timely, shareable and more useful
to a newcomer than a list sorted by safety alone.

## Goals

1. **Universal wording.** Site, README, repo description, finder skill and report say "AI agent skills" and name
   the agents, not "Claude skills".
2. **Universal auto-run coverage.** The scanner checks every agent's plugin/extension files that can run things
   automatically, not only Claude's.
3. **Universal finder.** The finder skill installs into the shared `~/.agents/skills/<folder>` and links it into
   the folder of the agent it is running in, like `npx skills add -g` does.
4. **Trending first.** The home page leads with "Trending this week" and "Trending this month" (fastest star
   growth), each card showing trust score, band and what the skill can do. The full trust leaderboard sits below.
5. **Popular skills scanned first.** The scan queue puts trending and high-star repos ahead of the long tail.

## Non-goals (this round)

- **"Most installed".** Deferred until the owner sets up a free Vercel project and we confirm a skills.sh API
  token can be minted from GitHub Actions (owner's choice: stars first, installs later). The home page has no
  empty "Most installed" section in the meantime.
- Other add-on formats: Cursor rules, Copilot instruction files, standalone MCP servers, Gemini extensions
  without skills. Only `SKILL.md` skills and the plugin files shipped with them.
- Using skills.sh's audit results. Our own scan is the trust score.

## Anti-goals

- A "trending" list that ranks skills only by popularity with the trust score hidden or secondary.
- The finder installing somewhere the user's agent can't see, or overwriting an existing skill (phase 1 rule
  stands: never delete an existing folder).
- Calling a paid API or adding a paid dependency (owner rule).
- Trend numbers that look precise but are guesses. Until a repo has 7 days of our own snapshots, its weekly
  number is either backfilled from a stated source or not shown.

## Constraints

- Free only: GitHub Actions, GitHub API with the owner's `SKILLTRUST_TOKEN` (5,000 core requests/hour, GraphQL
  5,000 points/hour), GitHub Pages.
- GitHub locked the stargazers list (with `starred_at`) to repo admins in July 2026 — verified: REST returns 404
  and GraphQL returns empty edges for public repos. Star history must come from our own daily snapshots.
- All text from scanned repos stays untrusted (phase 1 rules).
- Same stack and repo as phase 1. Data stays committed in `data/`.

## Approaches considered (popularity data)

| | Approach | Trade-off | Decision |
|---|---|---|---|
| **A** | Daily star snapshots via batched GraphQL (`stargazerCount`, ~100 repos per query), weekly/monthly deltas from our own history, one-time backfill of the top ~300 repos from OSS Insight's free star-history API | Free, no new accounts; true weekly numbers after 7 days, monthly after 30; backfill covers the top of the list from day one; no install counts yet | **Chosen** by the owner ("stars first, installs later") |
| B | A + skills.sh installs/trending/hot now | "Most installed" at launch; needs a Vercel project with OIDC federation and 12-hour tokens from Actions (unverified), adds an outside dependency | Deferred to a later spike |
| C | skills.sh's 100,000-skill list as the catalog, our scanner only scores | Biggest coverage fastest; SkillTrust's core then depends on Vercel's API and token | Ruled out |

## How it works (decided)

### 1. Universal wording

- Site title, hero, meta description, footer, How-we-score, Report, README, `package.json` description, the GitHub
  repo description and the finder skill's description say "AI agent skills" and list the main agents
  (Claude Code, Codex, Antigravity, Cursor, Copilot, Gemini CLI and more).
- Skill pages show "Works with any agent that supports SKILL.md skills" (no per-agent compatibility claims).

### 2. Auto-run coverage for every agent

Scanned as `plugin-auto` (findings labelled "runs automatically when installed") when they sit in the plugin
root that contains the skill — the nearest ancestor of the skill folder holding any of these manifests:

- `plugin.json` at the plugin root (Agent Plugins spec, read by Codex, Cursor and Copilot CLI) and in
  `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.antigravity-plugin/`, `.plugin/`
- `hooks/hooks.json`, `hooks.json`, `.mcp.json`, `mcp.json`
- `gemini-extension.json` (`mcpServers.*.command/args`)
- `config.toml` in a plugin root (Codex `[hooks]` tables)

Because the exact hook key names for Codex, Antigravity and Cursor are not documented consistently, the rule is
key-agnostic: in these files, any `command` value (JSON string, JSON array head, or TOML `command =`) is a
"runs commands" finding, and `npx|uvx|bunx|pnpm dlx|docker` commands are also "downloads and installs software"
(phase 1 already does this for Claude's files; this extends the file list and adds TOML).

### 3. Universal finder

- Detect the agent from environment variables, first match wins: `AI_AGENT` (generic override) → its value;
  `CLAUDECODE`/`CLAUDE_CODE` → Claude Code; `CODEX_THREAD_ID`/`CODEX_SANDBOX`/`CODEX_CI` → Codex;
  `ANTIGRAVITY_AGENT` → Antigravity; `CURSOR_AGENT` or `CURSOR_EXTENSION_HOST_ROLE=agent-exec` → Cursor;
  `AI_AGENT=github-copilot`/`COPILOT_MODEL` → Copilot; `GEMINI_CLI` → Gemini CLI; `OPENCODE`/`OPENCODE_CLIENT`
  → OpenCode. Unknown → ask the user which agent they use, with these as choices plus "other".
- Install the pinned, scored copy into `~/.agents/skills/<folder>` (same refusal if it already exists).
- Then, if the agent does not read `~/.agents/skills` natively, create a symlink in its folder:
  Claude Code `~/.claude/skills/<folder>`, Antigravity `~/.gemini/config/skills/<folder>`, Cursor
  `~/.cursor/skills/<folder>`, Copilot `~/.copilot/skills/<folder>`, Gemini CLI `~/.gemini/skills/<folder>`,
  OpenCode `~/.config/opencode/skills/<folder>`. Codex reads `~/.agents/skills` directly (no link). If the link
  path already exists, don't touch it and say so.
- All of this is printed as one finished command by the finder's `--install` script mode (phase 1 rule: the
  model never assembles the command). The agent name is passed as an argument validated against a fixed list.
- The site's install command shows the same `~/.agents/skills` install, plus a one-line note on linking for
  agents that need it.

### 4. Trending

- **Snapshots.** Each scan run records `stargazerCount` for every known repo (candidates with ≥ 10 stars and all
  recorded repos) using batched GraphQL queries (about 100 repos per query), into `data/stars.json`:
  `{ "owner/repo": [[ "YYYY-MM-DD", stars ], …] }`, one entry per day, trimmed to the last 40 days.
- **Backfill (one-time, top ~300).** For repos with fewer than 7/30 days of snapshots, fetch daily star history
  from OSS Insight's free API once and store it with source `ossinsight`. If OSS Insight is unavailable, rate
  limits, or its terms don't allow this use, skip it — those repos just wait for our own history.
- **Weekly / monthly.** Stars gained = today's count minus the count 7 (or 30) days ago. A repo only appears in
  a list if it has a data point at least 7 (or 30) days old. Ties broken by trust score, then name.
- **Repo vs skill.** Stars belong to repos; one repo can hold many skills. A trending card is a **repo** card
  showing its skills (top 3 by trust score, "+N more"), the repo's stars gained, and the **lowest** trust band
  among its skills with a link to each skill page.
- **Day-one fallback.** Until a list has at least 10 qualifying repos, that section shows "New and rising"
  instead: repos created in the last 60 days ranked by stars ÷ age in days, clearly labelled as such.

### 5. Home page

1. Hero (universal wording).
2. **Trending this week** — 10 repo cards.
3. **Trending this month** — 10 repo cards (or "New and rising" fallback).
4. The full trust leaderboard (existing), with filters.
Each card: repo name, stars gained (e.g. "+1,240 this week"), skills inside with band badges and the "what it can
do" sentences of the riskiest one.

### 6. Scan priority

Queue order becomes: never-scanned repos sorted by stars (highest first); then trending repos (top 50 weekly)
whose last check is older than 1 day; then the existing least-recently-checked order. Below-floor handling and
deadlines stay as in phase 1.

### 7. Discovery additions

Add GitHub repository search by topic — `topic:agent-skills`, `topic:claude-skills`, `topic:codex-skills`,
`topic:skills`+`SKILL.md` is not searchable, so topics only — within the existing search budget, as candidate
repos (repo-level refs). Add `VoltAgent/awesome-agent-skills` and `heilcheng/awesome-agent-skills` to the
awesome lists if not already present.

## Decisions from the builder check (my calls)

1. **Star cache for every candidate.** Each run starts with a separate snapshot step, before the scan loop, that
   looks up `stargazerCount` and `createdAt` for every discovery candidate in batched GraphQL queries (about 100
   per query; 10,000 candidates is about 100 queries, a few hundred points of the 5,000/hour budget). Repos with
   ≥ 10 stars go into `data/stars.json`; below-floor repos keep the phase 1 `belowFloor` handling. This feeds both
   trending and scan priority, so popular repos are known before they are scanned.
2. **Trending shows scanned repos only.** Lists are computed at site build time from `stars.json` joined with the
   skill records. A repo appears only if it has at least one `ok` skill record. Trending-but-unscanned repos are
   hidden, not shown as "scan pending" — the anti-goal says trust must never be secondary — and scan priority
   (section 6) gets the top 50 weekly repos scanned within a run or two.
3. **Snapshots survive cut-short runs.** The snapshot step runs first in the scan job and is committed even if the
   scan stops early (the commit step already runs `if: always()`). Deltas use the nearest data point on or before
   7 (or 30) days ago, but not older than 9 (or 35) days; otherwise the repo isn't in that list.
4. **Backfill.** Use OSS Insight's per-repo star-history endpoint (the builder confirms the exact path; it returns
   cumulative daily counts) once for the top 300 repos by stars, at most 300 requests, with attribution on the
   site ("star history before <date> from OSS Insight"). `stars.json` entries become `[date, stars, source?]` with
   source `"o"` for OSS Insight and omitted for our own snapshots. If the API errors, rate-limits, or publishes
   terms that disallow this, skip it and fall back to our own history.
5. **Which skills a trending card uses.** `unavailable` skills are excluded; `incomplete` ones are included with
   the "Partially scanned" marker. The card's band is the lowest among its `ok` skills. Repos with zero `ok`
   skills (e.g. awesome lists) never appear in trending.
6. **Fallback per list.** Weekly and monthly lists fall back to "New and rising" independently. `createdAt` comes
   from the snapshot step's GraphQL query.
7. **Finder platforms.** macOS and Linux only. On Windows the finder says it can't install there yet and links
   the skill's trust page. Agent paths are from each agent's official docs (Antigravity:
   antigravity.google/docs/skills); the agent name argument is validated against the fixed list in section 3.
8. **Topic discovery budget.** Repository search has its own limit (30/minute), separate from code search. Cap
   topic search at 10 pages per topic and 40 requests per run, resuming from a saved cursor like code search.
9. **Stable contracts.** Phase 1 URLs (`/skills/<id>/`, `/index.json`, `/rows.json`) and the `IndexEntry` fields
   stay as they are; this round only adds fields.

## Left to the builder

- GraphQL query shape and batching details; handling of renamed/deleted repos in snapshots.
- Exact card layout and styling (within the phase 1 design language).
- TOML parsing approach for `config.toml` (no new dependency: a minimal line-based scan for `command =` is fine).
- How the finder detects that a link target already exists (`[ -e ] || [ -L ]`, as phase 1).

## Open for the owner

- The skills.sh "Most installed" spike, once a free Vercel project exists.
- Launch announcements and reels (parked until this ships and the first full scan is spot-checked).
