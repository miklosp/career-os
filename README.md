# career-ops (private fork)

Personal, diverged copy of [santifer/career-ops](https://github.com/santifer/career-ops). Upstream tracking is severed; no auto-updates, no PRs back. This repo is the source of truth for one user's pipeline and will keep drifting from the public project.

## What it does

An AI job-search pipeline wired into Claude Code / OpenCode:

- **Fetch + gate + score** any job URL through a background agent (`/career-ops {url}`).
- **Location gate** skips roles that don't fit the candidate's geography before spending tokens scoring.
- **Structured evaluation** per role: A/B/C/D scored blocks + posting-legitimacy check, written to `reports/{NUM}-*.md`.
- **Portal scanner** (`scan.mjs`) hits Greenhouse / Ashby / Lever / BambooHR / Teamtailor / Workday APIs, deduplicates against `data/scan-history.db` + `data/applications.md`, and prints `DISPATCH_URLS=[...]` for the invoking session to fan out fetch agents.
- **Applications tracker** (`data/applications.md`) — markdown as single source of truth, `Fetched` → `Evaluated` → `Applied` → `Interview` → `Offer`.
- **CV personalization** on demand (Opus via Bifrost + WeasyPrint), triggered from the Go TUI dashboard.

## Layout

See `CLAUDE.md` and `DATA_CONTRACT.md` for the full contract. Short version:

```
config/     # user-edited: cv.md, profile.yml, _profile.md, portals.yml, story-bank.md
data/       # system-written: applications.md, scan-history.db, tracker-additions/, interview-prep/
jds/        # saved job descriptions (NUM-slug.md)
reports/    # evaluation reports (NUM-slug-date.md)
output/     # generated CV PDFs (gitignored)
modes/      # mode instructions for the LLM (fetch, gate, eval, scan, apply, deep, ...)
dashboard/  # Go Bubble Tea TUI
```

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
