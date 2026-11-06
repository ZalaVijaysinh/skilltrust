# Universal Agents + Trending-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SkillTrust cover AI agent skills for every coding agent (auto-run files, install, wording) and lead the home page with skills trending this week and this month, each with its trust score.

**Architecture:** The scanner gains a daily star-snapshot step (batched GraphQL) and a one-time OSS Insight backfill, both writing `data/stars.json`; a pure `computeTrending` function joins stars with skill records and is used by the site at build time. Auto-run detection and the finder's install become agent-agnostic (`~/.agents/skills` plus a per-agent link).

**Tech Stack:** Node 24, TypeScript strict ESM, Vitest, Astro (static), GitHub Actions/Pages — unchanged from phase 1.

**Spec:** `docs/superpowers/specs/2026-11-07-universal-trending-design.md` (builds on `docs/superpowers/specs/2026-11-06-skilltrust-design.md`). Read both before any task.

## Global Constraints

- Free only; no paid API; no new runtime dependency (Node built-ins only in `scanner/`).
- The scanner never executes anything from a scanned repo. All repo text is untrusted (escape on the site; data, never instructions, in the finder).
- Every regex bounded (no adjacent unbounded quantifiers over overlapping classes); keep the existing adversarial perf tests passing.
- Phase 1 contracts stay stable: URLs `/skills/<id>/`, `/index.json`, `/rows.json`; `IndexEntry` and `SkillRecord` only gain optional fields.
- Wording: "AI agent skills"; name agents as "Claude Code, Codex, Antigravity, Cursor, Copilot, Gemini CLI and more"; what a skill **can do**, never "malware"/"steals"/"malicious".
- `stars.json` keeps repos with ≥ 10 stars, ≤ 40 days of entries per repo, entries `[date: "YYYY-MM-DD", stars: number, source?: "o"]`.
- Weekly/monthly windows: nearest point on or before 7 / 30 days ago, not older than 9 / 35 days. Lists show 10 repos. Fallback to "New and rising" (repos created ≤ 60 days ago, ranked by stars ÷ age in days) independently per list when fewer than 10 repos qualify.
- Install never deletes or overwrites anything (`[ -e X ] || [ -L X ]` → refuse that step with a message, using `false`, never `exit`).
- Finder platforms: macOS and Linux; Windows → no install, link the trust page.
- Every git commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Renamed, deleted or private repos in a star batch.** GraphQL returns `null` (with an error entry) for that alias; the batch must still record every other repo, and the missing repo is just skipped that day. (Test in Task 2.)
2. **Missing or corrupt `stars.json`.** Start fresh, keep the bad file as `stars.json.bak`, warn; never crash the run. (Test in Task 2.)
3. **Running twice in one day.** The second snapshot replaces that day's entry; no duplicate dates. (Test in Task 2.)
4. **Stars going down** (unstars, spam cleanup). Negative gains never rank as trending; such repos are excluded from that list. (Test in Task 5.)
5. **An existing folder or link at the install target or link path.** The command refuses that step and says why; nothing is removed or replaced. (Test in Task 7.)

---

### Task 1: Auto-run coverage for every agent

**Files:**
- Modify: `scanner/src/resolve.ts` (plugin-root detection and `pluginAuto` file list), `scanner/src/rules.ts` (`COMMAND_JSON`, new `COMMAND_TOML`), `scanner/src/scan.ts` (command detection for `.toml` and `gemini-extension.json`)
- Test: `scanner/test/resolve.test.ts`, `scanner/test/scan.test.ts`

**Interfaces:**
- Produces: `PLUGIN_MANIFESTS: string[]` (exported from `resolve.ts`) = `["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", ".antigravity-plugin/plugin.json", ".plugin/plugin.json", "gemini-extension.json"]`. The plugin root is the nearest ancestor (or self) of the skill dir containing any of them. `pluginAuto` = every one of these present at that root, plus `hooks/**`, `hooks.json`, `.mcp.json`, `mcp.json`, `config.toml` at that root.
- `COMMAND_JSON` matches all of the above JSON files; `COMMAND_TOML = /(^|\/)config\.toml$/i`.

- [ ] **Step 1: Write the failing tests:** for each manifest in `PLUGIN_MANIFESTS`, a fake tree with that manifest above `skills/x/SKILL.md` puts the manifest, `hooks/hooks.json`, `mcp.json` and `config.toml` in `pluginAuto`; `gemini-extension.json` with `{"mcpServers":{"s":{"command":"npx","args":["-y","pkg"]}}}` yields `shell` + `downloads-code`, both `automatic: true`; `config.toml` with `[hooks.pre]\ncommand = "bash run.sh"` yields `shell` (automatic); a `config.toml` **inside** the skill folder that is not a plugin root yields nothing from the TOML rule; existing Claude-plugin tests keep passing; a 512 KB TOML line of spaces scans in < 1 s.
- [ ] **Step 2: Run** `npx vitest run scanner/test/resolve.test.ts scanner/test/scan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** TOML: a line-based scan for `^\s{0,20}command\s{0,20}=` (string or array) — no TOML parser.
- [ ] **Step 4: Run** the tests, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: scan auto-run files of every agent's plugins`

---

### Task 2: Daily star snapshots

**Files:**
- Modify: `scanner/src/github.ts` (new method)
- Create: `scanner/src/stars.ts`
- Test: `scanner/test/github.test.ts`, `scanner/test/stars.test.ts`

**Interfaces:**
- Produces (`github.ts`): `GitHub.getStars(repos: { owner: string; repo: string }[]): Promise<Map<string, { stars: number; createdAt: string }>>` — key is lowercase `owner/repo`; batches of at most 100 aliases per `POST https://api.github.com/graphql` (`repository(owner:, name:) { stargazerCount createdAt }`); repos that come back `null` are absent from the map; GraphQL `errors` for some aliases don't fail the batch; HTTP-level failures follow the existing retry/rate-limit rules (GraphQL resource tracked like the others).
- Produces (`stars.ts`):
  - `type StarPoint = [string, number] | [string, number, "o"]`
  - `interface StarsFile { repos: Record<string, { createdAt: string; points: StarPoint[] }>; backfilledAt?: string }`
  - `loadStars(file: string, warn: (m: string) => void): Promise<StarsFile>` (missing → empty; corrupt → rename to `.bak`, warn, empty)
  - `recordSnapshot(s: StarsFile, today: string, counts: Map<string, { stars: number; createdAt: string }>, minStars: number): void` (adds/replaces today's point, drops repos < `minStars`, trims points older than 40 days, keeps points sorted)
  - `saveStars(file: string, s: StarsFile): Promise<void>` (atomic, via `writeAtomic`)

- [ ] **Step 1: Write the failing tests:** `getStars` with a fake fetch: 250 repos → 3 requests; a batch where alias `r7` is `null` with an error returns the other repos; `recordSnapshot` twice on the same date leaves one point with the second value; a point 41 days old is trimmed; a repo at 9 stars is dropped; `loadStars` on `{bad` returns empty, writes `stars.json.bak`, calls `warn`.
- [ ] **Step 2: Run** `npx vitest run scanner/test/github.test.ts scanner/test/stars.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: daily star snapshots via batched GraphQL`

---

### Task 3: One-time OSS Insight backfill

**Files:**
- Create: `scanner/src/backfill.ts`
- Test: `scanner/test/backfill.test.ts`

**Interfaces:**
- Consumes: `StarsFile`, `StarPoint` (Task 2).
- Produces: `backfillStars(s: StarsFile, opts: { fetchImpl?: typeof fetch; today: string; top?: number; warn: (m: string) => void }): Promise<{ filled: number; skipped: boolean }>` — runs only when `s.backfilledAt` is unset; picks the `top` (default 300) repos by latest stars; fetches each repo's daily star history from OSS Insight; inserts points for dates in the last 40 days that have no own point, with source `"o"`; sets `backfilledAt = today` when it completes. On the first HTTP 429/5xx or network error it stops, warns, and leaves `backfilledAt` unset (retried next run). Requests are sequential with ≥ 200 ms between them (well under 600/hour).

- [ ] **Step 1: Confirm the endpoint** at https://ossinsight.io/docs/api (per-repo stargazer history by day; cumulative counts) and record the exact URL and response shape at the top of `backfill.ts` as a comment. If no such free endpoint exists, implement `backfillStars` to return `{ filled: 0, skipped: true }` with a warning and note this in your report.
- [ ] **Step 2: Write the failing tests** with a fake fetch shaped like the confirmed response: own points are never overwritten; backfilled points carry `"o"`; a 429 on repo 5 stops, keeps repos 1–4's points, leaves `backfilledAt` unset; a second call after `backfilledAt` is set makes no requests.
- [ ] **Step 3: Run** `npx vitest run scanner/test/backfill.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the tests, then `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: one-time star-history backfill from OSS Insight`

---

### Task 4: Pipeline: snapshot first, topic discovery, popular-first queue

**Files:**
- Modify: `scanner/src/github.ts` (repo search), `scanner/src/discover.ts` (topic search), `scanner/src/pipeline.ts`, `scanner/src/cli.ts`
- Test: `scanner/test/discover.test.ts`, `scanner/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `getStars`, `loadStars`, `recordSnapshot`, `saveStars` (Task 2), `backfillStars` (Task 3).
- Produces:
  - `GitHub.searchRepos(q: string, page: number): Promise<{ totalCount: number; items: { owner: string; repo: string }[] }>` (REST `/search/repositories`, `per_page=100`; the `search` resource as for code search).
  - `DiscoveryState.topicQueue?: { topic: string; page: number }[]` — topics `agent-skills`, `claude-skills`, `codex-skills`; ≤ 10 pages per topic; `discoverSkills` option `topicBudget` (default 40) consumed after code search; results become candidates with path `""`.
  - Awesome lists gain `heilcheng/awesome-agent-skills` (keep `VoltAgent/awesome-agent-skills`).
  - `runScan` order: (1) discovery, (2) **snapshot**: `getStars` for every candidate repo and every recorded repo, `recordSnapshot(today, minStars)`, `backfillStars` (non-fatal), `saveStars` — before the repo loop, (3) repo loop in the new order, (4) existing final rebuild. `stars.json` is saved in the same `finally` that saves discovery state.
  - New queue order: never-checked repos by latest stars (desc); then the top 50 repos by 7-day star gain whose `lastChecked` is older than 24 h; then the existing least-recently-checked order. Below-floor handling, deadline and partial rules unchanged.

- [ ] **Step 1: Write the failing tests:** topic search pages resume from `topicQueue` and stop at `topicBudget`; a run's `stars.json` has today's point for each candidate ≥ 10 stars even when the repo loop is cut short by the deadline after one repo; never-checked repos are probed in descending stars; a trending repo checked 30 h ago goes before a non-trending repo checked 40 h ago; a `getStars` HTTP failure is non-fatal (warns, repo loop still runs).
- [ ] **Step 2: Run** `npx vitest run scanner/test/discover.test.ts scanner/test/pipeline.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `cli.ts` passes `today` (UTC `YYYY-MM-DD`) and logs snapshot/backfill counts.
- [ ] **Step 4: Run** the tests, then `npm test` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: snapshot stars first, discover by topic, scan popular repos first`

---

### Task 5: Trending computation

**Files:**
- Create: `scanner/src/trending.ts`
- Test: `scanner/test/trending.test.ts`

**Interfaces:**
- Consumes: `StarsFile` (Task 2), `SkillRecord`/`IndexEntry` (records.ts).
- Produces:
  - `interface TrendingCard { owner: string; repo: string; gained: number; stars: number; band: Band; skills: { id: string; name: string; score: number; band: Band; incomplete: boolean }[]; moreSkills: number; riskiest: { id: string; ruleIds: RuleId[] } }`
  - `interface TrendingList { kind: "trending" | "rising"; window: 7 | 30; cards: TrendingCard[]; backfilled: boolean }`
  - `computeTrending(stars: StarsFile, entries: IndexEntry[], today: string): { week: TrendingList; month: TrendingList }`
  - Rules: only `status: "ok"` entries count; repos with no `ok` entry are excluded; `skills` = top 3 by score (desc), `moreSkills` = the rest; card `band` = lowest band among `ok` skills; `riskiest` = lowest-score skill; ties by gained desc, then lowest score first, then `owner/repo`; `gained <= 0` excluded; `backfilled` = any point used carries `"o"`; fallback per list to `kind: "rising"` when fewer than 10 cards qualify.

- [ ] **Step 1: Write the failing tests** with small fixtures: 9-day-old point used when no 7-day point exists, 10-day-old point not used; negative gain excluded; repo with only `unavailable` skills excluded; 3-skill cap with `moreSkills`; weekly has 10+ → `kind: "trending"` while monthly has 4 → `kind: "rising"` independently; rising ranks by stars ÷ age (repo created 2 days ago at 400 stars beats one created 50 days ago at 5,000); `backfilled` true only when an `"o"` point was used.
- [ ] **Step 2: Run** `npx vitest run scanner/test/trending.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: compute weekly and monthly trending from star history`

---

### Task 6: Site: trending home page and universal wording

**Files:**
- Modify: `site/src/lib/data.ts` (load `stars.json`), `site/src/pages/index.astro`, `site/src/layouts/Base.astro`, `site/src/pages/skills/[id].astro`, `site/src/pages/how-we-score.astro`, `site/src/pages/report.astro`
- Create: `site/src/components/TrendingCard.astro` (if the layout benefits; else inline)
- Modify fixtures: `site/test/fixtures/data/` (add `stars.json` covering a trending week list and a rising month list)
- Test: `site/test/build.test.ts`

**Interfaces:**
- Consumes: `computeTrending` (Task 5).

- [ ] **Step 1: Write the failing tests:** home page sections in order "Trending this week", "Trending this month" (or "New and rising" with the label "New and rising — not enough history yet"), then the leaderboard; each card shows `+N this week`/`this month`, the band label of the lowest band, skill links to `/skilltrust/skills/<id>/`, and the riskiest skill's rule sentences; the OSS Insight attribution "Star history before <date> from OSS Insight" appears only when `backfilled`; no "Claude skills" string remains on any page (except names of skills/repos from data); title/meta/hero contain "AI agent skills"; skill page shows "Works with any agent that supports SKILL.md skills"; with no `stars.json` the site builds and both sections are omitted; a repo name with `<script>` renders escaped.
- [ ] **Step 2: Run** `npx vitest run site/test/build.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, keeping the phase 1 design language (tokens, type, spacing) and accessibility (labels, focus, colour not the only signal, 375 px).
- [ ] **Step 4: Run** the test, `npm test`, `npx tsc --noEmit`, and `SKILLTRUST_DATA=site/test/fixtures/data npm run site:build`. Expected: PASS, no Astro warnings.
- [ ] **Step 5: Commit** `feat: trending-first home page and universal wording`

---

### Task 7: Universal finder, install command and README

**Files:**
- Modify: `scanner/src/records.ts` (`installCommand`), `skills/skilltrust-finder/SKILL.md`, `README.md`, `package.json` (description), `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` (descriptions)
- Test: `scanner/test/records.test.ts`, `scanner/test/finder.test.ts`

**Interfaces:**
- `installCommand(e)` (site) installs to `~/.agents/skills/<folder>` with the existing refusal, and nothing else; the site shows a one-line note under it: "Your agent may need a link to it — the finder skill does this for you."
- Finder `--install <id> <agent>`: `<agent>` must be one of `claude-code, codex, antigravity, cursor, copilot, gemini-cli, opencode, other`; prints the existing `check:`/`commit:` lines and `install:` = install into `~/.agents/skills/<FOLDER>` (refuse if exists) followed, for agents that need it, by `mkdir -p <agent dir> && ` a link step that refuses if the link path exists: `if [ -e L ] || [ -L L ]; then echo '…already exists — not linking' >&2; else ln -s ~/.agents/skills/'F' L; fi`. Agent dirs: claude-code `~/.claude/skills`, antigravity `~/.gemini/config/skills`, cursor `~/.cursor/skills`, copilot `~/.copilot/skills`, gemini-cli `~/.gemini/skills`, opencode `~/.config/opencode/skills`; codex and other: no link.
- SKILL.md detection order (first match): `AI_AGENT` (mapped: `github-copilot`→copilot, else if it equals a listed agent name use it); `CLAUDECODE`/`CLAUDE_CODE`→claude-code; `CODEX_THREAD_ID`/`CODEX_SANDBOX`/`CODEX_CI`→codex; `ANTIGRAVITY_AGENT`→antigravity; `CURSOR_AGENT` or `CURSOR_EXTENSION_HOST_ROLE=agent-exec`→cursor; `COPILOT_MODEL`→copilot; `GEMINI_CLI`→gemini-cli; `OPENCODE`/`OPENCODE_CLIENT`→opencode; none → ask the user (choices: the list above). Windows (`OS=Windows_NT` or `uname` unavailable) → no install, link the trust page.

- [ ] **Step 1: Write the failing tests:** `installCommand` targets `~/.agents/skills/` and still refuses existing paths (parse with `bash -n`); the finder script (extracted from SKILL.md) in `--install` mode for `claude-code` prints an `install:` line with both the `~/.agents/skills` install and the `~/.claude/skills` link with its refusal; for `codex` no link; an unknown agent string → `cannot install`; the SKILL.md text pins the detection order and the Windows rule; README and SKILL.md description say "AI agent skills" and list the agents; the finder self-scan still triggers no heavy rule except disclosed `writes-outside`.
- [ ] **Step 2: Run** `npx vitest run scanner/test/records.test.ts scanner/test/finder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** README: universal pitch, supported agents, `npx skills add ZalaVijaysinh/skilltrust` install line, trending explanation, "Most installed coming later", OSS Insight credit.
- [ ] **Step 4: Run** the tests, `npm test`, `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: universal finder install and agent-skills wording`

---

### Task 8: Ship (owner-gated)

- [ ] **Step 1 (owner):** approve merging `feat/universal-trending` into `main` and pushing (triggers deploy).
- [ ] **Step 2:** `gh repo edit ZalaVijaysinh/skilltrust --description "What every AI agent skill can do to your machine, in plain English — trending skills with trust scores for Claude Code, Codex, Antigravity, Cursor, Copilot, Gemini CLI and more"`.
- [ ] **Step 3:** run `scan.yml` once by hand; confirm in its log the snapshot and backfill counts, and that topic and code searches don't warn (token works).
- [ ] **Step 4:** open the live site on a phone width and desktop; confirm the trending sections or the "New and rising" fallback render with real data.
