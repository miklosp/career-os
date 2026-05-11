#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against data/scan-history.db and
 * data/applications.md, and records new URLs.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * New URLs are inserted into data/scan-history.db AND printed as JSON on
 * stdout so the invoking Claude session can dispatch one background
 * fetch+gate+score agent per URL (see modes/auto-pipeline.md).
 *
 * On first run, auto-migrates data/scan-history.tsv → SQLite and
 * renames the legacy TSV to .bak-{date}.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { runLinkedInScan } from './lib/scan-linkedin.mjs';
import { runRemoteInEuropeScan } from './lib/scan-remoteineurope.mjs';
const parseYaml = yaml.load;

// Auto-load .env so APIFY_API_TOKEN / FIRECRAWL_API_KEY are available
// without requiring the caller to source it. Silent if .env is absent.
function loadDotenv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotenv();

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'config/portals.yml';
const SCAN_HISTORY_DB_PATH = 'data/scan-history.db';
const SCAN_HISTORY_TSV_LEGACY = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

// ── SQLite: open, schema, one-shot TSV migration ────────────────────

function openScanHistoryDb() {
  const db = new Database(SCAN_HISTORY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS offers (
      url        TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      portal     TEXT,
      title      TEXT,
      company    TEXT,
      status     TEXT NOT NULL DEFAULT 'added'
    );
    CREATE INDEX IF NOT EXISTS idx_offers_first_seen ON offers(first_seen);
    CREATE INDEX IF NOT EXISTS idx_offers_company    ON offers(company);
  `);

  // One-shot migration: if DB is empty and legacy TSV exists, import it.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM offers').get();
  if (n === 0 && existsSync(SCAN_HISTORY_TSV_LEGACY)) {
    const lines = readFileSync(SCAN_HISTORY_TSV_LEGACY, 'utf-8').split('\n');
    const insert = db.prepare(
      `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
       VALUES (@url, @first_seen, @portal, @title, @company, @status)`
    );
    const tx = db.transaction(rows => { for (const r of rows) insert.run(r); });
    const rows = [];
    for (const line of lines.slice(1)) { // skip header
      const f = line.split('\t');
      if (!f[0] || f[0] === 'url') continue;
      rows.push({
        url: f[0],
        first_seen: f[1] || new Date().toISOString().slice(0, 10),
        portal: f[2] || null,
        title: f[3] || null,
        company: f[4] || null,
        status: f[5] || 'added',
      });
    }
    tx(rows);
    const bak = `${SCAN_HISTORY_TSV_LEGACY}.bak-${new Date().toISOString().slice(0, 10)}`;
    renameSync(SCAN_HISTORY_TSV_LEGACY, bak);
    console.log(`📦 Migrated ${rows.length} rows from ${SCAN_HISTORY_TSV_LEGACY} → ${SCAN_HISTORY_DB_PATH}`);
    console.log(`   Legacy TSV preserved at ${bak}`);
  }

  return db;
}

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

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
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls(db) {
  const seen = new Set();

  // scan-history.db
  for (const row of db.prepare('SELECT url FROM offers').all()) {
    seen.add(row.url);
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────

function insertNewOffers(db, offers, date) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
     VALUES (?, ?, ?, ?, ?, 'added')`
  );
  const tx = db.transaction(items => {
    for (const o of items) {
      stmt.run(o.url, date, o.source, o.title, o.company);
    }
  });
  tx(offers);
}

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

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read config/portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: config/portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Open DB + load dedup sets
  const db = openScanHistoryDb();
  const seenUrls = loadSeenUrls(db);
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
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
    insertNewOffers(db, newOffers, date);
  }

  // 5b. LinkedIn — Apify-based discovery + per-JD detail prefetch.
  // Pure HTTP, zero LLM tokens. Pre-writes data/jds/ + applications.md row so
  // dispatched auto-pipeline agents skip _fetch.md and run gate+score only.
  let linkedinUrls = [];
  let linkedinStats = null;
  if (config.linkedin_searches?.length && process.env.APIFY_API_TOKEN) {
    const jdsDir = resolve('data/jds');
    mkdirSync(jdsDir, { recursive: true });
    try {
      const result = await runLinkedInScan({
        db,
        portalsCfg: config,
        applicationsPath: APPLICATIONS_PATH,
        jdsDir,
        token: process.env.APIFY_API_TOKEN,
        dryRun,
      });
      linkedinUrls = result.newUrls;
      linkedinStats = result.stats;
    } catch (err) {
      errors.push({ company: 'LinkedIn (Apify)', error: err.message });
    }
  } else if (!process.env.APIFY_API_TOKEN) {
    console.log('(LinkedIn level skipped — APIFY_API_TOKEN not set in .env)');
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
    errors.push({ company: 'remoteineurope.com', error: err.message });
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (linkedinStats) {
    console.log('');
    console.log(`LinkedIn (Apify):      ${linkedinStats.searches} searches, ${linkedinStats.idsReturned} ids, ${linkedinStats.afterTitleFilter} after title filter`);
    console.log(`  Prefetched JDs:      ${linkedinStats.prefetched}`);
    console.log(`  Skipped (title):     ${linkedinStats.skipped}`);
  }
  if (rieStats) {
    console.log(`remoteineurope:        ${rieStats.sitemapJobs} in sitemap, ${rieStats.alreadySeen} already seen, ${rieStats.fetched} fetched, ${rieStats.failed} failed`);
    console.log(`  Skipped (title):     ${rieStats.skippedTitle}`);
    console.log(`  New dispatchable:    ${rieStats.dispatched}`);
  }

  const dispatchUrls = [...newOffers.map(o => o.url), ...linkedinUrls, ...rieUrls];

  if (newOffers.length > 0) {
    console.log('\nNew offers (Level 1 ATS APIs):');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
  }
  if (linkedinUrls.length > 0) {
    console.log('\nNew offers (Level 2 LinkedIn — JDs prefetched, agents skip _fetch.md):');
    for (const url of linkedinUrls) {
      console.log(`  + ${url}`);
    }
  }
  if (rieUrls.length > 0) {
    console.log('\nNew offers (remoteineurope.com — resolved employer ATS URLs):');
    for (const url of rieUrls) {
      console.log(`  + ${url}`);
    }
  }

  if (dispatchUrls.length > 0) {
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nRecorded in ${SCAN_HISTORY_DB_PATH}.`);
      console.log('Dispatch one background agent per URL below (modes/auto-pipeline.md):\n');
      console.log('DISPATCH_URLS=' + JSON.stringify(dispatchUrls));
    }
  }

  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
