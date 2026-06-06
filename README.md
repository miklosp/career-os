# career-ops (private fork)

Personal, diverged copy of [santifer/career-ops](https://github.com/santifer/career-ops). Upstream tracking is severed; no auto-updates, no PRs back. This repo is the source of truth for one user's pipeline and will keep drifting from the public project.

## What it does

An AI job-search pipeline wired into Claude Code / OpenCode:

- **Fetch + gate + score** any job URL through a background agent (`/career-ops {url}`).
- **Location gate** skips roles that don't fit the candidate's geography before spending tokens scoring.
- **Structured evaluation** per role: A/B/C/D scored blocks + posting-legitimacy check, written to `data/reports/{NUM}-*.md`.
- **Portal scanner** (`scan.mjs`) hits Greenhouse / Ashby / Lever / BambooHR / Teamtailor / Workday APIs, deduplicates against `data/scan-history.db` + `data/applications.md`, and prints `DISPATCH_URLS=[...]` for the invoking session to fan out fetch agents.
- **Applications tracker** (`data/applications.md`) — markdown as single source of truth, `Fetched` → `Evaluated` → `Applied` → `Interview` → `Offer`.
- **CV personalization** — two paths from one canonical `config/cv.json`: a deterministic projector (`lib/cv-project.mjs`) for the generic / LinkedIn / recruiter CV, and an LLM-tailored generator (Opus via Bifrost + WeasyPrint) for per-JD applications triggered from the Go TUI dashboard.

## Layout

Anything under `config/`, `data/`, or `output/` belongs to the user and is gitignored — **no script reads, modifies, or deletes user files autonomously**. Everything else is implementation and lives in this repo.

### User layer — `config/` (you edit these)

| Path | Purpose |
|------|---------|
| `config/cv.json` | Canonical CV (JSON Resume superset; per-bullet stable ids, authored `tier` / `archetypes`, `skills_inventory`, `evidence_refs`) — single source of truth |
| `config/cv.md` | Derived human-readable view of `cv.json` (`pnpm cv-build`); never hand-edited |
| `config/profile.md` | Single profile: frontmatter (`candidate`, `location_policy`) + body (archetypes, narrative, voice, comp anchor, scoring) |
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
- `/career-ops cv` — interactive CV health check, story-bank gap walk, optimization checklist; takes the user from "cv on disk" to "as good as it gets".
- `pnpm cv-project [--archetype product|ai|design] [--tier core|default|depth] [--budget N]` — deterministic generic CV projection (no LLM; output is a strict subset of `cv.json`, source-true by construction). Safe path for LinkedIn / personal site / recruiter sends.
- `node merge-tracker.mjs` — fold pending scoring TSVs into `data/applications.md` (user-triggered only).
- `go -C dashboard build -o career-dashboard .` — rebuild the TUI (the Go module lives in `dashboard/`).

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

**What `a` spawns.** A new focused cmux workspace in the repo, running the configured agent primed with a per-agent apply prompt:

```
cmux new-workspace --name "Apply · <Company>" --cwd <repo> --focus true \
  --command 'SAFEHOUSE_ENV_PASS=<CMUX_* names> SAFEHOUSE_ADD_DIRS=<cmux socket dir> \
             $SHELL -ic "<apply launcher> \"<per-agent apply prompt>\""'
```

- **Interactive-shell wrap (`$SHELL -ic`)** is load-bearing: the launcher is a *token*, not a path, so a shell function/alias (e.g. a sandbox wrapper like `claude() { safe claude --dangerously-skip-permissions "$@" }`) resolves. Functions/aliases never survive a non-interactive `sh -c`.
- **Sandbox bridge.** [Agent Safehouse](https://agent-safehouse.dev) is deny-by-default: it strips `CMUX_*` and blocks the cmux control socket (`~/Library/Application Support/cmux/cmux.sock`), so a sandboxed agent gets `Socket not found`. The dashboard runs *unsandboxed* inside cmux, so its own env carries the full `CMUX_*` set + socket path; it injects `SAFEHOUSE_ENV_PASS` (all `CMUX_*` names) and `SAFEHOUSE_ADD_DIRS` (the socket dir) so the wrapper grants them through. These are inert env vars for a non-Safehouse launcher — no detection, no branching, harmless when unused.
- A gitignored repo-root **`.safehouse`** (`add-dirs=<socket dir>`) covers *manual* sandboxed `apply` runs, but only when trusted (`SAFEHOUSE_TRUST_WORKDIR_CONFIG=1`); the config format has no env-pass key, so `CMUX_*` still needs `--env-pass`. The `a`-key path does not depend on this file.

**Choosing the agent.** `CAREER_OPS_APPLY_AGENT` in the repo `.env` — one of `claude` | `codex` | `gemini` | `opencode` | `pi` (precedence: `$CAREER_OPS_APPLY_CMD` process env, used verbatim → `.env` → `claude`). The dashboard maps the key to the correct interactive-prime invocation for each agent: `claude "<msg>"`, `codex "<msg>"`, `gemini -i "<msg>"`, `opencode --prompt "<msg>"`, `pi "<msg>"` (bare positional is headless for gemini; opencode has no positional prime form). The primed prompt is adapted per agent (`applyPrompt`, keyed off the launcher's leading token): Claude Code gets the native `/career-ops apply …` slash form, since `.claude/skills/career-ops/SKILL.md` is repo-local Claude-only sugar; every other agent (no career-ops command) gets a self-contained instruction — *"Read ./modes/apply.md and ./CLAUDE.md, then run the live application assistant for #N … fill the form but STOP before Submit"* — which works because `modes/apply.md` is self-contained and pulls its shared standards via in-file path references. Both forms keep the fill-never-submit constraint explicit. The mandatory `cmux current-workspace` verify in `modes/apply.md` is the empirical gate either way (a path grant alone may not satisfy macOS `sandbox-exec` for AF_UNIX `connect()`).

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
| `lib/cv-schema.mjs` | One parser/serializer/id authority for `cv.json` ↔ `cv.md`; preserves authored `tier`/`archetypes` across `cv-migrate` |
| `lib/cv-json-to-md.mjs`, `lib/cv-md-to-json.mjs` | Derived-view render (`cv-build`) and prose re-import (`cv-migrate`) with metadata preservation by stable id |
| `lib/cv-project.mjs` | Deterministic zero-token projection of `cv.json` by `tier` + `archetype` + length budget; the generic-CV mechanism |
| `lib/generate-cv-llm.mjs`, `render-cv-pdf.py`, `lib/prompts/ats-prompt.md` | LLM-tailored CV stack — Opus via Bifrost + WeasyPrint, closed-world `[src: id]` contract |
| `lib/cv-validate.mjs` | Hard-fail validator of the citation contract (Rules A/B/C/D) |
| `lib/cv-fact-check.mjs`, `lib/prompts/cv-review-prompt.md` | Independent cross-family fact-checker — Gemini via Bifrost (`gemini-pro`) |
| `lib/cv-status.mjs` | Deterministic CV health/optimality report consumed by `modes/cv.md` |
| `lib/keyword-frequency.mjs` | Zero-token cross-report keyword aggregation; advisor input to `modes/cv.md` |
| `scan.mjs` | Zero-token portal scanner; prints `DISPATCH_URLS=[...]` for the session to dispatch |
| `modes/_fetch.md`, `_location-gate.md`, `_eval.md` | The three single-purpose pipeline stages |
| `modes/_writing.md` | Shared writing & ATS standards for candidate-facing text (CV, cover letter, form answers) |
| `modes/practice.md`, `mock.md`, `analyze.md`, `storybank.md` | Practice & simulation layer (read `modes/_rubrics.md`; mock/analyze also `_round-types.md`) |
| `config/profile.md` | Candidate identity + `location_policy` (frontmatter), archetypes/narrative/voice (body); never auto-updated |
| `data/active-strategy.md` | Coaching bottleneck — system-written by `practice`/`mock`/`analyze` |
| `config/portals.yml` | `tracked_companies` (watched) + `banned_companies` (ban list) |
| `config/cv.json`, `config/cv.md`, `config/story-bank.md` | Canonical CV (JSON master + derived markdown view) + accumulated STAR+R stories |

## CV generation & fact-check

Two complementary paths from one canonical `config/cv.json`:

**Deterministic projection** — `pnpm cv-project` filters `cv.json` highlights by authored `tier` (`core`/`default`/`depth`) and `archetypes` (`product`/`ai`/`design`; empty = universal), with an optional `--budget N` cap. Output is a strict subset of the master, zero-token, no LLM, no validator needed — source-true by construction. This is the safe path for unsupervised artifacts (LinkedIn, personal site, recruiter sends). `core` is contractually always included, even under the tightest budget. See `lib/CV-PIPELINE.md` for the full subsystem map.

**LLM-tailored generation** — Opus rewrites the CV against a specific JD. Two-model pipeline: the Opus generator has a persistent "JD as vocabulary attractor" bias; a different model family (Gemini) as independent reviewer breaks those correlated errors. Findings carry three severity tiers: `fabricated` (no support anywhere), `stretched` (thin source support), `bridge` (deliberate CV↔JD vocabulary substitution — rendered CV keeps the conservative wording).

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
