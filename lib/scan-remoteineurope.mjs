// scan-remoteineurope.mjs — zero-token discovery from remoteineurope.com
//
// Aggregator site (Webflow-hosted) that mirrors job postings from various
// employer ATSes (Greenhouse, Lever, Ashby, Workday, custom careers pages).
// No native API, but sitemap.xml lists every job URL and each page has a
// clean <a class="apply-button"> linking straight to the employer's ATS.
//
// Flow:
//   1. Fetch /sitemap.xml → list of /job/{slug} URLs
//   2. Filter against scan-history.db (URL = the remoteineurope.com URL)
//   3. For each NEW URL: fetch the page, extract title `<title>{role} at {company}</title>`
//      and the apply-button href (the canonical employer ATS URL)
//   4. Apply title_filter from portals.yml
//   5. Insert into scan-history.db with portal='remoteineurope'
//   6. Return list of canonical employer ATS URLs for inclusion in DISPATCH_URLS
//
// No Apify cost. Parallel HTTP, capped at 20 concurrent fetches.

import { readFileSync } from 'fs';

const SITEMAP_URL = 'https://remoteineurope.com/sitemap.xml';
const JOB_URL_PREFIX = 'https://remoteineurope.com/job/';
const FETCH_CONCURRENCY = 20;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36';

// ── Concurrency limiter ──────────────────────────────────────────────

async function pLimit(concurrency, items, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function pull() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = { error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pull));
  return out;
}

// ── Sitemap parse ────────────────────────────────────────────────────

export function extractJobUrls(sitemapXml) {
  const urls = [];
  const re = /<loc>(https:\/\/remoteineurope\.com\/job\/[^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(sitemapXml)) !== null) urls.push(m[1].trim());
  // dedup just in case
  return [...new Set(urls)];
}

// ── Page parse ───────────────────────────────────────────────────────

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&([a-z]+|#\d+);/gi, (_, name) => ENTITY_MAP[name] ?? `&${name};`);
}

export function parseJobPage(html) {
  // Title format: "<title>Role at Company</title>"
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  let role = null;
  let company = null;
  if (titleMatch) {
    const raw = decodeEntities(titleMatch[1].trim());
    // Last "at" splits role from company (handles roles like "Sr Engineer (AI) at Foo Inc")
    const atIdx = raw.lastIndexOf(' at ');
    if (atIdx > 0) {
      role = raw.slice(0, atIdx).trim();
      company = raw.slice(atIdx + 4).trim();
    } else {
      role = raw;
    }
  }

  // Apply button: <a ... class="...apply-button..." ... href="...">
  // Webflow renders two of these (header + sidebar); both share the same href.
  let applyUrl = null;
  const applyRe = /<a[^>]*class="[^"]*\bapply-button\b[^"]*"[^>]*href="([^"]+)"/i;
  const applyAlt = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*\bapply-button\b/i;
  const m1 = html.match(applyRe) || html.match(applyAlt);
  if (m1) applyUrl = m1[1].trim();

  return { role, company, applyUrl };
}

// ── URL canonicalization ─────────────────────────────────────────────

function canonicalize(rawUrl) {
  if (!rawUrl) return null;
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  u.search = '';
  u.hash = '';
  let path = u.pathname.replace(/\/+$/, '').replace(/\/application\/*$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

// ── Title filter ─────────────────────────────────────────────────────

function passesTitleFilter(title, titleFilter) {
  if (!titleFilter) return true;
  const lower = (title ?? '').toLowerCase();
  const positive = (titleFilter.positive ?? []).map(s => s.toLowerCase());
  const negative = (titleFilter.negative ?? []).map(s => s.toLowerCase());
  if (positive.length > 0 && !positive.some(k => lower.includes(k))) return false;
  if (negative.some(k => lower.includes(k))) return false;
  return true;
}

// ── HTTP fetch helpers ───────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {Database} args.db                 — better-sqlite3 handle for scan-history
 * @param {object}   args.portalsCfg         — parsed portals.yml (for title_filter)
 * @param {boolean}  [args.dryRun]
 * @param {(s:string)=>void} [args.log]
 * @returns {Promise<{
 *   newUrls: string[],
 *   stats: { sitemapJobs: number, alreadySeen: number, fetched: number, failed: number, afterTitleFilter: number, skippedTitle: number, dispatched: number }
 * }>}
 */
export async function runRemoteInEuropeScan({
  db,
  portalsCfg,
  dryRun = false,
  log = (...args) => console.error('[remoteineurope]', ...args),
}) {
  const titleFilter = portalsCfg.title_filter ?? null;
  const stats = {
    sitemapJobs: 0,
    alreadySeen: 0,
    fetched: 0,
    failed: 0,
    afterTitleFilter: 0,
    skippedTitle: 0,
    dispatched: 0,
  };

  // 1. Sitemap
  let sitemap;
  try {
    sitemap = await fetchText(SITEMAP_URL);
  } catch (err) {
    log(`sitemap fetch failed: ${err.message}`);
    return { newUrls: [], stats };
  }
  const allJobUrls = extractJobUrls(sitemap);
  stats.sitemapJobs = allJobUrls.length;
  log(`sitemap: ${allJobUrls.length} job URLs`);

  // 2. Dedup against scan-history.db
  const seenStmt = db.prepare(`SELECT 1 FROM offers WHERE url = ? LIMIT 1`);
  const newUrls = allJobUrls.filter(u => !seenStmt.get(u));
  stats.alreadySeen = allJobUrls.length - newUrls.length;
  log(`already in scan-history: ${stats.alreadySeen}`);
  log(`new candidates to fetch: ${newUrls.length}`);

  if (newUrls.length === 0) {
    return { newUrls: [], stats };
  }

  // 3. Fetch each new page in parallel
  const fetchedDate = new Date().toISOString().slice(0, 10);
  const dispatched = [];
  const insertSkipped = db.prepare(
    `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
     VALUES (?, ?, 'remoteineurope', ?, ?, 'skipped_title')`,
  );
  const insertAdded = db.prepare(
    `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
     VALUES (?, ?, 'remoteineurope', ?, ?, 'added')`,
  );

  await pLimit(FETCH_CONCURRENCY, newUrls, async (sourceUrl) => {
    let html;
    try {
      html = await fetchText(sourceUrl);
    } catch (err) {
      stats.failed++;
      log(`fetch ${sourceUrl} failed: ${err.message}`);
      return;
    }
    stats.fetched++;
    const { role, company, applyUrl } = parseJobPage(html);

    if (!role) {
      log(`no title parseable in ${sourceUrl}`);
      return;
    }

    if (!passesTitleFilter(role, titleFilter)) {
      stats.skippedTitle++;
      if (!dryRun) insertSkipped.run(sourceUrl, fetchedDate, role, company);
      return;
    }
    stats.afterTitleFilter++;

    const canonical = canonicalize(applyUrl) || sourceUrl;

    if (!dryRun) {
      insertAdded.run(sourceUrl, fetchedDate, role, company);
    }
    dispatched.push({ canonical, sourceUrl, role, company });
  });

  // Dedup canonical URLs: two source pages may point to the same employer URL
  // (happens when remoteineurope captures a careers landing page rather than a
  // specific JD URL). Keep the first occurrence per canonical URL.
  const seenCanonical = new Set();
  const unique = dispatched.filter(d => {
    if (seenCanonical.has(d.canonical)) return false;
    seenCanonical.add(d.canonical);
    return true;
  });
  stats.dispatched = unique.length;
  log(`new dispatchable (after canonical-URL dedup): ${unique.length}`);

  for (const d of unique) {
    log(`+ ${d.company ?? '?'} | ${d.role} → ${d.canonical}`);
  }

  return { newUrls: unique.map(d => d.canonical), stats };
}

// ── CLI mode (for ad-hoc testing) ────────────────────────────────────
// Run directly: `node lib/scan-remoteineurope.mjs --dry-run` (uses
// data/scan-history.db and config/portals.yml from the project root)

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import('better-sqlite3')).default;
  const yaml = (await import('js-yaml')).default;
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database('data/scan-history.db');
  const portalsCfg = yaml.load(readFileSync('config/portals.yml', 'utf-8'));
  const { newUrls, stats } = await runRemoteInEuropeScan({ db, portalsCfg, dryRun });
  console.log('\nstats:', stats);
  console.log('\nnewUrls:', newUrls);
}
