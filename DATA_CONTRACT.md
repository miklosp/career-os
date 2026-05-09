# Data Contract

User-editable inputs live under `config/`. Generated and tracked state lives under `data/`, `reports/`, `output/`, and `jds/`. Everything else is system layer and gets replaced on update.

## User Layer (NEVER auto-updated)

### `config/` — files you write and edit

| Path | Purpose |
|------|---------|
| `config/cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range, `location_policy` |
| `config/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `config/portals.yml` | Your customized company list and search queries |
| `config/story-bank.md` | Your accumulated STAR+R stories |

### `data/` and other state directories — files the system writes

| Path | Purpose |
|------|---------|
| `data/applications.md` | Application tracker (Fetched → Applied → Offer) |
| `data/scan-history.db` | URL-level dedupe log (SQLite; previous `.tsv` preserved as `.bak`) |
| `data/tracker-additions/*.tsv` | Pending scoring TSVs awaiting `merge-tracker.mjs` |
| `data/interview-prep/*.md` | Company-specific interview reports (if generated) |
| `reports/*` | Evaluation reports (`{NUM}-{slug}-{date}.md`) |
| `output/*` | Generated CV PDFs |
| `jds/*` | Saved job descriptions (`{NUM}-{slug}.md`) |

## System Layer (safe to auto-update)

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, writing style |
| `modes/_fetch.md` | JD fetching — priority list, ATS API patterns, CDP rules |
| `modes/_location-gate.md` | Skip gate — reads `location_policy` from `config/profile.yml` |
| `modes/_eval.md` | Narrative evaluation — A/B/C/D scored + F legitimacy |
| `modes/auto-pipeline.md` | Orchestrator — fan out one agent per URL |
| `modes/pdf.md` | CV personalization (Opus via Bifrost) |
| `modes/scan.md` | Portal scanner usage |
| `modes/apply.md` | Application assistant |
| `modes/deep.md` | Company research |
| `modes/tracker.md` | Tracker overview |
| `modes/interview-prep.md` | Company-specific interview prep |
| `lib/next-num.mjs` | Canonical sequential-number helper |
| `scan.mjs`, `check-liveness.mjs`, `liveness-core.mjs` | Scanning + liveness |
| `generate-cv-llm.mjs`, `render-cv-pdf.py`, `pyproject.toml`, `config/ats-prompt.md` | CV personalization stack |
| `merge-tracker.mjs`, `verify-pipeline.mjs`, `dedup-tracker.mjs`, `normalize-statuses.mjs`, `cv-sync-check.mjs`, `test-all.mjs`, `doctor.mjs` | Pipeline utilities |
| `CLAUDE.md` | Agent instructions |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | `cv-template.css`, `states.yml`, `profile.example.yml`, `portals.example.yml`, `_profile.template.md` |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## The Rule

**`config/`, `data/`, `reports/`, `output/`, and `jds/` belong to the user.** No update process may read, modify, or delete anything in them.

**Everything else is system layer** and can be safely replaced with the latest version from upstream.
