# Mode: scan — Portal Scanner (Offer Discovery)

Discovers new job postings, filters by title, dedups against `data/scan-history.db`, and emits `DISPATCH_URLS=[...]` so the session can feed them into the auto-pipeline flow (prep script → batched eval agents).

Levels 1 (ATS APIs), 2 (LinkedIn via JobSpy), 2b (remoteineurope.com), 2e (We Work Remotely), and 2f (Remote PM Jobs) run **entirely inside `node scan.mjs`** — zero LLM tokens, free (no paid vendor). Level 3 (WebSearch) is the only agent-executed part, because WebSearch needs an LLM tool call. Implementation internals (the JobSpy subprocess, the optional Voyager ATS resolver, LinkedIn filter-code derivation, the WWR full-text RSS prefetch, the Remote PM Jobs MCP/JSON-RPC calls, rate-limit rationale, the `scan-history.db` schema) live in the script banners — `scan.mjs`, `lib/scan-linkedin.mjs`, `lib/scan-jobspy.py`, `lib/li-voyager.mjs`, `lib/scan-weworkremotely.mjs`, `lib/scan-remotepmjobs.mjs` — not here.

Per-source detail - why each source was chosen, its quirks and failure modes, and the list of sources evaluated and **rejected** (do not re-propose them) - lives in `modes/_scan-sources.md`. Read it before proposing a new source.

## Configuration

`config/portals.yml` drives everything: `tracked_companies` (Level 1 — ATS board auto-detected from each `careers_url`, incl. Greenhouse/Ashby/Lever/Recruitee/Teamtailor/join.team/Personio/SmartRecruiters/BambooHR/Breezy; an explicit `api:` block overrides detection), `linkedin_searches` (Level 2), `weworkremotely_feeds` (Level 2e — one category `.rss` URL per entry; the JD is prefetched whole, so agents skip `_fetch.md`), `remotepmjobs_searches` (Level 2f — one semantic `query` phrase per entry; PM-only board reached via its public MCP server, enrichment prefetched so agents skip `_fetch.md`), `search_queries` with `site:` filters (Level 3), and `title_filter` (applied in-process by `scan.mjs` across **all** levels — don't bake title rules into LinkedIn `keywords`; keep that for boolean LinkedIn matching). Optional `skip_tiers: [...]` drops Level-1 postings by seniority tier (intern…c-level; leadership is never down-ranked) before dispatch; absent = skip nothing. `config/profile.md` (Target Roles & Archetypes) is a sanity check that searches match the North Star; the frontmatter `location_policy` is for the downstream per-JD gate, not enforced at scan time. `banned_companies` (the ban list — inverse of `tracked_companies`) is enforced at scan time across **all** levels: a matching company/URL is dropped before the LinkedIn detail credit and never reaches `DISPATCH_URLS`; the run summary prints a `Banned skipped:` count per level.

## Recommended execution

**Do not wrap Levels 1/2/2b in a subagent — they are zero-token.** Run `node scan.mjs` directly as a background Bash from the parent session (Claude Code's `run_in_background: true`). The harness sends a completion notification on process exit; that *is* the end signal. The script also emits machine-readable markers (`DISPATCH_URLS=[...]`, optional `SCAN_FATAL=...`) so a tiny `grep` over the captured output yields everything the parent session needs without pulling the full stdout into context.

Earlier versions used a wrapping subagent. That pattern fails because there is no LLM work to wrap: an agent kicking off the script in *its own* background and waiting on a `Monitor` stream ends its turn before the script finishes, with no wake signal to resume it.

Level 3 (WebSearch + liveness checks) is the only LLM-driven part and stays inline in the parent session — it's bounded by `enabled: true` queries in `config/portals.yml`.

## Core orchestration

1. **Run the scanner** as a background Bash from the parent session:

   ```bash
   node scan.mjs > /tmp/career-ops-scan.log 2>&1
   ```

   This does Levels 1/2/2b zero-token: fetch ATS feeds + LinkedIn (JobSpy) + remoteineurope, apply the title filter, dedup against `data/scan-history.db` (auto-created, auto-migrates the legacy `.tsv`), write new rows, prefetch LinkedIn JDs into `data/jds/` + `Fetched` rows in `data/applications.md`. The employer ATS URL is resolved at scan time only when `LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID` are in `.env` (the free authenticated Voyager path); otherwise the LinkedIn URL is stored and ATS resolution defers to apply-time.

   End signal: process exit (notified automatically by the harness). The script always prints the per-level summary first, then `SCAN_FATAL=...` (if any), then `DISPATCH_URLS=[...]` (when non-empty and not `--dry-run`).

2. **Read only the markers** when the background Bash completes:

   ```bash
   grep -E "^(DISPATCH_URLS=|SCAN_FATAL=)" /tmp/career-ops-scan.log
   tail -40 /tmp/career-ops-scan.log   # per-level summary for the user
   ```

   Avoid `cat`-ing the full log — the per-URL listing can be hundreds of lines.

3. **Dispatch:** feed the URLs into the auto-pipeline flow (`modes/auto-pipeline.md`): `lib/prep-jds.mjs` inline, then batched eval agents. Pre-fetched LinkedIn JDs dispatch as their canonical URL (resolved employer ATS URL when Voyager ran, otherwise the LinkedIn URL); prep's dedup detects the existing `data/jds/` entry with `Fetched` status and queues it straight for gate + score (no double-fetch).

### Degraded-LinkedIn handling

If `scan.mjs` stdout contains `SCAN_FATAL=jobspy-unavailable` (printed before any `DISPATCH_URLS=`), the LinkedIn level could not run because `uv` is not on PATH or `python-jobspy` is not installable. **Stop and tell the user** the LinkedIn level was skipped and that JobSpy needs `uv` available (it runs `uv run --with python-jobspy`). Levels 1/2b/3 still ran — dispatch their URLs as normal. Detection is deterministic in `lib/scan-linkedin.mjs`; this mode only reacts to the marker. (If `LINKEDIN_LI_AT`/`LINKEDIN_JSESSIONID` are unset, that is **not** fatal — scan still runs and stores LinkedIn URLs; ATS resolution just defers to apply-time.)

## Level 3 — WebSearch + liveness check (agent-executed)

Optional, after `scan.mjs` exits. Run each `search_queries` entry with `enabled: true` via WebSearch. Dedup against the URLs already returned by Levels 1/2/2b.

**Extract `{title, company}` from result strings** — formats vary (`"Job Title @ Company"`, `"Job Title | Company"`, `"Job Title — Company"`, `"Job Title at Company"`). Generic regex:

```
(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$
```

**Verify liveness BEFORE dispatching.** WebSearch results can be weeks-stale (Levels 1/2/2b are real-time; only Level 3 needs this). For each new Level 3 URL, **sequentially — never parallel browser sessions**:

1. Try Firecrawl first — `firecrawl scrape "<url>" -o /tmp/verify.md` (no local browser, no leak risk). Fall back to agent-browser only if Firecrawl 403s or is out of credits.
2. agent-browser fallback (ephemeral, **always closed**):

   ```bash
   agent-browser --session-name verify open "<url>" \
     && agent-browser --session-name verify snapshot -i > /tmp/verify-snap.txt
   agent-browser close --session-name verify
   ```

   The `close` MUST run even if open/snapshot fails — wrap in a trap or use `;` so it always executes.
3. Classify:
   - **Active**: job title + role description + Apply/Submit control in main content.
   - **Expired**: `?error=true` in the final URL (Greenhouse), text "no longer available" / "position has been filled" / "page not found", or footer-only content (< ~300 chars).
4. Expired → insert into `scan-history.db` with `status='skipped_expired'`, discard.
5. Active → keep for dispatch.

## Final dispatch

Emit one final `DISPATCH_URLS=[...]` = the union of the Levels 1/2/2b URLs (from `scan.mjs`) plus the Level 3 survivors. The user's session feeds them into `modes/auto-pipeline.md`: `lib/prep-jds.mjs` inline (zero tokens), then batched background eval agents.
