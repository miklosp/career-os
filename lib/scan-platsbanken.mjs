// scan-platsbanken.mjs — zero-token discovery + JD prefetch from Platsbanken,
// Arbetsförmedlingen's national job board, via the JobTech JobSearch API
// (https://jobsearch.api.jobtechdev.se — official open data, free, no auth).
//
// Sweden-only by construction: every ad carries a structured workplace
// address, so this is the level that covers Stockholm on-site/hybrid roles
// beyond LinkedIn. Each hit ships the full JD text (description.text), the
// employer name, workplace_model, application_deadline and — for most ads —
// the employer's own application URL (Teamtailor, Workday, Ashby,
// SmartRecruiters…). So the JD is prefetched straight to disk, like the
// LinkedIn and remotepmjobs levels, and dispatched agents skip _fetch.md.
//
// URL contract (same as scan-remotepmjobs.mjs): the employer application URL
// becomes **URL:**/**Apply page:**; the Platsbanken ad URL
// (arbetsformedlingen.se/platsbanken/annonser/{id}) stays on a **Source:**
// line. Dispatch and scan-history dedup are keyed on the Platsbanken URL;
// fetch-jd.mjs matches the **Source:** line on disk. Ads with no web apply URL
// (email / via Arbetsförmedlingen) keep the Platsbanken URL as **URL:**.
//
// Query semantics: `q` matches headline + body with AND over terms, so a broad
// single word ("product", "design") is the sweep; the global title_filter does
// the precise include/exclude. Paginated 100/page up to the API's offset cap.
//
// Flow per entry in portals.yml `platsbanken_searches`:
//   1. GET /search?q=…&limit=100&offset=… until exhausted.
//   2. Dedup the Platsbanken URL (and the employer apply URL) against
//      scan-history.db + applications.md, and company::role against
//      applications.md (catches the same ad already found via LinkedIn / L1).
//   3. Drop past-deadline, banned, title-filtered.
//   4. Survivors: reserve NUM, write data/jds/{NUM}-{slug}.md, append a
//      Fetched row, record in scan-history (keyed on the Platsbanken URL).

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { nextNum, releaseNum } from './next-num.mjs';
import { loadSeenUrls, recordOffer, recordFetch } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';
import { APPLICATIONS_FILE, CONFIG_DIR, JDS_DIR, SCAN_HISTORY_DB } from './paths.mjs';
import { canonicalizeUrl } from './scan-linkedin.mjs';

const API = 'https://jobsearch.api.jobtechdev.se/search';
const PAGE = 100;
const MAX_OFFSET = 2000; // JobSearch API hard cap on offset
const PORTAL = 'platsbanken';

// ── Helpers ──────────────────────────────────────────────────────────

function passesTitleFilter(title, titleFilter) {
  if (!titleFilter) return true;
  const lower = (title ?? '').toLowerCase();
  const positive = (titleFilter.positive ?? []).map(s => s.toLowerCase());
  const negative = (titleFilter.negative ?? []).map(s => s.toLowerCase());
  if (positive.length > 0 && !positive.some(k => lower.includes(k))) return false;
  if (negative.some(k => lower.includes(k))) return false;
  return true;
}

// Swedish legal-entity names → tracker names: "Lovable Labs Sweden AB" →
// "Lovable Labs", "MAG Interactive AB (publ)" → "MAG Interactive".
export function cleanCompany(name) {
  // Trailing suffixes only (a brand ending in "Sweden" loses it — accepted).
  return (name ?? '')
    .replace(/(?:[\s,]+(?:aktiebolag|ab|i sverige|sweden|sverige|\(publ\)))+[\s.]*$/i, '')
    .trim();
}

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
  const t = date ? new Date(date).getTime() : NaN;
  if (Number.isNaN(t)) return 'unspecified';
  const days = Math.max(0, Math.round((Date.now() - t) / 86400_000));
  return days === 0 ? 'today' : `${days} days ago`;
}

// Employer application URL, canonicalized; null for email / via-AF / junk
// (some ads put a recruiter's LinkedIn profile in the URL field).
function applyUrlOf(hit) {
  let raw = hit.application_details?.url?.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const c = canonicalizeUrl(raw);
  if (!c || /linkedin\.com\/in\//.test(c)) return null;
  return c.replace(/\/applications\/new$/, ''); // Teamtailor apply-form suffix
}

// workplace_model is "Arbete på plats" (on-site) or absent; remote/hybrid are
// labelled in Swedish when present. Location is "{city}, Sweden".
function scopeOf(hit) {
  const a = hit.workplace_address || {};
  const city = a.city || a.municipality || a.region || null;
  const location = city ? `${city}, Sweden` : 'Sweden';
  const model = (hit.workplace_model?.label || '').toLowerCase();
  if (/distans|remote/.test(model)) return { location, scope: 'full-remote-countries:Sweden' };
  if (/hybrid/.test(model)) return { location, scope: `hybrid:${city || 'unspecified'}` };
  if (/på plats/.test(model)) return { location, scope: `onsite:${city || 'unspecified'}` };
  return { location, scope: 'unspecified' };
}

function buildJd({ sourceUrl, applyUrl, fetchedDate, hit, company }) {
  const url = applyUrl || sourceUrl;
  const { location, scope } = scopeOf(hit);
  const d = hit.description || {};
  const lines = [];
  lines.push(`# ${company} — ${hit.headline}`);
  lines.push('');
  lines.push(`**URL:** ${url}`);
  lines.push(`**Source:** ${sourceUrl}`);
  lines.push(`**Fetched:** ${fetchedDate}`);
  lines.push(`**Fetch-method:** platsbanken-api`);
  lines.push(`**Posting age:** ${postingAgeStr(hit.publication_date)}`);
  lines.push(`**Status:** active`);
  lines.push('');
  lines.push(`**Location:** ${location}`);
  lines.push(`**Remote scope:** ${scope}`);
  lines.push(`**Timezone:** CET`);
  lines.push(`**Visa/authorization:** unspecified`);
  lines.push(`**Relocation offered:** unspecified`);
  lines.push('');
  lines.push(`**Employer (legal name):** ${hit.employer?.name || 'unspecified'}`);
  if (hit.employer?.url) lines.push(`**Employer homepage:** ${hit.employer.url}`);
  lines.push(`**Employment type:** ${[hit.employment_type?.label, hit.working_hours_type?.label, hit.duration?.label].filter(Boolean).join(' · ') || 'unspecified'}`);
  if (hit.salary_description) lines.push(`**Salary:** ${hit.salary_description}`);
  lines.push(`**Occupation (SSYK):** ${hit.occupation?.label || 'unspecified'}`);
  lines.push(`**Published:** ${hit.publication_date || 'unspecified'}`);
  lines.push(`**Application deadline:** ${hit.application_deadline || 'unspecified'}`);
  lines.push(`**Apply page:** ${url}`);
  lines.push('');
  lines.push('## Role Summary');
  lines.push('');
  lines.push((d.text || '').trim() || '_No description in ad._');
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

// company::role keys already in the tracker (cleaned + lowercased).
function loadSeenCompanyRoles(applicationsPath) {
  const seen = new Set();
  if (!existsSync(applicationsPath)) return seen;
  for (const line of readFileSync(applicationsPath, 'utf-8').split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (!/^\d+$/.test(cells[1] || '')) continue;
    seen.add(`${cleanCompany(cells[3]).toLowerCase()}::${(cells[4] || '').toLowerCase()}`);
  }
  return seen;
}

async function fetchPage(q, offset) {
  const url = `${API}?q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${offset}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * @returns {Promise<{ newUrls: string[], stats: { searches, hits, alreadySeen,
 *   prefetched, skippedTitle, banned, expired, dupCompanyRole, failed } }>}
 */
export async function runPlatsbankenScan({
  db,
  portalsCfg,
  applicationsPath,
  jdsDir,
  dryRun = false,
  log = (...args) => console.error('[platsbanken]', ...args),
}) {
  const searches = (portalsCfg.platsbanken_searches ?? []).filter(s => s.enabled !== false && s.q);
  const titleFilter = portalsCfg.title_filter ?? null;
  const stats = {
    searches: searches.length, hits: 0, alreadySeen: 0, prefetched: 0,
    skippedTitle: 0, banned: 0, expired: 0, dupCompanyRole: 0, failed: 0,
  };
  if (!searches.length) return { newUrls: [], stats };

  const seen = new Set(loadSeenUrls(db, { applicationsPath }));
  const seenCompanyRoles = loadSeenCompanyRoles(applicationsPath);
  const fetchedDate = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const newUrls = [];

  for (const search of searches) {
    let offset = 0;
    let total = Infinity;
    while (offset < total && offset <= MAX_OFFSET) {
      let page;
      try {
        page = await fetchPage(search.q, offset);
      } catch (err) {
        stats.failed++;
        log(`${search.name ?? search.q} offset ${offset} failed: ${err.message}`);
        break;
      }
      total = page.total?.value ?? 0;
      const hits = page.hits ?? [];
      if (!hits.length) break;
      offset += PAGE;

      for (const hit of hits) {
        stats.hits++;
        const sourceUrl = hit.webpage_url || `https://arbetsformedlingen.se/platsbanken/annonser/${hit.id}`;
        if (seen.has(sourceUrl)) { stats.alreadySeen++; continue; }
        seen.add(sourceUrl);

        const role = (hit.headline || '').trim();
        const company = cleanCompany(hit.employer?.name) || hit.employer?.workplace || 'Unknown Company';
        const applyUrl = applyUrlOf(hit);
        const rec = status => { if (!dryRun) recordOffer(db, { url: sourceUrl, firstSeen: fetchedDate, portal: PORTAL, title: role, company, status }); };

        const deadline = hit.application_deadline ? new Date(hit.application_deadline).getTime() : NaN;
        if (hit.removed || (!Number.isNaN(deadline) && deadline < now)) { stats.expired++; rec('skipped_expired'); continue; }
        if (isBanned({ company, url: applyUrl || sourceUrl })) { stats.banned++; rec('banned'); continue; }
        if (!passesTitleFilter(role, titleFilter)) { stats.skippedTitle++; rec('skipped_title'); continue; }

        const key = `${company.toLowerCase()}::${role.toLowerCase()}`;
        if ((applyUrl && seen.has(applyUrl)) || seenCompanyRoles.has(key)) {
          stats.dupCompanyRole++;
          rec('skipped_dup');
          continue;
        }
        if (applyUrl) seen.add(applyUrl);
        seenCompanyRoles.add(key);

        if (dryRun) {
          newUrls.push(sourceUrl);
          stats.prefetched++;
          log(`+ (dry) ${company} | ${role} → ${applyUrl || sourceUrl}`);
          continue;
        }

        let num;
        try { num = nextNum(); } catch (err) { log(`nextNum() failed: ${err.message}`); continue; }
        const jdPath = resolve(jdsDir, `${num}-${slugify(company)}-${slugify(role)}.md`);
        try {
          writeFileSync(jdPath, buildJd({ sourceUrl, applyUrl, fetchedDate, hit, company }));
          appendApplicationRow({ applicationsPath, num, fetchedDate, company, role });
          recordFetch(db, { canonicalUrl: sourceUrl, portal: PORTAL, title: role, company, firstSeen: fetchedDate, num });
          newUrls.push(sourceUrl);
          stats.prefetched++;
          log(`+ NUM ${num} ${company} | ${role} → ${applyUrl || sourceUrl}`);
        } catch (err) {
          log(`failed to write NUM ${num} (${company} / ${role}): ${err.message}`);
        } finally {
          releaseNum(num);
        }
      }
    }
  }

  return { newUrls, stats };
}

// ── CLI mode (ad-hoc testing) ────────────────────────────────────────
// `node lib/scan-platsbanken.mjs --dry-run`

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import('better-sqlite3')).default;
  const yaml = (await import('js-yaml')).default;
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database(SCAN_HISTORY_DB);
  const portalsCfg = yaml.load(readFileSync(resolve(CONFIG_DIR, 'portals.yml'), 'utf-8'));
  const { newUrls, stats } = await runPlatsbankenScan({
    db, portalsCfg, applicationsPath: APPLICATIONS_FILE, jdsDir: JDS_DIR, dryRun,
  });
  console.log('\nstats:', stats);
  console.log('\nnewUrls:', newUrls);
}
