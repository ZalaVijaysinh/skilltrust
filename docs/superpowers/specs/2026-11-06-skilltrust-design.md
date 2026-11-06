# SkillTrust — design

Date: 2026-11-06 · Owner: Vijaysinh Zala (`ZalaVijaysinh`) · Status: draft for approval

Working name "SkillTrust" is a placeholder (my call); the owner picks the final name before launch.

## Intent and the why

There are thousands of Claude skills on GitHub and several directories already list them (skills.sh, Anthropic's
official plugin directory, awesome lists with 37k–79k stars, skillx.sh). None of them tells a newcomer, in plain
English, **what a skill will do to their machine**. skills.sh shows scanner verdicts like "Critical Risk" with no
reason a beginner can act on. The owner hit exactly this installing `last30days`: a "Fail" verdict, and the only way
to judge it was to read the code.

SkillTrust is "TrustMRR for Claude skills". TrustMRR is credible because revenue is verified from Stripe, not
self-reported. SkillTrust is credible because every trust score comes from a public, rerunnable scanner and every
human review is a public, signed-off pull request. The point of the project is open-source reputation for the owner:
GitHub stars and recognition under his personal name.

**Audience:** people new to Claude who cannot read a skill's code. Secondary: experienced users who want a fast
second opinion before installing.

## Goals

1. Every public Claude skill (above a small star floor) gets a **trust page**: what it touches, in plain English, with
   links to the exact file and line that prove each finding, and a **trust score**.
2. A **leaderboard** ranks skills by trust, filterable by category, sortable by trust, stars and recency.
3. A **human-reviewed badge**, earned through a public pull request, pinned to the exact version reviewed.
4. A **finder skill** users install in Claude: they describe what they need, it recommends the safest matching skills
   with their trust summaries, and installs only after the user says yes.
5. A **launch report** with aggregate numbers from the first full scan (for example, how many skills read cookies,
   download and run code, or call paid APIs). This is the launch post.

## Non-goals (for launch)

- User accounts, ratings, comments, likes (Approach B, deferred).
- Testing whether skills *work well* (the "verified results" angle; possible later).
- AI-written summaries. Launch uses rule-based plain-English sentences only. AI summaries come later, and only after
  the owner approves the cost (owner rule: never spend on a paid API without asking).
- Covering non-Claude agent formats beyond what shares the `SKILL.md` format.

## Anti-goals (would make this a failure even if it works)

- **Defaming legitimate skills.** The site states what a skill *can do*, never that it *is* malware. `last30days`
  legitimately reads X cookies with consent; it must not be painted as an attack. Wording is "reads your browser
  cookies", never "steals".
- **Becoming the eighth plain directory.** Every page leads with trust information, not star counts.
- **Silent installs or silent spending.** The finder skill never installs without a yes, and nothing in the project
  calls a paid API without the owner's approval.
- **Executing scanned code.** The scanner only reads files. It never runs, imports or installs anything from a scanned
  repo.

## Constraints

- Hosting and compute must be free: GitHub Pages or Vercel free tier, GitHub Actions for the scanner.
- TypeScript throughout (the owner's main web stack).
- Repo lives under the owner's personal GitHub account `ZalaVijaysinh`, public, open-source licence (MIT, my call).
- GitHub API limits: code search is about 10 requests a minute authenticated and returns at most 1,000 results per
  query, so discovery must slice queries (for example by file size or path) and run incrementally. The default
  Actions token may not be allowed to search all public code; if so, the owner adds a personal access token
  (read-only, public repos) as a repo secret. Free.
- Everything fetched from scanned repos is untrusted input: escape all text on the site, cap file sizes, skip
  binaries, and never let scanned text reach the finder skill as instructions (it is data).

## Approaches considered

| | Approach | Trade-off | Decision |
|---|---|---|---|
| **A** | Static site + daily GitHub Actions scanner that commits JSON data into the repo | Free, nothing to run, git history is a public audit trail of every score change. No accounts or ratings; search runs in the browser. | **Chosen** by the owner. Matches the "verify it yourself" pitch and ships fastest. |
| B | Next.js app + Postgres (Supabase/Neon) + scheduled jobs | Accounts, ratings, live search. Costs money, more to secure, and data in a database is harder for outsiders to verify. | Deferred; can be added later without redoing the scanner or data. |
| C | Contribute a trust layer to Vercel's `skills` / skills.sh | Least work, but the credit and stars go to Vercel. | Ruled out: works against the goal. |

## How it works (decided)

### 1. Catalog (discovery)

- Sources: public GitHub repos containing a `SKILL.md`, Anthropic's official plugin directory
  (`anthropics/claude-plugins-official`) and the marketplace manifests it lists, and the major awesome lists
  (ComposioHQ, VoltAgent, sickn33, hesreallyhim). Duplicates are merged by repo + skill path.
- Launch floor: repos with **10+ stars**. Configurable.
- One repo can hold many skills; each `SKILL.md` directory is one skill, identified as `owner/repo/path`.
- **Copies and forks** (my call): skills are also deduplicated by a hash of the skill directory's content. Identical
  copies collapse into one entry; the canonical copy is the oldest repo, with "also found in" links to the rest.
  Launch-report counts use unique content only, so numbers are not inflated by mirrors.
- Refresh daily. New skills are added; changed skills (new commit touching the skill directory) are rescanned.

### 2. Scanner (automatic trust score)

- Fetches the skill at a specific commit (tarball or contents API), reads text files only, never executes.
- **What counts as "the skill"** (my call): the skill directory, **plus** every file elsewhere in the repo that the
  skill references (relative paths in `SKILL.md`, script imports, `../` paths), followed transitively. Unreferenced
  repo code is not scored, so skills are not penalised for code they never use. "Its own folder" for the
  writes-outside rule means the skill directory plus those referenced paths.
- **Plugins** (my call): plugin-level files that run automatically (`hooks/`, `.mcp.json`, `plugin.json` commands)
  are scanned once per plugin and their findings appear on every skill installed with that plugin, labelled
  "runs automatically when the plugin is installed". These carry the same penalties as the table below.
- Applies fixed, open rules. Each rule has an id, a plain-English sentence, a severity and the patterns it matches.
  Starting rule set (my call; weights tunable, documented on the methodology page):

| Capability | Example patterns | Plain-English sentence | Penalty |
|---|---|---|---|
| Hidden or obfuscated code | `eval(atob(...))`, long base64 blobs piped to a shell, minified scripts in a skill | "Contains code that is hidden or hard to read" | −25 |
| Reads browser cookies or password stores | Chrome/Firefox cookie DB paths, `security find-generic-password`, keychain access | "Reads your browser cookies or saved passwords" | −25 |
| Reads secrets and sends data out | reads `.env`, `~/.ssh`, API-key env vars, combined with network calls | "Reads your API keys or secrets" | −20 |
| Downloads and runs code | `curl … \| sh`, `npx -y`, `pip install`, `brew install`, `uvx` | "Downloads and installs other software" | −15 |
| Can spend money | calls to paid API hosts (OpenAI, Anthropic, Gemini, xAI, ElevenLabs, Replicate, fal, etc.) | "Can call paid AI services billed to you" | −10 |
| Network access | `fetch`, `curl`, `requests`, raw URLs | "Sends data to these websites: …" (lists hosts) | −5 |
| Runs shell commands | `subprocess`, `child_process`, `os.system`, bash blocks in `SKILL.md` | "Runs commands on your computer" | −5 |
| Writes outside its folder | writes to `~`, `/etc`, shell rc files, other skills' folders | "Changes files outside its own folder" | −10 |

- **Disclosure matters.** If a capability is mentioned in the skill's own `SKILL.md`/README (keyword match against
  the rule's vocabulary), its penalty is halved and the page says "disclosed by the author". Undisclosed capabilities
  take the full penalty. This separates `last30days` (documents its cookie use) from a skill that hides it.
- Score = 100 minus penalties, floored at 0, banded: 80–100 "Low risk", 50–79 "Review before installing", 0–49 "High
  risk". Every finding links to `file:line` at the scanned commit.
- The scanner, rules and weights are in the repo; anyone can rerun them and get the same result for the same commit
  **and the same rules version**. Every scan records the rules version it used.
- **False positives and disputes** (my call): a public `overrides/` file, changed only by merged pull request, can
  suppress a specific finding (skill, commit, rule id, file:line) with a written reason and the approver's handle.
  The scanner applies overrides, so reruns stay reproducible. Skill authors dispute a finding by opening such a pull
  request; the skill page shows "1 finding withdrawn after review" with a link to the reason.

### 3. Data layout (in the repo)

- `data/skills/<owner>__<repo>__<skill-path>.json`: metadata (name, description, stars, last commit, category),
  scanned commit SHA, findings, score, scan history.
- `data/index.json`: compact list for the leaderboard and the finder skill.
- `reviews/<owner>/<repo>/<skill-path>/<commit-sha>.md`: human reviews (see 5).
- `overrides/`: withdrawn findings with reasons (see 2).
- `data/report.json`: aggregate numbers for the launch report.

### 4. Website

Static site generated from the data files. Pages:

- **Leaderboard** (home): ranked by trust; filters for category and risk band; sort by trust, stars, recently updated.
- **Skill page**: trust card ("what it touches", each line with evidence links), score and band, badge state, install
  command, score history over time.
- **Compare**: two or three skills side by side on the same trust card.
- **How we score**: the methodology, rules and weights, and the honest limits of static scanning.
- **Reviewers**: leaderboard of volunteer reviewers.
- **Report**: the launch numbers.

### 5. Human reviews and badges

- A review is a pull request adding `reviews/…/<commit-sha>.md` with a fixed checklist: what the skill touches, whether
  that matches its README, anything suspicious, verdict. The reviewer's GitHub handle is the author.
- The owner or trusted maintainers merge it; merging is the approval.
- Badge states:
  - **Reviewed** (green): the reviewed commit is the current one.
  - **Reviewed an older version, nothing new and risky** (green, with change count): the skill changed but the scanner
    diff between reviewed and current commit found no new risky capability.
  - **Review outdated: new risk added** (red warning, still visible): an update added a risky capability (for example
    "this update now reads your browser cookies"). The score drops and the finder skill stops recommending the skill
    until it is re-reviewed.
  - **Not reviewed**: automatic score only.
- Re-review is a new pull request against the new commit.
- **What a review changes** (my call): the badge only, never the score. The score stays purely mechanical so anyone
  can reproduce it. Verdicts are **pass** (green badge), **concerns** (amber badge, reviewer's note shown) and
  **fail** (red badge, and the finder skill stops recommending it). One review merged by a maintainer is enough.
  A skill's own author, or anyone with commit access to its repo, cannot review it (checked in CI from the
  repo's contributor list).
- **What counts as "new and risky"** for the badge (my call): any newly triggered rule with a penalty of 10 or
  more, any new plugin-level automatic hook, or a new paid-API host. New plain network hosts or shell use alone
  stay green and are listed as "changes since review".

### 6. Finder skill

- A `SKILL.md` in this repo, installable with the existing tooling (`npx skills add` and a Claude Code plugin
  marketplace manifest).
- When the user describes what they want, it fetches the published `index.json`, lets the user's own Claude match the
  request to skill descriptions (no paid API), and shows the top three with score, band, badge and the
  "what it touches" lines.
- It installs only after an explicit yes, and shows the exact install command first. Skills in the red "review
  outdated" state, or with a **fail** review, are not recommended.
- **Pinned installs** (my call): before installing, the finder checks the skill's current commit against the scanned
  one. If they match, it installs that commit. If they differ, it says "this version has changed since it was
  scored" and offers the scored commit instead (a git checkout of that exact commit into the skills folder). It
  copies files itself rather than running `npx skills add`, so installing doesn't download and run another tool.
  The skill page shows the same pinned command.
- Text from the index is treated as data, never as instructions.

### 7. Launch

- Launch with automatic scores for every skill; human badges are added over time.
- **Phase 1, launch as soon as possible (owner's decision):** catalog + scanner, leaderboard, skill trust pages,
  "How we score" page, launch report, finder skill. No fixed date; ship when these work.
- **Phase 2, soon after:** compare page, human reviews and badge states, reviewers leaderboard, overrides flow.
- The launch post leads with the report's aggregate numbers, under the owner's personal name.

## Left to the builder

- Static site framework (Astro or Next.js static export), styling, and search library for in-browser search.
- Exact discovery query slicing, caching and incremental scan strategy within GitHub's rate limits.
- Pattern details for each rule, as long as each rule keeps its plain-English sentence and evidence links.
- Category assignment method (from repo topics and description keywords, no paid API).
- Review checklist wording and the pull request template.

## Open for the owner

- Final project name and domain (free subdomain is fine at launch).
