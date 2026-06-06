// li-voyager.mjs — authenticated LinkedIn job resolver (free, ~0 token).
//
// LinkedIn gates the offsite apply URL (and, when logged out, the full JD)
// behind authentication. Four unauthenticated tools (JobSpy, browser-use
// cloud CDP, ever-jobs, Bright Data) were tested and cannot cross it; only
// the authenticated Voyager REST endpoint or paid Apify can. This module is
// the free path. Two consumers:
//   • lib/scan-linkedin.mjs (scan/discovery) — uses resolveAts() OPTIONALLY:
//     no cookies ⇒ store the LinkedIn URL, defer ATS resolution to apply-time.
//   • lib/fetch-jd.mjs (per-pasted-URL) — uses fetchJobPosting()+parseJobPosting()
//     to get JD text + ATS URL. A pasted LinkedIn URL has no free JD source
//     without auth, so there cookies are REQUIRED (the handler errors with an
//     actionable message otherwise).
// See memory/reference_linkedin_ats_resolution.md.
//
// Auth (env, from gitignored .env — never committed, never passed to a
// subagent prompt):
//   LINKEDIN_LI_AT       the li_at cookie value
//   LINKEDIN_JSESSIONID  the JSESSIONID value INCLUDING the "ajax:" prefix
//
// The csrf-token header must equal the JSESSIONID value (with ajax:, no
// quotes). Endpoint shape is reverse-engineered and LinkedIn-ToS-violating —
// run at modest volume, serially, against an account whose risk you accept.
// 401/403 ⇒ cookie expired: re-grab BOTH cookies.

const VOYAGER = 'https://www.linkedin.com/voyager/api/jobs/jobPostings';
const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const OFFSITE = 'com.linkedin.voyager.jobs.OffsiteApply';
const ONSITE = 'com.linkedin.voyager.jobs.ComplexOnsiteApply';

const WORKPLACE = {
  'urn:li:fs_workplaceType:1': 'ONSITE',
  'urn:li:fs_workplaceType:2': 'REMOTE',
  'urn:li:fs_workplaceType:3': 'HYBRID',
};

/** True when both cookies are present in the environment. */
export function hasVoyagerCookies(env = process.env) {
  return Boolean(env.LINKEDIN_LI_AT && env.LINKEDIN_JSESSIONID);
}

/**
 * Some companyApplyUrl values are tracking-redirect wrappers around the real
 * ATS URL. Unwrap the well-known ones so the pipeline stores canonical
 * employer URLs, not tracker links. Idempotent; unknown shapes pass through.
 *   - recruitics:  jsv3.recruitics.com/redirect?...&rx_url=<encoded ATS>
 *   - linkedin:    .../externalApply?...&url=<encoded ATS>
 */
export function unwrapApplyUrl(raw) {
  if (!raw) return raw;
  let url = String(raw);
  for (let i = 0; i < 3; i++) {
    let u;
    try { u = new URL(url); } catch { return url; }
    const host = u.hostname.toLowerCase();
    let inner = null;
    if (host.includes('recruitics.com')) inner = u.searchParams.get('rx_url');
    else if (host.includes('linkedin.com') && /externalApply/i.test(u.pathname)) {
      inner = u.searchParams.get('url');
    }
    if (!inner) return url;
    try { inner = decodeURIComponent(inner); } catch { /* already decoded */ }
    url = inner;
  }
  return url;
}

// Definite tracking/analytics query keys to drop. Identity keys that locate
// the posting (gh_jid, ashby_jid, folderId, jobId, opportunityId, …) are
// NOT listed → kept by default, so a blanket strip never breaks an ATS URL.
const TRACKING_PARAMS = new Set([
  'source', 'src', 'ref', 'referrer', 'gh_src', 'gns', 'iis', 'iisn',
  'jobsite', '_l', 'hl', 'codes', 'domain', 'microsite', 'jobshare',
  '__jvst', '__jvsd', 's', 'sourcetype', 'trk',
]);
// Apply-form path suffixes — the posting page (without them) is the canonical
// URL the agent navigates to apply from.
const APPLY_SUFFIX = /\/(?:application|apply|applications\/new|c\/new)\/*$/i;

/**
 * Normalize a resolved employer ATS URL: unwrap tracking redirects, drop
 * tracking query params (utm_*, lever-*, source, src, …) while KEEPING
 * identity params, and strip apply-form path suffixes. Not the generic
 * lossy canonicalizeUrl (which nukes the whole query, breaking
 * ?folderId=/?gh_jid= postings). Idempotent.
 */
export function cleanAtsUrl(raw) {
  let unwrapped = unwrapApplyUrl(raw);
  if (!unwrapped) return unwrapped;
  // LinkedIn/Voyager sometimes emits HTML-entity-encoded ampersands
  // (…?source=x&amp;utm_source=y, or %26amp%3B), so query keys arrive as
  // `amp;utm_source`. Normalize before parsing.
  unwrapped = String(unwrapped).replace(/&amp;|&amp%3B/gi, '&');
  let u;
  try { u = new URL(unwrapped); } catch { return unwrapped; }
  for (const k of [...u.searchParams.keys()]) {
    const lk = k.toLowerCase().replace(/^amp;/, '');
    if (TRACKING_PARAMS.has(lk) || /^(?:utm_|lever-)/i.test(lk)) {
      u.searchParams.delete(k);
    }
  }
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '').replace(APPLY_SUFFIX, '');
  const qs = u.searchParams.toString();
  return `${u.protocol}//${u.host}${path || '/'}${qs ? `?${qs}` : ''}`;
}

/**
 * Classify a Voyager `.applyMethod` object. Offsite URLs come back cleaned
 * (tracking stripped, identity kept) so dedup collapses utm-only variants.
 * @returns {{kind:'offsite'|'easy-apply'|'unknown', atsUrl:string|null, detail?:string}}
 */
export function pickAts(applyMethod = {}) {
  if (applyMethod?.[OFFSITE]?.companyApplyUrl) {
    return { kind: 'offsite', atsUrl: cleanAtsUrl(applyMethod[OFFSITE].companyApplyUrl) };
  }
  if (applyMethod?.[ONSITE] !== undefined) {
    return { kind: 'easy-apply', atsUrl: null };
  }
  return {
    kind: 'unknown', atsUrl: null,
    detail: `applyMethod keys: ${Object.keys(applyMethod || {}).join(',') || 'none'}`,
  };
}

/**
 * GET the raw Voyager jobPostings record for one job id.
 * @returns {Promise<{kind:'ok'|'auth-expired'|'error', status:number|null, data:object|null, detail?:string}>}
 */
export async function fetchJobPosting(jobId, { liAt, jsessionid, log = () => {} } = {}) {
  liAt = liAt ?? process.env.LINKEDIN_LI_AT;
  jsessionid = jsessionid ?? process.env.LINKEDIN_JSESSIONID;
  if (!liAt || !jsessionid) {
    return { kind: 'error', status: null, data: null, detail: 'no cookies' };
  }
  const id = String(jobId).replace(/\D/g, '');
  if (!id) return { kind: 'error', status: null, data: null, detail: 'bad id' };

  let res;
  try {
    res = await fetch(`${VOYAGER}/${id}`, {
      headers: {
        'csrf-token': jsessionid,
        'x-restli-protocol-version': '2.0.0',
        accept: 'application/json',
        'user-agent': UA,
        cookie: `li_at=${liAt}; JSESSIONID="${jsessionid}"`,
      },
    });
  } catch (err) {
    log(`voyager ${id} fetch threw: ${err.message}`);
    return { kind: 'error', status: null, data: null, detail: err.message };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: 'auth-expired', status: res.status, data: null };
  }
  if (!res.ok) return { kind: 'error', status: res.status, data: null };
  try {
    return { kind: 'ok', status: res.status, data: await res.json() };
  } catch {
    return { kind: 'error', status: res.status, data: null, detail: 'non-JSON' };
  }
}

/** Normalize a raw Voyager jobPostings record into the fields we use. */
export function parseJobPosting(data = {}) {
  const wp = (data.workplaceTypes ?? [])
    .map(u => WORKPLACE[u])
    .filter(Boolean);
  return {
    title: data.title ?? null,
    descriptionText: data.description?.text ?? '',
    location: data.formattedLocation ?? null,
    listedAt: data.listedAt ?? null,
    expireAt: data.expireAt ?? null,
    jobState: data.jobState ?? null,
    closedAt: data.closedAt ?? null,
    workplaceTypes: wp,
    companyDescription: data.companyDescription ?? null,
    applies: data.applies ?? null,
    applyMethod: data.applyMethod ?? {},
  };
}

/**
 * Best-effort employer name from the UNAUTHENTICATED guest job fragment
 * (the authed Voyager record only carries a company urn, not the name).
 * Stable HTML, no auth, free. Returns null if it can't be found.
 */
export async function fetchGuestCompanyName(jobId, { log = () => {} } = {}) {
  const id = String(jobId).replace(/\D/g, '');
  if (!id) return null;
  let html;
  try {
    const res = await fetch(`${GUEST}/${id}`, { headers: { 'user-agent': UA } });
    if (!res.ok) return null;
    html = await res.text();
  } catch (err) {
    log(`guest company-name ${id} threw: ${err.message}`);
    return null;
  }
  const pats = [
    /class="topcard__org-name-link[^"]*"[^>]*>\s*([^<]+?)\s*</,
    /class="topcard__flavor"[^>]*>\s*([^<]+?)\s*</,
    /<meta[^>]+og:title[^>]+content="([^"]+?) hiring /i,
  ];
  for (const re of pats) {
    const m = html.match(re);
    if (m && m[1]) {
      const name = m[1].replace(/&amp;/g, '&').trim();
      if (name) return name;
    }
  }
  return null;
}

/**
 * A posting is dead when LinkedIn no longer lists it: jobState other than
 * LISTED (CLOSED/SUSPENDED/DELISTED…), a set closedAt, or a past expireAt.
 * Voyager still returns HTTP 200 + full data for these, and applyMethod can
 * still be ComplexOnsiteApply — so without this check a CLOSED job would be
 * written as an active Easy-Apply and dispatched. Takes a parseJobPosting()
 * result (or raw data).
 */
export function isJobExpired(p = {}) {
  if (p.jobState && p.jobState !== 'LISTED') return true;
  if (p.closedAt) return true;
  if (p.expireAt && Number(p.expireAt) < Date.now()) return true;
  return false;
}

/**
 * Resolve one LinkedIn job id to its employer ATS URL (scan-path API).
 *
 * @returns {Promise<{
 *   kind:'offsite'|'easy-apply'|'unknown'|'auth-expired'|'error',
 *   atsUrl:string|null, status:number|null, expired:boolean, detail?:string }>}
 *   expired=true      → posting is CLOSED/expired; caller should skip it
 *                       (no JD/row/dispatch), recording skipped_expired.
 *   'offsite'         → atsUrl is the (cleaned) employer ATS URL.
 *   'easy-apply'      → on-platform Easy Apply, no ATS URL exists.
 *   'auth-expired'    → 401/403: re-grab both cookies; stop Voyager this run.
 *   'error'/'unknown' → transient/unparseable; fall back to the LinkedIn URL.
 */
export async function resolveAts(jobId, opts = {}) {
  const r = await fetchJobPosting(jobId, opts);
  if (r.kind === 'auth-expired') {
    return { kind: 'auth-expired', atsUrl: null, status: r.status, expired: false };
  }
  if (r.kind !== 'ok' || !r.data) {
    return { kind: 'error', atsUrl: null, status: r.status, expired: false, detail: r.detail };
  }
  const parsed = parseJobPosting(r.data);
  const a = pickAts(r.data.applyMethod);
  return {
    ...a,
    status: r.status,
    expired: isJobExpired(parsed),
    workplaceTypes: parsed.workplaceTypes,
    formattedLocation: parsed.location,
  };
}
