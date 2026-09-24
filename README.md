# career-ops

Public, diverged copy of [santifer/career-ops](https://github.com/santifer/career-ops). Upstream tracking is severed; no auto-updates, no PRs back. This repo is the source of truth for one user's pipeline and will keep drifting from the original project.

## What it does

An AI job-search pipeline wired into Claude Code:

- **Fetch + gate + score** any job URL (`/career-ops {url...}`). A zero-token prep script (`lib/prep-jds.mjs`) fetches every JD and runs the deterministic location gate in-session; background agents then score the queue in batches of 4 JDs, pulling their whole context (CV, profile, story-bank digest, JDs) in a single `lib/eval-context.mjs` call. Unknown hosts fall back to solo agents that teach the fetch registry.
- **Location gate** skips roles that don't fit the candidate's geography before spending tokens scoring — deterministic rules in prep, an LLM pass inside the eval agent for the ambiguous rest.
- **Structured evaluation** per role: A/B/C/D scored blocks written to `user/data/reports/{NUM}-*.md`. Triage is JD-text-only with zero WebSearch; compensation, posting-legitimacy, and company-health checks are deferred to `interview-prep` (only run for roles that come back).
- **Portal scanner** (`scan.mjs`) queries ten ATS APIs directly (Greenhouse, Ashby, Lever, Recruitee, Teamtailor, join.team, Personio, SmartRecruiters, BambooHR, Breezy) plus aggregator sources (LinkedIn via JobSpy, We Work Remotely, Remote PM Jobs, RemoteInEurope), deduplicates against `user/data/scan-history.db` + `user/data/applications.md`, and prints `DISPATCH_URLS=[...]` for the invoking session to feed into the same prep-then-batch pipeline.
- **Applications tracker** (`user/data/applications.md`) — markdown as single source of truth, `Fetched` → `Evaluated` → `Applied` → `Interview` → `Offer`.
- **CV personalization** — two paths from one canonical `user/config/cv.json`: a deterministic projector (`lib/cv-project.mjs`) for the generic / LinkedIn / recruiter CV, and a per-JD tailored CV drafted inside the interactive `tailor` session (dashboard `t` key; PDF via WeasyPrint).

## Layout

Everything the user owns — `config/`, `data/`, `output/`, `transcripts/` — lives in `user/`, a separate private git repo that this repo gitignores. Code resolves every user path through one module (`lib/paths.mjs` for Node, `dashboard/internal/paths` for Go); set `CAREER_OPS_USER_DIR` to use a checkout elsewhere. Paths stored inside user data (the tracker's `[NUM](data/reports/…)` links, TSVs) are relative to `user/`, so the data repo is self-contained. **No script reads, modifies, or deletes user files autonomously.** Everything else is implementation and lives in this repo. Secrets stay in the root `.env`, never in `user/`.

New user: copy the starter layout, then run `/career-ops onboarding` (remote steps in `user-template/README.md`).

```bash
mkdir -p user && cp -R user-template/. user/ && git -C user init
```

Existing data repo:

```bash
git clone <private-data-remote> user
```

### User layer — `user/config/` (you edit these)

| Path | Purpose |
|------|---------|
| `user/config/cv.json` | Canonical CV (JSON Resume superset; per-bullet stable ids, authored `tier` / `archetypes`, `skills_inventory`, `evidence_refs`) — single source of truth |
| `user/config/cv.md` | Derived human-readable view of `cv.json` (`pnpm cv-build`); never hand-edited |
| `user/config/profile.md` | Single profile: frontmatter (`candidate`, `location_policy`) + body (archetypes, narrative, voice, comp anchor, scoring) |
| `user/config/portals.yml` | Customized company list and search queries |
| `user/config/story-bank.md` | Accumulated STAR+R stories |

### State layer — the system writes these (in `user/`)

| Path | Purpose |
|------|---------|
| `user/data/applications.md` | Tracker (Fetched → Applied → Offer) — single source of truth |
| `user/data/scan-history.db` | URL-level dedupe log (SQLite) |
| `user/data/tracker-additions/*.tsv` | Pending scoring TSVs awaiting `merge-tracker.mjs` |
| `user/data/jds/{NUM}-*.md` | Saved job descriptions |
| `user/data/reports/{NUM}-*-{date}.md` | Evaluation reports |
| `user/output/customized-cvs/{NUM}-*-cv.{md,pdf}` | Generated CV markdown + PDF |
| `user/output/customized-cvs/{NUM}-*-cv-review.json` | Pending fact-check review findings (deleted after walkthrough) |
| `user/output/cover-letters/{NUM}-*-cover-letter.{md,pdf}` | Generated cover letters |
| `user/output/interview-prep/*.md` | Company-specific interview prep |

### Implementation

`modes/` (LLM mode instructions: fetch, gate, eval, scan, apply, interview-prep, …), `lib/` (helpers; `lib/prompts/` holds the generic CV-generator and fact-checker prompts), `dashboard/` (Go Bubble Tea TUI), `style/` (CV/cover-letter CSS + self-hosted fonts), `templates/`, `.claude/skills/`, plus root `.mjs` scripts, `render-cv-pdf.py`, `pyproject.toml`, `package.json`. See `CLAUDE.md` for agent rules.

## Common invocations

- `/career-ops {url1} {url2} ...` — pipeline one or more URLs (zero-token prep, then batched background eval agents).
- `/career-ops scan` — scan configured portals, feed any new URLs through the same pipeline.
- `/career-ops apply` — interactive application assistant.
- `/career-ops cover-letter [{NUM}]` — one-page cover-letter PDF + paste-ready text (context via `lib/letter-context.mjs`, register from the accepted letters in `user/config/cover-letters/`).
- `/career-ops cv` — interactive CV health check, story-bank gap walk, optimization checklist; takes the user from "cv on disk" to "as good as it gets".
- `/career-ops interview-prep` — company-specific interview prep (research artifact).
- `/career-ops storybank [review | add | status]` — interactive story-bank management.
- `/career-ops practice` · `mock` · `analyze` — drill loop, full simulated interview, and real-transcript scoring against the shared rubric.
- `/career-ops onboarding` — first-run setup walkthrough (also auto-triggered when `user/` is missing or still holds template placeholders).
- CV PDF generation runs through the interactive tailor session — dashboard `t` key or `/career-ops tailor {NUM}` (see below).
- `pnpm cv-project [--archetype product|ai|design] [--tier core|default|depth] [--budget N]` — deterministic generic CV projection (no LLM; output is a strict subset of `cv.json`, source-true by construction). Safe path for LinkedIn / personal site / recruiter sends.
- `node merge-tracker.mjs` — fold pending scoring TSVs into `user/data/applications.md` (user-triggered only).
- `go -C dashboard build -o career-dashboard .` — rebuild the TUI (the Go module lives in `dashboard/`).

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
| `user/data/applications.md` | Single source of truth — `Fetched` → `Applied` → `Interview` → `Offer` |
| `user/data/scan-history.db` | URL-level dedupe log (SQLite, table `offers`, PK `url`) |
| `user/data/tracker-additions/` | Lock-free write-queue; scoring drops one TSV per JD, `merge-tracker.mjs` folds them in |
| `user/data/jds/{NUM}-*.md` | Saved JD with location header; NUM reserved at fetch time |
| `user/data/reports/{NUM}-*.md` | Narrative triage; A–D scored, global score in `**Score:**` header |
| `user/data/score-history.md`, `user/data/revisit-queue.md` | Practice/mock/analyze score log + active root-cause queue |
| `lib/next-num.mjs` | Canonical sequential-number helper |
| `lib/fetch-jd.mjs` | Deterministic zero-token fetcher — built-in matchers (lever/greenhouse/ashby/teamtailor/personio/workday/rippling/recruitee/linkedin/smartrecruiters) + the learned `ats-registry.json` (covers bamboohr/breezy/join.team via generic JSON-LD); `--learn`/`--list` manage the registry |
| `lib/ats-registry.json` | Learned host→handler map — committed shared wisdom, not user-edited |
| `lib/ban-list.mjs` | Shared ban predicate; reads `user/config/portals.yml` → `banned_companies` |
| `lib/prep-jds.mjs` | Zero-token batch prep — runs `fetch-jd` + `location-gate` over every URL, emits the eval queue as one JSON line; catches already-scored and duplicate listings before any agent spawns |
| `lib/eval-context.mjs` | One-call context assembly for eval agents — annotated CV, profile, story-bank digest, confirmed notes, report example, and every JD in the batch |
| `lib/scan-history.mjs` | Single shared persistence layer for `scan-history.db` |
| `lib/cv-schema.mjs` | One parser/serializer/id authority for `cv.json` ↔ `cv.md`; preserves authored `tier`/`archetypes` across `cv-migrate` |
| `lib/cv-json-to-md.mjs`, `lib/cv-md-to-json.mjs` | Derived-view render (`cv-build`) and prose re-import (`cv-migrate`) with metadata preservation by stable id |
| `lib/cv-project.mjs` | Deterministic zero-token projection of `cv.json` by `tier` + `archetype` + length budget; the generic-CV mechanism |
| `lib/cv-draft.mjs`, `render-cv-pdf.py`, `lib/prompts/ats-prompt.md` | Tailored-CV stack: `context` prints the contract + inputs for the tailor session, `finalize` validates and projects its draft; WeasyPrint render; closed-world `[src: id]` contract |
| `lib/cv-validate.mjs` | Hard-fail validator of the citation contract (Rules A/B/C/D) |
| `lib/cv-fact-check.mjs`, `lib/prompts/cv-review-prompt.md` | Independent cross-family fact-checker — reviewer model (`REVIEW_MODEL`, ideally a different family) |
| `lib/cv-status.mjs` | Deterministic CV health/optimality report consumed by `modes/cv.md` |
| `lib/keyword-frequency.mjs` | Zero-token cross-report keyword aggregation; advisor input to `modes/cv.md` |
| `scan.mjs` | Zero-token portal scanner; prints `DISPATCH_URLS=[...]` for the session to dispatch |
| `modes/_fetch.md`, `_location-gate.md`, `_eval.md` | The three single-purpose pipeline stages (`_fetch` is the LLM fallback for hosts the deterministic fetcher can't resolve) |
| `modes/_writing.md` | Shared writing & ATS standards for candidate-facing text (CV, cover letter, form answers) |
| `modes/practice.md`, `mock.md`, `analyze.md`, `storybank.md` | Practice & simulation layer (read `modes/_rubrics.md`; mock/analyze also `_round-types.md`) |
| `user/config/profile.md` | Candidate identity + `location_policy` (frontmatter), archetypes/narrative/voice (body); never auto-updated |
| `user/data/active-strategy.md` | Coaching bottleneck — system-written by `practice`/`mock`/`analyze` |
| `user/config/portals.yml` | `tracked_companies` (watched) + `banned_companies` (ban list) |
| `user/config/cv.json`, `user/config/cv.md`, `user/config/story-bank.md` | Canonical CV (JSON master + derived markdown view) + accumulated STAR+R stories |

## CV generation & fact-check

Two complementary paths from one canonical `user/config/cv.json`:

**Deterministic projection** — `pnpm cv-project` filters `cv.json` highlights by authored `tier` (`core`/`default`/`depth`) and `archetypes` (`product`/`ai`/`design`; empty = universal), with an optional `--budget N` cap. Output is a strict subset of the master, zero-token, no LLM, no validator needed — source-true by construction. This is the safe path for unsupervised artifacts (LinkedIn, personal site, recruiter sends). `core` is contractually always included, even under the tightest budget. See `lib/CV-PIPELINE.md` for the full subsystem map.

**Tailored per-JD CV** — the interactive `tailor` session (dashboard `t`, or `/career-ops tailor {NUM}`) drafts the CV itself against a specific JD, under the closed-world `[src: id]` contract in `lib/prompts/ats-prompt.md`. `lib/cv-draft.mjs` bookends the draft deterministically: `context` prints every input in one call, `finalize` validates the draft (`lib/cv-validate.mjs`), projects the identity header, role headings, dates, and descriptions from canonical data, and writes the CV markdown + audit trace. A validator failure prints the failed constraints and writes nothing; the session fixes the draft in front of the user and reruns.

Review is a separate, cross-family control: `lib/cv-fact-check.mjs` runs an ATS simulation (`REVIEW_MODEL`, same family as Ashby's evaluator) and a citation fact-check (`FACTCHECK_MODEL`, a third family) in parallel, configured in `.env` against any OpenAI-compatible API. Findings carry three severity tiers: `fabricated` (no support anywhere), `stretched` (thin source support), `bridge` (deliberate CV↔JD vocabulary substitution; the rendered CV keeps the conservative wording).

Tailor flow:

```
criteria gaps → elicit evidence (notes.yml)
    ↓
cv-draft context → session writes {NUM}-{slug}-cv-draft.md → cv-draft finalize (validate; fix + rerun until pass)
    ↓
cv-fact-check --review-only → review-pending (review JSON on disk)
    ↓
walkthrough in the session (or Enter on the dashboard row): apply accepted edits
    ↓
delete review JSON → render PDF → PDF ✅ in the tracker
```

On a `review-pending` row, Enter opens the fact-check walkthrough before the report (forced gate). The system does not auto-revise from reviewer output: the user stays in the loop applying fixes.

## Stack

Node.js (`.mjs` modules), `agent-browser` (ephemeral session-named Chromium, every invocation closes — no persistent CDP port), Playwright (doctor probe + last-resort SPA fallback only), WeasyPrint via `render-cv-pdf.py`, review models configured in `.env` (any OpenAI-compatible API), YAML config, Markdown data, Go (Bubble Tea TUI dashboard, reads `scan-history.db` via `modernc.org/sqlite`), optional Canva MCP for a visual CV.

## Notes vs. upstream

- `scan-history` is SQLite (`user/data/scan-history.db`), not TSV. Legacy TSV preserved as `.bak` after one-shot migration in `scan.mjs`.
- `user/data/pipeline.md` deleted — scan output goes straight through `DISPATCH_URLS` into the prep script and batched eval agents; there is no intermediate queue file.
- `update-system.mjs` and all upstream auto-update machinery removed.
- Go dashboard uses `modernc.org/sqlite` to read `scan-history.db` for URL enrichment.
