# career-ops (private fork)

Personal, diverged copy of [santifer/career-ops](https://github.com/santifer/career-ops). Upstream tracking is severed; no auto-updates, no PRs back. This repo is the source of truth for one user's pipeline and will keep drifting from the public project.

## What it does

An AI job-search pipeline wired into Claude Code / OpenCode:

- **Fetch + gate + score** any job URL through a background agent (`/career-ops {url}`).
- **Location gate** skips roles that don't fit the candidate's geography before spending tokens scoring.
- **Structured evaluation** per role: A/B/C/D scored blocks + posting-legitimacy check, written to `data/reports/{NUM}-*.md`.
- **Portal scanner** (`scan.mjs`) hits Greenhouse / Ashby / Lever / BambooHR / Teamtailor / Workday APIs, deduplicates against `data/scan-history.db` + `data/applications.md`, and prints `DISPATCH_URLS=[...]` for the invoking session to fan out fetch agents.
- **Applications tracker** (`data/applications.md`) — markdown as single source of truth, `Fetched` → `Evaluated` → `Applied` → `Interview` → `Offer`.
- **CV personalization** on demand (Opus via Bifrost + WeasyPrint), triggered from the Go TUI dashboard.

## Layout

Anything under `config/`, `data/`, or `output/` belongs to the user and is gitignored — **no script reads, modifies, or deletes user files autonomously**. Everything else is implementation and lives in this repo.

### User layer — `config/` (you edit these)

| Path | Purpose |
|------|---------|
| `config/cv.md` | Canonical CV in markdown |
| `config/profile.yml` | Identity, targets, comp range, `location_policy` |
| `config/_profile.md` | Archetypes, narrative, negotiation scripts |
| `config/portals.yml` | Customized company list and search queries |
| `config/story-bank.md` | Accumulated STAR+R stories |
| `config/ats-prompt.md`, `config/cv-review-prompt.md` | Prompts for the CV generator and fact-checker |

### State layer — the system writes these (gitignored)

| Path | Purpose |
|------|---------|
| `data/applications.md` | Tracker (Fetched → Applied → Offer) — single source of truth |
| `data/scan-history.db` | URL-level dedupe log (SQLite) |
| `data/tracker-additions/*.tsv` | Pending scoring TSVs awaiting `merge-tracker.mjs` |
| `data/jds/{NUM}-*.md` | Saved job descriptions |
| `data/reports/{NUM}-*-{date}.md` | Evaluation reports |
| `output/customized-cvs/{NUM}-*-cv.{md,pdf}` | Generated CV markdown + PDF |
| `output/customized-cvs/{NUM}-*-cv-review.json` | Pending fact-check review findings (deleted after walkthrough) |
| `output/cover-letters/{NUM}-*-cover-letter.{md,pdf}` | Generated cover letters |
| `output/interview-prep/*.md` | Company-specific interview prep |

### Implementation

`modes/` (LLM mode instructions: fetch, gate, eval, scan, apply, interview-prep, …), `lib/` (helpers), `dashboard/` (Go Bubble Tea TUI), `style/` (CV/cover-letter CSS + self-hosted fonts), `templates/`, `.claude/skills/`, plus root `.mjs` scripts, `render-cv-pdf.py`, `pyproject.toml`, `package.json`. See `CLAUDE.md` for agent rules.

## Common invocations

- `/career-ops {url1} {url2} ...` — pipeline one or more URLs (background agents).
- `/career-ops scan` — scan configured portals, dispatch agents for any new URLs.
- `/career-ops tracker` — show pipeline summary.
- `/career-ops apply` — interactive application assistant.
- `/career-ops pdf` — CV personalization + ATS PDF.
- `node merge-tracker.mjs` — fold pending scoring TSVs into `data/applications.md` (user-triggered only).
- `go build -o dashboard/career-dashboard ./dashboard/` — rebuild the TUI.

## Notes vs. upstream

- `scan-history` is SQLite (`data/scan-history.db`), not TSV. Legacy TSV preserved as `.bak` after one-shot migration in `scan.mjs`.
- `data/pipeline.md` deleted — scan output goes straight through `DISPATCH_URLS` to background fetch agents; there is no intermediate queue file.
- `update-system.mjs` and all upstream auto-update machinery removed.
- Go dashboard uses `modernc.org/sqlite` to read `scan-history.db` for URL enrichment.
