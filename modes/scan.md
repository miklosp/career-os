# Mode: scan — Portal Scanner (Offer Discovery)

Discovers new job postings across LinkedIn AND configured ATS portals (Greenhouse / Ashby / Lever / BambooHR / Teamtailor / Workday), filters by title, deduplicates against `data/scan-history.db`, and prints `DISPATCH_URLS=[...]` so the invoking Claude session can fan out one background `auto-pipeline` agent per URL.

The mode runs entirely as zero-LLM-token shell + Node helpers. Browser-based discovery (CDP/Playwright) was retired — every source is now a structured API.

## Discovery sources

| Level | Source | Implementation |
|-------|--------|----------------|
| 1 | **ATS APIs** for `tracked_companies` with an `api:` definition | `scan.mjs` (existing, zero-token) |
| 2 | **LinkedIn** via Apify `valig~linkedin-jobs-scraper` + per-JD `apimaestro~linkedin-job-detail` | `lib/scan-linkedin.mjs` (zero-token; called from `scan.mjs`) |
| 2b | **remoteineurope.com** sitemap + per-page scrape; aggregator that links straight to employer ATS via clean apply-button | `lib/scan-remoteineurope.mjs` (zero-token; free; called from `scan.mjs`) |
| 3 | **WebSearch queries** for `search_queries` with `site:` filters (broad discovery, agent-executed because WebSearch needs an LLM tool call) | `modes/scan.md` agent path |

The historical "Level 3 — agent-browser via Chromium CDP" sub-flow is gone. CDP for LinkedIn search was the source of session-contamination bugs and is replaced by the Apify path. CDP for non-LinkedIn careers pages is replaced by Firecrawl in the per-JD `_fetch.md` ladder. The persistent Chromium on `:9222` now exists solely for `apply` mode.

## Configuration

Read `config/portals.yml`:

- `tracked_companies`: companies with `careers_url` and optionally `api:` (provider + slug). API-defined companies get hit by Level 1.
- `search_queries`: WebSearch queries with `site:` filters (Level 3).
- `linkedin_searches`: catalogue of LinkedIn search URLs / payloads (Level 2).
- `title_filter`: `positive` / `negative` / `seniority_boost` keyword lists. Applied uniformly to all sources.

Read `config/profile.yml` for `target_roles` (used to validate that LinkedIn searches are aligned with the user's North Star) and `location_policy` (for the per-JD location gate downstream — not enforced at scan time).

## Browser prerequisite

None. The whole scan is HTTP + structured APIs. Apify, Greenhouse, Ashby, Lever, BambooHR, Teamtailor, and Workday CXS all return JSON or RSS without authentication.

If `apply` mode happens to be running on `:9222` in headed mode, leave it alone — scan never touches CDP.

## Recommended execution

Run as a subagent so the scan output doesn't consume main context:

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of this file + portals.yml + profile.yml summary]",
  run_in_background=True
)
```

The agent's job is mostly orchestration: invoke `scan.mjs`, read its `DISPATCH_URLS` line, and (if `search_queries` are enabled) run the Level 3 WebSearch pass. The heavy lifting is in `scan.mjs` and `lib/scan-linkedin.mjs`.

## Workflow

```bash
node scan.mjs
```

`scan.mjs` does the following in order, all zero-token:

1. **Read config**: `config/portals.yml`.
2. **Open `data/scan-history.db`** (auto-creates on first run; also auto-migrates the legacy `.tsv`).
3. **Read existing offers**: `SELECT url FROM offers` → known URLs.
4. **Level 1 — ATS APIs (parallel)**: for each `tracked_companies` entry with `api:` defined and `enabled: true`, hit the structured feed (Greenhouse `/jobs`, Ashby GraphQL, Lever `?mode=json`, BambooHR `/careers/list`, Teamtailor `/jobs.rss`, Workday CXS `/jobs`). Parse per provider, collect `{title, url, company, portal}`.
5. **Level 2 — LinkedIn via Apify**: invoke `lib/scan-linkedin.mjs`. For each enabled `linkedin_searches` entry, parse the LinkedIn URL (or read the structured `payload:` field) and call `valig~linkedin-jobs-scraper` with `skipJobId` populated from scan-history. For each new job ID returned, call `apimaestro~linkedin-job-detail` to resolve the canonical employer ATS URL plus the full JD payload. Save `data/jds/{NUM}-{slug}.md` with all header fields (URL = the resolved employer ATS URL, NOT the LinkedIn URL) and insert a `Fetched` row into `data/applications.md`. See "LinkedIn helper details" below.

5b. **Level 2b — remoteineurope.com**: invoke `lib/scan-remoteineurope.mjs`. Fetches `https://remoteineurope.com/sitemap.xml`, dedups against scan-history.db (URL primary key), then fetches each new `/job/{slug}` page (parallel, concurrency 20). Parses `<title>{role} at {company}</title>` and the `<a class="apply-button">` href — that href is the canonical employer ATS URL (typically Greenhouse / Ashby / Workable / Workday). Applies title filter; inserts source URL into scan-history with `portal='remoteineurope'`; emits the resolved employer URL for dispatch. Free (pure HTTP, no Apify, no Firecrawl).

   The auto-pipeline agent dispatched against the resolved URL fetches the full JD itself via `_fetch.md` Priority 1 (the resolved URL is almost always a structured ATS endpoint). Unlike LinkedIn, we don't prefetch the JD body here — the aggregator's copy is a stale re-render of the employer's page, so it's better to fetch fresh from the source.
6. **Apply title filter** (in-process): keep rows whose `title` matches at least one `positive` keyword and zero `negative` keywords (case-insensitive).
7. **Deduplicate** by URL against `scan-history.db`. New rows get inserted with `status='added'`. Filter rejections get `status='skipped_title'`. URL-level duplicates from multiple search sources collapse on the SQLite primary key.
8. **Print `DISPATCH_URLS=[...]`** on stdout — the canonical employer ATS URLs (Level 1) plus the resolved LinkedIn-derived URLs (Level 2).

After `scan.mjs` exits, the orchestrator can OPTIONALLY run Level 3 (WebSearch). This step is agent-driven because WebSearch needs an LLM tool call:

9. **Level 3 — WebSearch queries** (parallel where possible): run each query in `search_queries` with `enabled: true`. Extract `{title, url, company}` from results — see "Extracting title and company from WebSearch results" below. Dedup against Levels 1 and 2.

10. **Verify liveness of WebSearch results — BEFORE dispatching:**

   WebSearch results can be stale (Google caches for weeks). Levels 1 and 2 are inherently real-time. Only Level 3 needs this check.

   For each new URL from Level 3 (sequential — never parallel browser sessions for liveness):
   1. `agent-browser snapshot -i <url>` (or Firecrawl)
   2. Classify:
      - **Active**: job title visible + role description + Apply/Submit control in main content.
      - **Expired** signals: `?error=true` in final URL (Greenhouse), text "no longer available" / "position has been filled" / "page not found", footer-only content (< ~300 chars).
   3. Expired → insert into `scan-history.db` with `status='skipped_expired'`, discard.
   4. Active → continue to dispatch.

11. **Final dispatch line**: union of Level 1+2 (from `scan.mjs`) plus Level 3 survivors. The orchestrator emits a final `DISPATCH_URLS=[...]` and the user's session fans out one `auto-pipeline` agent per URL.

## LinkedIn helper details (`lib/scan-linkedin.mjs`)

The helper exists so the LLM never has to reconstruct the Apify call. All title permutations, the `skipJobId` array, the actor invocations, and the per-JD detail fetch are pure Node.

What it does, in one zero-token pass:

1. Read `config/portals.yml` `linkedin_searches`.
2. For each enabled entry, build a valig payload:
   - If `payload:` field is present, use it directly.
   - Otherwise parse the LinkedIn search URL — `keywords` → `title`, `location` → `location`, `f_TPR` → `datePosted`, `f_E` → `experienceLevel` (CSV split), `f_JT` → `contractType` (CSV split), `f_WT` → `remote` (CSV split). Anything else → append to `urlParam[]` as `{key, value}`.
3. Read `data/scan-history.db` for every LinkedIn job ID we've seen (`url LIKE 'https://www.linkedin.com/jobs/view/%'`). Inject the IDs as `skipJobId` so the actor only returns genuinely new ones — this is the single biggest credit saver.
4. POST to `valig~linkedin-jobs-scraper/run-sync-get-dataset-items` (parallel, capped at **2** simultaneous calls — Apify's account limit on the current plan). Concatenate responses, dedup by `id`.
5. Apply the same `title_filter` from `portals.yml` so noise-titles are filtered before we spend per-JD credits.
6. For each survivor, POST to `apimaestro~linkedin-job-detail/run-sync-get-dataset-items` with `{"job_id":[...]}` (batched, up to ~50 IDs per call to amortize the actor cold-start). Read three nested objects per record: `job_info`, `company_info`, `apply_details`.
7. For each detail record:
   1. Reserve NUM via `lib/next-num.mjs`.
   2. Compute canonical employer URL from `apply_details.application_url` (fallback: `https://www.linkedin.com/jobs/view/{id}` if the actor returned no resolved URL — easy-apply roles).
   3. Strip query string, trailing slash, `/application` suffix.
   4. Build slug `{company-slug}-{role-slug}`.
   5. Write `data/jds/{NUM}-{slug}.md` with `**Fetch-method:** apify-linkedin`, `**Status:**` derived from `job_state`/`expire_at`, full Role Summary / Responsibilities / Requirements / Compensation / Other Details sections from `job_info.description`.
   6. Insert `Fetched` row into `data/applications.md`.
   7. Insert into `scan-history.db` with the LinkedIn URL (so the *next* scan dedups via `skipJobId`), `portal='linkedin-apify'`, `status='added'`.
   8. Release the NUM reservation marker.
8. Return the list of new URLs (canonical ATS URLs) for `scan.mjs` to include in `DISPATCH_URLS`.

The auto-pipeline agents that the user's session subsequently dispatches will hit the dedup at `_fetch.md` Step 1 (URL already in `data/jds/`). Step 1 is status-aware: when the matching `applications.md` row is `Fetched` (i.e. this scan prefetched the JD), the agent skips Steps 2–5 and proceeds directly to location-gate + scoring. No double-fetch, no duplicate Apify spend.

## Filter code reference (LinkedIn-side)

These are LinkedIn's own internal filter codes, exposed through `f_*` URL params and through the valig actor's structured fields:

| Field | Codes |
|-------|-------|
| `datePosted` | `r3600` (1h), `r86400` (24h), `r604800` (7 days, default), `r2592000` (30 days) |
| `contractType` | `F`=Full-time, `P`=Part-time, `C`=Contract, `T`=Temporary, `V`=Volunteer, `I`=Internship, `O`=Other |
| `experienceLevel` | `1`=Internship, `2`=Entry, `3`=Associate, `4`=Mid-Senior, `5`=Director, `6`=Executive |
| `remote` | `1`=On-site, `2`=Remote, `3`=Hybrid |
| `urlParam` | `[{key, value}]` passthrough for any LinkedIn `f_*` filter not modeled above |

When migrating an existing `linkedin_searches` URL to a structured `payload:` block, follow this mapping. Both forms work.

## Apify rate-limiting

Both LinkedIn actors (`valig`, `apimaestro`) use Apify's managed proxy infrastructure (residential + datacenter rotation) and are explicitly "no cookies required". Apify handles LinkedIn-side rate-limiting internally — we do NOT need to throttle calls from our side. The valig actor's 30-day stats: 33,862 successes vs 33 aborts (99.7% success rate).

The only constraint we respect on our side:

- **Account-level parallel cap**: 2 simultaneous Apify runs (current plan). `lib/scan-linkedin.mjs` enforces this with a small concurrency limiter.

The historical "human pacing — 3–5s between navigations" rule applied only to authenticated CDP scraping. With Apify it does not apply.

## Credit caveat

Apify charges per actor run. Credits can run out — check before bulk runs:

```bash
xh GET "https://api.apify.com/v2/users/me?token=$APIFY_API_TOKEN" | jq '.data.usageCycle'
firecrawl --status | grep Credits
```

Approximate per-call cost:

- valig (LinkedIn search): ~$0.001 per result returned (a 50-job sweep is pennies).
- apimaestro (per-JD detail): ~$0.005 per job. Called once per dispatched LinkedIn ID.
- Firecrawl (only relevant downstream when the resolved ATS URL is an SPA without a structured API): ~1 credit per page.

If either pool is dry, scale back the `datePosted` window (e.g. switch to `r86400` for daily scans), drop secondary searches, or stop and tell the user. Don't silently fall back to CDP scraping just because Apify is exhausted — flag it.

`skipJobId` is the biggest credit saver. The helper always passes scan-history through; never call valig without it.

## Title filtering

Lives in `config/portals.yml` `title_filter`. Applied uniformly across all levels, in-process, on the response title field. Don't put title rules into the LinkedIn `keywords` query itself — keep that for boolean LinkedIn matching only. Boolean matching at the source plus structured filtering on our side gives the best signal-to-noise.

## Scan history

`data/scan-history.db` (single table):

```sql
CREATE TABLE offers (
  url        TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,        -- YYYY-MM-DD
  portal     TEXT,                 -- 'greenhouse-api', 'ashby-api', 'linkedin-apify', 'websearch — AI PM', etc.
  title      TEXT,
  company    TEXT,
  status     TEXT NOT NULL DEFAULT 'added'
                                   -- added | skipped_title | skipped_dup | skipped_expired
);
```

LinkedIn rows store the LinkedIn URL (`linkedin.com/jobs/view/{id}`) so the next scan's `skipJobId` dedup works server-side. The corresponding JD file in `data/jds/` uses the resolved employer ATS URL as its canonical `**URL:**` line.

The legacy `data/scan-history.tsv` is preserved as `.bak` after the one-shot SQLite migration.

## Extracting title and company from WebSearch results (Level 3 only)

WebSearch results come in formats like `"Job Title @ Company"` or `"Job Title | Company"` or `"Job Title — Company"`. Extraction patterns per portal:

- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title `Senior AI PM`, company `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title `AI Engineer`, company `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title `Product Manager - AI`, company `Temporal`

Generic regex: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## Output summary

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Level 1 (ATS APIs): N companies hit, M jobs returned
Level 2 (LinkedIn Apify): N searches run, M IDs returned, K survived title filter, J prefetched JDs written
Level 3 (WebSearch, optional): N queries run, M results, K verified active

Filtered by title: total N relevant
Duplicates: N (already seen)
Apify credits used: ~$N.NNN (search) + ~$N.NN (per-JD detail)

  + {company} | {title} | {source} | NUM {n}
  ...

DISPATCH_URLS=["https://...","https://..."]
```

The caller parses the `DISPATCH_URLS=[...]` line and spawns one background `auto-pipeline` agent per URL. Pre-fetched LinkedIn JDs are dispatched as their canonical employer ATS URL — the agent's `_fetch.md` Step 1 detects the existing `data/jds/` entry with `Fetched` status and skips ahead to gate + score.

## Maintenance

- Add new companies to `tracked_companies` with `careers_url` (always) and `api:` (when on a known ATS) — that promotes them to Level 1.
- Add new LinkedIn saved searches to `linkedin_searches` (URL or structured `payload:` form).
- Disable noisy queries with `enabled: false`.
- Adjust `title_filter` keywords as target roles evolve.
- Verify `careers_url` periodically — companies change ATS platforms. The 404 detection in Level 1 will surface broken links.
