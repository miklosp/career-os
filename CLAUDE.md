# Career-Ops — Agent Rules

An AI job-search pipeline wired into Claude Code and custom dashboard. Human overview lives in `README.md`.

## Personalization

User-specific content (archetypes, narrative, proof points, location policy, comp anchor, voice) goes in `config/profile.md` — YAML frontmatter for the structured contracts (`candidate`, `location_policy`, `tooling`), markdown body for everything LLM modes read as prose. **NEVER put user-specific content in `modes/` system files.** When the user asks to customize archetypes/scoring/companies, edit the relevant `config/` or `modes/` file directly.

| Request | Edit |
|---|---|
| Archetypes / narrative / scoring bonuses (user) | `config/profile.md` |
| Add companies | `config/portals.yml` |
| Scoring defaults (weights, bands, archetype detection) | `modes/_eval.md` |
| Writing & ATS standards (CV, cover letter, form answers) | `modes/_writing.md` |
| CV template design | `style/cv-template.css` |

## Data Contract (CRITICAL)

- **`config/`** — user-edited inputs. `cv.md`, `profile.md`, `portals.yml`, `story-bank.md`. Personalization goes HERE.
- **`data/` + `output/`** — system-written state, including `data/active-strategy.md` (coaching bottleneck, proposed-updated by `practice`/`mock`/`analyze`). Never assume a script may autonomously delete user files.
- Everything else (`modes/`, `lib/`, `dashboard/`, `templates/`) is implementation, edited freely.
- `config/cv.md` is the canonical CV. `config/story-bank.md` holds STAR+R stories. **NEVER hardcode metrics — cite from these at evaluation time.**

## The Pipeline

Every URL (user-pasted, multi-URL, or scan-discovered) takes the same path as a **background agent**. Multiple URLs = parallel agents, **≤ 3 concurrent**.

1. **Fetch** — `lib/fetch-jd.mjs` (deterministic, zero-token): dedup, reserve NUM via `lib/next-num.mjs`, save `data/jds/{NUM}-*.md`, insert `Fetched` row. `modes/_fetch.md` is the LLM fallback only on `unknown-host`/`error`; it teaches `lib/ats-registry.json` so the next hit is zero-token.
2. **Location gate** — `modes/_location-gate.md` vs `config/profile.md` frontmatter → `location_policy`. On SKIP: status `Skipped-Location`, quoted JD evidence in Notes, stop.
3. **Score** — `modes/_eval.md`, Sonnet, inline in the agent (no nested subprocess). JD-text-only triage, **zero WebSearch**. A/B/C/D scored; weighted global score in the `**Score:**` header. Writes `data/reports/{NUM}-*.md` + a TSV in `data/tracker-additions/`.
4. **CV personalization** — user-triggered only (dashboard `g`). Opus via Bifrost. Never part of the auto pipeline.

Agents NEVER call `merge-tracker.mjs` or `dedup-tracker.mjs` — only the user does.

## Skill Modes

| User intent | Mode |
|---|---|
| Pastes one or more JDs/URLs | `auto-pipeline` (fan out one bg agent per URL) |
| Interview prep for a company | `interview-prep` (web research allowed here) |
| Generate CV/PDF | `pdf` (Opus 4.7 via Bifrost, dashboard `g`) |
| Application status | `tracker` |
| Fill an application form | `apply` |
| Find new offers | `scan` (then dispatch one fetch agent per URL) |

Use path references to mode files, never inline their content into agent prompts — the agent reads only what it needs via Read.

## Onboarding

Silently each session, check: `config/cv.md`, `config/profile.md`, `config/portals.yml` exist (the real files, not `*.example`). If `config/profile.md` is missing, copy from `templates/profile.example.md` silently.

**If any required file is missing, enter onboarding — do nothing else until basics exist.** Walk the user through, in order:

1. **CV** — offer: paste CV / paste LinkedIn / describe experience. Write clean `config/cv.md` (Summary, Experience, Projects, Education, Skills).
2. **Profile** — copy `templates/profile.example.md` → `config/profile.md`; collect name, email, location, timezone, target roles, salary range into the frontmatter. Archetypes/narrative go in the markdown body.
3. **Portals** — copy `templates/portals.example.yml` → `config/portals.yml`; align `title_filter.positive` with target roles.
4. **Tracker** — create `data/applications.md` with header `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |`.
5. **Deepen** — ask for superpower, energizers/drainers, deal-breakers, lead achievement, published work. Store in `config/profile.md`.
6. Confirm ready; offer recurring scan automation via `/loop` or `/schedule` if available, else suggest cron.

**After every evaluation, learn.** Score-too-high / missed-experience feedback → update `config/profile.md`, never system-layer files.

## CV Generation → Fact-Check

Two-model pipeline (Opus generator + Gemini reviewer — different family breaks correlated hallucinations). Flow diagram and file list: see README. Agent-relevant rules:

- Generator + reviewer both ground on the latest `data/reports/{NUM}-*.md`: Block A Matches are pre-validated; Block A Gaps are forbidden. Metrics must trace to a CV line or a `config/story-bank.md` entry. Raw JD only supplies wording for already-validated claims.
- Severity tiers and default actions: `fabricated` (no support → apply conservative fix); `stretched` (thin support → apply conservative downgrade); `bridge` (CV/JD vocabulary substitution → **keep CV text**, apply only if the user genuinely has the JD-term experience).
- A row with `review-pending` status: pressing Enter opens the fact-check walkthrough **before** the report. Forced gate.
- Never auto-revise from reviewer output — cascading edits introduce new leaks. Reviewer surfaces; user applies.

## Ethical Use (CRITICAL)

Quality, not quantity. Genuine matches, not mass applications.

- **NEVER submit an application without the user reviewing first.** Fill forms, draft answers, generate PDFs — STOP before Submit/Send/Apply.
- Score < 4.0/5 → explicitly recommend against applying; proceed only on a stated user override.
- Every application costs a human's attention. Guide toward fewer, better applications.

## Offer Verification (MANDATORY)

**NEVER trust WebSearch/WebFetch to confirm an offer is still active.** Firecrawl first; ephemeral `agent-browser` only if Firecrawl 403s/empty.

```bash
set -a; source .env; set +a
firecrawl scrape "<url>" -o /tmp/verify.md
```

agent-browser fallback — ephemeral session, **mandatory close even on failure** (use `;`/trap; skipping it leaks Chromium):

```bash
agent-browser --session-name verify open "<url>" && agent-browser --session-name verify snapshot -i
agent-browser close --session-name verify
```

Classify: footer/navbar only = closed; title + description + Apply = active. Background `claude -p` agents without agent-browser: fall back to WebFetch and mark the report header `**Verification:** unconfirmed (background mode)`.

## Conventions & Pipeline Integrity

- Node `.mjs` scripts, YAML config, Markdown data, Go TUI dashboard. Sequential 3-digit NUM via `lib/next-num.mjs` only. Conventional commits.
- **After an evaluation batch lands in `data/tracker-additions/`: `node merge-tracker.mjs` THEN `node lib/dedup-tracker.mjs`** (that order — dedup needs merged state). User-only.
- **NEVER append a new applications.md row for a company+role that already exists.** `merge-tracker.mjs` promotes the `Fetched` row in place; new rows only when there is no match.
- `lib/scan-history.mjs` is the single shared writer for `data/scan-history.db` — every path records through it; no ad-hoc `INSERT INTO offers`. The DB is the authoritative dedupe index. Reconcile with `node lib/scan-history.mjs --backfill` (idempotent).
- **Ban list:** a URL/company matching an enabled `banned_companies` entry in `config/portals.yml` is dropped at the earliest zero-cost point of every path (`fetch-jd.mjs` Guards A/B, scan filters). `fetch-jd.mjs` emits `status:'banned'` → agents stop silently. Logged in `scan-history.db` as `banned`, never an applications.md row.
- Health: `node lib/verify-pipeline.mjs`. Normalize: `node lib/normalize-statuses.mjs`. Dedup: `node lib/dedup-tracker.mjs`.
- All mode files are English. Reports/CVs match the JD's language at generation time (EN default).

### Pipeline Integrity rules

1. Fetch agents MAY add `Fetched` rows directly — pipeline entry point.
2. Scoring agents NEVER append rows — they write a TSV; merge promotes the existing row in place.
3. You MAY edit applications.md to update status/notes of existing entries (e.g. `Evaluated` → `Applied`).
4. Every report header includes `**URL:**` (between `**ID:**` and `**Summary:**`). No `**PDF:**` line in reports — PDF status lives only in applications.md.
5. All statuses canonical (below; source of truth `templates/states.yml`).

### TSV for tracker additions

One file per evaluation: `data/tracker-additions/{num}-{company-slug}.tsv`, single line, 9 tab-separated columns **in this order (status BEFORE score)**:

```
{num}	{date}	{company}	{role}	{status}	{score}/5	{pdf ✅|❌}	[{num}](data/reports/{num}-{slug}-{date}.md)	{note}
```

In applications.md score comes before status; `merge-tracker.mjs` handles the swap.

### Canonical states

`Fetched` (JD saved, awaiting gate+score) · `Skipped-Location` (gate skip; Notes = `<rule-id>: "<evidence>"`) · `Evaluated` (report done) · `Applied` · `Responded` · `Interview` · `Offer` · `Rejected` · `Discarded` (candidate dropped / offer closed) · `SKIP` (manual don't-apply).

Status field: no `**bold**`, no dates (use date column), no extra text (use notes column).
