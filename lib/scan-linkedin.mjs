// scan-linkedin.mjs — zero-token LinkedIn discovery + JD prefetch (free).
//
// Called from scan.mjs Level 2. One pass, no LLM, no paid vendor:
//   1. Read portals.yml linkedin_searches → derive JobSpy search params
//      (existing `url:`/`payload:` entries reused as-is; an explicit
//      `jobspy:` block on an entry overrides the derivation).
//   2. Spawn lib/scan-jobspy.py via `uv run --with python-jobspy` — returns
//      LinkedIn jobs WITH full JD text in the same pass (replaces the paid
//      Apify valig+apimaestro pair; JobSpy gives everything scan→score needs).
//   3. Client-side dedup against scan-history (skipJobId pool + seen URLs),
//      ban check, title_filter.
//   4. ATS URL is resolved ONLY when authenticated LinkedIn cookies are
//      present (lib/li-voyager.mjs, free, ~0 token). Without cookies the
//      canonical URL is the LinkedIn URL and ATS resolution defers to
//      apply-time (the headed authed apply browser resolves it via the
//      native "Apply on company website" click). Easy-Apply roles have no
//      ATS URL by definition → LinkedIn URL is canonical.
//   5. For each survivor: reserve NUM, write jds/{NUM}-{slug}.md, append a
//      Fetched row, dual-record (canonical URL + linkedin.com/jobs/view/{id})
//      in scan-history so ID-level dedup keeps working unchanged.
//   6. Return canonical URLs for DISPATCH_URLS.
//
// Why JobSpy over Apify/ever-jobs/Bright Data/cloud-CDP and why resolution is
// deferred: memory/reference_linkedin_ats_resolution.md (5 tools tested).
//
// Rate-limit: LinkedIn throttles JobSpy ~page 10 and the result set is
// sampled/rotating — coverage accumulates across scheduled runs via
// scan-history.db, not one sweep. Keep results_wanted modest, hours_old tight.
//
// canonicalizeUrl + buildJdMarkdown (and their helpers) are also imported by
// lib/fetch-jd.mjs for the LinkedIn detail shape it builds from Voyager —
// preserved verbatim; do not change their signatures.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { nextNum, releaseNum } from './next-num.mjs';
import { linkedInSkipIds, loadSeenUrls, recordOffer, recordFetch } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';
import { resolveAts, hasVoyagerCookies } from './li-voyager.mjs';

const JOBSPY_SCRIPT = 'lib/scan-jobspy.py';
const DEFAULT_RESULTS_WANTED = 50;
const VOYAGER_DELAY_MS = 1500; // serial pacing between Voyager calls

// ── Tiny concurrency limiter ─────────────────────────────────────────

async function pLimit(concurrency, items, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function pull() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, pull));
  return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── LinkedIn URL → search payload (reused by JobSpy derivation) ───────

const FILTER_PARAM_MAP = {
  f_TPR: 'datePosted',     // single value
  f_E:   'experienceLevel', // CSV
  f_JT:  'contractType',    // CSV
  f_WT:  'remote',          // CSV
};

export function parseLinkedInSearchUrl(url) {
  const u = new URL(url);
  const payload = {};
  const urlParam = [];
  for (const [key, value] of u.searchParams) {
    if (key === 'keywords') payload.title = decodeURIComponent(value);
    else if (key === 'location') payload.location = decodeURIComponent(value);
    else if (FILTER_PARAM_MAP[key]) {
      const target = FILTER_PARAM_MAP[key];
      if (target === 'datePosted') payload[target] = value;
      else payload[target] = value.split(',').map(v => v.trim()).filter(Boolean);
    } else if (key.startsWith('f_')) {
      urlParam.push({ key, value });
    }
  }
  if (urlParam.length > 0) payload.urlParam = urlParam;
  return payload;
}

export function searchEntryToPayload(entry) {
  if (entry.payload && typeof entry.payload === 'object') {
    return { ...entry.payload };
  }
  if (entry.url) return parseLinkedInSearchUrl(entry.url);
  throw new Error(`linkedin_searches entry "${entry.name}" has neither url nor payload`);
}

// LinkedIn f_TPR datePosted code → JobSpy hours_old.
function datePostedToHours(code) {
  const m = /^r(\d+)$/.exec(String(code ?? ''));
  if (!m) return null;
  const hours = Math.round(Number(m[1]) / 3600);
  return hours > 0 ? hours : null;
}

/**
 * Derive JobSpy params from a linkedin_searches entry. An explicit
 * `jobspy:` block wins; otherwise we map the existing url:/payload: form
 * (title→search_term, location, f_TPR→hours_old, f_WT=2→is_remote).
 */
export function searchEntryToJobSpy(entry) {
  const o = entry.jobspy && typeof entry.jobspy === 'object' ? entry.jobspy : {};
  const p = searchEntryToPayload(entry);
  const remote = Array.isArray(p.remote) ? p.remote.map(String) : [];
  return {
    name: entry.name ?? o.search_term ?? p.title ?? 'linkedin',
    search_term: o.search_term ?? p.title ?? null,
    location: o.location ?? p.location ?? null,
    hours_old: o.hours_old ?? datePostedToHours(p.datePosted),
    is_remote: o.is_remote ?? (remote.includes('2') ? true : null),
    results_wanted: o.results_wanted ?? entry.results_wanted ?? DEFAULT_RESULTS_WANTED,
  };
}

// ── JobSpy subprocess ────────────────────────────────────────────────

/**
 * Run lib/scan-jobspy.py via uv. Returns { jobs:[], fatal, fatalDetail }.
 * Per-search scrape failures are isolated inside the script (logged, not
 * fatal). fatal is set only for unrunnable: uv/jobspy missing or bad config.
 */
function runJobSpy(searches, log) {
  return new Promise((resolvePromise) => {
    const cfg = JSON.stringify({ searches, default_results_wanted: DEFAULT_RESULTS_WANTED });
    const child = spawn('uv', ['run', '--with', 'python-jobspy', JOBSPY_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let errBuf = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', (d) => {
      errBuf += d;
      let nl;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl).trim();
        errBuf = errBuf.slice(nl + 1);
        if (line) log(line.replace(/^\[jobspy\]\s?/, ''));
      }
    });
    child.on('error', (err) => {
      resolvePromise({ jobs: [], fatal: 'jobspy-unavailable', fatalDetail: `spawn uv failed: ${err.message}` });
    });
    child.on('close', (code) => {
      if (errBuf.trim()) log(errBuf.trim().replace(/^\[jobspy\]\s?/, ''));
      if (code === 3) {
        resolvePromise({ jobs: [], fatal: 'jobspy-unavailable', fatalDetail: 'python-jobspy not importable (uv run failed)' });
        return;
      }
      if (code === 2) {
        resolvePromise({ jobs: [], fatal: 'jobspy-unavailable', fatalDetail: 'scan-jobspy.py rejected its config' });
        return;
      }
      const jobs = [];
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { jobs.push(JSON.parse(t)); } catch { /* skip malformed line */ }
      }
      resolvePromise({ jobs, fatal: null, fatalDetail: '' });
    });
    child.stdin.end(cfg);
  });
}

// ── Title filter (in-process) ────────────────────────────────────────

export function passesTitleFilter(title, titleFilter) {
  if (!titleFilter) return true;
  const lower = (title ?? '').toLowerCase();
  const positive = (titleFilter.positive ?? []).map(s => s.toLowerCase());
  const negative = (titleFilter.negative ?? []).map(s => s.toLowerCase());
  if (positive.length > 0 && !positive.some(k => lower.includes(k))) return false;
  if (negative.some(k => lower.includes(k))) return false;
  return true;
}

// ── URL canonicalization (also used by lib/fetch-jd.mjs) ─────────────

// Query params that carry job identity rather than tracking: Greenhouse embed
// widgets (careers.<co>.com/?gh_jid=), Saba TalentLink apply pages (?jobId=),
// Ashby embeds on a company's own careers page (?ashby_jid=), aplitrak
// (/?adid=), softgarden click URLs (?jp=), Deel's own careers page
// (www.deel.com/careers/job?ats_id=). Without these the postings on a
// host collapse to one canonical URL and distinct jobs alias onto each other.
const ID_PARAMS = ['gh_jid', 'jobId', 'ashby_jid', 'adid', 'jp', 'ats_id'];
// Jobvite splits identity across two single-letter params; scope them to the
// host so unrelated `?c=` tracking params elsewhere keep being dropped.
const JOBVITE_ID_PARAMS = ['c', 'j'];

export function canonicalizeUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const names = u.host.endsWith('jobvite.com')
    ? [...ID_PARAMS, ...JOBVITE_ID_PARAMS]
    : ID_PARAMS;
  const kept = names
    .map((k) => [k, u.searchParams.get(k)])
    .filter(([, v]) => v != null);
  u.hash = '';                         // strip fragment
  let path = u.pathname.replace(/\/+$/, ''); // trim trailing slash
  path = path.replace(/\/application\/*$/, ''); // strip Ashby /application suffix
  const query = kept.length ? `?${kept.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  const sep = !path && query ? '/' : ''; // keep root slash so host/?gh_jid= matches the stored form
  return `${u.protocol}//${u.host}${path}${sep}${query}`;
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

// ── Detail-shaped JD writer — lib/fetch-jd.mjs imports this and feeds it a
//    detail object synthesized from the Voyager record (job_info /
//    company_info / apply_details). Keep the shape stable for that caller. ──

function cityFromLocation(loc) {
  if (!loc) return null;
  const first = String(loc).split(',')[0].trim();
  if (!first) return null;
  if (/^(remote|anywhere|worldwide|global)$/i.test(first)) return null;
  return first;
}

function workplaceToScope(workplaceTypes, location) {
  const v = new Set((workplaceTypes ?? []).map(s => String(s).toUpperCase()));
  const city = cityFromLocation(location) || 'unspecified';
  if (v.has('REMOTE')) return 'full-remote-region:unspecified';
  if (v.has('HYBRID')) return `hybrid:${city}`;
  if (v.has('ONSITE')) return `onsite:${city}`;
  return 'unspecified';
}

function postingAgeStr(listedAt) {
  if (!listedAt) return 'unspecified';
  const t = new Date(listedAt).getTime();
  if (Number.isNaN(t)) return 'unspecified';
  const days = Math.max(0, Math.round((Date.now() - t) / 86400_000));
  return days === 0 ? 'today' : `${days} days ago`;
}

function statusFromDetail(detail) {
  const state = detail.job_info?.job_state;
  if (state && state !== 'LISTED') return 'expired';
  const expireAt = detail.job_info?.expire_at;
  if (expireAt && new Date(expireAt).getTime() < Date.now()) return 'expired';
  return 'active';
}

export function buildJdMarkdown({ canonicalUrl, fetchedDate, detail }) {
  const j = detail.job_info ?? {};
  const c = detail.company_info ?? {};
  const a = detail.apply_details ?? {};
  const status = statusFromDetail(detail);
  const lines = [];
  lines.push(`# ${c.name ?? 'Unknown'} — ${j.title ?? 'Unknown role'}`);
  lines.push('');
  lines.push(`**URL:** ${canonicalUrl}`);
  lines.push(`**Fetched:** ${fetchedDate}`);
  lines.push(`**Fetch-method:** voyager-linkedin`);
  lines.push(`**Posting age:** ${postingAgeStr(j.listed_at)}`);
  lines.push(`**Status:** ${status}`);
  lines.push('');
  lines.push(`**Location:** ${j.location ?? 'unspecified'}`);
  lines.push(`**Remote scope:** ${workplaceToScope(j.workplace_types, j.location)}`);
  lines.push(`**Timezone:** unspecified`);
  lines.push(`**Visa/authorization:** unspecified`);
  lines.push(`**Relocation offered:** unspecified`);
  lines.push('');
  lines.push(`**Country code:** ${j.country_code ?? 'unspecified'}`);
  lines.push(`**Listed at:** ${j.listed_at ?? 'unspecified'}`);
  lines.push(`**Expire at:** ${j.expire_at ?? 'unspecified'}`);
  lines.push(`**Easy apply:** ${a.is_easy_apply ? 'yes' : 'no'}`);
  lines.push(`**Total applies:** ${a.total_applies ?? 'unspecified'}`);
  lines.push(`**LinkedIn job URL:** ${j.job_url ?? `https://www.linkedin.com/jobs/view/${j.job_posting_id ?? ''}`}`);
  if (c.staff_count) lines.push(`**Company size (LinkedIn):** ${c.staff_count}`);
  if (Array.isArray(c.industries) && c.industries.length > 0) {
    lines.push(`**Company industries:** ${c.industries.join(', ')}`);
  }
  lines.push('');
  lines.push('## Role Summary');
  lines.push('');
  lines.push((j.description ?? '').trim() || '_No description returned by Voyager._');
  lines.push('');
  if (c.description) {
    lines.push('## About the Company');
    lines.push('');
    lines.push(c.description.trim());
    lines.push('');
  }
  return lines.join('\n');
}

// ── JobSpy-shaped JD writer ──────────────────────────────────────────

function buildJobSpyJd({ canonicalUrl, fetchedDate, job, resolution }) {
  const company = job.company?.trim() || 'Unknown Company';
  const role = job.title?.trim() || 'Unknown Role';
  const linkedinUrl = `https://www.linkedin.com/jobs/view/${job.id}`;
  const easyApply = resolution?.kind === 'easy-apply'
    ? 'yes'
    : resolution?.kind === 'offsite' ? 'no' : 'unspecified';
  const voyagerEnriched = resolution?.kind === 'offsite'
    || resolution?.kind === 'easy-apply'
    || (resolution?.workplaceTypes?.length ?? 0) > 0;
  const method = voyagerEnriched ? 'jobspy-linkedin+voyager' : 'jobspy-linkedin';
  const lines = [];
  lines.push(`# ${company} — ${role}`);
  lines.push('');
  lines.push(`**URL:** ${canonicalUrl}`);
  lines.push(`**Fetched:** ${fetchedDate}`);
  lines.push(`**Fetch-method:** ${method}`);
  lines.push(`**Posting age:** ${postingAgeStr(job.date_posted)}`);
  lines.push(`**Status:** active`);
  lines.push('');
  const locFromVoyager = resolution?.formattedLocation;
  const remoteScope = resolution?.workplaceTypes?.length
    ? workplaceToScope(resolution.workplaceTypes, locFromVoyager || job.location)
    : (job.is_remote ? 'full-remote-region:unspecified' : 'unspecified');
  lines.push(`**Location:** ${locFromVoyager || job.location || 'unspecified'}`);
  lines.push(`**Remote scope:** ${remoteScope}`);
  lines.push(`**Timezone:** unspecified`);
  lines.push(`**Visa/authorization:** unspecified`);
  lines.push(`**Relocation offered:** unspecified`);
  lines.push('');
  lines.push(`**Listed at:** ${job.date_posted ?? 'unspecified'}`);
  lines.push(`**Easy apply:** ${easyApply}`);
  lines.push(`**LinkedIn job URL:** ${linkedinUrl}`);
  if (resolution?.kind === 'offsite' && resolution.atsUrl) {
    lines.push(`**Resolved ATS URL:** ${resolution.atsUrl}`);
  }
  lines.push('');
  lines.push('## Role Summary');
  lines.push('');
  lines.push((job.description ?? '').trim() || '_No description returned by JobSpy._');
  lines.push('');
  return lines.join('\n');
}

// ── applications.md row ──────────────────────────────────────────────

function sanitizeCell(s) {
  return String(s ?? '').replace(/\|/g, '/');
}

function appendApplicationRow({ applicationsPath, num, fetchedDate, company, role }) {
  const row = `| ${num} | ${fetchedDate} | ${sanitizeCell(company)} | ${sanitizeCell(role)} |  | Fetched | ❌ |  |  |\n`;
  appendFileSync(applicationsPath, row);
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {Database} args.db                — better-sqlite3 handle
 * @param {object}   args.portalsCfg        — parsed portals.yml
 * @param {string}   args.applicationsPath  — path to data/applications.md
 * @param {string}   args.jdsDir            — path to jds/
 * @param {boolean}  [args.dryRun]
 * @param {(s:string)=>void} [args.log]
 *
 * @returns {Promise<{
 *   newUrls: string[],
 *   stats: { searches, idsReturned, afterTitleFilter, prefetched, skipped,
 *            banned, resolved, easyApply, deferred, voyager,
 *            fatal:(string|null), fatalDetail:string }
 * }>}
 */
export async function runLinkedInScan({
  db,
  portalsCfg,
  applicationsPath,
  jdsDir,
  dryRun = false,
  log = (...args) => console.error('[linkedin]', ...args),
}) {
  const linkedinSearches = (portalsCfg.linkedin_searches ?? []).filter(e => e.enabled !== false);
  const titleFilter = portalsCfg.title_filter ?? null;
  const stats = {
    searches: linkedinSearches.length, idsReturned: 0, afterTitleFilter: 0,
    prefetched: 0, skipped: 0, banned: 0,
    resolved: 0, easyApply: 0, deferred: 0, voyager: 'off',
    voyagerCalls: 0, reused: 0, repostsCollapsed: 0, expired: 0,
    fatal: null, fatalDetail: '',
  };

  if (linkedinSearches.length === 0) {
    log('no enabled linkedin_searches in portals.yml');
    return { newUrls: [], stats };
  }

  const cookiesPresent = hasVoyagerCookies();
  stats.voyager = cookiesPresent ? 'on' : 'off';
  log(cookiesPresent
    ? 'Voyager cookies present — resolving employer ATS URLs at scan time'
    : 'no Voyager cookies — storing LinkedIn URLs; ATS resolution deferred to apply-time');

  // Dedup pools (scan-history.db is the authoritative index).
  const skipIds = new Set(linkedInSkipIds(db));
  const seenCanonical = new Set(loadSeenUrls(db, { applicationsPath }));
  log(`skipId pool: ${skipIds.size} ids; seen URL pool: ${seenCanonical.size}`);

  // 1. JobSpy discovery + JD.
  const jobspySearches = linkedinSearches.map(searchEntryToJobSpy)
    .filter(s => s.search_term);
  if (jobspySearches.length === 0) {
    log('no linkedin_searches yielded a search_term');
    return { newUrls: [], stats };
  }
  const { jobs, fatal, fatalDetail } = await runJobSpy(jobspySearches, log);
  if (fatal) {
    stats.fatal = fatal;
    stats.fatalDetail = fatalDetail;
    log(`FATAL: ${fatal} — ${fatalDetail}`);
    return { newUrls: [], stats };
  }

  // Dedup by LinkedIn job id within this run.
  const byId = new Map();
  for (const job of jobs) {
    if (job?.id && !byId.has(job.id)) byId.set(job.id, job);
  }
  stats.idsReturned = byId.size;
  log(`JobSpy unique ids: ${byId.size}`);

  // 2. skipId (server-side-equivalent dedup), ban, title filter.
  const today = new Date().toISOString().slice(0, 10);
  const survivors = [];
  for (const job of byId.values()) {
    const linkedinUrl = `https://www.linkedin.com/jobs/view/${job.id}`;
    if (skipIds.has(String(job.id)) || seenCanonical.has(linkedinUrl)) {
      continue; // already in the authoritative index
    }
    if (isBanned({ company: job.company, url: linkedinUrl })) {
      stats.banned++;
      if (!dryRun) {
        recordOffer(db, {
          url: linkedinUrl, firstSeen: today, portal: 'linkedin-jobspy',
          title: job.title, company: job.company, status: 'banned',
        });
      }
      continue;
    }
    if (!passesTitleFilter(job.title, titleFilter)) {
      stats.skipped++;
      if (!dryRun) {
        recordOffer(db, {
          url: linkedinUrl, firstSeen: today, portal: 'linkedin-jobspy',
          title: job.title, company: job.company, status: 'skipped_title',
        });
      }
      continue;
    }
    survivors.push(job);
  }
  stats.afterTitleFilter = survivors.length;
  log(`after skipId/ban/title filter: ${survivors.length}`);
  if (survivors.length === 0) return { newUrls: [], stats };

  // 3. Optional ATS resolution (serial, paced; stop on auth-expired).
  // LinkedIn reposts one role across many ids/locations — all sharing
  // company+title and resolving to the same ATS URL. Resolve Voyager ONCE
  // per normalized company|title and reuse it for the reposts: no redundant
  // authed/ToS-sensitive calls, no per-repost pacing delay. Each individual
  // id is still recordFetch'd below so id-level dedup stays complete.
  // Tradeoff: a genuine same-company+title-but-different-role collision would
  // reuse the wrong canonical for the 2nd posting — rare; the canonical-dedup
  // and per-id recording keep state correct either way.
  const fetchedDate = today;
  const newUrls = [];
  let voyagerDead = !cookiesPresent;
  const resolvedCache = new Map(); // company|title → definitive resolution
  const seenRoleKeys = new Set();  // company|title already emitted with a
                                   // bare LinkedIn canonical (no distinct ATS
                                   // URL to dedup on) — collapses Easy-Apply /
                                   // deferred same-role reposts to one row.

  for (const job of survivors) {
    const linkedinUrl = `https://www.linkedin.com/jobs/view/${job.id}`;
    const roleKey = `${slugify(job.company)}|${slugify(job.title)}`;
    let resolution = null;

    if (cookiesPresent && !voyagerDead) {
      if (resolvedCache.has(roleKey)) {
        resolution = resolvedCache.get(roleKey);
        stats.reused++;
      } else {
        resolution = await resolveAts(job.id, { log });
        stats.voyagerCalls++;
        if (resolution.kind === 'auth-expired') {
          log(`Voyager auth-expired (HTTP ${resolution.status}) — re-grab LINKEDIN_LI_AT + LINKEDIN_JSESSIONID. Deferring remaining ATS resolution to apply-time.`);
          voyagerDead = true;
          stats.fatalDetail = stats.fatalDetail || 'voyager-auth-expired';
          resolution = null;
        } else if (resolution.expired
          || resolution.kind === 'offsite' || resolution.kind === 'easy-apply') {
          resolvedCache.set(roleKey, resolution); // reuse for same-role reposts
        }
        await sleep(VOYAGER_DELAY_MS);
      }
    }

    // Expired/closed posting (Voyager says jobState≠LISTED / closedAt /
    // past expireAt). Skip entirely — no dead JD/row/dispatch — but record
    // skipped_expired so the id stays in the dedup index.
    if (resolution?.expired) {
      stats.expired++;
      log(`skip expired/closed: ${linkedinUrl} (${job.company} | ${job.title})`);
      if (!dryRun) {
        recordOffer(db, {
          url: linkedinUrl, firstSeen: today, portal: 'linkedin-jobspy',
          title: job.title, company: job.company, status: 'skipped_expired',
        });
      }
      continue;
    }

    // Per-job outcome (covers cached, fresh, and no-cookie/deferred).
    if (resolution?.kind === 'offsite') stats.resolved++;
    else if (resolution?.kind === 'easy-apply') stats.easyApply++;
    else stats.deferred++;

    // Canonical URL: the resolved offsite ATS URL (already cleaned by
    // li-voyager.pickAts → cleanAtsUrl: tracking params/apply suffixes
    // stripped, identity params kept); otherwise the LinkedIn URL
    // (Easy-Apply, no cookies, or unresolved).
    const canonical = resolution?.kind === 'offsite' && resolution.atsUrl
      ? resolution.atsUrl
      : linkedinUrl;

    // Easy-Apply / deferred / no-cookie reposts each keep their OWN distinct
    // jobs/view/{id} URL, so seenCanonical (URL-keyed) can't collapse the
    // same role posted under N ids. Collapse them by company|title here:
    // first wins, the rest are recorded for id-dedup but produce no new
    // JD/row/dispatch. Offsite reposts already collapse via the shared ATS
    // URL below, so this gate is scoped to the bare-LinkedIn-canonical case.
    if (canonical === linkedinUrl) {
      if (seenRoleKeys.has(roleKey)) {
        log(`skip same-role LinkedIn repost: ${roleKey} (id ${job.id})`);
        stats.repostsCollapsed = (stats.repostsCollapsed ?? 0) + 1;
        if (!dryRun) {
          recordFetch(db, {
            canonicalUrl: linkedinUrl, linkedInId: job.id, portal: 'linkedin-jobspy',
            title: job.title, company: job.company, firstSeen: fetchedDate,
          });
        }
        continue;
      }
      seenRoleKeys.add(roleKey);
    }

    if (seenCanonical.has(canonical)) {
      log(`skip duplicate canonical: ${canonical} (id ${job.id})`);
      if (!dryRun) {
        recordFetch(db, {
          canonicalUrl: canonical, linkedInId: job.id, portal: 'linkedin-jobspy',
          title: job.title, company: job.company, firstSeen: fetchedDate,
        });
      }
      continue;
    }
    seenCanonical.add(canonical);

    if (dryRun) {
      newUrls.push(canonical);
      stats.prefetched++;
      continue;
    }

    let num;
    try {
      num = nextNum();
    } catch (err) {
      log(`nextNum() failed: ${err.message}`);
      continue;
    }
    const company = job.company?.trim() || 'Unknown Company';
    const role = job.title?.trim() || 'Unknown Role';
    const slug = `${slugify(company)}-${slugify(role)}`;
    const jdPath = resolve(jdsDir, `${num}-${slug}.md`);
    try {
      writeFileSync(jdPath, buildJobSpyJd({ canonicalUrl: canonical, fetchedDate, job, resolution }));
      appendApplicationRow({ applicationsPath, num, fetchedDate, company, role });
      recordFetch(db, {
        canonicalUrl: canonical, linkedInId: job.id, portal: 'linkedin-jobspy',
        title: role, company, firstSeen: fetchedDate,
      });
      newUrls.push(canonical);
      stats.prefetched++;
      log(`+ NUM ${num} ${company} | ${role} → ${canonical}`);
    } catch (err) {
      log(`failed to write NUM ${num} (${company} / ${role}): ${err.message}`);
    } finally {
      releaseNum(num);
    }
  }

  return { newUrls, stats };
}
