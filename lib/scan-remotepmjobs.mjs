// scan-remotepmjobs.mjs — zero-token discovery + JD prefetch from
// remotepmjobs.com (free, no paid vendor, no LLM tokens).
//
// remotepmjobs.com publishes a PUBLIC, auth-free, CORS-open MCP server whose
// own `instructions` field explicitly invites programmatic access. It is
// stateless streamable-HTTP — a plain JSON-RPC POST to /api/mcp, no session
// handshake, no MCP client library needed. We use three tools:
//   • search_jobs  → recency-sorted list (filters AND together; arrays = ANY;
//                    default 25, max 100). Returns id, title, companyName,
//                    companySlug, canonicalUrl, seniority, productArea,
//                    remoteType, geoRestriction, salary, rolePitch, flags.
//   • get_job(id)  → adds structured `enrichment` (requiredSkills,
//                    niceToHaveSkills, aiNativeSignals, yearsExperienceMin,
//                    benefitsTags, locationEligibleRegions…) + `company`
//                    (industry, size, funding, website). NOTE: no verbatim JD
//                    body — the full description lives on canonicalUrl. The
//                    enrichment is rich enough for the lean triage eval; the
//                    prefetched JD links to canonicalUrl for the full text.
//
// PM-only board: design-leadership roles never appear here (those stay with
// WWR / LinkedIn).
//
// Geo gate (scan-side): the candidate's location_policy is applied HERE so the
// US/Canada-only flood is dropped at the source, never fetched/scored/skipped
// downstream. A cheap free-text pre-gate on the search-result geoRestriction
// skips obvious excludes before get_job; the authoritative gate then uses
// get_job's structured locationEligibleRegions/Locales. Only ambiguous roles
// (no structured geo signal) fall through to the downstream location gate.
//
// ATS resolution (scan-side): the MCP exposes no employer apply URL, but each
// canonical page embeds the Apply button as the outbound link tagged
// utm_campaign=apply. We resolve it for eligible roles and write it as the JD's
// **URL:**/**Apply page:**, keeping the remotepmjobs canonical on a **Source:**
// line (provenance + the dedup key fetch-jd matches). Unresolvable → canonical.
//
// Flow per configured search in portals.yml `remotepmjobs_searches`:
//   1. search_jobs → candidate jobs.
//   2. Dedup canonicalUrl vs scan-history.db + applications.md; ban; title; geo
//      pre-gate.
//   3. For each survivor: get_job → drop non-open / geo-ineligible; resolve ATS
//      apply URL; reserve NUM, write data/jds/{NUM}-{slug}.md, append Fetched
//      row, record (dedup stays keyed on the remotepmjobs canonical).
//   4. Return remotepmjobs canonicalUrls — the agent's fetch-jd.mjs matches the
//      `**Source:**` line on disk and skips _fetch.md straight to gate+score.

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { nextNum, releaseNum } from './next-num.mjs';
import { loadSeenUrls, recordOffer, recordFetch } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';
import { APPLICATIONS_FILE, CONFIG_DIR, JDS_DIR, SCAN_HISTORY_DB } from './paths.mjs';
import { canonicalizeUrl } from './scan-linkedin.mjs';

const MCP_ENDPOINT = 'https://remotepmjobs.com/api/mcp';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36';
const GETJOB_CONCURRENCY = 3; // gentle — the endpoint throttles bursts
const DEFAULT_LIMIT = 50;

// ── Concurrency limiter ──────────────────────────────────────────────

async function pLimit(concurrency, items, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function pull() {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await worker(items[i], i); }
      catch (err) { out[i] = { error: err.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pull));
  return out;
}

// ── MCP JSON-RPC over HTTP (stateless) ───────────────────────────────

async function mcpCallOnce(name, args) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'User-Agent': UA },
    body,
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  let payload;
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
    if (!data.length) throw new Error('empty SSE response');
    payload = JSON.parse(data[data.length - 1]);
  } else {
    payload = await res.json();
  }
  if (payload.error) throw new Error(`MCP error: ${payload.error.message || JSON.stringify(payload.error)}`);
  // tools/call → result.content[] with a stringified-JSON text item.
  const textItem = Array.isArray(payload.result?.content)
    ? payload.result.content.find(c => c.type === 'text')
    : null;
  if (textItem) {
    try { return JSON.parse(textItem.text); } catch { return textItem.text; }
  }
  return payload.result;
}

// The endpoint is intermittently slow (Cloudflare cold edges) — retry transient
// network/5xx failures a couple of times before giving up.
async function mcpCall(name, args, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await mcpCallOnce(name, args); }
    catch (err) {
      lastErr = err;
      if (/HTTP 4\d\d/.test(err.message)) throw err; // client error — don't retry
    }
  }
  throw lastErr;
}

// ── geoRestriction → location-gate scope vocab ───────────────────────

function geoToScope(geoRestriction, regions) {
  const tokens = [];
  if (Array.isArray(regions)) tokens.push(...regions.map(r => String(r).toLowerCase()));
  if (geoRestriction) tokens.push(String(geoRestriction).toLowerCase());
  const blob = tokens.join(' ').trim();
  const loc = geoRestriction || (Array.isArray(regions) && regions.length ? regions.join(', ') : null);
  if (!blob) return { scope: 'full-remote-region:unspecified', location: 'Remote' };
  if (/\b(global|worldwide|anywhere)\b/.test(blob)) {
    return { scope: 'full-remote-region:global', location: loc || 'Worldwide' };
  }
  return { scope: `full-remote-countries:${loc}`, location: loc };
}

// ── Geo eligibility (scan-side gate) ─────────────────────────────────
// Reuse config/profile.md location_policy so the US/Canada-only flood is
// dropped at the source — never fetched, scored, then skipped downstream.

const COUNTRY_TO_ISO = { sweden: 'se', norway: 'no', denmark: 'dk', finland: 'fi', iceland: 'is' };

function loadGeoPolicy(profilePath) {
  let home = 'Sweden', allowed = [];
  try {
    const text = readFileSync(profilePath, 'utf8');
    const fm = text.match(/^---\n([\s\S]+?)\n---/);
    if (fm) {
      home = (fm[1].match(/home_country:\s*"?([^"\n]+)"?/) || [])[1]?.trim() || home;
      const blk = fm[1].match(/remote_allowed_scopes:\n((?:\s+-\s+"?[^"\n]+"?\n)+)/);
      if (blk) allowed = [...blk[1].matchAll(/-\s+"?([^"\n]+?)"?\s*$/gm)].map(m => m[1].trim());
    }
  } catch { /* defaults below */ }
  const tokens = new Set([home.toLowerCase(), ...allowed.map(s => s.toLowerCase())]);
  const homeLocale = COUNTRY_TO_ISO[home.toLowerCase()] || home.slice(0, 2).toLowerCase();
  return { home, tokens, homeLocale };
}

// Authoritative gate on get_job's structured fields (locationEligibleRegions
// like ["us"]/["worldwide"]/["emea"]; locationEligibleLocales like ISO ["SE"]).
function structuredGeoVerdict(regions, locales, policy) {
  const r = Array.isArray(regions) ? regions.map(x => String(x).toLowerCase()) : [];
  if (r.some(x => policy.tokens.has(x))) return 'eligible';
  const l = Array.isArray(locales) ? locales.map(x => String(x).toLowerCase()) : [];
  if (l.includes(policy.homeLocale)) return 'eligible';
  if (r.length || l.length) return 'ineligible';
  return 'unknown'; // no structured signal — keep; the downstream location-gate decides
}

// Cheap pre-gate on the search-result free-text geoRestriction so we skip
// get_job for the obvious US/excluded flood. Conservative: only excludes a
// recognizable geo string carrying NO home/allowed token; ambiguous values
// (Remote/null/unspecified/empty) pass through to the authoritative gate.
function freeTextGeoExcludes(text, policy) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t || /^(remote|anywhere|null|unspecified)$/.test(t)) return false;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const toks = [...policy.tokens, 'global', 'worldwide', 'anywhere', 'emea', 'eu', 'europe', 'nordic'];
  return !toks.some(tok => new RegExp(`\\b${esc(tok)}\\b`).test(t));
}

// ── ATS apply-URL resolution ─────────────────────────────────────────
// The MCP exposes no employer apply URL; the canonical page embeds the Apply
// button as the outbound link tagged utm_campaign=apply. Extract it and drop
// the remotepmjobs tracking params → the real employer ATS URL. Falls back to
// null (caller keeps the canonical) when the page has no resolvable apply link.
function cleanApplyUrl(raw) {
  const s = String(raw).replace(/&amp;/g, '&');
  try {
    const u = new URL(s);
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref'])
      u.searchParams.delete(p);
    return u.toString().replace(/\?$/, '');
  } catch { return s.split('?')[0]; }
}
async function resolveAtsUrl(canonicalUrl) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(canonicalUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const html = await res.text();
      const m = html.match(/https?:\/\/[^"'\\<> ]*utm_campaign=apply[^"'\\<> ]*/i);
      return m ? cleanApplyUrl(m[0]) : null;
    } catch { /* transient — retry once */ }
  }
  return null;
}

// ── Title filter (same contract as every level) ──────────────────────

function passesTitleFilter(title, titleFilter) {
  if (!titleFilter) return true;
  const lower = (title ?? '').toLowerCase();
  const positive = (titleFilter.positive ?? []).map(s => s.toLowerCase());
  const negative = (titleFilter.negative ?? []).map(s => s.toLowerCase());
  if (positive.length > 0 && !positive.some(k => lower.includes(k))) return false;
  if (negative.some(k => lower.includes(k))) return false;
  return true;
}

// ── JD writer (matches the **URL:**/**Remote scope:** shape) ─────────

function slugify(s, max = 50) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

function postingAgeStr(date) {
  if (!date) return 'unspecified';
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return 'unspecified';
  const days = Math.max(0, Math.round((Date.now() - t) / 86400_000));
  return days === 0 ? 'today' : `${days} days ago`;
}

function formatSalary(e) {
  if (!e || (e.salaryMin == null && e.salaryMax == null)) return null;
  const cur = e.salaryCurrency ? `${e.salaryCurrency} ` : '';
  const range = [e.salaryMin, e.salaryMax].filter(v => v != null).join('–');
  const per = e.salaryPeriod ? `/${e.salaryPeriod}` : '';
  return `${cur}${range}${per}`;
}

function bullets(arr) {
  return arr.map(s => `- ${s}`).join('\n');
}

function buildPmJobJd({ canonicalUrl, atsUrl, fetchedDate, job, status }) {
  const e = job.enrichment || {};
  const co = job.company || {};
  const applyUrl = atsUrl || canonicalUrl;
  const { scope, location } = geoToScope(job.geoRestriction ?? e.geoRestriction, e.locationEligibleRegions);
  const lines = [];
  lines.push(`# ${job.companyName || 'Unknown Company'} — ${job.title || 'Unknown Role'}`);
  lines.push('');
  lines.push(`**URL:** ${applyUrl}`);
  // Provenance + dedup key: fetch-jd matches this line for the dispatched
  // remotepmjobs URL, even though **URL:** above is now the employer ATS.
  lines.push(`**Source:** ${canonicalUrl}`);
  lines.push(`**Fetched:** ${fetchedDate}`);
  lines.push(`**Fetch-method:** remotepmjobs-mcp`);
  lines.push(`**Posting age:** ${postingAgeStr(job.datePostedOn || job.postedOn)}`);
  lines.push(`**Status:** ${status === 'open' || status == null ? 'active' : 'expired'}`);
  lines.push('');
  lines.push(`**Location:** ${location}`);
  lines.push(`**Remote scope:** ${scope}`);
  lines.push(`**Timezone:** unspecified`);
  lines.push(`**Visa/authorization:** ${job.geoRestriction ? `region-restricted: ${job.geoRestriction}` : 'unspecified'}`);
  lines.push(`**Relocation offered:** unspecified`);
  lines.push('');
  lines.push(`**Seniority:** ${job.seniority || e.seniority || 'unspecified'}`);
  lines.push(`**Product area:** ${job.productArea || e.productArea || 'unspecified'}`);
  lines.push(`**Employment type:** ${e.employmentType || 'unspecified'}`);
  if (e.yearsExperienceMin != null) lines.push(`**Min years experience:** ${e.yearsExperienceMin}`);
  const salary = formatSalary(e);
  if (salary) lines.push(`**Salary:** ${salary}`);
  lines.push(`**Geo restriction:** ${job.geoRestriction || e.geoRestriction || 'unspecified'}`);
  lines.push(`**Posted on:** ${job.datePostedOn || job.postedOn || 'unspecified'}`);
  if (job.firstSeenOn) lines.push(`**First seen:** ${job.firstSeenOn}`);
  if (co.name) {
    lines.push('');
    lines.push(`**Company:** ${co.name}${co.industry ? ` — ${co.industry}` : ''}`);
    if (co.companySize) lines.push(`**Company size:** ${co.companySize}`);
    if (co.fundingStage) lines.push(`**Funding stage:** ${co.fundingStage}`);
    if (co.website) lines.push(`**Employer homepage:** ${co.website}`);
  }
  lines.push(`**Apply page:** ${applyUrl}`);
  lines.push('');
  lines.push('## Role Summary');
  lines.push('');
  lines.push((job.rolePitch || e.rolePitch || '').trim() || '_No pitch provided._');
  lines.push('');
  if (Array.isArray(e.requiredSkills) && e.requiredSkills.length) {
    lines.push('## Required Skills', '', bullets(e.requiredSkills), '');
  }
  if (Array.isArray(e.niceToHaveSkills) && e.niceToHaveSkills.length) {
    lines.push('## Nice-to-have Skills', '', bullets(e.niceToHaveSkills), '');
  }
  if (Array.isArray(e.aiNativeSignals) && e.aiNativeSignals.length) {
    lines.push('## AI-native Signals', '', bullets(e.aiNativeSignals), '');
  }
  if (Array.isArray(e.benefitsTags) && e.benefitsTags.length) {
    lines.push(`**Benefits:** ${e.benefitsTags.join(', ')}`, '');
  }
  lines.push(`> Full description, application instructions, and company profile: ${canonicalUrl}`);
  lines.push('');
  return lines.join('\n');
}

function sanitizeCell(s) {
  return String(s ?? '').replace(/\|/g, '/');
}

function appendApplicationRow({ applicationsPath, num, fetchedDate, company, role }) {
  const row = `| ${num} | ${fetchedDate} | ${sanitizeCell(company)} | ${sanitizeCell(role)} |  | Fetched | ❌ |  |  |  |  |  |  |\n`;
  appendFileSync(applicationsPath, row);
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {Database} args.db                — better-sqlite3 handle
 * @param {object}   args.portalsCfg        — parsed portals.yml
 * @param {string}   args.applicationsPath  — path to data/applications.md
 * @param {string}   args.jdsDir            — path to data/jds/
 * @param {boolean}  [args.dryRun]
 * @param {(s:string)=>void} [args.log]
 * @returns {Promise<{
 *   newUrls: string[],
 *   stats: { searches, candidates, alreadySeen, prefetched, skippedTitle,
 *            banned, expired, failed }
 * }>}
 */
export async function runRemotePmJobsScan({
  db,
  portalsCfg,
  applicationsPath,
  jdsDir,
  profilePath = resolve(CONFIG_DIR, 'profile.md'),
  dryRun = false,
  log = (...args) => console.error('[remotepmjobs]', ...args),
}) {
  const searches = (portalsCfg.remotepmjobs_searches ?? []).filter(s => s.enabled !== false);
  const titleFilter = portalsCfg.title_filter ?? null;
  const policy = loadGeoPolicy(profilePath);
  const stats = {
    searches: searches.length, candidates: 0, alreadySeen: 0, prefetched: 0,
    skippedTitle: 0, skippedGeo: 0, atsResolved: 0, banned: 0, expired: 0, failed: 0,
  };

  if (searches.length === 0) {
    log('no enabled remotepmjobs_searches in portals.yml');
    return { newUrls: [], stats };
  }

  const seenCanonical = new Set(loadSeenUrls(db, { applicationsPath }));
  const fetchedDate = new Date().toISOString().slice(0, 10);

  // 1. search_jobs across all configured searches → unique candidates.
  // `query` is phrase/semantic (NOT boolean keyword-OR) — multi-term strings
  // match nothing; prefer the structured filters from list_filters (arrays
  // match ANY value, filters AND together). Forward whichever keys an entry
  // sets; `limit` defaults to DEFAULT_LIMIT.
  const FILTER_KEYS = ['query', 'seniority', 'productArea', 'geoRestriction', 'industry', 'fundingStage', 'companySize', 'cultureSignals', 'isAiNative'];
  const candidates = new Map(); // canonical → { id, title, companyName, canonical }
  for (const s of searches) {
    const argsObj = { limit: s.limit ?? DEFAULT_LIMIT };
    for (const k of FILTER_KEYS) if (s[k] != null) argsObj[k] = s[k];
    if (Object.keys(argsObj).length === 1) { log(`search "${s.name ?? '?'}" sets no filters`); continue; }
    let out;
    try {
      out = await mcpCall('search_jobs', argsObj);
    } catch (err) {
      stats.failed++;
      log(`search_jobs "${s.name ?? '?'}" failed: ${err.message}`);
      continue;
    }
    const jobs = Array.isArray(out?.jobs) ? out.jobs : [];
    log(`${s.name ?? '(unnamed)'}: ${jobs.length}/${out?.totalMatched ?? '?'} returned`);

    for (const job of jobs) {
      stats.candidates++;
      const canonical = canonicalizeUrl(job.canonicalUrl);
      if (!canonical) continue;
      if (seenCanonical.has(canonical) || candidates.has(canonical)) { stats.alreadySeen++; continue; }

      if (isBanned({ company: job.companyName, url: canonical })) {
        stats.banned++;
        if (!dryRun) recordOffer(db, { url: canonical, firstSeen: fetchedDate, portal: 'remotepmjobs', title: job.title, company: job.companyName, status: 'banned' });
        continue;
      }
      if (!passesTitleFilter(job.title, titleFilter)) {
        stats.skippedTitle++;
        if (!dryRun) recordOffer(db, { url: canonical, firstSeen: fetchedDate, portal: 'remotepmjobs', title: job.title, company: job.companyName, status: 'skipped_title' });
        continue;
      }
      // Cheap geo pre-gate: drop the obvious US/excluded flood before spending a
      // get_job call. The structured gate (post get_job) is authoritative for
      // anything ambiguous that slips through here.
      if (freeTextGeoExcludes(job.geoRestriction, policy)) {
        stats.skippedGeo++;
        if (!dryRun) recordOffer(db, { url: canonical, firstSeen: fetchedDate, portal: 'remotepmjobs', title: job.title, company: job.companyName, status: 'skipped_location' });
        continue;
      }
      candidates.set(canonical, { id: job.id, title: job.title, companyName: job.companyName, canonical });
    }
  }

  const survivors = [...candidates.values()];
  log(`survivors after dedup/ban/title: ${survivors.length}`);

  if (dryRun) {
    for (const c of survivors) log(`+ (dry) ${c.companyName ?? '?'} | ${c.title} → ${c.canonical}`);
    stats.prefetched = survivors.length;
    return { newUrls: survivors.map(c => c.canonical), stats };
  }

  // 2. get_job each survivor → prefetch. Concurrency-limited.
  const newUrls = [];
  const results = await pLimit(GETJOB_CONCURRENCY, survivors, async (c) => {
    let detail;
    try {
      detail = await mcpCall('get_job', { id: c.id });
    } catch (err) {
      stats.failed++;
      log(`get_job ${c.id} failed: ${err.message}`);
      return null;
    }
    const status = detail?.status;
    const job = detail?.job;
    if (!job) { stats.failed++; log(`get_job ${c.id} returned no job`); return null; }
    if (status && status !== 'open') {
      stats.expired++;
      recordOffer(db, { url: c.canonical, firstSeen: fetchedDate, portal: 'remotepmjobs', title: c.title, company: c.companyName, status: 'skipped_expired' });
      return null;
    }
    // Authoritative geo gate on structured eligibility — drops country-locked
    // roles (incl. messy multi-country strings) the candidate can't take.
    const e = job.enrichment || {};
    if (structuredGeoVerdict(e.locationEligibleRegions, e.locationEligibleLocales, policy) === 'ineligible') {
      stats.skippedGeo++;
      recordOffer(db, { url: c.canonical, firstSeen: fetchedDate, portal: 'remotepmjobs', title: c.title, company: c.companyName, status: 'skipped_location' });
      return null;
    }
    // Resolve the employer ATS apply URL from the canonical page (eligible roles
    // only, so the extra GET is low-volume). null → caller keeps the canonical.
    const atsUrl = await resolveAtsUrl(c.canonical);
    if (atsUrl) stats.atsResolved++;
    return { c, job, status, atsUrl };
  });

  // 3. Write sequentially (NUM reservation + appendFile are not concurrency-safe).
  for (const r of results) {
    if (!r) continue;
    const { c, job, status, atsUrl } = r;
    let num;
    try { num = nextNum(); }
    catch (err) { log(`nextNum() failed: ${err.message}`); continue; }
    const company = (job.companyName || c.companyName || 'Unknown Company').trim();
    const role = (job.title || c.title || 'Unknown Role').trim();
    const slug = `${slugify(company)}-${slugify(role)}`;
    const jdPath = resolve(jdsDir, `${num}-${slug}.md`);
    try {
      writeFileSync(jdPath, buildPmJobJd({ canonicalUrl: c.canonical, atsUrl, fetchedDate, job, status }));
      appendApplicationRow({ applicationsPath, num, fetchedDate, company, role });
      recordFetch(db, { canonicalUrl: c.canonical, portal: 'remotepmjobs', title: role, company, firstSeen: fetchedDate, num });
      newUrls.push(c.canonical);
      stats.prefetched++;
      log(`+ NUM ${num} ${company} | ${role} → ${c.canonical}`);
    } catch (err) {
      log(`failed to write NUM ${num} (${company} / ${role}): ${err.message}`);
    } finally {
      releaseNum(num);
    }
  }

  return { newUrls, stats };
}

// ── CLI mode (ad-hoc testing) ────────────────────────────────────────
// `node lib/scan-remotepmjobs.mjs --dry-run` uses data/scan-history.db,
// config/portals.yml, data/applications.md, data/jds/ from the project root.

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import('better-sqlite3')).default;
  const yaml = (await import('js-yaml')).default;
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database(SCAN_HISTORY_DB);
  const portalsCfg = yaml.load(readFileSync(resolve(CONFIG_DIR, 'portals.yml'), 'utf-8'));
  const { newUrls, stats } = await runRemotePmJobsScan({
    db, portalsCfg, applicationsPath: APPLICATIONS_FILE, jdsDir: JDS_DIR, dryRun,
  });
  console.log('\nstats:', stats);
  console.log('\nnewUrls:', newUrls);
}
