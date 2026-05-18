# Mode: scan — Portal Scanner (Offer Discovery)

Discovers new job postings, filters by title, dedups against `data/scan-history.db`, and emits `DISPATCH_URLS=[...]` so the session can fan out one background `auto-pipeline` agent per URL.

Levels 1 (ATS APIs), 2 (LinkedIn via JobSpy), 2b (remoteineurope.com), and 2c (hiring.cafe) run **entirely inside `node scan.mjs`** — zero LLM tokens, free (no paid vendor). Level 3 (WebSearch) is the only agent-executed part, because WebSearch needs an LLM tool call. Implementation internals (the JobSpy subprocess, the optional Voyager ATS resolver, LinkedIn filter-code derivation, the hiring.cafe SSR/searchState scheme, rate-limit rationale, the `scan-history.db` schema) live in the script banners — `scan.mjs`, `lib/scan-linkedin.mjs`, `lib/scan-jobspy.py`, `lib/li-voyager.mjs`, `lib/scan-hiringcafe.mjs` — not here.

## Configuration

`config/portals.yml` drives everything: `tracked_companies` (Level 1 — those with an `api:` block), `linkedin_searches` (Level 2), `hiringcafe_searches` (Level 2c — one semantic role phrase per entry, **not** boolean), `search_queries` with `site:` filters (Level 3), and `title_filter` (applied in-process by `scan.mjs` across **all** levels — don't bake title rules into LinkedIn `keywords`; keep that for boolean LinkedIn matching). `config/profile.md` (Target Roles & Archetypes) is a sanity check that searches match the North Star; the frontmatter `location_policy` is for the downstream per-JD gate, not enforced at scan time. `banned_companies` (the ban list — inverse of `tracked_companies`) is enforced at scan time across **all** levels: a matching company/URL is dropped before the LinkedIn detail credit and never reaches `DISPATCH_URLS`; the run summary prints a `Banned skipped:` count per level.

## Recommended execution

Run as a background subagent so scan output doesn't consume main context. The agent's whole job is orchestration: run the script, read its output line, run the Level 3 pass.

## Core orchestration

1. **Run the scanner:**

   ```bash
   node scan.mjs
   ```

   This does Levels 1/2/2b/2c zero-token: fetch ATS feeds + LinkedIn (JobSpy) + remoteineurope + hiring.cafe, apply the title filter, dedup against `data/scan-history.db` (auto-created, auto-migrates the legacy `.tsv`), write new rows, prefetch LinkedIn JDs into `data/jds/` + `Fetched` rows in `data/applications.md`. The employer ATS URL is resolved at scan time only when `LINKEDIN_LI_AT` + `LINKEDIN_JSESSIONID` are in `.env` (the free authenticated Voyager path); otherwise the LinkedIn URL is stored and ATS resolution defers to apply-time.

2. **Parse stdout:** read the `DISPATCH_URLS=[...]` line — a JSON array of canonical employer ATS URLs (Levels 1/2/2b/2c). Printed only when non-empty and not `--dry-run`.

3. **Dispatch:** spawn **one background `auto-pipeline` agent per URL** (`modes/auto-pipeline.md`), bounded to ≤ 3 concurrent. Pre-fetched LinkedIn JDs dispatch as their canonical URL (resolved employer ATS URL when Voyager ran, otherwise the LinkedIn URL); the agent's `_fetch.md` Step 1 detects the existing `data/jds/` entry with `Fetched` status and skips straight to gate + score (no double-fetch).

### Degraded-LinkedIn handling

If `scan.mjs` stdout contains `SCAN_FATAL=jobspy-unavailable` (printed before any `DISPATCH_URLS=`), the LinkedIn level could not run because `uv` is not on PATH or `python-jobspy` is not installable. **Stop and tell the user** the LinkedIn level was skipped and that JobSpy needs `uv` available (it runs `uv run --with python-jobspy`). Levels 1/2b/2c/3 still ran — dispatch their URLs as normal. Detection is deterministic in `lib/scan-linkedin.mjs`; this mode only reacts to the marker. (If `LINKEDIN_LI_AT`/`LINKEDIN_JSESSIONID` are unset, that is **not** fatal — scan still runs and stores LinkedIn URLs; ATS resolution just defers to apply-time.)

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

Emit one final `DISPATCH_URLS=[...]` = the union of the Levels 1/2/2b URLs (from `scan.mjs`) plus the Level 3 survivors. The user's session fans out one background `auto-pipeline` agent per URL.
