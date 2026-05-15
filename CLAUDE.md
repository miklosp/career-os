# Career-Ops -- AI Job Search Pipeline

## Provenance

This is a personal, diverged fork of the public [santifer/career-ops](https://github.com/santifer/career-ops) project. Upstream tracking has been severed — no auto-updates, no PRs back, no shared release cycle. Treat this repository as the source of truth for Miklos's own pipeline. The original archetypes, scoring logic, and modes have been customized locally and will keep drifting.

**Personalization goes in `config/`.** When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), write to `config/_profile.md` or `config/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content.

## Data Contract (CRITICAL)

Two layers (see README "Layout" for the full table).

**`config/` — user-edited inputs** (personalization goes HERE):
- `config/cv.md`, `config/profile.yml`, `config/_profile.md`, `config/portals.yml`, `config/story-bank.md`

**`data/` and `output/` — system-written state**:
- `data/applications.md`, `data/scan-history.db`, `data/tracker-additions/`, `data/jds/`, `data/reports/`
- `output/customized-cvs/`, `output/interview-prep/`

Everything else (modes, scripts, dashboard, templates) is implementation and edited freely in this repo.

## What is career-ops

AI-powered job search automation built on Claude Code: unified JD ingestion, location gating, cheap background scoring, user-triggered CV personalization, portal scanning.

### The one pipeline

Every URL — whether the user paste it, multiple URLs on `/career-ops url1 url2 ...`, or newly discovered by `scan.mjs` — goes through the exact same path, as a **background agent**:

1. **Fetch** (`modes/_fetch.md`) — save `data/jds/{NUM}-*.md`, reserve NUM via `lib/next-num.mjs`, insert `Fetched` row in `data/applications.md`.
2. **Location gate** (`modes/_location-gate.md`) — cheap check against `config/profile.yml` → `location_policy`. On SKIP: status flips to `Skipped-Location`, quoted JD evidence in Notes, stop.
3. **Score** (`modes/_eval.md`) — Sonnet (`claude -p --model claude-sonnet-4-6`). Lean narrative report: A/B/C/D scored. No compensation block. Writes `data/reports/{NUM}-*.md` and drops a TSV in `data/tracker-additions/`.
4. **CV personalization** — user-triggered only (dashboard `g` key). Opus via Bifrost. Never part of the auto pipeline.

Multiple URLs = parallel agents (≤ 3 concurrent; keeps agent-browser / CDP sessions and target-site rate limits healthy).

### Main Files

| File | Function |
|------|----------|
| `data/applications.md` | Single source of truth — from `Fetched` through `Applied`, `Interview`, `Offer`. |
| `data/scan-history.db` | URL-level dedupe log (SQLite, table `offers`, PK `url`). Every URL ever seen lands here. Legacy `.tsv` kept as `.bak` after migration. |
| `data/tracker-additions/` | Lock-free write-queue. Scoring agents drop one TSV per evaluated JD; `merge-tracker.mjs` folds them into applications.md. |
| `data/jds/{NUM}-*.md` | Saved JD with populated location header fields. Reserved at fetch time. |
| `data/reports/{NUM}-*.md` | Narrative evaluation. Blocks A–D scored. No compensation block. |
| `lib/next-num.mjs` | Canonical sequential-number helper. |
| `config/profile.yml` | Candidate identity, targets, and `location_policy` block. |
| `modes/_fetch.md`, `modes/_location-gate.md`, `modes/_eval.md` | The three single-purpose stages. |
| `modes/_shared.md` | System rules, scoring weights. |
| `config/_profile.md` | User customization (never auto-updated). |
| `config/portals.yml` | Company and search configuration. |
| `config/cv.md`, `config/story-bank.md` | Candidate proof-point sources (always read, never hardcoded). |
| `style/cv-template.css`, `style/cover-letter.css`, `style/fonts/`, `lib/generate-cv-llm.mjs`, `render-cv-pdf.py`, `pyproject.toml`, `config/ats-prompt.md`, `.env` | CV personalization stack — Opus via Bifrost + WeasyPrint. |
| `lib/cv-fact-check.mjs`, `config/cv-review-prompt.md` | Independent fact-checker for generated CVs — Gemini via Bifrost (`gemini-pro` alias). Interactive walkthrough flags fabrications missed by the generator, applies fixes in-place, re-renders the PDF on apply. Dashboard: pressing Enter on a row with `review-pending` status opens the walkthrough before the report. |
| `scan.mjs` | Zero-token portal scanner — discovers URLs, inserts into `data/scan-history.db`, prints `DISPATCH_URLS=[...]` on stdout for Claude to dispatch fetch agents. Auto-migrates from legacy `scan-history.tsv` on first run. |
| `modes/practice.md`, `modes/mock.md`, `modes/analyze.md`, `modes/storybank.md` | Practice & simulation layer — drill loop, full mock interview, real-transcript analysis, interactive story-bank management. All read `modes/_rubrics.md` (5-dim rubric + root cause taxonomy); `mock`/`analyze` also read `modes/_round-types.md`; `practice --type pm-lens` reads `modes/_role-drills.md`. |
| `modes/_rubrics.md`, `modes/_round-types.md`, `modes/_role-drills.md` | Shared coaching references — answer rubric, round taxonomy with per-round weight shifts, PM Six-Lens drill. Read by practice/mock/analyze only; not loaded by the auto-pipeline. |
| `data/score-history.md` | Append-only score log across `practice`/`mock`/`analyze`. Tab-separated, one row per scored round. |
| `data/revisit-queue.md` | Active root causes (from `_rubrics.md` taxonomy) detected across multiple rounds. `practice` reads at session start; modes append/update entries; entries auto-resolve after 3+ sessions without repeat. |

### OpenCode Commands

When using [OpenCode](https://opencode.ai), the following slash commands are available (defined in `.opencode/commands/`):

| Command | Claude Code Equivalent | Description |
|---------|------------------------|-------------|
| `/career-ops` | `/career-ops` | Show menu or run the pipeline on one or more URLs |
| `/career-ops-pdf` | `/career-ops pdf` | Generate ATS-optimized CV |
| `/career-ops-tracker` | `/career-ops tracker` | Application status overview |
| `/career-ops-apply` | `/career-ops apply` | Live application assistant |
| `/career-ops-scan` | `/career-ops scan` | Scan portals for new offers |
| `/career-ops-followup` | `/career-ops followup` | Follow-up cadence tracker |

**Note:** OpenCode commands invoke the same `.claude/skills/career-ops/SKILL.md` skill used by Claude Code. The `modes/*` files are shared between both platforms.

### First Run — Onboarding (IMPORTANT)

**Before doing ANYTHING else, check if the system is set up.** Run these checks silently every time a session starts:

1. Does `config/cv.md` exist?
2. Does `config/profile.yml` exist (not just profile.example.yml)?
3. Does `config/_profile.md` exist (not just _profile.template.md)?
4. Does `config/portals.yml` exist (not just templates/portals.example.yml)?

If `config/_profile.md` is missing, copy from `templates/_profile.template.md` silently. This is the user's customization file — it will never be overwritten by updates.

**If ANY of these is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place. Guide the user step by step:

#### Step 1: CV (required)
If `config/cv.md` is missing, ask:
> "I don't have your CV yet. You can either:
> 1. Paste your CV here and I'll convert it to markdown
> 2. Paste your LinkedIn URL and I'll extract the key info
> 3. Tell me about your experience and I'll draft a CV for you
>
> Which do you prefer?"

Create `config/cv.md` from whatever they provide. Make it clean markdown with standard sections (Summary, Experience, Projects, Education, Skills).

#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `templates/profile.example.yml` and then ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
>
> I'll set everything up for you."

Fill in `config/profile.yml` with their answers. For archetypes and targeting narrative, store the user-specific mapping in `config/_profile.md` or `config/profile.yml` rather than editing `modes/_shared.md`.

#### Step 3: Portals (recommended)
If `config/portals.yml` is missing:
> "I'll set up the job scanner with 45+ pre-configured companies. Want me to customize the search keywords for your target roles?"

Copy `templates/portals.example.yml` → `config/portals.yml`. If they gave target roles in Step 2, update `title_filter.positive` to match.

#### Step 4: Tracker
If `data/applications.md` doesn't exist, create it:
```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

#### Step 5: Get to know the user (important for quality)

After the basics are set up, proactively ask for more context. The more you know, the better your evaluations will be:

> "The basics are ready. But the system works much better when it knows you well. Can you tell me more about:
> - What makes you unique? What's your 'superpower' that other candidates don't have?
> - What kind of work excites you? What drains you?
> - Any deal-breakers? (e.g., no on-site, no startups under 20 people, no Java shops)
> - Your best professional achievement — the one you'd lead with in an interview
> - Any projects, articles, or case studies you've published?
>
> The more context you give me, the better I filter. Think of it as onboarding a recruiter — the first week I need to learn about you, then I become invaluable."

Store any insights the user shares in `config/profile.yml` (under narrative) or `config/_profile.md`. Do not put user-specific archetypes or framing into `modes/_shared.md`.

**After every evaluation, learn.** If the user says "this score is too high, I wouldn't apply here" or "you missed that I have experience in X", update your understanding in `config/_profile.md` or `config/profile.yml`. The system should get smarter with every interaction without putting personalization into system-layer files.

#### Step 6: Ready
Once all files exist, confirm:
> "You're all set! You can now:
> - Paste a job URL to evaluate it
> - Run `/career-ops scan` (or `/career-ops-scan` if using OpenCode) to search portals
> - Run `/career-ops` to see all commands
>
> Everything is customizable — just ask me to change anything."

Then suggest automation:
> "Want me to scan for new offers automatically? I can set up a recurring scan every few days so you don't miss anything. Just say 'scan every 3 days' and I'll configure it."

If the user accepts, use the `/loop` or `/schedule` skill (if available) to set up a recurring `/career-ops scan` (or `/career-ops-scan` if using OpenCode). If those aren't available, suggest adding a cron job or remind them to run `/career-ops scan` (or `/career-ops-scan` if using OpenCode) periodically.

### Personalization

This system is designed to be customized by YOU (AI Agent). When the user asks you to change archetypes, translate modes, adjust scoring, add companies, or modify negotiation scripts -- do it directly. You read the same files you use, so you know exactly what to edit.

**Common customization requests:**
- "Change the archetypes to [backend/frontend/data/devops] roles" → edit `config/_profile.md` or `config/profile.yml`
- "Translate the modes to English" → edit all files in `modes/`
- "Add these companies to my portals" → edit `config/portals.yml`
- "Update my profile" → edit `config/profile.yml`
- "Change the CV template design" → edit `style/cv-template.css`
- "Adjust the scoring weights" → edit `config/_profile.md` for user-specific weighting, or `modes/_shared.md` + `modes/_eval.md` for shared system defaults

### Language Policy for Mode Files

All mode files in `modes/` must be in English. Reports and CVs still match the JD's language (EN default) — that happens at generation time, not by swapping mode files. Language subdirectories (`modes/de/`, `modes/fr/`, `modes/ja/`, etc.) have been removed and should not be re-introduced.

### Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes one or more JDs / URLs | `auto-pipeline` — fan out one background agent per URL (fetch → gate → score) |
| Preps for interview at specific company | `interview-prep` |
| Wants to generate CV/PDF | `pdf` (Opus 4.7 via Bifrost, triggered by dashboard `g`) |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` (then dispatch one fetch agent per discovered URL) |

**Always dispatch fetch + score as background agents.** The user is not blocked waiting. `/career-ops url1 url2 url3` = three parallel agents (bounded to ≤ 3 active browser sessions). Agents never call `merge-tracker.mjs` — only the user does.

### CV Source of Truth

- `config/cv.md` is the canonical CV
- `config/story-bank.md` has accumulated STAR+R stories from evaluations
- **NEVER hardcode metrics** -- read them from these files at evaluation time

### CV Generation → Fact-Check Flow

Two-model pipeline. The Opus generator has a persistent "JD as vocabulary attractor" bias — even with explicit prompt rules, it lifts JD phrases into bullets. A different model family (Gemini) as an independent reviewer breaks those correlated errors.

**Grounding inputs.** Generator and reviewer both read the evaluation report at `data/reports/{NUM}-*.md` (most-recent by mtime). Block A already enumerated the JD↔CV matches with cited CV lines and named the gaps — that work is reused, not re-derived. Block A Matches are pre-validated; Block A Gaps are forbidden territory. The story bank (`config/story-bank.md`) is the primary source for quantified outcomes — metrics must trace to a CV line or a story-bank entry. The raw JD only supplies exact wording for claims the report already validated.

**Three severity tiers.** Findings carry one of:
- `fabricated` — no support anywhere (CV, story bank, Block-A Match). Default action: apply the conservative fix.
- `stretched` — thin source-CV support but plausible. Default action: apply the conservative downgrade.
- `bridge` — intentional vocabulary substitution between CV phrasing and JD term (CV: "Agile" / JD: "Scrum"). The rendered CV always uses the conservative wording; the JD-vocabulary upgrade is offered via the walkthrough. Default action: **keep the CV text** (presumptively allowed); apply only if the user genuinely has the JD-term experience.

**Bridges plumbing.** The generator emits a `<bridges>` JSON block at the end of its output. `generate-cv-llm.mjs` extracts it (so it doesn't appear in the rendered CV) and writes it to `output/customized-cvs/{NUM}-{slug}-cv-bridges.json`. `cv-fact-check.mjs` merges that file into the Gemini findings before saving the final review JSON. The reviewer can also emit its own `bridge` findings independently; both sources coexist with deduplication.

**Dashboard flow (pressing `g` on a row):**

```
generating  (Opus produces markdown + bridges JSON; PDF deferred)
    ↓
reviewing   (Gemini reads source CV + report + JD + generated CV; bridges merged in)
    ↓
review-pending  (merged review JSON on disk awaiting user walkthrough)
    ↓  (user presses Enter on the row, or F)
interactive walkthrough:  per-finding [a]pprove [r]eject [e]dit [s]kip [q]uit
    ↓
apply accepted edits to the markdown; delete review JSON; render PDF (via main.go)
    ↓
done  (CV + PDF ready to send; Enter now opens the report as normal)
```

**Precedence:** when a row has `review-pending` status, pressing Enter opens the review walkthrough BEFORE the report — forces the user through the fact-check before reading the scoring narrative. After the walkthrough exits, the report opens automatically.

**Files:**
- `lib/generate-cv-llm.mjs` — Opus generator, uses `config/ats-prompt.md`. Reads `config/cv.md`, `config/story-bank.md`, `config/profile.yml`, the latest matching `data/reports/{NUM}-*.md`, and the JD. Writes `output/customized-cvs/{NUM}-{slug}-cv.md` and `output/customized-cvs/{NUM}-{slug}-cv-bridges.json`. PDF generation is deferred (`--no-pdf` in dashboard mode) to after the walkthrough.
- `lib/cv-fact-check.mjs` — two-phase reviewer:
  - `--review-only <cv>` → phase 1 only (Gemini call, merges generator bridges, saves review JSON, exits). Used by dashboard auto-chain.
  - `<cv>` (no flag) → phase 2 walkthrough. If review JSON exists, skips the LLM call. Deletes JSON at end of walkthrough.
- `config/cv-review-prompt.md` — reviewer prompt (fact-checker role, three severity tiers, takes the evaluation report as a third input).
- `output/customized-cvs/{NUM}-{slug}-cv-bridges.json` — generator's emitted bridges. Merged into the review JSON; harmless if left on disk after merge.
- `output/customized-cvs/{NUM}-{slug}-cv-review.json` — persisted merged findings (fabricated + stretched + bridge). Presence of this file is the "review-pending" signal.

**Dashboard keys on a row:**
- `g` — generate CV and auto-chain review.
- `Enter` — open review walkthrough if pending, otherwise open the report.

**Why NOT auto-revise based on reviewer output:** cascading edits — the fix for one leak can introduce another. Reviewer surfaces issues; the user stays in the loop on applying fixes.

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.** The goal is to help the user find and apply to roles where there is a genuine match -- not to spam companies with mass applications.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply. The user makes the final call.
- **Strongly discourage low-fit applications.** If a score is below 4.0/5, explicitly recommend against applying. The user's time and the recruiter's time are both valuable. Only proceed if the user has a specific reason to override the score.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50. Guide the user toward fewer, better applications.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** Use Firecrawl first (no local browser, nothing to clean up); fall back to ephemeral `agent-browser` only when Firecrawl 403s or is dry.

Firecrawl path:

```bash
set -a; source .env; set +a
firecrawl scrape "<url>" -o /tmp/verify.md
```

agent-browser fallback — **ephemeral session, mandatory close**:

```bash
agent-browser --session-name verify open "<url>" \
  && agent-browser --session-name verify snapshot -i
agent-browser close --session-name verify     # MUST run, even on failure
```

Wrap in a trap/`;` so the close always executes. Skipping it is how Chromium processes accumulate.

Classify: only footer/navbar without JD = closed. Title + description + Apply = active.

See `agent-browser skills get core` for full CLI patterns (snapshot refs, clicks, fills, sessions).

**Exception for background `claude -p` agents:** `agent-browser` is not always available in headless pipe mode. Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (background mode)`. The user can verify manually later or press `R` in the dashboard to re-score.

---

## Stack and Conventions

- Node.js (mjs modules), `agent-browser` (ephemeral session-named Chromium browsers; every invocation closes with `agent-browser close --session-name <name>`, no persistent CDP port), Playwright (only as a doctor.mjs install-check probe and the last-resort SPA fallback in `_fetch.md` Priority 5), WeasyPrint via `render-cv-pdf.py` (PDF), YAML (config), HTML/CSS (template), Markdown (data), Canva MCP (optional visual CV)
- Go (dashboard TUI)
- Scripts in `.mjs`, configuration in YAML
- Output in `output/` (gitignored), Reports in `data/reports/`
- JDs in `data/jds/` — reserved at fetch time, NUM drives everything downstream (report filename, tracker report link, CV output)
- Report / JD numbering: sequential 3-digit zero-padded via `lib/next-num.mjs` (single canonical helper, called from every site that assigns numbers)
- **RULE: After any evaluation batch lands in `data/tracker-additions/`, run `node merge-tracker.mjs`** to fold TSVs into applications.md. Agents never call this themselves — only the user.
- **RULE: NEVER append new entries to applications.md for company+role pairs that already exist.** `merge-tracker.mjs` promotes `Fetched` rows in place; new-entry creation happens only when there's no existing match.

### TSV Format for Tracker Additions

Write one TSV file per evaluation to `data/tracker-additions/{num}-{company-slug}.tsv`. Single line, 9 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](data/reports/{num}-{slug}-{date}.md)\t{note}
```

**Column order (IMPORTANT -- status BEFORE score):**
1. `num` -- sequential number (integer)
2. `date` -- YYYY-MM-DD
3. `company` -- short company name
4. `role` -- job title
5. `status` -- canonical status (e.g., `Evaluated`)
6. `score` -- format `X.X/5` (e.g., `4.2/5`)
7. `pdf` -- `✅` or `❌`
8. `report` -- markdown link `[num](data/reports/...)`
9. `notes` -- one-line summary

**Note:** In applications.md, score comes BEFORE status. The merge script handles this column swap automatically.

### Pipeline Integrity

1. **Fetch agents may ADD `Fetched` rows to applications.md directly** — that's the entry point of the pipeline.
2. **Scoring agents NEVER append new rows.** Scoring writes a TSV in `data/tracker-additions/`; `merge-tracker.mjs` promotes the existing `Fetched` row in place to `Evaluated`.
3. **YES you can edit applications.md to UPDATE status/notes of existing entries** (e.g. flipping `Evaluated` → `Applied` after submission).
4. All reports MUST include `**URL:**` in the header (between `**ID:**` and `**Summary:**`). Do NOT add a `**PDF:**` line to report headers — PDF status lives only in applications.md and goes stale if duplicated.
5. All statuses MUST be canonical (see `templates/states.yml`).
6. Health check: `node lib/verify-pipeline.mjs` (or `pnpm run verify`)
7. Normalize statuses: `node lib/normalize-statuses.mjs` (or `pnpm run normalize`)
8. Dedup: `node lib/dedup-tracker.mjs` (or `pnpm run dedup`)

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Fetched` | JD saved under `data/jds/`, awaiting location gate + scoring. Score + Report empty. |
| `Skipped-Location` | Location gate said skip. Notes column holds `<rule-id>: "<quoted evidence>"`. No report. |
| `Evaluated` | Report completed, pending decision. |
| `Applied` | Application sent. |
| `Responded` | Company responded. |
| `Interview` | In interview process. |
| `Offer` | Offer received. |
| `Rejected` | Rejected by company. |
| `Discarded` | Discarded by candidate or offer closed. |
| `SKIP` | Manual don't-apply (not the location gate). |

**RULES:**
- No markdown bold (`**`) in status field
- No dates in status field (use the date column)
- No extra text (use the notes column)
