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
// Apify handles LinkedIn-side rate-limiting via managed proxies (no cookies,
// no manual pacing). Account-level parallel cap is 2 simultaneous runs.
//
// Auth: APIFY_API_TOKEN in process env (sourced from .env).
//
// No LLM calls anywhere in this file.

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { nextNum, releaseNum } from './next-num.mjs';

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

function appendApplicationRow({ applicationsPath, num, fetchedDate, company, role }) {
  const row = `| ${num} | ${fetchedDate} | ${company} | ${role} |  | Fetched | ❌ |  |  |\n`;
  appendFileSync(applicationsPath, row);
}

// ── scan-history insert ──────────────────────────────────────────────

function recordInScanHistory({ db, linkedinUrl, fetchedDate, company, title }) {
  db.prepare(
    `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
     VALUES (?, ?, 'linkedin-apify', ?, ?, 'added')`,
  ).run(linkedinUrl, fetchedDate, title, company);
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
 *   stats: { searches: number, idsReturned: number, afterTitleFilter: number, prefetched: number, skipped: number }
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
  const stats = { searches: linkedinSearches.length, idsReturned: 0, afterTitleFilter: 0, prefetched: 0, skipped: 0 };

  if (linkedinSearches.length === 0) {
    log('no enabled linkedin_searches in portals.yml');
    return { newUrls: [], stats };
  }
  if (!token) {
    log('APIFY_API_TOKEN missing — skipping LinkedIn level');
    return { newUrls: [], stats };
  }

  // skipJobId from history: every LinkedIn URL we've ever recorded.
  const skipRows = db
    .prepare(`SELECT url FROM offers WHERE url LIKE 'https://www.linkedin.com/jobs/view/%'`)
    .all();
  const skipJobId = skipRows
    .map(r => {
      const m = r.url.match(/jobs\/view\/(\d+)/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  log(`skipJobId pool: ${skipJobId.length} ids from scan-history`);

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

  // 2. Title filter (in-process — cheap).
  const survivors = [...byId.values()].filter(item => {
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
      return [];
    }
  });
  const details = detailBatchResults.flat();
  log(`apimaestro returned ${details.length} detailed records`);

  // 4. Write JDs.
  const fetchedDate = new Date().toISOString().slice(0, 10);
  const newUrls = [];
  // Multiple LinkedIn IDs sometimes resolve to the same employer ATS URL
  // (same role posted multiple times). Track canonical URLs already emitted
  // in this run AND already present in jds/ via grep, to skip duplicates.
  const seenCanonical = new Set();

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
