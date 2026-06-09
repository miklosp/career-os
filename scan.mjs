#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, Lever, Recruitee, Teamtailor, and join.team
 * APIs directly, applies title filters from portals.yml, deduplicates
 * against data/scan-history.db and data/applications.md, and records new
 * URLs.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * New URLs are inserted into data/scan-history.db AND printed as JSON on
 * stdout so the invoking Claude session can dispatch one background
 * fetch+gate+score agent per URL (see modes/auto-pipeline.md).
 *
 * The scan-history DB is opened, migrated, and written exclusively
 * through lib/scan-history.mjs (openScanHistoryDb / recordOffers) —
 * this script never touches SQLite directly.
 *
 * data/scan-history.db schema (single table; URL-level dedupe log):
 *
 *   CREATE TABLE offers (
 *     url        TEXT PRIMARY KEY,   -- LinkedIn rows store linkedin.com/jobs/view/{id}
 *     first_seen TEXT NOT NULL,      -- YYYY-MM-DD
 *     portal     TEXT,               -- greenhouse-api | ashby-api | lever-api
 *                                    -- | recruitee-api | teamtailor-api | join_team-api
 *                                    -- | linkedin-jobspy | remoteineurope | websearch — …
 *     title      TEXT,
 *     company    TEXT,
 *     status     TEXT NOT NULL DEFAULT 'added'
 *                -- added | skipped_title | skipped_dup | skipped_expired
 *   );
 *
 * Degraded-LinkedIn contract: if the LinkedIn level (lib/scan-linkedin.mjs)
 * cannot run JobSpy (no `uv` on PATH, or python-jobspy not installable),
 * this script prints a single line
 *   SCAN_FATAL=jobspy-unavailable
 * BEFORE any DISPATCH_URLS= line. It is non-fatal to the run — Levels 1/2b/3
 * still execute and their URLs are still dispatched; only LinkedIn is skipped.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import { runLinkedInScan } from "./lib/scan-linkedin.mjs";
import { runRemoteInEuropeScan } from "./lib/scan-remoteineurope.mjs";
import { runHiringCafeScan } from "./lib/scan-hiringcafe.mjs";
import { runWeWorkRemotelyScan } from "./lib/scan-weworkremotely.mjs";
import { runRemotePmJobsScan } from "./lib/scan-remotepmjobs.mjs";
import {
  openScanHistoryDb,
  loadSeenUrls,
  recordOffers,
} from "./lib/scan-history.mjs";
import { isBanned } from "./lib/ban-list.mjs";
const parseYaml = yaml.load;

// Auto-load .env so FIRECRAWL_API_KEY and the optional LinkedIn cookies
// (LINKEDIN_LI_AT / LINKEDIN_JSESSIONID) are available without requiring the
// caller to source it. Silent if .env is absent.
function loadDotenv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotenv();

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = "config/portals.yml";
const SCAN_HISTORY_DB_PATH = "data/scan-history.db";
const APPLICATIONS_PATH = "data/applications.md";

// Ensure required directories exist (fresh setup)
mkdirSync("data", { recursive: true });

// ── Fetch tuning ────────────────────────────────────────────────────

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // 1. Explicit api: field wins — sniff the URL pattern.
  //    Lets custom domains (e.g. careers.britepayments.com/jobs.json) work
  //    without baking another host pattern into the careers_url matcher.
  if (company.api) {
    const a = company.api;
    if (a.includes("greenhouse.io")) return { type: "greenhouse", url: a };
    if (a.includes("api.ashbyhq.com")) return { type: "ashby", url: a };
    if (a.includes("api.lever.co")) return { type: "lever", url: a };
    if (a.includes(".recruitee.com")) return { type: "recruitee", url: a };
    if (a.includes("join.team")) return { type: "join_team", url: a };
    if (/\/jobs\.json(?:$|\?)/.test(a)) return { type: "teamtailor", url: a };
    // Unknown api: shape — fall through to careers_url detection.
  }

  const url = company.careers_url || "";

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: "ashby",
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: "lever",
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch) {
    return {
      type: "greenhouse",
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  // Teamtailor: {tenant}.teamtailor.com (custom domains use explicit api:)
  const ttMatch = url.match(/https?:\/\/([^/]+\.teamtailor\.com)/);
  if (ttMatch) {
    return { type: "teamtailor", url: `https://${ttMatch[1]}/jobs.json` };
  }

  // Recruitee: {tenant}.recruitee.com (custom domains use explicit api:)
  const recruiteeMatch = url.match(/https?:\/\/([^/]+\.recruitee\.com)/);
  if (recruiteeMatch) {
    return { type: "recruitee", url: `https://${recruiteeMatch[1]}/api/offers/` };
  }

  // join.team: aggregator with per-team boards at join.team/{slug}/
  const joinTeamMatch = url.match(/https?:\/\/join\.team\/([^/?#]+)/);
  if (joinTeamMatch) {
    return {
      type: "join_team",
      url: `https://join.team/api/teams/${joinTeamMatch[1]}/jobs/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map((j) => ({
    title: j.title || "",
    url: j.absolute_url || "",
    company: companyName,
    location: j.location?.name || "",
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map((j) => ({
    title: j.title || "",
    url: j.jobUrl || "",
    company: companyName,
    location: j.location || "",
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map((j) => ({
    title: j.text || "",
    url: j.hostedUrl || "",
    company: companyName,
    location: j.categories?.location || "",
  }));
}

function parseRecruitee(json, companyName) {
  const offers = (json.offers || []).filter(
    (o) => !o.status || o.status === "published",
  );
  return offers.map((o) => ({
    title: o.title || "",
    url: o.careers_url || o.careers_apply_url || "",
    company: companyName,
    location:
      o.location || [o.city, o.country].filter(Boolean).join(", ") || "",
  }));
}

// Teamtailor publishes a JSON Feed v1 at <career-site>/jobs.json: each
// item has {title, id, url, date_published, summary, tags}. Location is
// not part of the feed; the downstream per-JD gate handles it.
function parseTeamtailor(json, companyName) {
  const items = json.items || [];
  return items.map((it) => ({
    title: it.title || "",
    url: it.url || "",
    company: companyName,
    location: "",
  }));
}

// join.team has an undocumented JSON API at
//   /api/teams/{team-slug}/jobs/jobs → { jobs: [{ id, title, slug, location,
//   location_option, position, status }] }
// status === 1 means published. The team slug isn't in the JSON payload, so
// we derive it from the api URL; the canonical job URL is
// https://join.team/{team-slug}/jobs/{job-slug}.
function parseJoinTeam(json, companyName, apiUrl) {
  const slugMatch = (apiUrl || "").match(
    /\/api\/teams\/([^/]+)\/jobs\/jobs(?:$|\?)/,
  );
  const teamSlug = slugMatch ? slugMatch[1] : "";
  const jobs = (json.jobs || []).filter((j) => j.status === 1);
  return jobs.map((j) => ({
    title: j.title || "",
    url:
      teamSlug && j.slug
        ? `https://join.team/${teamSlug}/jobs/${j.slug}`
        : "",
    company: companyName,
    location: j.location || j.location_option || "",
  }));
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  ashby: parseAshby,
  lever: parseLever,
  recruitee: parseRecruitee,
  teamtailor: parseTeamtailor,
  join_team: parseJoinTeam,
};

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map((k) => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map((k) => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive =
      positive.length === 0 || positive.some((k) => lower.includes(k));
    const hasNegative = negative.some((k) => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, "utf-8");
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(
      /\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g,
    )) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== "company") {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    next(),
  );
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const companyFlag = args.indexOf("--company");
  const filterCompany =
    companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read config/portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error("Error: config/portals.yml not found. Run onboarding first.");
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, "utf-8"));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled, non-banned companies with detectable APIs
  const enabled = companies.filter((c) => c.enabled !== false);
  const notBanned = enabled.filter(
    (c) => !isBanned({ company: c.name, url: c.careers_url || "" }),
  );
  let bannedSkipped = enabled.length - notBanned.length;
  const targets = notBanned
    .filter(
      (c) => !filterCompany || c.name.toLowerCase().includes(filterCompany),
    )
    .map((c) => ({ ...c, _api: detectApi(c) }))
    .filter((c) => c._api !== null);

  const skippedCount = notBanned.length - targets.length;

  console.log(
    `Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`,
  );
  if (dryRun) console.log("(dry run — no files will be written)\n");

  // 3. Open DB + load dedup sets
  const db = openScanHistoryDb({ dryRun });
  const seenUrls = loadSeenUrls(db);
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map((company) => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name, url);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (isBanned({ url: job.url, company: job.company })) {
          bannedSkipped++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    recordOffers(
      db,
      newOffers.map((o) => ({
        url: o.url,
        title: o.title,
        company: o.company,
        portal: o.source,
      })),
      { firstSeen: date },
    );
  }

  // 5b. LinkedIn — JobSpy discovery + JD prefetch (free, no Apify, zero LLM
  // tokens). Pre-writes data/jds/ + applications.md row so dispatched
  // auto-pipeline agents skip _fetch.md and run gate+score only. Employer
  // ATS URL is resolved here only when LINKEDIN_LI_AT + LINKEDIN_JSESSIONID
  // are set (lib/li-voyager.mjs); otherwise the LinkedIn URL is stored and
  // resolution defers to apply-time.
  let linkedinUrls = [];
  let linkedinStats = null;
  if (config.linkedin_searches?.length) {
    const jdsDir = resolve("data/jds");
    mkdirSync(jdsDir, { recursive: true });
    try {
      const result = await runLinkedInScan({
        db,
        portalsCfg: config,
        applicationsPath: APPLICATIONS_PATH,
        jdsDir,
        dryRun,
      });
      linkedinUrls = result.newUrls;
      linkedinStats = result.stats;
    } catch (err) {
      errors.push({ company: "LinkedIn (JobSpy)", error: err.message });
    }
  }

  // 5c. remoteineurope.com — sitemap + per-page scrape, free, no Apify.
  // Discovers jobs the aggregator has surfaced; each page links straight
  // to the employer's ATS via a clean apply-button. Helper returns the
  // resolved employer ATS URLs; auto-pipeline agents fetch+gate+score
  // those normally (Greenhouse / Ashby / Workable / etc — all structured).
  let rieUrls = [];
  let rieStats = null;
  try {
    const result = await runRemoteInEuropeScan({
      db,
      portalsCfg: config,
      dryRun,
    });
    rieUrls = result.newUrls;
    rieStats = result.stats;
  } catch (err) {
    errors.push({ company: "remoteineurope.com", error: err.message });
  }

  // 5d. hiring.cafe — SSR __NEXT_DATA__ scrape, free, no Apify. Federates
  // thousands of employer ATSes; the helper returns resolved employer ATS
  // URLs (Greenhouse / Ashby / Lever / Workable / …), which auto-pipeline
  // agents fetch+gate+score normally. Driven by hiringcafe_searches in
  // portals.yml; the global title_filter does the precise include/exclude.
  let hcUrls = [];
  let hcStats = null;
  try {
    const result = await runHiringCafeScan({
      db,
      portalsCfg: config,
      dryRun,
    });
    hcUrls = result.newUrls;
    hcStats = result.stats;
  } catch (err) {
    errors.push({ company: "hiring.cafe", error: err.message });
  }

  // 5e. We Work Remotely — full-text category RSS, free, no Apify. The whole
  // JD ships in each feed item, so this prefetches data/jds/ + applications.md
  // rows like the LinkedIn level; dispatched agents skip _fetch.md and run
  // gate+score only. Canonical URL is the WWR detail page; employer-ATS
  // resolution defers to apply-time. Driven by weworkremotely_feeds in
  // portals.yml; the global title_filter does the precise include/exclude.
  let wwrUrls = [];
  let wwrStats = null;
  if (config.weworkremotely_feeds?.length) {
    const jdsDir = resolve("data/jds");
    mkdirSync(jdsDir, { recursive: true });
    try {
      const result = await runWeWorkRemotelyScan({
        db,
        portalsCfg: config,
        applicationsPath: APPLICATIONS_PATH,
        jdsDir,
        dryRun,
      });
      wwrUrls = result.newUrls;
      wwrStats = result.stats;
    } catch (err) {
      errors.push({ company: "weworkremotely.com", error: err.message });
    }
  }

  // 5f. Remote PM Jobs — public MCP server (search_jobs/get_job) called as
  // plain JSON-RPC, free, zero LLM tokens. PM-only board. Prefetches the
  // structured enrichment into data/jds/ + applications.md rows like the WWR
  // level; agents skip _fetch.md. Canonical URL is internal (apply-time ATS
  // resolution). Driven by remotepmjobs_searches in portals.yml; the global
  // title_filter does the precise include/exclude.
  let pmUrls = [];
  let pmStats = null;
  if (config.remotepmjobs_searches?.length) {
    const jdsDir = resolve("data/jds");
    mkdirSync(jdsDir, { recursive: true });
    try {
      const result = await runRemotePmJobsScan({
        db,
        portalsCfg: config,
        applicationsPath: APPLICATIONS_PATH,
        jdsDir,
        profilePath: "config/profile.md",
        dryRun,
      });
      pmUrls = result.newUrls;
      pmStats = result.stats;
    } catch (err) {
      errors.push({ company: "remotepmjobs.com", error: err.message });
    }
  }

  // 6. Print summary
  console.log(`\n${"━".repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${"━".repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`Banned skipped:        ${bannedSkipped}`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (linkedinStats) {
    console.log("");
    console.log(
      `LinkedIn (JobSpy):     ${linkedinStats.searches} searches, ${linkedinStats.idsReturned} ids, ${linkedinStats.afterTitleFilter} after title filter`,
    );
    console.log(`  Prefetched JDs:      ${linkedinStats.prefetched}`);
    console.log(`  Skipped (title):     ${linkedinStats.skipped}`);
    console.log(`  Banned skipped:      ${linkedinStats.banned ?? 0}`);
    console.log(
      `  ATS resolution:      voyager ${linkedinStats.voyager ?? "off"} — ${linkedinStats.resolved ?? 0} resolved, ${linkedinStats.easyApply ?? 0} easy-apply, ${linkedinStats.deferred ?? 0} deferred to apply-time`,
    );
    console.log(
      `  Expired skipped:     ${linkedinStats.expired ?? 0} CLOSED/expired postings dropped (not dispatched)`,
    );
    console.log(
      `  Voyager calls:       ${linkedinStats.voyagerCalls ?? 0} made, ${linkedinStats.reused ?? 0} reused via company|title cache`,
    );
    console.log(
      `  Reposts collapsed:   ${linkedinStats.repostsCollapsed ?? 0} same-role Easy-Apply/deferred dupes folded into one row`,
    );
    if (linkedinStats.fatal) {
      console.log("");
      console.log(
        `  ⚠ LinkedIn level SKIPPED — ${linkedinStats.fatal}${linkedinStats.fatalDetail ? ` (${linkedinStats.fatalDetail})` : ""}.`,
      );
      console.log(
        "    JobSpy needs `uv` on PATH (it runs `uv run --with python-jobspy`). Other levels ran normally.",
      );
    }
  }
  if (rieStats) {
    console.log(
      `remoteineurope:        ${rieStats.sitemapJobs} in sitemap, ${rieStats.alreadySeen} already seen, ${rieStats.fetched} fetched, ${rieStats.failed} failed`,
    );
    console.log(`  Skipped (title):     ${rieStats.skippedTitle}`);
    console.log(`  Banned skipped:      ${rieStats.banned ?? 0}`);
    console.log(`  New dispatchable:    ${rieStats.dispatched}`);
  }
  if (hcStats) {
    console.log(
      `hiring.cafe:           ${hcStats.searches} searches, ${hcStats.seen} hits scanned, ${hcStats.alreadySeen} already seen, ${hcStats.failed} failed`,
    );
    console.log(`  Expired skipped:     ${hcStats.expired}`);
    console.log(`  Skipped (title):     ${hcStats.skippedTitle}`);
    console.log(`  Banned skipped:      ${hcStats.banned ?? 0}`);
    console.log(`  New dispatchable:    ${hcStats.dispatched}`);
  }
  if (wwrStats) {
    console.log(
      `weworkremotely:        ${wwrStats.feeds} feeds, ${wwrStats.itemsSeen} items scanned, ${wwrStats.alreadySeen} already seen, ${wwrStats.failed} failed`,
    );
    console.log(`  Expired skipped:     ${wwrStats.expired}`);
    console.log(`  Skipped (title):     ${wwrStats.skippedTitle}`);
    console.log(`  Banned skipped:      ${wwrStats.banned ?? 0}`);
    console.log(`  Prefetched JDs:      ${wwrStats.prefetched}`);
  }
  if (pmStats) {
    console.log(
      `remotepmjobs:          ${pmStats.searches} searches, ${pmStats.candidates} candidates, ${pmStats.alreadySeen} already seen, ${pmStats.failed} failed`,
    );
    console.log(`  Expired skipped:     ${pmStats.expired}`);
    console.log(`  Skipped (title):     ${pmStats.skippedTitle}`);
    console.log(`  Skipped (geo):       ${pmStats.skippedGeo ?? 0}`);
    console.log(`  Banned skipped:      ${pmStats.banned ?? 0}`);
    console.log(`  Prefetched JDs:      ${pmStats.prefetched} (${pmStats.atsResolved ?? 0} ATS-resolved)`);
  }

  // Backstop: nothing banned reaches DISPATCH_URLS even if an upstream
  // (LinkedIn/remoteineurope) helper missed it.
  const dispatchUrls = [
    ...newOffers.map((o) => o.url),
    ...linkedinUrls,
    ...rieUrls,
    ...hcUrls,
    ...wwrUrls,
    ...pmUrls,
  ].filter((u) => !isBanned({ url: u }));

  if (newOffers.length > 0) {
    console.log("\nNew offers (Level 1 ATS APIs):");
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || "N/A"}`);
    }
  }
  if (linkedinUrls.length > 0) {
    console.log(
      "\nNew offers (Level 2 LinkedIn — JDs prefetched, agents skip _fetch.md):",
    );
    for (const url of linkedinUrls) {
      console.log(`  + ${url}`);
    }
  }
  if (rieUrls.length > 0) {
    console.log(
      "\nNew offers (remoteineurope.com — resolved employer ATS URLs):",
    );
    for (const url of rieUrls) {
      console.log(`  + ${url}`);
    }
  }
  if (hcUrls.length > 0) {
    console.log("\nNew offers (hiring.cafe — resolved employer ATS URLs):");
    for (const url of hcUrls) {
      console.log(`  + ${url}`);
    }
  }
  if (wwrUrls.length > 0) {
    console.log(
      "\nNew offers (We Work Remotely — JDs prefetched, agents skip _fetch.md):",
    );
    for (const url of wwrUrls) {
      console.log(`  + ${url}`);
    }
  }
  if (pmUrls.length > 0) {
    console.log(
      "\nNew offers (Remote PM Jobs — JDs prefetched, agents skip _fetch.md):",
    );
    for (const url of pmUrls) {
      console.log(`  + ${url}`);
    }
  }

  // Machine-readable fatal marker — ALWAYS printed before DISPATCH_URLS so the
  // orchestrator can deterministically detect a degraded LinkedIn level
  // (e.g. jobspy-unavailable when `uv` is missing). Other levels still ran.
  if (linkedinStats?.fatal) {
    console.log(`\nSCAN_FATAL=${linkedinStats.fatal}`);
  }

  if (dispatchUrls.length > 0) {
    if (dryRun) {
      console.log("\n(dry run — run without --dry-run to save results)");
    } else {
      console.log(`\nRecorded in ${SCAN_HISTORY_DB_PATH}.`);
      console.log(
        "Dispatch one background agent per URL below (modes/auto-pipeline.md):\n",
      );
      console.log("DISPATCH_URLS=" + JSON.stringify(dispatchUrls));
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
