// scan-linkedin.mjs — zero-token LinkedIn discovery + per-JD detail fetch
//
// Called from scan.mjs Level 2. Does the entire LinkedIn flow in one pass:
//   1. Read portals.yml linkedin_searches → build valig payloads
//   2. Read scan-history.db → skipJobId list (server-side dedup, saves credits)
//   3. POST valig (concurrency 2) → list of new LinkedIn job IDs
//   4. Apply title_filter from portals.yml
//   5. POST apimaestro (concurrency 2, batched) → full JD detail per ID
//   6. For each detail: reserve NUM, write jds/{NUM}-{slug}.md with the canonical
//      employer ATS URL (from apply_details.application_url), insert Fetched row
//      into applications.md, insert linkedin URL into scan-history.db
//   7. Return list of canonical URLs for inclusion in DISPATCH_URLS
//
// Auth: APIFY_API_TOKEN in process env (sourced from .env).
//
// No LLM calls anywhere in this file.
//
// ── LinkedIn filter-code reference (f_* URL params ↔ valig payload) ───
// Migrating a linkedin_searches `url:` to a structured `payload:` block uses
// FILTER_PARAM_MAP below; both forms work. Code meanings:
//   datePosted      r3600=1h  r86400=24h  r604800=7d (default)  r2592000=30d
//   contractType    F=Full-time P=Part-time C=Contract T=Temporary
//                   V=Volunteer I=Internship O=Other            (CSV)
//   experienceLevel 1=Internship 2=Entry 3=Associate 4=Mid-Senior
//                   5=Director 6=Executive                      (CSV)
//   remote          1=On-site 2=Remote 3=Hybrid                 (CSV)
//   urlParam        [{key,value}] passthrough for any f_* not modeled above
//
// ── Apify rate-limiting rationale ────────────────────────────────────
// Both actors use Apify managed proxies (residential + datacenter rotation,
// no cookies). Apify handles LinkedIn-side throttling internally — we do NOT
// pace calls. valig 30-day stats: 33,862 ok / 33 aborts (~99.7%). The only
// constraint we enforce is the account-level 2-concurrent-run cap
// (APIFY_PARALLEL_CAP, via the pLimit limiter). The legacy "3–5s between
// navigations" rule was for authenticated CDP scraping and does not apply.
//
// ── Credit / cost math ───────────────────────────────────────────────
// Apify bills per actor run. Rough costs:
//   valig (search)         ~$0.001 per result (a 50-job sweep = pennies)
//   apimaestro (per JD)    ~$0.005 per job, once per dispatched LinkedIn id
// skipJobId is the single biggest saver — server-side dedup against
// scan-history; valig is NEVER called without it. apimaestro is batched
// ~50 ids/call (DETAIL_BATCH_SIZE) to amortize cold-start. To economize:
// narrow datePosted (e.g. r86400 for daily scans) or drop secondary searches.
//
// ── Insufficient-credit contract (deterministic) ─────────────────────
// On a valig/apimaestro failure that looks like a quota/balance signal
// (HTTP 402, "insufficient-balance", "usage-hard-limit") OR an ambiguous
// auth-ish 401/403, we make ONE balance probe: GET /v2/users/me. If that
// confirms exhaustion (or the actor error was a definitive 402), we DO NOT
// throw — instead runLinkedInScan returns `stats.fatal =
// 'apify-insufficient-credits'` (+ `stats.fatalDetail`). scan.mjs turns
// that into a `SCAN_FATAL=apify-insufficient-credits` stdout line printed
// BEFORE any DISPATCH_URLS=. Levels 1/2b/3 still run; only LinkedIn is
// degraded. Transient errors (timeouts, 5xx, network) keep the old
// behavior: logged, that search yields nothing, no fatal marker.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { nextNum, releaseNum } from './next-num.mjs';
import { linkedInSkipIds, loadSeenUrls, recordOffer } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';

const APIFY_BASE = 'https://api.apify.com/v2/acts';
const VALIG_ACTOR = 'valig~linkedin-jobs-scraper';
const DETAIL_ACTOR = 'apimaestro~linkedin-job-detail';
const APIFY_PARALLEL_CAP = 2;
const DETAIL_BATCH_SIZE = 50; // IDs per apimaestro call

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

// ── LinkedIn URL → valig payload ─────────────────────────────────────

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

// ── Apify HTTP wrappers ──────────────────────────────────────────────

async function apifyPost(actor, body, token) {
  const url = `${APIFY_BASE}/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify ${actor} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function valigSearch({ payload, skipJobId, limit }, token) {
  const body = { ...payload, skipJobId, limit: limit ?? payload.limit ?? 50 };
  return apifyPost(VALIG_ACTOR, body, token);
}

async function detailFetch(jobIds, token) {
  if (jobIds.length === 0) return [];
  return apifyPost(DETAIL_ACTOR, { job_id: jobIds.map(String) }, token);
}

// ── Apify credit / fatal diagnosis ───────────────────────────────────
// apifyPost throws `Apify <actor> → HTTP <status>: <body>`. Classify the
// caught error text without re-issuing the failing actor call.

// Definitive: the actor itself reported a payment/usage-limit condition.
function isApifyQuotaError(err) {
  const m = String(err?.message ?? '');
  return /HTTP 402\b/.test(m)
    || /insufficient[- ]?balance/i.test(m)
    || /(monthly[- ]?)?usage[- ]?hard[- ]?limit/i.test(m)
    || /payment required/i.test(m)
    || /quota[^.]*exceed/i.test(m);
}

// Ambiguous: 401/403 can be a bad token OR a usage-limited account lockout.
// Worth one balance probe to disambiguate.
function isAmbiguousApifyError(err) {
  return /HTTP 40[13]\b/.test(String(err?.message ?? ''));
}

// One GET /v2/users/me. Returns { exhausted:boolean, detail:string }.
// Conservative: anything inconclusive → not exhausted (treated as transient,
// preserving prior behavior — we never false-positive a fatal).
async function apifyBalanceProbe(token, log) {
  try {
    const res = await fetch(
      `https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`,
    );
    if (res.status === 402) return { exhausted: true, detail: 'users/me → HTTP 402' };
    if (!res.ok) return { exhausted: false, detail: `users/me inconclusive (HTTP ${res.status})` };
    const body = await res.json().catch(() => ({}));
    const plan = body?.data?.plan ?? {};
    const max = Number(
      plan.maxMonthlyUsageUsd ?? plan.monthlyUsageCreditsUsd ?? NaN,
    );
    const used = Number(
      body?.data?.currentBillingPeriod?.usageUsd
        ?? body?.data?.monthlyUsage?.usageTotalUsd
        ?? NaN,
    );
    if (Number.isFinite(max) && max > 0 && Number.isFinite(used) && used >= max) {
      return { exhausted: true, detail: `used $${used} of $${max} monthly` };
    }
    return {
      exhausted: false,
      detail: Number.isFinite(used) && Number.isFinite(max)
        ? `active (used $${used} of $${max})`
        : 'active (usage figures unavailable)',
    };
  } catch (err) {
    return { exhausted: false, detail: `balance probe threw: ${err.message}` };
  }
}

/**
 * Decide whether collected Apify errors mean the account is out of credits.
 * @param {Error[]} apifyErrors
 * @returns {Promise<{fatal:boolean, detail:string}>}
 */
async function diagnoseApifyFatal(apifyErrors, token, log) {
  if (apifyErrors.length === 0) return { fatal: false, detail: '' };
  const definitive = apifyErrors.some(isApifyQuotaError);
  const ambiguous = !definitive && apifyErrors.some(isAmbiguousApifyError);
  if (!definitive && !ambiguous) return { fatal: false, detail: '' }; // transient
  log(definitive
    ? 'Apify reported a payment/usage-limit error — confirming via balance probe'
    : 'Apify auth-ish error — probing balance to disambiguate');
  const probe = await apifyBalanceProbe(token, log);
  log(`balance probe: ${probe.detail}`);
  // A definitive actor 402 is authoritative even if the probe is inconclusive.
  if (definitive || probe.exhausted) {
    return { fatal: true, detail: probe.detail };
  }
  return { fatal: false, detail: '' };
}

// ── Title filter ─────────────────────────────────────────────────────

export function passesTitleFilter(title, titleFilter) {
  if (!titleFilter) return true;
  const lower = (title ?? '').toLowerCase();
  const positive = (titleFilter.positive ?? []).map(s => s.toLowerCase());
  const negative = (titleFilter.negative ?? []).map(s => s.toLowerCase());
  if (positive.length > 0 && !positive.some(k => lower.includes(k))) return false;
  if (negative.some(k => lower.includes(k))) return false;
  return true;
}

// ── URL canonicalization ─────────────────────────────────────────────

export function canonicalizeUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  u.search = '';                       // strip query string
  u.hash = '';                         // strip fragment
  let path = u.pathname.replace(/\/+$/, ''); // trim trailing slash
  path = path.replace(/\/application\/*$/, ''); // strip Ashby /application suffix
  return `${u.protocol}//${u.host}${path}`;
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

// ── JD writer ────────────────────────────────────────────────────────

function workplaceToScope(workplaceTypes) {
  const v = new Set((workplaceTypes ?? []).map(s => String(s).toUpperCase()));
  if (v.has('REMOTE')) return 'full-remote-region:unspecified';
  if (v.has('HYBRID')) return 'hybrid:unspecified';
  if (v.has('ONSITE')) return 'onsite:unspecified';
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
  lines.push(`**Fetch-method:** apify-linkedin`);
  lines.push(`**Posting age:** ${postingAgeStr(j.listed_at)}`);
  lines.push(`**Status:** ${status}`);
  lines.push('');
  lines.push(`**Location:** ${j.location ?? 'unspecified'}`);
  lines.push(`**Remote scope:** ${workplaceToScope(j.workplace_types)}`);
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
  lines.push((j.description ?? '').trim() || '_No description returned by the Apify actor._');
  lines.push('');
  if (c.description) {
    lines.push('## About the Company');
    lines.push('');
    lines.push(c.description.trim());
    lines.push('');
  }
  return lines.join('\n');
}

// ── applications.md row ──────────────────────────────────────────────

// Pipe in free-text cells corrupts the markdown table (parser splits on it).
function sanitizeCell(s) {
  return String(s ?? '').replace(/\|/g, '/');
}

function appendApplicationRow({ applicationsPath, num, fetchedDate, company, role }) {
  const row = `| ${num} | ${fetchedDate} | ${sanitizeCell(company)} | ${sanitizeCell(role)} |  | Fetched | ❌ |  |  |\n`;
  appendFileSync(applicationsPath, row);
}

// ── scan-history insert ──────────────────────────────────────────────

function recordInScanHistory({ db, linkedinUrl, fetchedDate, company, title }) {
  recordOffer(db, {
    url: linkedinUrl, firstSeen: fetchedDate,
    portal: 'linkedin-apify', title, company,
  });
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {Database} args.db                   — better-sqlite3 handle for scan-history
 * @param {object}   args.portalsCfg           — parsed portals.yml
 * @param {string}   args.applicationsPath     — path to data/applications.md
 * @param {string}   args.jdsDir               — path to jds/
 * @param {string}   args.token                — Apify token
 * @param {boolean}  [args.dryRun]             — if true, no files written, no DB writes
 * @param {(s:string)=>void} [args.log]        — logger (default console.error)
 *
 * @returns {Promise<{
 *   newUrls: string[],
 *   stats: { searches: number, idsReturned: number, afterTitleFilter: number, prefetched: number, skipped: number,
 *            fatal: ('apify-insufficient-credits'|null), fatalDetail: string }
 * }>}
 */
export async function runLinkedInScan({
  db,
  portalsCfg,
  applicationsPath,
  jdsDir,
  token,
  dryRun = false,
  log = (...args) => console.error('[linkedin]', ...args),
}) {
  const linkedinSearches = (portalsCfg.linkedin_searches ?? []).filter(e => e.enabled !== false);
  const titleFilter = portalsCfg.title_filter ?? null;
  const stats = { searches: linkedinSearches.length, idsReturned: 0, afterTitleFilter: 0, prefetched: 0, skipped: 0, banned: 0, fatal: null, fatalDetail: '' };
  const apifyErrors = [];

  if (linkedinSearches.length === 0) {
    log('no enabled linkedin_searches in portals.yml');
    return { newUrls: [], stats };
  }
  if (!token) {
    log('APIFY_API_TOKEN missing — skipping LinkedIn level');
    return { newUrls: [], stats };
  }

  // Dedup pools — a single authoritative query each. scan-history.db is the
  // complete index now that every writer (scan.mjs / scan-linkedin.mjs /
  // scan-remoteineurope.mjs / fetch-jd.mjs) records through lib/scan-history.mjs,
  // so no JD-corpus filesystem walk is needed: skipJobId covers ATS-first
  // roles too (the 434/536 fix is enforced at the source, in fetch-jd.mjs).
  const skipJobId = linkedInSkipIds(db);
  const priorCanonicals = loadSeenUrls(db, { applicationsPath });
  log(`skipJobId pool: ${skipJobId.length} ids; seenCanonical seeded with ${priorCanonicals.size} prior URLs (DB authoritative)`);

  // 1. valig — parallel, capped at 2 concurrent.
  const searchResults = await pLimit(APIFY_PARALLEL_CAP, linkedinSearches, async (entry) => {
    const payload = searchEntryToPayload(entry);
    log(`valig "${entry.name}" — title="${payload.title?.slice(0, 60) ?? '?'}" location="${payload.location ?? '?'}"`);
    try {
      const items = await valigSearch({ payload, skipJobId }, token);
      log(`valig "${entry.name}" → ${items.length} items`);
      return items;
    } catch (err) {
      log(`valig "${entry.name}" FAILED: ${err.message}`);
      apifyErrors.push(err);
      return [];
    }
  });

  // Flatten + dedup by id.
  const byId = new Map();
  for (const arr of searchResults) {
    for (const item of arr) {
      const id = String(item.id ?? '');
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, item);
    }
  }
  stats.idsReturned = byId.size;
  log(`valig total unique ids: ${byId.size}`);

  // Credit gate after the search stage: if the account is exhausted there's
  // no point spending an apimaestro call that will also 402. Bail with a
  // fatal signal; scan.mjs still runs the other levels.
  {
    const diag = await diagnoseApifyFatal(apifyErrors, token, log);
    if (diag.fatal) {
      stats.fatal = 'apify-insufficient-credits';
      stats.fatalDetail = diag.detail;
      log(`FATAL: Apify credits exhausted (${diag.detail}) — skipping LinkedIn level`);
      return { newUrls: [], stats };
    }
  }

  // 2. Title filter (in-process — cheap).
  const survivors = [...byId.values()].filter(item => {
    // Ban check BEFORE the apimaestro detail fetch — the per-job Apify
    // credit cost. A banned company never costs a detail call.
    if (isBanned({ company: item.companyName, url: `https://www.linkedin.com/jobs/view/${item.id}` })) {
      stats.banned++;
      if (!dryRun) {
        recordOffer(db, {
          url: `https://www.linkedin.com/jobs/view/${item.id}`,
          firstSeen: new Date().toISOString().slice(0, 10),
          portal: 'linkedin-apify', title: item.title, company: item.companyName,
          status: 'banned',
        });
      }
      return false;
    }
    if (passesTitleFilter(item.title, titleFilter)) return true;
    stats.skipped++;
    if (!dryRun) {
      db.prepare(
        `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
         VALUES (?, ?, 'linkedin-apify', ?, ?, 'skipped_title')`,
      ).run(`https://www.linkedin.com/jobs/view/${item.id}`, new Date().toISOString().slice(0, 10), item.title, item.companyName);
    }
    return false;
  });
  stats.afterTitleFilter = survivors.length;
  log(`after title filter: ${survivors.length}`);

  if (survivors.length === 0) {
    return { newUrls: [], stats };
  }

  // 3. apimaestro — batched.
  const survivorIds = survivors.map(s => String(s.id));
  const batches = [];
  for (let i = 0; i < survivorIds.length; i += DETAIL_BATCH_SIZE) {
    batches.push(survivorIds.slice(i, i + DETAIL_BATCH_SIZE));
  }
  const detailBatchResults = await pLimit(APIFY_PARALLEL_CAP, batches, async (batch, idx) => {
    log(`apimaestro batch ${idx + 1}/${batches.length} (${batch.length} ids)`);
    try {
      return await detailFetch(batch, token);
    } catch (err) {
      log(`apimaestro batch ${idx + 1} FAILED: ${err.message}`);
      apifyErrors.push(err);
      return [];
    }
  });
  const details = detailBatchResults.flat();
  log(`apimaestro returned ${details.length} detailed records`);

  // Credit gate after the detail stage: valig may have come back from cache
  // (skipJobId) while apimaestro hit the wall. Still surface it as fatal.
  if (details.length === 0) {
    const diag = await diagnoseApifyFatal(apifyErrors, token, log);
    if (diag.fatal) {
      stats.fatal = 'apify-insufficient-credits';
      stats.fatalDetail = diag.detail;
      log(`FATAL: Apify credits exhausted (${diag.detail}) — no JD details fetched`);
      return { newUrls: [], stats };
    }
  }

  // 4. Write JDs.
  const fetchedDate = new Date().toISOString().slice(0, 10);
  const newUrls = [];
  // Multiple LinkedIn IDs sometimes resolve to the same employer ATS URL
  // (same role posted multiple times). Track canonical URLs already emitted
  // in this run AND already present in jds/ via grep, to skip duplicates.
  const seenCanonical = new Set(priorCanonicals);

  for (const detail of details) {
    const j = detail.job_info ?? {};
    const c = detail.company_info ?? {};
    const a = detail.apply_details ?? {};
    const company = c.name?.trim() || 'Unknown Company';
    const role = j.title?.trim() || 'Unknown Role';
    const jobId = String(j.job_posting_id ?? '');
    const linkedinUrl = jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : null;
    const canonical = canonicalizeUrl(a.application_url) || canonicalizeUrl(linkedinUrl);
    if (!canonical) {
      log(`skip detail with no resolvable URL (company="${company}" role="${role}")`);
      continue;
    }
    if (seenCanonical.has(canonical)) {
      log(`skip duplicate canonical URL: ${canonical} (LinkedIn id ${jobId})`);
      // Still record the LinkedIn URL in scan-history so future scans skip it
      // server-side via skipJobId — even though we don't write a new JD for it.
      if (!dryRun && linkedinUrl) {
        recordInScanHistory({ db, linkedinUrl, fetchedDate, company, title: role });
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

    const slug = `${slugify(company)}-${slugify(role)}`;
    const jdPath = resolve(jdsDir, `${num}-${slug}.md`);
    const jdContent = buildJdMarkdown({ canonicalUrl: canonical, fetchedDate, detail });

    try {
      writeFileSync(jdPath, jdContent);
      appendApplicationRow({ applicationsPath, num, fetchedDate, company, role });
      if (linkedinUrl) recordInScanHistory({ db, linkedinUrl, fetchedDate, company, title: role });
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
