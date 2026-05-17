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
| `config/profile.md` | Single profile: frontmatter (`candidate`, `location_policy`, `tooling`) + body (archetypes, narrative, voice, comp anchor, scoring) |
| `config/portals.yml` | Customized company list and search queries |
| `config/story-bank.md` | Accumulated STAR+R stories |

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

`modes/` (LLM mode instructions: fetch, gate, eval, scan, apply, interview-prep, …), `lib/` (helpers; `lib/prompts/` holds the generic CV-generator and fact-checker prompts), `dashboard/` (Go Bubble Tea TUI), `style/` (CV/cover-letter CSS + self-hosted fonts), `templates/`, `.claude/skills/`, plus root `.mjs` scripts, `render-cv-pdf.py`, `pyproject.toml`, `package.json`. See `CLAUDE.md` for agent rules.

## Common invocations

- `/career-ops {url1} {url2} ...` — pipeline one or more URLs (background agents).
- `/career-ops scan` — scan configured portals, dispatch agents for any new URLs.
- `/career-ops tracker` — show pipeline summary.
- `/career-ops apply` — interactive application assistant.
- `/career-ops pdf` — CV personalization + ATS PDF.
- `node merge-tracker.mjs` — fold pending scoring TSVs into `data/applications.md` (user-triggered only).
- `go build -o dashboard/career-dashboard ./dashboard/` — rebuild the TUI.

## OpenCode commands

Defined in `.opencode/commands/`; all invoke the same `.claude/skills/career-ops/SKILL.md` and shared `modes/*` files as Claude Code.

| Command | Equivalent | Description |
|---|---|---|
| `/career-ops` | `/career-ops` | Menu, or pipeline one or more URLs |
| `/career-ops-pdf` | `/career-ops pdf` | Generate ATS-optimized CV |
| `/career-ops-tracker` | `/career-ops tracker` | Application status overview |
| `/career-ops-apply` | `/career-ops apply` | Live application assistant |
| `/career-ops-scan` | `/career-ops scan` | Scan portals for new offers |
| `/career-ops-followup` | `/career-ops followup` | Follow-up cadence tracker |

## Applying from the dashboard (cmux + sandbox)

The Go TUI's `a` key on a row starts the interactive apply flow in a dedicated, primed agent session. It is the one flow that prefers the **cmux browser** over `agent-browser` (visible surface, persistent logged-in profile). `o` (open the job URL) follows the same cmux-vs-host logic.

**cmux detection — capability probe, not env var.** `CMUX_*` env vars are not a reliable signal: a sandbox can strip them. The dashboard instead probes `cmux current-workspace` (a control-socket round-trip, 3s timeout) — it succeeds only if cmux is actually drivable. When it fails, `a` degrades to opening the job URL in the host browser and `o` falls back to `open`/`xdg-open`/`start`.

**What `a` spawns.** A new focused cmux workspace in the repo, running the configured agent primed with `/career-ops apply — application #N: …`:

```
cmux new-workspace --name "Apply · <Company>" --cwd <repo> --focus true \
  --command 'SAFEHOUSE_ENV_PASS=<CMUX_* names> SAFEHOUSE_ADD_DIRS=<cmux socket dir> \
             $SHELL -ic "<apply_agent> \"/career-ops apply …\""'
```

- **Interactive-shell wrap (`$SHELL -ic`)** is load-bearing: the launcher is a *token*, not a path, so a shell function/alias (e.g. a sandbox wrapper like `claude() { safe claude --dangerously-skip-permissions "$@" }`) resolves. Functions/aliases never survive a non-interactive `sh -c`.
- **Sandbox bridge.** [Agent Safehouse](https://agent-safehouse.dev) is deny-by-default: it strips `CMUX_*` and blocks the cmux control socket (`~/Library/Application Support/cmux/cmux.sock`), so a sandboxed agent gets `Socket not found`. The dashboard runs *unsandboxed* inside cmux, so its own env carries the full `CMUX_*` set + socket path; it injects `SAFEHOUSE_ENV_PASS` (all `CMUX_*` names) and `SAFEHOUSE_ADD_DIRS` (the socket dir) so the wrapper grants them through. These are inert env vars for a non-Safehouse launcher — no detection, no branching, harmless when unused.
- A gitignored repo-root **`.safehouse`** (`add-dirs=<socket dir>`) covers *manual* sandboxed `apply` runs, but only when trusted (`SAFEHOUSE_TRUST_WORKDIR_CONFIG=1`); the config format has no env-pass key, so `CMUX_*` still needs `--env-pass`. The `a`-key path does not depend on this file.

**Choosing the agent.** `tooling.apply_agent` in `config/profile.md` frontmatter (precedence: `$CAREER_OPS_APPLY_CMD` env → `profile.md` → `claude`). Only the launcher token is swapped — the primed prompt is fixed `/career-ops apply …`. A clean swap therefore works only for an agent that (1) starts an interactive session from `<cmd> "<message>"` and (2) resolves the `/career-ops apply` skill/command. Claude Code fits directly. OpenCode exposes the skill as `/career-ops-apply` and has no `<cmd> "<msg>"` interactive-prime form (its CLI is `opencode run "<msg>"`, non-interactive); Codex CLI has no career-ops command at all. So full multi-agent parity needs a per-agent invocation **and** prompt template — deliberately deferred until a concrete second agent is in use; the single-token variable is the minimal, dependency-free step. The mandatory `cmux current-workspace` verify in `modes/apply.md` is the empirical gate either way (a path grant alone may not satisfy macOS `sandbox-exec` for AF_UNIX `connect()`).

## Key files

| File | Function |
|---|---|
| `data/applications.md` | Single source of truth — `Fetched` → `Applied` → `Interview` → `Offer` |
| `data/scan-history.db` | URL-level dedupe log (SQLite, table `offers`, PK `url`) |
| `data/tracker-additions/` | Lock-free write-queue; scoring drops one TSV per JD, `merge-tracker.mjs` folds them in |
| `data/jds/{NUM}-*.md` | Saved JD with location header; NUM reserved at fetch time |
| `data/reports/{NUM}-*.md` | Narrative triage; A–D scored, global score in `**Score:**` header |
| `data/score-history.md`, `data/revisit-queue.md` | Practice/mock/analyze score log + active root-cause queue |
| `lib/next-num.mjs` | Canonical sequential-number helper |
| `lib/fetch-jd.mjs` | Deterministic zero-token fetcher (lever/greenhouse/ashby/teamtailor/personio/workday/rippling/linkedin); `--learn`/`--list` manage the registry |
| `lib/ats-registry.json` | Learned host→handler map — committed shared wisdom, not user-edited |
| `lib/ban-list.mjs` | Shared ban predicate; reads `config/portals.yml` → `banned_companies` |
| `lib/scan-history.mjs` | Single shared persistence layer for `scan-history.db` |
| `lib/generate-cv-llm.mjs`, `render-cv-pdf.py`, `lib/prompts/ats-prompt.md` | CV personalization stack — Opus via Bifrost + WeasyPrint |
| `lib/cv-fact-check.mjs`, `lib/prompts/cv-review-prompt.md` | Independent CV fact-checker — Gemini via Bifrost (`gemini-pro`) |
| `scan.mjs` | Zero-token portal scanner; prints `DISPATCH_URLS=[...]` for the session to dispatch |
| `modes/_fetch.md`, `_location-gate.md`, `_eval.md` | The three single-purpose pipeline stages |
| `modes/_writing.md` | Shared writing & ATS standards for candidate-facing text (CV, cover letter, form answers) |
| `modes/practice.md`, `mock.md`, `analyze.md`, `storybank.md` | Practice & simulation layer (read `modes/_rubrics.md`; mock/analyze also `_round-types.md`) |
| `config/profile.md` | Candidate identity + `location_policy` (frontmatter), archetypes/narrative/voice (body); never auto-updated |
| `data/active-strategy.md` | Coaching bottleneck — system-written by `practice`/`mock`/`analyze` |
| `config/portals.yml` | `tracked_companies` (watched) + `banned_companies` (ban list) |
| `config/cv.md`, `config/story-bank.md` | Canonical CV + accumulated STAR+R stories |

## CV generation & fact-check

Two-model pipeline. The Opus generator has a persistent "JD as vocabulary attractor" bias; a different model family (Gemini) as independent reviewer breaks those correlated errors. Findings carry three severity tiers: `fabricated` (no support anywhere), `stretched` (thin source support), `bridge` (deliberate CV↔JD vocabulary substitution — rendered CV keeps the conservative wording).

Dashboard flow (pressing `g` on a row):

```
generating  (Opus → markdown + bridges JSON; PDF deferred)
    ↓
reviewing   (Gemini reads source CV + report + JD + generated CV; bridges merged in)
    ↓
review-pending  (merged review JSON on disk, awaiting user walkthrough)
    ↓  (user presses Enter on the row, or F)
walkthrough:  per-finding [a]pprove [r]eject [e]dit [s]kip [q]uit
    ↓
apply accepted edits → delete review JSON → render PDF
    ↓
done  (Enter now opens the report as normal)
```

`g` generates + auto-chains review. On a `review-pending` row, Enter opens the walkthrough before the report (forced fact-check gate). The system does not auto-revise from reviewer output — the user stays in the loop applying fixes.

## Stack

Node.js (`.mjs` modules), `agent-browser` (ephemeral session-named Chromium, every invocation closes — no persistent CDP port), Playwright (doctor probe + last-resort SPA fallback only), WeasyPrint via `render-cv-pdf.py`, Opus/Gemini via the Bifrost proxy, YAML config, Markdown data, Go (Bubble Tea TUI dashboard, reads `scan-history.db` via `modernc.org/sqlite`), optional Canva MCP for a visual CV.

## Notes vs. upstream

- `scan-history` is SQLite (`data/scan-history.db`), not TSV. Legacy TSV preserved as `.bak` after one-shot migration in `scan.mjs`.
- `data/pipeline.md` deleted — scan output goes straight through `DISPATCH_URLS` to background fetch agents; there is no intermediate queue file.
- `update-system.mjs` and all upstream auto-update machinery removed.
- Go dashboard uses `modernc.org/sqlite` to read `scan-history.db` for URL enrichment.
