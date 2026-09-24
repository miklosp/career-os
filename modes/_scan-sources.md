# Scan sources

Where career-ops discovers job offers: which sources are wired in, what each one's quirks and failure modes are, and which sources were evaluated and deliberately rejected. Orchestration (how the levels run, dispatch, degraded handling) lives in `modes/scan.md`; per-source implementation internals live in the script banners. This file holds the knowledge that has no home in code - why a source was chosen, what breaks, and what not to re-test.

## Active sources

| Source | Level | Helper script | Cost | Notes |
|---|---|---|---|---|
| ATS APIs (Greenhouse, Ashby, Lever, Recruitee, Teamtailor, join.team, Personio, SmartRecruiters, BambooHR, Breezy) | 1 | `scan.mjs` (inline) | Free | Real-time, exact, employer-first. Driven by `tracked_companies` in `user/config/portals.yml`. |
| LinkedIn | 2 | `lib/scan-linkedin.mjs` + `lib/scan-jobspy.py` (+ optional `lib/li-voyager.mjs`) | Free | Discovery + full JD text in one pass. JD prefetched, agents skip `modes/_fetch.md`. |
| Remote PM Jobs (remotepmjobs.com) | 2f | `lib/scan-remotepmjobs.mjs` | Free | Public MCP server; scan-side geo gate + ATS resolution. PM-only board. |
| Platsbanken (JobTech JobSearch API) | 2g | `lib/scan-platsbanken.mjs` | Free | Sweden's national job board, official open data. Full JD + employer apply URL per hit; JD prefetched. |
| startupmap.one | seed | `lib/import-startupmap.mjs` | Free | Not a discovery level: one-off/re-runnable importer that turns startup careers boards into `tracked_companies` entries. |
| Firecrawl | support | `firecrawl` CLI | ~1 credit/scrape | Not a discovery source: the SPA fetch fallback (`modes/_fetch.md` Priority 3) and the first-choice liveness prober for offer verification. |

Level numbering: integer levels are major source classes (1 = ATS APIs, 2 = LinkedIn). Aggregator scanners are conceptually a sub-pattern of LinkedIn-style discovery (find URLs, dedup, scrape titles), so they sit under Level 2 with a letter suffix. New aggregators follow the same shape: `lib/scan-{site}.mjs`, called from `scan.mjs`, next free letter. `2b` (remoteineurope.com), `2c` (hiring.cafe), `2d` (englishjobs.se) and `2e` (We Work Remotely) are burnt - see "Rejected sources".

### Level 1 - tracked-company ATS APIs

The only real-time, exactness-guaranteed level. Boards are auto-detected from each `careers_url`; an explicit `api:` block on a `tracked_companies` entry overrides detection. Zero-auth list endpoints and the canonical per-job URL each one yields are documented in the `scan.mjs` banner.

Level 1 stays even where a broader crawler would subsume its mechanism: it is real-time and exact, where crawler-derived sources run at roughly a day's latency.

### Level 2 - LinkedIn (JobSpy, free)

Discovery and JD text come from JobSpy (`uv run --with python-jobspy`), spawned by `lib/scan-linkedin.mjs`. The employer ATS URL is a separate problem - see below.

**Filter codes.** `linkedin_searches` entries in `user/config/portals.yml` carry LinkedIn's own internal `f_*` filter codes (a pasted LinkedIn search URL works as-is; `lib/scan-linkedin.mjs` derives `hours_old` from `f_TPR` and `is_remote` from `f_WT=2`). Keep this reference when editing searches:

| Field | Codes |
|---|---|
| `datePosted` / `f_TPR` | `r3600` (1h), `r86400` (24h), `r604800` (7d default), `r2592000` (30d) |
| `contractType` / `f_JT` | F=Full-time, P=Part-time, C=Contract, T=Temporary, V=Volunteer, I=Internship, O=Other |
| `experienceLevel` / `f_E` | 1=Internship, 2=Entry, 3=Associate, 4=Mid-Senior, 5=Director, 6=Executive |
| `remote` / `f_WT` | 1=On-site, 2=Remote, 3=Hybrid |

Do not bake title rules into LinkedIn `keywords` - `title_filter` in `portals.yml` is applied in-process across all levels; `keywords` is for LinkedIn's own boolean matching only.

**The ATS-resolution wall (tested 2026-05-18).** LinkedIn gates the offsite apply URL behind authentication. These were tested and eliminated - each returns jobs plus JD text but NOT the employer ATS URL. Do not re-evaluate unauthenticated or free LinkedIn tools for ATS resolution; they cannot cross this by construction:

- JobSpy - `job_url_direct` is null.
- browser-use cloud CDP - auth-gated.
- ever-jobs - no apply field in the schema.
- Bright Data dataset `gd_lpfll7v5hcqtkxl6l` - `apply_link` null 8/8, even for off-site roles, even paid.

Only two things worked: the (now removed) Apify detail actor, and authenticated LinkedIn Voyager REST.

**Voyager (optional, free, 6/6 empirically).** Runs only when `LINKEDIN_LI_AT` and `LINKEDIN_JSESSIONID` are in `.env` (gitignored; `JSESSIONID` includes the `ajax:` prefix). `lib/li-voyager.mjs` exposes `resolveAts` / `hasVoyagerCookies` / `unwrapApplyUrl` / `fetchJobPosting` / `parseJobPosting` / `pickAts`.

```
GET https://www.linkedin.com/voyager/api/jobs/jobPostings/{jobId}
headers: csrf-token: <JSESSIONID value incl. "ajax:" prefix, no quotes>
         x-restli-protocol-version: 2.0.0 ; realistic user-agent
cookie:  li_at=<token>; JSESSIONID="ajax:..."
```

`.applyMethod` resolves to `com.linkedin.voyager.jobs.OffsiteApply.companyApplyUrl` (the ATS URL) or `com.linkedin.voyager.jobs.ComplexOnsiteApply` (Easy-Apply: on-platform, no ATS, skip).

Caveats:
- Reverse-engineered and LinkedIn-ToS-violating; own-account risk. Tested on a throwaway account.
- Some `companyApplyUrl` values are tracking-redirect wrappers (recruitics `jsv3.recruitics.com/redirect?...&rx_url=<encoded>`, LinkedIn `externalApply?url=`). Unwrap by query-param decode.
- Resolved ATS URLs often carry meaningful query strings (`?folderId=` on Avature). Store them VERBATIM; do NOT run the lossy `canonicalizeUrl` on them.
- Rate limit: serial with pacing (1.5s). 401/403 means cookies expired - re-grab both.

**Without cookies, ATS resolution defers to apply-time.** Nothing upstream of `modes/apply.md` needs the ATS URL: `modes/_eval.md`'s `**URL:**` accepts a LinkedIn URL, and the headed authenticated apply browser resolves it via the native "Apply on company website" click. Missing cookies is NOT fatal to a scan; only a missing `uv` / python-jobspy is (`SCAN_FATAL=jobspy-unavailable`).

**Dedup.** `recordFetch` dual-rows the canonical URL and `linkedin.com/jobs/view/{id}`, so ID-level dedup keeps working whether or not Voyager ran.

**Retired: the Apify path.** Level 2 previously used the paid pair `valig~linkedin-jobs-scraper` (discovery, ~$0.001/result, `skipJobId` for server-side dedup) plus `apimaestro~linkedin-job-detail` (per-JD detail, ~$0.005/job, `apply_details.application_url` = employer ATS URL). It worked - 99.7% success over valig's 33,969 30-day runs, a full 12-search sweep cost ~$0.81 - but JobSpy gives everything the scan-to-score half consumes for free, so Apify was removed from the pipeline entirely on 2026-05-18 along with `APIFY_API_TOKEN`. Do not re-introduce it without a reason JobSpy plus Voyager cannot cover. The old helper name was `lib/linkedin-scan.mjs`; the current one is `lib/scan-linkedin.mjs`.

**New-ATS pointer.** When a new ATS needs a parser, port one from ever-jobs (`packages/plugins/source-ats-*`, ~38 connectors) or JobSpy before reverse-engineering it - see the learning loop in `modes/_fetch.md`.

### Level 2f - Remote PM Jobs (integrated 2026-06-08)

Driven by `remotepmjobs_searches` in `user/config/portals.yml`. PM-only board - design-leadership roles never appear here, those stay with LinkedIn and Platsbanken.

remotepmjobs.com exposes a **public, auth-free, CORS-open, stateless MCP server at `https://remotepmjobs.com/api/mcp`** (streamable HTTP). It is called as plain JSON-RPC POST (`tools/call` to `search_jobs` / `get_job` / `list_filters`) - no MCP client library, no session handshake. The server's own `instructions` field explicitly invites programmatic use.

Hard-won gotchas, all tested - do not re-investigate:

- **The `seniority` structured filter is BROKEN.** It always times out, at any value or limit. Use the semantic `query` filter instead, **one clean title phrase per entry**: multi-term queries match nothing ("AI Product Manager" works; "Head of Product VP Product Director" returns 0).
- **The endpoint throttles bursts.** Roughly 15 rapid calls produce sustained timeouts. `mcpCall` retries 3x on transient/5xx; `get_job` concurrency is 3. Coverage accumulates across daily runs, like LinkedIn. A failed `get_job` is dropped rather than recorded, so it is retried next run.
- **`get_job` returns no verbatim JD body** - only `rolePitch`, plus rich `enrichment` (requiredSkills, niceToHaveSkills, aiNativeSignals, yearsExperienceMin, geoRestriction, company industry/size/funding). The prefetched JD links to `canonicalUrl` for the full text. There is **no apply-URL field anywhere** in the MCP response.
- **Scan-side geo gate (added 2026-06-09).** `get_job`'s structured `enrichment.locationEligibleRegions` (`["us"]` / `["worldwide"]` / `["emea"]`) and `locationEligibleLocales` (ISO codes - a Sweden role lists `"SE"`) are the reliable signal, gated against `user/config/profile.md` `location_policy` so the US/Canada flood is dropped at the source and never fetched, scored, or skipped downstream. A cheap free-text pre-gate on the search-result `geoRestriction` skips obvious-US before `get_job`; the structured gate is authoritative; ambiguous cases (null / "Remote" / unspecified) fall through to the downstream location gate. Real-world: about 29 of 40 dropped on a broad PM query.
- **The `geoRestriction` source filter is exact-match on messy free text** (~250 distinct strings: city names, timezones, country lists), not a clean region enum. Arrays are ignored (they return the whole dataset), `"Worldwide"` returns 0 (the actual value is `"Anywhere in the World"`). Single exact values do work (`"EMEA"` 13, `"Europe"` 22, `"Sweden"` 5) but are brittle - do not rely on it as the geo filter, use the structured gate.
- **ATS resolution (added 2026-06-09).** The canonical page embeds the Apply button as the outbound link tagged `utm_source=remotepmjobs.com...utm_campaign=apply`. Regex it out, strip the utm params (keep meaningful query such as `?gh_jid=`) and you get the real employer ATS URL (Greenhouse / Ashby / Workday / own careers; close to 100% hit rate). That becomes the JD's `**URL:**` / `**Apply page:**`; the remotepmjobs canonical moves to a `**Source:**` line. `lib/fetch-jd.mjs` has a `**Source:** {inputCanonical}` dedup fallback so a dispatched or pasted remotepmjobs URL still resolves on disk. **Dispatch and scan-history dedup stay keyed on the remotepmjobs canonical** - `search_jobs` only ever returns that.

### Level 2g - Platsbanken (integrated 2026-09-24)

Driven by `platsbanken_searches` in `user/config/portals.yml`. Arbetsförmedlingen's JobTech JobSearch API (`https://jobsearch.api.jobtechdev.se/search`) is official open data: free, no auth, no key. It is the only source that covers Swedish on-site and hybrid roles outside LinkedIn.

- **`q` is an AND full-text match over headline + body**, so broad single words (`product`, `design`, `ux`) are the sweep; ~2,800 hits in total, and the global `title_filter` cuts it to a handful. Multi-word queries shrink fast (`product manager` 33, `head of product` 9). Pagination is 100/page with an offset cap of 2,000.
- **Every hit ships the full JD** (`description.text`), employer legal name, `workplace_address`, `workplace_model` and `application_deadline`, so the JD is prefetched and agents skip `modes/_fetch.md`.
- **`application_details.url` is the employer apply URL** for most ads (Teamtailor, Workday, Ashby, SmartRecruiters, Greenhouse, own careers pages). It becomes `**URL:**`/`**Apply page:**`; the Platsbanken ad URL stays on `**Source:**` and is the dispatch + dedup key, the same contract as remotepmjobs. The field is sometimes scheme-less or a recruiter's LinkedIn profile; both are handled.
- **Cross-source dedup** on the apply URL and on cleaned-company::role against `applications.md`: the same Swedish ad often surfaces on LinkedIn too. Employer names are legal entities (`Lovable Labs Sweden AB`); trailing `AB`/`Aktiebolag`/`Sweden`/`(publ)` are stripped for the tracker.
- **Many ads are Swedish-language or placed by staffing agencies** (Academic Work, ANTS, Nordic Investin). Language is handled by the deterministic location gate (`jd_language_not_allowed`); agencies go on the ban list when they turn up.
- Smoke test: `node lib/scan-platsbanken.mjs --dry-run`.

### startupmap.one (company seeding, 2026-09-24)

`https://startupmap.one` maps European startups by city. It is used only to **seed Level 1**, never as a discovery level. `robots.txt` allows `/startup/*` (`Content-Signal: ai-input=yes`) and disallows `/api`, so `lib/import-startupmap.mjs` reads the sitemap, then each `/startup/{slug}_{cc}` page serially with a delay, pulls the embedded `website_careers_url`, keeps boards `scan.mjs`'s `detectApi()` recognises (plus Teamtailor custom domains via `/jobs.json`), probes each board once, and prints `tracked_companies` YAML to paste into `portals.yml`. Re-run it to pick up newly listed startups; already-tracked names and boards are skipped.

### Firecrawl (fetch and verify support, not discovery)

`FIRECRAWL_API_KEY` lives in the gitignored `.env` at the repo root alongside `BIFROST_*`. Source it before calling:

```bash
set -a; source .env; set +a
firecrawl scrape "{url}" -o /tmp/fc-{NUM}.md
```

- ~1 credit per scrape. Check `firecrawl --status` before bulk runs. Concurrency cap is 2 parallel jobs.
- **Does NOT work on LinkedIn** (auth wall).
- If credits run out, fall back to a fresh ephemeral Playwright context (`modes/_fetch.md` Priority 5).
- **Why it is preferred over agent-browser/CDP for unauthenticated content:** a shared CDP profile (`$HOME/.chromium-debug`) carries persistent state - service workers, IndexedDB, stale tabs - between agent runs, which caused real false-dedup bugs (Synder content served for unrelated Accure and Alva URLs). Firecrawl runs each scrape in an isolated cloud browser, immune to that contamination.
- Verified on the Alva careers SPA - the URL that originally exposed the CDP-contamination bug - returning 84 lines of clean markdown including JD body, location, hiring contact, and apply link.

## Aggregator liveness

**Aggregator repost pages stay live long after the employer closes the requisition.** Jobgether, Remotive, Himalayas and euremotejobs all do this. Any liveness check on an aggregator URL must resolve to the **employer's own ATS URL first**, then verify - never verify the aggregator page.

Measured on the 2026-07-31 scan: 2 false positives out of 14 "live" verdicts.

- Cint via Jobgether - aggregator page rendered fine; the SmartRecruiters API said `"active": false` (released 2026-06-22).
- Finary via Remotive - aggregator page scraped at 5 KB with no dead-phrase markers; the URL was actually HTTP 410 Gone, and Finary's Ashby board had no Head of Product role at all.
- smartclip via Himalayas - Himalayas still advertised "Apply before Aug 22, 2026" while `careers.smartclip.tv` returned 410.

Why the byte-count plus dead-phrase heuristic in `modes/scan.md` misses these: aggregator shells are large enough to clear the "under ~300 chars = footer only" test and carry no "no longer available" string. That classifier is only safe on employer ATS pages.

**How to apply:** extract the APPLY href from the scraped aggregator markdown (it carries the employer ATS URL), then feed *that* to `lib/prep-jds.mjs` - its dedup and fetch handlers settle liveness for free. This also skips the solo-agent cost: on that run it turned 7 would-be solo agents into one zero-token prep call.

**Aggregator hosts must never get a `lib/ats-registry.json` entry.** They are multi-employer, so a host-to-handler mapping would misroute every other employer's posting.

**Authoritative liveness endpoints.** HTTP status on the human page is not enough - Workday serves a 128-byte JS shell and Workable a 7.6 KB SPA shell, both 200, whether the role is open or closed.

| ATS | Check |
|---|---|
| Ashby | `api.ashbyhq.com/posting-api/job-board/{org}` - is `{id}` in `.jobs[]`? |
| Lever | `api.lever.co/v0/postings/{org}/{id}` - 200 |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{org}/jobs/{id}` - 200 |
| Workday | `{host}/wday/cxs/{tenant}/{site}/job/{path}` - `.jobPostingInfo.canApply` |
| Workable | `apply.workable.com/api/v2/accounts/{org}/jobs/{shortcode}` - `.state == "published"` |
| SmartRecruiters | posting API - `.active` |
| Teamtailor | page 410s when closed; a full render (tens of KB) means open |

Run these **backgrounded**: a foreground loop over ~12 URLs blocked past a 7-minute timeout, while the same calls each finish in well under a second.

## Rejected sources - do not re-propose

| Source | Date evaluated | Reason rejected |
|---|---|---|
| englishjobs.se | 2026-05-18 | Recruiter pool - no employer identity, no employer ATS link, apply is `mailto:` |
| remote.io | 2026-06-08 | Only structured source (`/api/portal/jobs`) is robots-disallowed; no RSS, no JSON-LD |
| Upstream `scan-ats-full.mjs` reverse-ATS discovery | 2026-07-02 | Brute-force over a 28.7k third-party slug dump with zero geo/role metadata; US-heavy firehose |
| hiring.cafe | removed 2026-09-10 | robots.txt disallows the `?searchState=` pattern; Cloudflare blocks Node's TLS fingerprint |
| remoteineurope.com | removed 2026-09-24 | Site gone: redirects to weworkremotely.com, sitemap 404 since May 2026 |
| We Work Remotely | removed 2026-09-24 | 0 of 38 scored JDs reached 4.0 - pure eval-token cost; apply URL is WWR-internal |

### englishjobs.se (2026-05-18)

Technically it would have been easy: a WordPress site with a clean zero-token REST API at `https://www.englishjobs.se/wp-json/wp/v2/jobs` (256 jobs, `X-WP-Total` / `X-WP-TotalPages` pagination, `?after=ISO&orderby=date&order=desc&_fields=...` for incremental delta, full JD HTML in `content.rendered`, `job-role` / `job-type` taxonomies). A `lib/scan-englishjobs.mjs` cloned from the (since removed) remoteineurope helper would have slotted in as Level 2d.

**Why rejected:** there is no employer/company field anywhere in the structured data and no external employer ATS link. The only apply path is `mailto:...@englishjobs.se` - recruiter/agency-mediated, reposted and aggregated listings. That breaks the tracker's Company column and dedup, and it breaks `modes/apply.md`'s real-employer-form model. It is exactly the low-signal recruiter-pool category the quality-over-quantity design filters against. Do not re-propose or re-investigate unless the user asks.

### remote.io (2026-06-08)

A Vite/React SPA: every `/feed`, `/rss` and `*.xml` path returns the app shell (soft-404) - no RSS, no JSON-LD, and no embedded job data in the HTML. Jobs load only from its private JSON API **`/api/portal/jobs`** (traced in the JS bundle). But `robots.txt` carries `Disallow: /api/` **and** `Disallow: /portal/` for all agents; Googlebot is allowed only `/api/v2/`, `/api/profiles/` and `/api/og/`, none of which serve jobs. Its only structured source is explicitly crawl-disallowed, so using it would defy the site's stated policy and the project's good-citizen posture. Do not re-propose without a new official feed or API.

### Upstream reverse-ATS discovery, `scan-ats-full.mjs` (2026-07-02)

Upstream `scan-ats-full.mjs` (santifer/career-ops #746) "reverse ATS discovery" was evaluated and rejected for this fork. Its "companies you haven't configured" universe is a third-party GitHub slug dump (`Feashliaa/job-board-aggregator`, unpinned main): about 28,700 bare board slugs (8.3k Greenhouse / 4.4k Lever / 3.2k Ashby / 12.9k Workday) with **zero geo or role metadata**, brute-force fetched per slug and keyword-filtered client-side. Zero tokens, but US/global-heavy, producing a firehose of US title matches that the per-JD location gate would discard 90%+ of. It is a quantity tool grafted onto a quality-over-quantity pipeline.

At the time, the decisive reason to skip was that the fork already had the better version in hiring.cafe (server-side geo, workplace-type, date and semantic filtering, returning the employer's real apply URL). **hiring.cafe has since been removed** (below), so that specific argument no longer holds - but the primary objection stands on its own: geo-precision and ethos, not recruiter-pool noise. The slug dump still carries no geo or role metadata.

Cheaper alternatives already present: broaden the role phrases and geo settings on the existing searches, add newly found companies to `portals.yml` `tracked_companies`, and lean on remotepmjobs / Platsbanken. Seeding the slug universe from `portals.yml` is pointless - `scan.mjs` already scans those at Level 1. The only defensible lite variant would be VC-portfolio seeds (`--seeds yc,a16z`, bounded to a few thousand), but that is US and early-stage skewed; revisit only if startup coverage is specifically wanted.

### hiring.cafe (removed 2026-09-10)

hiring.cafe was Level 2c in `scan.mjs`. `lib/scan-hiringcafe.mjs`, the `hiringcafe_searches` config block and all doc references were removed on 2026-09-10. Two independent blockers, both verified in-session:

1. **`hiringcafe.com/robots.txt` now carries `Disallow: /*?searchState=*`** - the exact URL pattern the scanner was built on - plus `x-robots-tag: noindex, nofollow` on search responses. Same reason remote.io was declined.
2. **Cloudflare blocks Node's TLS fingerprint specifically.** Interleaved same-IP A/B across 5 queries: Node `fetch` (undici) challenged 5/5, Node `https` module challenged, Node plus Chrome cipher order challenged - while `curl --http1.1` returned real job JSON at the same moment, 10/10. Headers, cookies and CSRF tokens are NOT the discriminator. An IP rate limit sits on top: roughly 10-20 requests trips a 429 with `Cf-Mitigated: challenge`, clearing after about 90s.

A workaround exists and was proven end-to-end (shell out to macOS system curl `--http1.1` in `fetchHtml`, 8s inter-request delay, 95s cooldown retry, yielding 39 unique dispatch URLs across 5 searches). **It was deliberately not shipped**: it knowingly circumvents a stated anti-scraping posture, and it depends on macOS `/usr/bin/curl`'s SecureTransport/LibreSSL fingerprint specifically (Homebrew curl on OpenSSL is untested and likely differs).

The legitimate alternative does not substitute: the `Allow`ed sitemaps are an unfiltered 12,721-URL US-heavy dump with no semantic ranking and no geo filter - the same shape already rejected as reverse-ATS discovery.

The SSR scheme itself never broke (`__NEXT_DATA__` to `props.pageProps.ssrHits` still parses); the failure was purely transport-layer. `hiring.cafe` also now 308-redirects to `hiringcafe.com`, which was cosmetic.

## Deferred

### open-jobs (elliottdehn) - evaluated 2026-09-10, revisit on or after 2026-09-12

`https://github.com/elliottdehn/open-jobs`, evaluated as a candidate **Level 2g**. Verdict: integrate with caveats, deferred. Not implemented.

**Why it passes the bars that killed remote.io and hiring.cafe:** it crawls employer ATS endpoints directly (first-party, not aggregator reposts, so the aggregator-liveness problem does not bite), it is CC0, free, and needs no auth. Its `robots.txt` returns 401 (no file exists - neither allow nor disallow), and the maintainer publishes `/data/*` explicitly for programmatic reuse and ships an agent skill telling you to consume it.

**Scale:** ~75,660 board slugs across 36 ATS providers, ~3.12M postings, nightly consolidation to R2 at `https://backend.dehnbostele.workers.dev/data/*`. A free `POST /status` (60 per 10 min) returns `open` / `removed` per posting straight from the crawler - a genuine liveness oracle. `POST /embed` is 10 per 10 min. `/export`, `/boards/*` and `/ats` are admin-only.

**Access pattern that works (verified):** DuckDB httpfs `read_parquet()` over the daily diff parquet with column pruning - a real `title_filter` plus EU geo regex returned counts in 3.9-6.9s against a 189 MB file **without downloading it**. The `content` column carries full JD text, so a level built on this would prefetch JDs zero-token and agents would skip `modes/_fetch.md`, like the LinkedIn and Platsbanken levels.

**Two blockers as of 2026-09-10 - check both before building:**

1. Published diff history is broken: 2 of 3 daily diffs return HTTP 500 (Cloudflare 1101). Missing a day means re-bootstrapping from 79 MB+ of group files, not backfilling.
2. `tier = 'first_party' | 'aggregator'` (commit `7ae7ef4`) takes effect 2026-09-11. That column is required to honour the aggregator rule; earlier exports lack it.

**Yield is a trickle, not a firehose.** Measured on one day's delta of 173,843 added rows: 767 pass `title_filter`, 96 EU, **1 EU leadership role, 0 Sweden**. Roughly 30 EU leadership roles per month from untracked employers. Scope any integration to leadership seniority only - the senior-PM tier (36 EU per day) would swamp the eval budget.

**Overlap:** 95% novel against `user/data/scan-history.db` (47 of 925 URLs already seen). It largely subsumes Level 1's *mechanism* across 75k boards versus our 51, but at roughly one day's latency versus Level 1's real-time exactness - so **Level 1 stays**; open-jobs' value is strictly the long tail of employers we would never think to add.

**Risks:** bus factor 1 (279 of 282 commits from one person, 0 releases, high daily churn, README explicitly declines an uptime commitment). The `dark` tier includes recruitment agencies posing as employers, and the `staffing` flag is populated on only 42% of rows, so the ban list would need to grow. Job-level enrichment is 1.9% populated, so all geo and seniority gating must be ours, locally, on title and location strings.

**Decision rule:** if the diff 500s persist two weeks out, treat that as a reliability signal and do not integrate.

**Recheck 2026-09-24:** blocker 1 is cleared going forward - every diff from `2026-09-08__2026-09-09` to `2026-09-23__2026-09-24` serves (206 on a range probe); only the two oldest (09-06, 09-07) still 500. The chain is unbroken but not strictly daily (`2026-09-14__2026-09-18`, `2026-09-20__2026-09-23` are multi-day diffs), so a consumer must replay by `from == head`, not by calendar date (`diffs/index.json` documents this). `manifest.json` now splits `jobs` (3.61M first-party) from `jobs_aggregator` (3.75M), consistent with blocker 2 being live; the `tier` column itself was not inspected (DuckDB httpfs could not be installed in the sandbox).
