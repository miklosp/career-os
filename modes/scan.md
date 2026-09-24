# Mode: scan — Portal Scanner (Offer Discovery)

Discovers new job postings, filters by title, dedups against `user/data/scan-history.db`, and emits `DISPATCH_URLS=[...]` so the session can feed them into the auto-pipeline flow (prep script → batched eval agents).

Levels 1 (ATS APIs), 2 (LinkedIn via JobSpy), 2f (Remote PM Jobs), and 2g (Platsbanken) run **entirely inside `node scan.mjs`** — zero LLM tokens, free (no paid vendor). There is no agent-executed discovery level. Implementation internals (the JobSpy subprocess, the optional Voyager ATS resolver, LinkedIn filter-code derivation, the Remote PM Jobs MCP/JSON-RPC calls, the Platsbanken JobSearch API mapping, rate-limit rationale, the `scan-history.db` schema) live in the script banners — `scan.mjs`, `lib/scan-linkedin.mjs`, `lib/scan-jobspy.py`, `lib/li-voyager.mjs`, `lib/scan-remotepmjobs.mjs`, `lib/scan-platsbanken.mjs` — not here.

Per-source detail - why each source was chosen, its quirks and failure modes, and the list of sources evaluated and **rejected** (do not re-propose them) - lives in `modes/_scan-sources.md`. Read it before proposing a new source.

## Configuration

`user/config/portals.yml` drives everything: `tracked_companies` (Level 1 — ATS board auto-detected from each `careers_url`, incl. Greenhouse/Ashby/Lever/Recruitee/Teamtailor/join.team/Personio/SmartRecruiters/BambooHR/Breezy; an explicit `api:` block overrides detection), `linkedin_searches` (Level 2), `remotepmjobs_searches` (Level 2f — one semantic `query` phrase per entry; PM-only board reached via its public MCP server, enrichment prefetched so agents skip `_fetch.md`), `platsbanken_searches` (Level 2g — one broad `q` word per entry; Sweden-only national job board, full JD prefetched so agents skip `_fetch.md`), and `title_filter` (applied in-process by `scan.mjs` across **all** levels — don't bake title rules into LinkedIn `keywords`; keep that for boolean LinkedIn matching). Optional `skip_tiers: [...]` drops Level-1 postings by seniority tier (intern…c-level; leadership is never down-ranked) before dispatch; absent = skip nothing. `user/config/profile.md` (Target Roles & Archetypes) is a sanity check that searches match the North Star; the frontmatter `location_policy` is for the downstream per-JD gate, not enforced at scan time. `banned_companies` (the ban list — inverse of `tracked_companies`) is enforced at scan time across **all** levels: a matching company/URL is dropped before the LinkedIn detail credit and never reaches `DISPATCH_URLS`; the run summary prints a `Banned skipped:` count per level.

## Recommended execution

**Do not wrap the scanner in a subagent — it is zero-token.** Run `node scan.mjs` directly as a background Bash from the parent session (Claude Code's `run_in_background: true`). The harness sends a completion notification on process exit; that *is* the end signal. The script also emits machine-readable markers (`DISPATCH_URLS=[...]`, optional `SCAN_FATAL=...`) so a tiny `grep` over the captured output yields everything the parent session needs without pulling the full stdout into context.

Earlier versions used a wrapping subagent. That pattern fails because there is no LLM work to wrap: an agent kicking off the script in *its own* background and waiting on a `Monitor` stream ends its turn before the script finishes, with no wake signal to resume it.

## Core orchestration

1. **Run the scanner** as a background Bash from the parent session:

   ```bash
   node scan.mjs > /tmp/career-ops-scan.log 2>&1
   ```

   This runs every level zero-token: fetch ATS feeds + LinkedIn (JobSpy) + aggregator feeds, apply the title filter, dedup against `user/data/scan-history.db` (auto-created, auto-migrates the legacy `.tsv`), write new rows, prefetch LinkedIn JDs into `user/data/jds/` + `Fetched` rows in `user/data/applications.md`. The employer ATS URL is resolved at scan time only when `LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID` are in `.env` (the free authenticated Voyager path); otherwise the LinkedIn URL is stored and ATS resolution defers to apply-time.

   End signal: process exit (notified automatically by the harness). The script always prints the per-level summary first, then `SCAN_FATAL=...` (if any), then `DISPATCH_URLS=[...]` (when non-empty and not `--dry-run`).

2. **Read only the markers** when the background Bash completes:

   ```bash
   grep -E "^(DISPATCH_URLS=|SCAN_FATAL=)" /tmp/career-ops-scan.log
   tail -40 /tmp/career-ops-scan.log   # per-level summary for the user
   ```

   Avoid `cat`-ing the full log — the per-URL listing can be hundreds of lines.

3. **Dispatch:** feed the URLs into the auto-pipeline flow (`modes/auto-pipeline.md`): `lib/prep-jds.mjs` inline, then batched eval agents. Pre-fetched LinkedIn JDs dispatch as their canonical URL (resolved employer ATS URL when Voyager ran, otherwise the LinkedIn URL); prep's dedup detects the existing `user/data/jds/` entry with `Fetched` status and queues it straight for gate + score (no double-fetch).

### Degraded-LinkedIn handling

If `scan.mjs` stdout contains `SCAN_FATAL=jobspy-unavailable` (printed before any `DISPATCH_URLS=`), the LinkedIn level could not run because `uv` is not on PATH or `python-jobspy` is not installable. **Stop and tell the user** the LinkedIn level was skipped and that JobSpy needs `uv` available (it runs `uv run --with python-jobspy`). The other levels still ran — dispatch their URLs as normal. Detection is deterministic in `lib/scan-linkedin.mjs`; this mode only reacts to the marker. (If `LINKEDIN_LI_AT`/`LINKEDIN_JSESSIONID` are unset, that is **not** fatal — scan still runs and stores LinkedIn URLs; ATS resolution just defers to apply-time.)
