// scan-hiringcafe.mjs — zero-token discovery from hiring.cafe (Level 2c)
//
// hiring.cafe is a meta job-search engine that federates postings from
// thousands of employer ATSes (Greenhouse, Ashby, Lever, Workable,
// Teamtailor, Deel, …). It exposes NO usable public API: the documented
// POST /api/search-jobs endpoint is now WAF/auth-gated (GET→401, POST→405
// behind Cloudflare+Vercel, even with full browser headers + cookie jar).
//
// BUT the site is server-rendered Next.js: every search page embeds the
// full structured result set in <script id="__NEXT_DATA__">. Search is
// driven entirely by a single URL param — `?searchState={...JSON...}` —
// so we drive it without a browser, without auth, without Apify credits.
//
//   props.pageProps.ssrHits          → array of fully structured jobs
//   props.pageProps.ssrTotalCount    → total matches for the query
//   props.pageProps.ssrIsLastPage    → pagination terminator
//   hit.apply_url                    → the EMPLOYER's real ATS URL
//   hit.source / hit.board_token     → ATS type (downstream zero-token fetch)
//   hit.is_expired                   → free offer-verification signal
//   hit.v5_processed_job_data        → pre-parsed: core_job_title,
//                                      company_name, seniority_level,
//                                      workplace_type, requirements_summary…
//
// IMPORTANT — searchQuery is SEMANTIC, not boolean. `"Head of Product" OR
// "VP Product"` returns 0 hits; `head of product` returns the relevant set
// ranked by relevance. So each hiringcafe_searches entry carries ONE
// natural-language phrase. Coverage comes from listing several entries,
// the same way linkedin_searches lists several URLs. Our own
// `title_filter` (applied on the parsed core_job_title) does the precise
// include/exclude — hiring.cafe's own seniority enums proved unreliable.
//
// Flow:
//   1. For each enabled hiringcafe_searches entry, build searchState and
//      page through ?searchState= until ssrIsLastPage / MAX_PAGES.
//   2. Canonicalize hit.apply_url (strip tracking params) — this is BOTH
//      the scan-history dedupe key and the dispatch URL, so the same role
//      found via LinkedIn/remoteineurope/ATS cross-dedupes by employer URL.
//   3. Drop expired, apply title_filter, apply ban-list.
//   4. Record into scan-history.db with portal='hiringcafe'.
//   5. Return resolved employer ATS URLs for DISPATCH_URLS — auto-pipeline
//      agents fetch+gate+score them normally (all structured ATS hosts).
//
// No Apify cost. Sequential per-query paging (politeness), pages are small.

import { readFileSync } from 'fs';
import { recordOffer } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';

const BASE_URL = 'https://hiring.cafe/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
// Safety cap per query. 40/page → 10 pages = 400 jobs/query, far beyond
// what any sane semantic query returns post title-filter. scan-history
// dedupe makes re-runs cheap regardless.
const MAX_PAGES = 10;
// Tracking/analytics params to strip during canonicalization so the same
// job is one stable key no matter which referrer surfaced it.
const TRACKING_PARAMS = new Set([
  'pid', 'ref', 'source', 'src', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_term', 'utm_content', 'gh_src', 'lever-source', 'rx_source',
]);

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s;

// ── searchState construction ─────────────────────────────────────────

/**
 * Build the hiring.cafe searchState object for one config entry. Known
 * ergonomic keys map straight in; anything under `searchState:` is merged
 * verbatim last, so a power user can reach filters we don't model without
 * a code change (the reason the user chose a dedicated config block).
 */
export function buildSearchState(entry) {
  const ss = {};
  if (entry.query != null) ss.searchQuery = String(entry.query);
  if (Array.isArray(entry.workplaceTypes)) ss.workplaceTypes = entry.workplaceTypes;
  if (entry.dateFetchedPastNDays != null) ss.dateFetchedPastNDays = entry.dateFetchedPastNDays;
  if (Array.isArray(entry.locations)) ss.locations = entry.locations;
  if (entry.searchState && typeof entry.searchState === 'object') {
    Object.assign(ss, entry.searchState);
  }
  return ss;
}

function searchUrl(searchState, page) {
  const q = encodeURIComponent(JSON.stringify(searchState));
  let url = `${BASE_URL}?searchState=${q}`;
  if (page > 0) url += `&page=${page}`;
  return url;
}

// ── SSR parse ────────────────────────────────────────────────────────

/** Extract props.pageProps from a hiring.cafe SSR HTML document. */
export function parsePageProps(html) {
  const m = html.match(NEXT_DATA_RE);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  return data?.props?.pageProps ?? null;
}

/** Pull the fields we care about out of one ssrHits entry. */
export function extractJob(hit) {
  const v5 = hit?.v5_processed_job_data ?? {};
  const info = hit?.job_information ?? {};
  const role = v5.core_job_title || info.title || info.job_title_raw || null;
  const company =
    v5.company_name ||
    hit?.enriched_company_data?.name ||
    hit?.board_token ||
    null;
  return {
    role,
    company,
    applyUrl: hit?.apply_url ?? null,
    source: hit?.source ?? null,
    isExpired: hit?.is_expired === true,
  };
}

// ── URL canonicalization ─────────────────────────────────────────────

export function canonicalize(rawUrl) {
  if (!rawUrl) return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  // Keep meaningful ATS query params (e.g. ?gh_jid=, Workday ids); drop
  // only known tracking/referrer noise so the key stays stable.
  for (const p of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
  }
  u.hash = '';
  const search = u.searchParams.toString();
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}${search ? `?${search}` : ''}`;
}

// ── Title filter (same semantics as the other scanners) ──────────────

function passesTitleFilter(title, titleFilter) {
  if (!titleFilter) return true;
  const lower = (title ?? '').toLowerCase();
  const positive = (titleFilter.positive ?? []).map(s => s.toLowerCase());
  const negative = (titleFilter.negative ?? []).map(s => s.toLowerCase());
  if (positive.length > 0 && !positive.some(k => lower.includes(k))) return false;
  if (negative.some(k => lower.includes(k))) return false;
  return true;
}

// ── HTTP ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {Database}          args.db          — better-sqlite3 scan-history handle
 * @param {object}            args.portalsCfg  — parsed portals.yml
 * @param {boolean}           [args.dryRun]
 * @param {(s:string)=>void}  [args.log]
 * @returns {Promise<{ newUrls: string[], stats: object }>}
 */
export async function runHiringCafeScan({
  db,
  portalsCfg,
  dryRun = false,
  log = (...a) => console.error('[hiringcafe]', ...a),
}) {
  const titleFilter = portalsCfg.title_filter ?? null;
  const searches = (portalsCfg.hiringcafe_searches ?? []).filter(
    e => e && e.enabled !== false,
  );
  const stats = {
    searches: searches.length,
    seen: 0,
    alreadySeen: 0,
    expired: 0,
    skippedTitle: 0,
    banned: 0,
    dispatched: 0,
    failed: 0,
  };

  if (searches.length === 0) {
    log('no enabled hiringcafe_searches in portals.yml — skipping');
    return { newUrls: [], stats };
  }

  const seenStmt = db.prepare(`SELECT 1 FROM offers WHERE url = ? LIMIT 1`);
  const fetchedDate = new Date().toISOString().slice(0, 10);
  const dispatched = [];
  const seenCanonical = new Set();

  for (const entry of searches) {
    const searchState = buildSearchState(entry);
    const label = entry.name || entry.query || JSON.stringify(searchState).slice(0, 60);
    let page = 0;
    let total = null;

    while (page < MAX_PAGES) {
      let pp;
      try {
        const html = await fetchHtml(searchUrl(searchState, page));
        pp = parsePageProps(html);
      } catch (err) {
        stats.failed++;
        log(`"${label}" page ${page} fetch failed: ${err.message}`);
        break;
      }
      if (!pp || !Array.isArray(pp.ssrHits)) {
        log(`"${label}" page ${page}: no parseable ssrHits — stopping query`);
        break;
      }
      if (total === null) {
        total = pp.ssrTotalCount ?? pp.ssrHits.length;
        log(`"${label}": ${total} total matches`);
      }

      for (const hit of pp.ssrHits) {
        stats.seen++;
        const { role, company, applyUrl, isExpired } = extractJob(hit);

        if (isExpired) {
          stats.expired++;
          continue;
        }
        const canonical = canonicalize(applyUrl);
        if (!canonical) continue;

        if (seenStmt.get(canonical)) {
          stats.alreadySeen++;
          continue;
        }
        if (!role || !passesTitleFilter(role, titleFilter)) {
          stats.skippedTitle++;
          if (!dryRun) {
            recordOffer(db, {
              url: canonical, firstSeen: fetchedDate, portal: 'hiringcafe',
              title: role, company, status: 'skipped_title',
            });
          }
          continue;
        }
        if (isBanned({ company, url: `${applyUrl} ${canonical}` })) {
          stats.banned++;
          if (!dryRun) {
            recordOffer(db, {
              url: canonical, firstSeen: fetchedDate, portal: 'hiringcafe',
              title: role, company, status: 'banned',
            });
          }
          continue;
        }
        if (seenCanonical.has(canonical)) continue; // dup within this run
        seenCanonical.add(canonical);

        if (!dryRun) {
          recordOffer(db, {
            url: canonical, firstSeen: fetchedDate, portal: 'hiringcafe',
            title: role, company, status: 'added',
          });
        }
        dispatched.push({ canonical, role, company });
      }

      if (pp.ssrIsLastPage || pp.ssrHits.length === 0) break;
      page++;
    }
  }

  stats.dispatched = dispatched.length;
  log(`new dispatchable: ${dispatched.length}`);
  for (const d of dispatched) {
    log(`+ ${d.company ?? '?'} | ${d.role} → ${d.canonical}`);
  }

  return { newUrls: dispatched.map(d => d.canonical), stats };
}

// ── CLI mode (ad-hoc testing) ────────────────────────────────────────
// `node lib/scan-hiringcafe.mjs --dry-run`  (uses data/scan-history.db
// and config/portals.yml from the project root)

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import('better-sqlite3')).default;
  const yaml = (await import('js-yaml')).default;
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database('data/scan-history.db');
  const portalsCfg = yaml.load(readFileSync('config/portals.yml', 'utf-8'));
  const { newUrls, stats } = await runHiringCafeScan({ db, portalsCfg, dryRun });
  console.log('\nstats:', stats);
  console.log('\nnewUrls:', newUrls);
}
