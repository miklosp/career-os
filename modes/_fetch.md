# Mode: _fetch — Get the JD, save it, reserve a number

Single source of truth for turning a job URL into a numbered file under `data/jds/`. Called by `modes/auto-pipeline.md` and by `scan.mjs`. Always dispatch as a background agent.

> **This mode is the fallback, not the front door.** `node lib/fetch-jd.mjs "{url}"` already does Steps 1–5 deterministically and zero-token for every known ATS (Lever, Greenhouse, Ashby, Teamtailor, Personio, Workday CXS, Rippling, LinkedIn) plus any host in the learned registry. The orchestrator runs it first (see `auto-pipeline.md` Step 1). You only land here when the helper returned `unknown-host` or `error`. Your job then: resolve the structured source by hand using the priority methods below, save the JD, and **teach the registry** (see "Learning loop") so the next time it's zero-token.

> **Ban list.** A banned company (`config/portals.yml` → `banned_companies`) is caught by `fetch-jd.mjs` Guard A *before* `unknown-host` is ever emitted, so a banned URL never reaches this mode. If you nonetheless discover mid-resolution that the employer is on the ban list, **stop immediately** — write no JD, no row — and report `banned`. Never spend a Firecrawl/agent-browser/Playwright call on a banned company.

## Input

A job posting URL (LinkedIn, Greenhouse, Lever, Ashby, company careers page, aggregator).

## Step 1 — Dedup

1. Check whether a JD for this URL is already in the pipeline. Strip query strings, trailing slash, and `/application` path suffix first — tracking params like `?source=LinkedIn` and apply-form paths like `/application` must not cause false negatives:

   ```bash
   url_path=$(printf '%s' "{url}" | awk -F'?' '{print $1}' | sed 's|/application/*$||;s|/$||')
   match=$(grep -rlF "**URL:** ${url_path}" data/jds/ 2>/dev/null | head -1)
   ```

   If `$match` is non-empty, the JD already exists. The next decision depends on its evaluation status — read the row in `data/applications.md` whose `#` column equals the leading 3-digit NUM of `$match`:

   - **Status `Evaluated` / `Applied` / `Responded` / `Interview` / `Offer` / `Rejected` / `Discarded` / `Skipped-Location` / `SKIP`** → stop silently. Already handled.
   - **Status `Fetched`** → the JD was prefetched (typically by `lib/scan-linkedin.mjs` during `scan.mjs`). The fetch work is already done; **skip Steps 2–5 and proceed to Step 6 (Hand off)** so the orchestrator runs `_location-gate.md` then `_eval.md` against the existing JD. Do NOT re-fetch — that would burn Apify/Firecrawl credits for content already on disk.
   - **No matching row in `applications.md`** → the JD file is orphaned (race or manual edit). Treat as if dedup didn't hit and continue with Steps 2–5 to populate the row, but reuse the existing NUM and JD path instead of reserving a new one.

   **`data/applications.md` is NOT a URL dedup source — it has no URL column. The `**URL:**` line in each `data/jds/*.md` file is the canonical URL store.** The status column in `applications.md` is what differentiates "already fetched, awaiting evaluation" from "fully handled."

   Whenever you write the `**URL:**` header in Step 4, write the **stripped** form (no query string, no trailing slash, no `/application` suffix) so future dedup grep always matches.

2. Read `data/scan-history.db` (SQLite, table `offers` with `url` PK) if it exists. Stop only if the row's status is terminal: `skipped_title`, `skipped_dup`, or `skipped_expired`. A row with status `added` is expected — it means the scanner just discovered this URL and dispatched it to us; proceed to fetch.

## Step 2 — Reserve a number

Call `lib/next-num.mjs` to atomically reserve the next 3-digit number:

```bash
node lib/next-num.mjs
```

Store the returned value as `NUM`. The helper scans `data/jds/`, `data/reports/`,
`data/applications.md`, and `data/tracker-additions/`, computes `max + 1`,
and **atomically creates** `data/jds/{NUM}.reserved` via `O_EXCL`. Parallel
agents that race on the same NUM will lose the exclusive create and
automatically retry with the next value — no manual retry needed.

**After writing** `data/jds/{NUM}-{slug}.md` in Step 4, release the reservation
marker:

```bash
node -e "import('./lib/next-num.mjs').then(m => m.releaseNum('${NUM}'))"
```

If you don't release, the marker lingers as a harmless orphan (it just
advances the counter past that NUM on the next scan). A fetch failure
between reservation and release is the main reason to ensure release
happens in a `finally`-style block.

## Step 3 — Fetch the JD

**Structured-first rule:** always prefer formatted feeds (XML / JSON / JSON-LD) over rendered HTML scraping when one exists for the host. Spend 30 seconds checking for `/xml`, an ATS public API, or embedded JSON-LD before falling back to a browser.

Try these methods in order. Stop at the first that returns real content
(title + description + apply link). Never fall through to a later method
silently — log which worked in the saved JD header.

| Priority | Tool | Handles | Notes |
|----------|------|---------|-------|
| 1 | **ATS API** (`xh` GET/POST JSON) | Lever / Greenhouse / Ashby / Personio / Workday CXS / **LinkedIn (via Apify actor)** — see table below | Free or near-free, structured, fastest. Always try first if the URL host maps to a known ATS pattern. The LinkedIn row resolves the LinkedIn → employer ATS redirect server-side, so a `linkedin.com/jobs/view/{id}` URL becomes a real ATS URL plus a full JD payload in one round-trip. |
| 2 | **`xh`** | Static HTML aggregators + Teamtailor (JSON-LD) | Free, no JS. Works on startup.jobs, remotive, welcometothejungle, **Teamtailor** (full job in embedded JSON-LD). SPAs that return shells — escalate. |
| 3 | **Firecrawl `scrape`** | JS-rendered SPAs (Alva, Tally, Greenhouse SPAs, custom careers pages) | Paid credits but isolated per-call. **Default for SPA fetches.** Requires `FIRECRAWL_API_KEY` in `.env`. Does NOT work on LinkedIn. See "Firecrawl scrape" below. |
| 4 | **Authenticated agent-browser session** (`--session-name himalayas`, ephemeral) | Cloudflare-walled hosts only (himalayas.app, some company careers where Firecrawl 403s) | Spawns a per-call Chromium that loads cookies from the named session on disk and saves any updates back. Closes when done. No shared port, no persistent process, no cross-agent contamination. See "Authenticated agent-browser session" below. |
| 5 | **Fresh Playwright** (`uv run --with playwright python3 ...`) | Last-resort SPA fallback when Firecrawl is out of credit and CDP is too risky | Spawns a clean ephemeral chromium per call. Only reach for this when both Firecrawl and the structured options have failed. |

### ATS API URL patterns

Single-posting endpoints return the full description HTML plus location:

| URL pattern | → API endpoint | Extract |
|-------------|----------------|---------|
| `jobs.lever.co/{org}/{id}` | `https://api.lever.co/v0/postings/{org}/{id}` | `.text`, `.description`, `.lists[]` (responsibilities/requirements), `.categories.location`, `.categories.commitment`, `.workplaceType` |
| `boards.greenhouse.io/{org}/jobs/{id}` or `job-boards.greenhouse.io/{org}/jobs/{id}` | `https://boards-api.greenhouse.io/v1/boards/{org}/jobs/{id}` | `.title`, `.content` (HTML), `.location.name`, `.metadata`, `.offices[].name` |
| `jobs.ashbyhq.com/{org}/{id}` | `https://api.ashbyhq.com/posting-api/job-board/{org}` → filter `.jobs[]` by `id == {id}` | `.title`, `.descriptionHtml`, `.location`, `.employmentType`, `.workplaceType` |

| `{company}.teamtailor.com/jobs/{id}-{slug}` | `xh GET "{url}" \| python3 -c "import sys,re,json; h=sys.stdin.read(); m=re.search(r'application/ld\+json[^>]*>(.*?)</script>', h, re.DOTALL); print(m.group(1).strip() if m else '')"` | Full JobPosting schema: `.title`, `.description` (HTML), `.datePosted`, `.employmentType`, `.jobLocation`, `.hiringOrganization.name`. No auth required. |
| `{tenant}.jobs.personio.de/job/{id}` (any locale) | `xh GET https://{tenant}.jobs.personio.de/xml` | Full XML feed of every active posting at the tenant. Filter by `<id>` matching `{id}`. Includes `<name>`, `<description>`, `<office>`, `<schedule>`, `<recruitingCategory>`, `<seniority>`, `<employmentType>`, `<jobDescriptions>` (multi-section). Authoritative for the company name (one tenant = one company), so this also defends against shared/embedded-tenant confusion. |
| `{tenant}.wd{N}.myworkdayjobs.com/{site}/job/{path}/{slug}_{id}` | `xh GET https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{path}/{slug}_{id}` | `.jobPostingInfo.title`, `.jobPostingInfo.jobDescription` (HTML), `.jobPostingInfo.location`, `.jobPostingInfo.additionalLocations[]`, `.jobPostingInfo.timeType`, `.jobPostingInfo.startDate`, `.jobPostingInfo.endDate`, `.jobPostingInfo.externalUrl`, `.jobPostingInfo.canApply`, `.jobPostingInfo.jobReqId`, `.hiringOrganization.name`. No auth. Workday hosts a public CXS REST endpoint that mirrors any browser-facing job URL — always try this BEFORE rendering the SPA in a browser. |
| `ats.rippling.com/{tenant}/jobs/{uuid}` | `xh --print=hb GET "{url}" -o /tmp/r.html` then extract embedded `__NEXT_DATA__`: `python3 -c "import re,json,sys; h=open('/tmp/r.html').read(); m=re.search(r'<script id=\"__NEXT_DATA__\"[^>]*>(.*?)</script>', h, re.DOTALL); print(json.dumps(json.loads(m.group(1))['props']['pageProps']['apiData']))"` | Rippling ATS (Next.js SPA, Cloudflare-fronted) embeds full payload in `__NEXT_DATA__`. `apiData` keys: `jobBoard`, **`jobPost`** (`name`, `description.role` HTML, `description.company` HTML, `createdOn`, `employmentType`, `companyName`, `url`, `activeJobApplication`), **`workLocations`** (array of human-readable strings like "Remote (Stockholm, Stockholm County, SE)"), `department`, `payRangeDetails`. No auth. The HTML body is the SPA shell — `xh` alone won't show the JD; you MUST parse `__NEXT_DATA__`. Cheaper than Firecrawl since `xh` works (just need to follow up with JSON extraction). |
| `linkedin.com/jobs/view/{id}` (or `/jobs/collections/.../?currentJobId={id}` or any LinkedIn URL where the job ID can be extracted) | `xh POST "https://api.apify.com/v2/acts/apimaestro~linkedin-job-detail/run-sync-get-dataset-items?token=$APIFY_API_TOKEN"` with payload `{"job_id":["{id}"]}` (array — supports batched IDs) | Three nested objects per record: **`job_info`**: `title`, `description`, `location`, `country_code`, `is_remote_allowed`, `workplace_types[]` (`ONSITE`/`HYBRID`/`REMOTE`), `listed_at` + `expire_at` (ISO), `job_state` (`LISTED`/`CLOSED`), `industries[]`, `job_functions[]`, `experience_level`, `employment_status`, `job_url` (canonical LinkedIn URL), `is_reposted`. **`company_info`**: `name`, `universal_name`, `description`, `staff_count`, `industries[]`, `headquarters` (structured address), `url`, `logo_url`. **`apply_details`**: **`application_url` (the EMPLOYER ATS URL — write THIS as the canonical `**URL:**` in the saved JD; fall back to the LinkedIn URL only when `application_url` is null AND `is_easy_apply` is true, since easy-apply jobs only exist on LinkedIn)**, `is_easy_apply`, `total_applies`, `total_views`. Token in `.env`; source it first via `set -a; source .env; set +a`. Costs Apify credits (~$0.005/job at the time of writing). |

If `isListed == false` (Ashby) or HTTP 404 (Lever/Greenhouse), the posting is genuinely expired. Still save the JD with `**Status:** expired` in the header — the location gate and scoring will short-circuit it, but the dashboard keeps the trail.

For the LinkedIn endpoint, `job_state != "LISTED"` means closed/expired. `expire_at < now` is the secondary signal. Treat both the same way (`**Status:** expired`).

### LinkedIn → employer ATS resolution

LinkedIn is a discovery index, not a JD source (with the exception of Easy Apply). Use Apify `apimaestro~linkedin-job-detail` actor (row above) to get canonical employer ATS URL:

1. Extract the LinkedIn job ID. Common URL shapes:
   - `linkedin.com/jobs/view/{id}` — `id` is the path segment.
   - `linkedin.com/jobs/collections/recommended/?currentJobId={id}` — `id` is in the query string.
   - Search-result cards: same `currentJobId={id}` pattern.

2. Call the actor with `{"job_id":["{id}"]}`.

3. Read `apply_details.application_url` from the response. **That is the canonical employer ATS URL** — save it as the `**URL:**` line in the JD.

4. **Easy-apply fallback.** When `application_url` is null and `is_easy_apply` is true, the role is LinkedIn-only — there is no employer ATS URL. Save `https://www.linkedin.com/jobs/view/{id}` as the canonical URL in that case. URL-dedup downstream still works (the LinkedIn URL IS the canonical URL for these). For any other case where `application_url` is set, never substitute the LinkedIn URL.

`apimaestro~linkedin-job-detail` bills against the shared `APIFY_API_TOKEN` quota. If endpoint fails, check usage with `xh GET "https://api.apify.com/v2/users/me?token=$APIFY_API_TOKEN" | jq '.data.usageCycle'`. Stop and warn the user if shows insufficient credits.

### Firecrawl scrape (preferred SPA fallback)

When Priority 1 (ATS API) and Priority 2 (`xh`) fail, try Firecrawl before any browser-rendered method. Firecrawl runs each scrape in an isolated cloud browser — no shared profile, no session contamination, no CDP race conditions.

Source `FIRECRAWL_API_KEY` fron the project's `.env`. The binary reads the key from process env, it does NOT auto-load `.env`. Each scrape costs ~1 credit; check headroom with `firecrawl --status` before bulk runs.

Default invocation:

```bash
set -a; source .env; set +a
firecrawl scrape "{url}" -o /tmp/fc-{NUM}.md
```

The `set -a` / `set +a` guard exports every variable defined in the source step and then stops auto-export, so unrelated shell state isn't leaked.

The output is clean markdown with the JD body, location, hiring contact, and apply link. Set `**Fetch-method:** firecrawl` in the saved JD header.

When Firecrawl is the right choice:

- JS-rendered SPAs without a known ATS API (Alva career-pages, Tally job forms, custom Next.js careers pages, embedded job-board widgets).
- Any host where the previous fetch produced suspect content and you need a clean re-render that can't be polluted by prior browser state.
- Concurrent dispatches across multiple URLs — each Firecrawl call is fully independent, so parallel agents can't contaminate each other's results (unlike shared CDP).

When NOT to use Firecrawl:

- **LinkedIn** — auth-walled.
- **A known ATS pattern is in the table above** — free, structured, and faster.
- **Out of credits.** If `firecrawl --status` shows insufficient credits, stop and tell user.

### Authenticated agent-browser session (Cloudflare-walled hosts only)

The pattern is ephemeral, not persistent. Each fetch spawns its own headless Chromium, loads cookies from the named session on disk, runs the work, and **always** closes the browser before returning. No port :9222, no detect/ensure/launch protocol, no shared profile, no cross-agent state.

```bash
# Open + snapshot the page
agent-browser --session-name himalayas open "{url}"
agent-browser --session-name himalayas snapshot -i

# Mandatory teardown — every code path must reach this, including failures
agent-browser close --session-name himalayas
```

Wrap the open/snapshot in a `trap` or shell-level `finally` so the close runs even on error:

```bash
( agent-browser --session-name himalayas open "{url}" \
  && agent-browser --session-name himalayas snapshot -i > /tmp/jd-{NUM}.txt
) ; agent-browser close --session-name himalayas
```

For CLI syntax and patterns, load the installed skill:

```bash
agent-browser skills get core
```

**First-time auth on a new machine:** run `agent-browser --session-name himalayas --headed open https://himalayas.app/login` manually, log in once, then `agent-browser close --session-name himalayas`. Cookies are saved to disk under the session name and reload automatically on subsequent runs.

Use this path specifically for:

- **Cloudflare-walled hosts** (himalayas.app, some company careers) where `xh` / WebFetch / Firecrawl 403.
- LinkedIn is NOT in this list — use the Apify `linkedin-job-detail` actor instead (see "LinkedIn → employer ATS resolution" above).
- Human pacing on auth-walled hosts: 3–5s between navigations, 2s+ hydration. Velocity triggers bot detection on Cloudflare too.

### Fresh Playwright (last-resort SPA fallback)

When Firecrawl is unavailable (no API key, no credits, host blocks it) and the host genuinely needs a real browser, use a one-shot Playwright spawn — never the shared CDP for unauthenticated content. The script gets a clean ephemeral chromium profile per call:

```bash
uv run --with playwright python3 - <<'PY'
from playwright.sync_api import sync_playwright
url = "{url}"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context().new_page()
    pg.goto(url, wait_until="networkidle", timeout=30000)
    print("TITLE:", pg.title())
    print(pg.locator("main, article, [role=main]").first.text_content() or pg.locator("body").text_content())
    b.close()
PY
```

Set `**Fetch-method:** playwright-fresh-context`. Slower than Firecrawl (~2s startup) but free and uncontaminable.

### Encountering a new host

If the URL host isn't in the table above, investigate the structured-source landscape **before** scraping. In order:

1. **Check for a public feed.** Common shapes to probe: `/xml`, `/feed.xml`, `/rss`, `/api/jobs`, `/jobs.json`. Many ATSes (Personio, Workable, SmartRecruiters, JazzHR, Recruitee, BambooHR) expose one. A 200 with structured data is almost always faster and more accurate than rendering the page.
2. **Check the page for embedded JSON-LD.** `xh GET {url} | grep -A2 'application/ld+json'` — most modern career pages embed a `JobPosting` schema with the full description, location, and `hiringOrganization`. JSON-LD is also the most reliable cross-check for "what company is actually hiring" when a tenant page might be misleading.
3. **Search for an ATS API doc.** A 30-second WebSearch for `"{ATS name} job board API"` is usually enough to find the public endpoint.
4. **Only then** fall back to a browser fetch — and prefer Firecrawl over the shared CDP (see next section).

### Learning loop (make the next hit zero-token)

When you successfully resolve a host that arrived here as `unknown-host`, persist what you learned so `lib/fetch-jd.mjs` handles it deterministically next time. Two cases:

1. **The host is an existing provider on an unrecognised domain** — e.g. `careers.acme.com` is really a Greenhouse board, or a Workday/Personio tenant the URL regex didn't match. The right handler already exists in `lib/fetch-jd.mjs`; you just need to map the host to it:

   ```bash
   node lib/fetch-jd.mjs --learn careers.acme.com greenhouse --params '{"org":"acme"}' --note "custom domain fronting Greenhouse"
   ```

   `--params` supplies anything the handler can't extract from the URL itself (org/tenant slug). Use `--regex` instead of a bare host when one rule should cover many subdomains. The entry lands in `lib/ats-registry.json` — **committed shared wisdom**, not `data/` per-user state and not `config/portals.yml` (user-owned). It's version-controlled so the next person inherits every host you resolve. The registry is consulted before the built-in matchers, so the learned mapping wins.

2. **The host is a genuinely new provider** with an API shape no existing handler parses (new JSON/XML structure). The registry alone can't help — a new code handler is needed in `lib/fetch-jd.mjs` (`handlers.{name}` with `match()` + `fetch()` returning the normalized shape). **Before reverse-engineering it from scratch, check whether the parser already exists openly:** the ever-jobs repo (`github.com/ever-jobs/ever-jobs`) ships ~38 ATS connectors under `packages/plugins/source-ats-*` (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Jobvite, Workable, Avature, Oracle, …), and JobSpy covers the major boards — port the endpoint/shape from there rather than brute-forcing network calls. Then add the handler and `--learn` the host to it. Until the handler exists, record the endpoint in the **ATS API URL patterns** table above as the human-readable fallback.

Never store host-resolution knowledge in agent prompts or memories — it belongs in the registry (case 1) or the handler code (case 2).

## Step 4 — Save the JD

Write to `data/jds/{NUM}-{company-slug}-{role-slug}.md`.

`{company-slug}` and `{role-slug}` = lowercase with spaces / punctuation → hyphens, ASCII only.

Schema (the location gate depends on these header fields — fill them all; if the JD doesn't say, write `unspecified`):

```markdown
# {Company} — {Role Title}

**URL:** {canonical employer ATS URL; the LinkedIn URL only for easy-apply roles with no employer URL — see Step 3.4}
**Fetched:** {YYYY-MM-DD}
**Fetch-method:** {ats-api | apify-linkedin | xh | firecrawl | agent-browser-session | playwright-fresh-context}
**Posting age:** {X days ago | unspecified}
**Status:** {active | expired}

**Location:** {exact string from JD, e.g. "Remote (EU)" or "Berlin, Germany"}
**Remote scope:** {full-remote-global | full-remote-region:EU | full-remote-countries:US,CA | hybrid:Stockholm | onsite:Berlin | unspecified}
**Timezone:** {CET | PST 9-5 overlap required | any EU timezone | unspecified}
**Visa/authorization:** {EU work auth required | US work auth required | sponsorship available | unspecified}
**Relocation offered:** {yes | no | unspecified}

## Role Summary
{1–2 paragraphs about the role}

## Responsibilities
- {bullets}

## Requirements
- {bullets, must-haves}

## Nice to Have
- {bullets, if present}

## Other Details
{team size, stage, reporting line, any other context from the JD}
```

**Parsing the location fields** — read the JD text carefully:

- `Remote scope` keywords to recognise: "Remote — US only", "EU remote", "Americas only", "Worldwide", "Global", "Remote (Portugal, Spain)". Map to one of the enum values above.
- `Timezone` keywords: "Must overlap with PST 9-5", "EU timezones", "CET ±2". If none, write `unspecified`.
- `Visa/authorization` keywords: "Must be authorized to work in the US", "H1B only", "EU citizens only", "Visa sponsorship available".
- `Relocation offered`: "Relocation package available", "Relocation assistance", "Must relocate to Berlin".

**Prose wins over JSON-LD country lists.** Recruitee, Greenhouse, and Lever often emit a `JobPosting.applicantLocationRequirements` array with 10–20 specific countries. That list is almost always the **example payroll countries** (where the employer is set up to hire), NOT the eligibility scope. If the JD prose explicitly states a broader region — e.g. "anywhere in EMEA", "physically based within the EU", "remote across LATAM", "any EU timezone is fine" — the prose is authoritative. Use the region designation (`full-remote-region:EMEA`, `full-remote-region:EU`, `full-remote-region:LATAM`, etc.), NOT the country enumeration. Past incident: Hostaway #279 was wrongly `Skipped-Location` because the fetcher transcribed `applicantLocationRequirements: [ES,PT,GB,IT,HR,DE,NL,FR,EE,RO,CZ,GR,PL,IE,AT,FI,LV,LT]` into the header even though the JD's first paragraph said "please only apply if you are physically based within EMEA". When the two disagree, the prose is the contract; the JSON-LD list is hiring infrastructure.

## Step 5 — Register in applications.md

Append one row to `data/applications.md` with status `Fetched`:

```
| {NUM} | {YYYY-MM-DD} | {Company} | {Role} |  | Fetched | ❌ |  |  |
```

(Score and Report columns stay empty — they fill in after the location gate
and scoring.) The next stage reads this row's NUM to keep numbering
consistent across `data/jds/`, `applications.md`, and `data/reports/`.

## Step 6 — Hand off

Return the `NUM` and `data/jds/{NUM}-...md` path to the caller. The orchestrator
(`modes/auto-pipeline.md`) will invoke `modes/_location-gate.md` next.

## Failure handling

- If every fetch method fails: append the row with status `Fetched` and a note `**Notes:** fetch failed — host unreachable, needs an ATS pattern` in the Notes column. Don't leave the row out; the user needs to see what the system couldn't reach (and which host to add to the ATS table).
- If the URL was already in `scan-history.db`: stop silently, exit 0.
