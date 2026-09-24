#!/usr/bin/env node

/**
 * fetch-jd.mjs — Deterministic, zero-token JD fetcher.
 *
 * Turns a single job URL into a numbered file under data/jds/ + a Fetched
 * row in data/applications.md, with no Claude API tokens. It is the
 * fast path for modes/_fetch.md: the LLM agent only takes over when this
 * helper returns `unknown-host` or `error`.
 *
 * Resolution order for a URL:
 *   1. Dedup — URL already in data/jds/ or linked to a NUM in scan-history.db
 *      (report headers, deleted JDs)? emit {status:"exists",num,appStatus}
 *   2. Learned registry (lib/ats-registry.json, committed) — host → handler
 *   3. Built-in provider matchers (lever/greenhouse/ashby/teamtailor/
 *      personio/workday/rippling/linkedin)
 *   4. No match → {status:"unknown-host"} so the agent can resolve it
 *      and teach the registry via `--learn`.
 *
 * Usage:
 *   node lib/fetch-jd.mjs <url>
 *   node lib/fetch-jd.mjs <url> --dry-run
 *   node lib/fetch-jd.mjs --learn <hostOrPattern> <handler> [--params '{"org":"acme"}'] [--regex] [--note "..."]
 *   node lib/fetch-jd.mjs --list
 *
 * stdout: exactly one JSON line (the result). Logs go to stderr.
 * Statuses: ok | exists | expired | unknown-host | error
 */

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync,
} from 'fs';
import { resolve, join } from 'path';
import { execFileSync } from 'child_process';
import { isIP } from 'net';
import { pathToFileURL } from 'url';
import { nextNum, releaseNum } from './next-num.mjs';
import { canonicalizeUrl, buildJdMarkdown } from './scan-linkedin.mjs';
import { openScanHistoryDb, recordFetch, knownNums } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';
import { APPLICATIONS_FILE, JDS_DIR } from './paths.mjs';
import {
  hasVoyagerCookies, fetchJobPosting, parseJobPosting, pickAts,
  fetchGuestCompanyName, isJobExpired,
} from './li-voyager.mjs';

const APPLICATIONS_PATH = APPLICATIONS_FILE;
// Committed shared wisdom — lives in lib/ (not data/, not gitignored) so
// learned host→handler mappings travel with the repo for the next person.
const REGISTRY_PATH = 'lib/ats-registry.json';
const FETCH_TIMEOUT_MS = 15_000;
const TODAY = new Date().toISOString().slice(0, 10);

const log = (...a) => console.error('[fetch-jd]', ...a);

// ── .env (LINKEDIN_LI_AT / LINKEDIN_JSESSIONID for the LinkedIn handler;
//     FIRECRAWL_API_KEY for the SPA fallback) ──────────────────────────

function loadDotenv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k]) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}
loadDotenv();

// ── Small utilities ──────────────────────────────────────────────────

function slugify(s, max = 50) {
  return String(s ?? '')
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, max) || 'x';
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#x27': "'", '#x2F': '/', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…',
};
function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

// HTML → readable markdown-ish text. Good enough for scoring, not a
// general converter: lists → "- ", headings → "## ", <br>/<p> → newline.
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // Some ATSes (Greenhouse) return entity-encoded HTML (`&lt;div&gt;`).
  // Decode only entity-encoded *tags*, never the whole document: a blanket
  // decode also turns prose like `&lt;5% churn` into a bare `<`, which the
  // tag-stripper below then eats along with everything up to the next `>`.
  // Anchoring on `&lt;` + `/`-or-letter keeps `&lt;5%` out of the match.
  s = s.replace(/&lt;\/?[a-zA-Z][\s\S]*?&gt;/g, decodeEntities);
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*li[^>]*>/gi, '\n- ');
  s = s.replace(/<\s*\/\s*li\s*>/gi, '');
  s = s.replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol)\s*\/?>/gi, '\n');
  s = s.replace(/<\s*(h[1-6])[^>]*>/gi, '\n\n## ');
  s = s.replace(/<\s*p[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ── SSRF guard ───────────────────────────────────────────────────────
// Some handlers (teamtailor/rippling/xh) fetch a raw JD URL and Node's fetch
// auto-follows redirects, so a public JD host could 30x-redirect to an
// internal target (169.254.169.254, [::1], metadata.google.internal, …).
// fetchText is the single choke point for every outbound fetch, so validating
// each hop here covers all handlers. Node's URL parser already normalizes
// numeric/hex IPv4 (http://2130706433 → 127.0.0.1), so we classify the literal
// it yields.
const MAX_REDIRECTS = 5;

function ipv4IsPrivate(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||                            // 0.0.0.0/8 (incl. 0.0.0.0)
    a === 10 ||                           // 10/8 private
    a === 127 ||                          // loopback
    (a === 169 && b === 254) ||           // link-local (169.254.169.254 metadata)
    (a === 172 && b >= 16 && b <= 31) ||  // 172.16/12 private
    (a === 192 && b === 168) ||           // 192.168/16 private
    (a === 100 && b >= 64 && b <= 127)    // 100.64/10 CGNAT
  );
}

// Expand an IPv6 literal (incl. `::` compression and an embedded IPv4 tail) to
// its 16 bytes, or null if malformed.
function ipv6Bytes(ip) {
  let s = ip;
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const q = v4[1].split('.').map(Number);
    if (q.every(n => n >= 0 && n <= 255)) {
      s = s.slice(0, v4.index) +
        ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
    }
  }
  let parts;
  if (s.includes('::')) {
    const [h, t = ''] = s.split('::');
    const head = h ? h.split(':') : [];
    const tail = t ? t.split(':') : [];
    parts = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    parts = s.split(':');
  }
  if (parts.length !== 8) return null;
  const bytes = [];
  for (const part of parts) {
    const n = parseInt(part || '0', 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function ipv6IsPrivate(ip) {
  const b = ipv6Bytes(ip);
  if (!b) return true;                                                // unparseable → unsafe
  if (b.every(x => x === 0)) return true;                             // ::  unspecified
  if (b.slice(0, 15).every(x => x === 0) && b[15] === 1) return true; // ::1 loopback
  if (b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return ipv4IsPrivate(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);      // ::ffff:v4 mapped
  }
  if ((b[0] & 0xfe) === 0xfc) return true;                            // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;           // fe80::/10 link-local
  return false;
}

// Throw if `rawUrl` targets a non-public host. A single trailing dot (FQDN
// root) and IPv6 brackets are stripped first so `169.254.169.254.` and `[::1]`
// can't slip past.
function assertPublicTarget(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error(`SSRF guard: invalid URL ${rawUrl}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`SSRF guard: blocked non-http(s) scheme ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const kind = isIP(host);
  if (kind === 4 && ipv4IsPrivate(host)) throw new Error(`SSRF guard: blocked private IPv4 ${host}`);
  if (kind === 6 && ipv6IsPrivate(host)) throw new Error(`SSRF guard: blocked private IPv6 ${host}`);
  if (kind === 0 &&
      (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))) {
    throw new Error(`SSRF guard: blocked internal host ${host}`);
  }
}

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // Manual redirect following: validate every hop so a public host can't
    // bounce us into the internal network.
    let current = url;
    for (let hop = 0; ; hop++) {
      assertPublicTarget(current);
      const res = await fetch(current, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (career-ops fetch-jd)', ...opts.headers },
        ...opts,
        redirect: 'manual',
      });
      const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
      if (loc) {
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${url}`);
        current = new URL(loc, current).href;
        continue;
      }
      const body = await res.text();
      return { ok: res.ok, status: res.status, body, finalUrl: res.url || current };
    }
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return JSON.parse(r.body);
}

function workplaceToScope(s) {
  const v = String(s ?? '').toLowerCase();
  if (v.includes('remote')) return 'full-remote-global';
  if (v.includes('hybrid')) return 'hybrid:unspecified';
  if (v.includes('on-site') || v.includes('onsite')) return 'onsite:unspecified';
  return 'unspecified';
}
function postingAge(iso) {
  if (!iso) return 'unspecified';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unspecified';
  const d = Math.max(0, Math.round((Date.now() - t) / 86_400_000));
  return d === 0 ? 'today' : `${d} days ago`;
}

// ── Normalized JD → markdown (modes/_fetch.md Step 4 schema) ─────────

function buildGenericJd(n) {
  const L = [];
  L.push(`# ${n.company || 'Unknown'} — ${n.role || 'Unknown role'}`, '');
  L.push(`**URL:** ${n.canonicalUrl}`);
  if (n.sourceUrl) L.push(`**Source:** ${n.sourceUrl}`);
  L.push(`**Fetched:** ${TODAY}`);
  L.push(`**Fetch-method:** ${n.fetchMethod}`);
  L.push(`**Posting age:** ${n.postingAge || 'unspecified'}`);
  L.push(`**Status:** ${n.jdStatus || 'active'}`, '');
  L.push(`**Location:** ${n.location || 'unspecified'}`);
  L.push(`**Remote scope:** ${n.remoteScope || 'unspecified'}`);
  L.push(`**Timezone:** unspecified`);
  L.push(`**Visa/authorization:** unspecified`);
  L.push(`**Relocation offered:** unspecified`, '');
  L.push('## Role Summary', '', (n.summary || '').trim() || '_Not provided._', '');
  if (n.responsibilities?.length) {
    L.push('## Responsibilities', '', ...n.responsibilities.map(x => `- ${x}`), '');
  }
  if (n.requirements?.length) {
    L.push('## Requirements', '', ...n.requirements.map(x => `- ${x}`), '');
  }
  if (n.niceToHave?.length) {
    L.push('## Nice to Have', '', ...n.niceToHave.map(x => `- ${x}`), '');
  }
  if (n.other) L.push('## Other Details', '', n.other.trim(), '');
  return L.join('\n');
}

// Per-posting id shapes shared by extract() across handlers.
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function numericId(u) {
  const m = u.match(/\/jobs?\/(\d+)/) || u.match(/(\d{5,})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

// Split an html-derived block into bullet lines (drop empties).
function bullets(text) {
  return htmlToText(text).split('\n')
    .map(s => s.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}

// InnerHtml of the first `<div class="{cls}">...` block, respecting nested
// <div> tags (a plain regex can't, since the content itself may contain
// divs). Shared by the wysiwygDiv registry handler — custom-CMS career pages
// that render the JD body as a rich-text field under a fixed class name
// (e.g. getencube.com's Next.js site uses class="wysiwyg").
function extractDivByClass(html, cls) {
  const open = new RegExp(`<div[^>]*class="${cls}"[^>]*>`);
  const m = open.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  const tagRe = /<(\/?)div\b[^>]*>/g;
  tagRe.lastIndex = start;
  let t;
  while ((t = tagRe.exec(html))) {
    depth += t[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}

// schema.org JobPosting embedded as <script type="application/ld+json">.
// Scans every ld+json block (a page often has several — Organization,
// BreadcrumbList, JobPosting) and unwraps an @graph, returning the first
// JobPosting found. Shared by the teamtailor handler and the generic `xh`
// (JSON-LD) registry handler. Returns null when the page carries none.
function extractJsonLdJobPosting(html) {
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const list = Array.isArray(data) ? data
      : Array.isArray(data['@graph']) ? data['@graph'] : [data];
    const jp = list.find(x => x && x['@type'] === 'JobPosting');
    if (jp) return jp;
  }
  return null;
}

// schema.org JobPosting → normalized JD (the shape buildGenericJd consumes).
function normalizeJsonLd(jp, fetchMethod = 'xh') {
  // Some ATS vendors (iCIMS, Oracle Taleo-style career sites) emit the
  // literal string "UNAVAILABLE" for empty required schema.org fields
  // instead of omitting them — filter it out like any other blank.
  const str = v => {
    const s = v && typeof v === 'object' ? (v.name || '') : (v || '');
    return s.toUpperCase?.() === 'UNAVAILABLE' ? '' : s;
  };
  const addr = jp.jobLocation?.address || jp.jobLocation?.[0]?.address;
  const location = addr
    ? [str(addr.addressLocality), str(addr.addressRegion), str(addr.addressCountry)]
      .filter(Boolean).join(', ')
    : '';
  return {
    company: str(jp.hiringOrganization?.name) || 'Unknown',
    role: jp.title || 'Unknown role',
    fetchMethod,
    jdStatus: 'active',
    postingAge: postingAge(jp.datePosted),
    location: location || 'unspecified',
    // schema.org uses "TELECOMMUTE" for remote roles.
    remoteScope: jp.jobLocationType === 'TELECOMMUTE'
      ? 'full-remote-global'
      : workplaceToScope(jp.jobLocationType || ''),
    summary: htmlToText(jp.description),
    other: jp.employmentType
      ? `Employment type: ${[].concat(jp.employmentType).join(', ')}`
      : '',
  };
}

// ── Provider handlers ────────────────────────────────────────────────
// Each: {
//   match(url)   → params|null   strict, host-anchored — built-in auto-detect
//   extract(url) → partial params (optional) — host-agnostic; pulls just
//                  the per-posting id from the path. Used on registry hits
//                  so a custom-domain mapping (careers.acme.com → greenhouse
//                  @ org acme) can still find the job id. The org/tenant
//                  slug comes from the registry entry's `params`.
//   fetch(params,url) → normalized JD
// }

const handlers = {
  lever: {
    match(u) {
      const m = u.match(/jobs\.lever\.co\/([^/?#]+)\/([^/?#]+)/);
      return m ? { org: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(UUID_RE);
      return m ? { id: m[1] } : {};
    },
    async fetch({ org, id }) {
      const j = await fetchJson(`https://api.lever.co/v0/postings/${org}/${id}`);
      const lists = j.lists || [];
      const pick = re => lists.find(l => re.test(l.text || ''));
      const resp = pick(/responsib|what you/i);
      const reqs = pick(/require|qualif|you have|looking for/i);
      return {
        company: org,
        role: j.text || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: 'active',
        postingAge: postingAge(j.createdAt),
        location: j.categories?.location || 'unspecified',
        remoteScope: workplaceToScope(j.workplaceType || j.categories?.location),
        summary: htmlToText(j.description || j.descriptionPlain),
        responsibilities: resp ? bullets(resp.content) : [],
        requirements: reqs ? bullets(reqs.content) : [],
        other: j.categories?.commitment ? `Commitment: ${j.categories.commitment}` : '',
      };
    },
  },

  greenhouse: {
    match(u) {
      const m = u.match(/(?:job-boards(?:\.eu)?|boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
      return m ? { org: m[1], id: m[2] } : null;
    },
    extract(u) {
      const id = numericId(u);
      return id ? { id } : {};
    },
    async fetch({ org, id }) {
      let j;
      try {
        j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${id}`);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) {
          return { expired: true, company: org, role: `job ${id}` };
        }
        throw e;
      }
      return {
        company: org,
        role: j.title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: 'active',
        postingAge: postingAge(j.updated_at),
        location: j.location?.name || j.offices?.[0]?.name || 'unspecified',
        remoteScope: workplaceToScope(j.location?.name),
        summary: htmlToText(j.content),
      };
    },
  },

  ashby: {
    match(u) {
      const m = u.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{16,})/i);
      return m ? { org: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(UUID_RE);
      return m ? { id: m[1] } : {};
    },
    async fetch({ org, id }) {
      const j = await fetchJson(
        `https://api.ashbyhq.com/posting-api/job-board/${org}`,
      );
      const post = (j.jobs || []).find(p => p.id === id || p.jobId === id);
      if (!post) return { expired: true, company: org, role: `job ${id}` };
      return {
        company: org,
        role: post.title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: post.isListed === false ? 'expired' : 'active',
        postingAge: postingAge(post.publishedAt),
        location: post.location || 'unspecified',
        remoteScope: workplaceToScope(post.workplaceType || post.location),
        summary: htmlToText(post.descriptionHtml || post.description),
        other: post.employmentType ? `Employment type: ${post.employmentType}` : '',
      };
    },
  },

  teamtailor: {
    match(u) {
      const m = u.match(/https?:\/\/([^/.]+)\.teamtailor\.com\/jobs\/([^/?#]+)/);
      return m ? { tenant: m[1], slug: m[2] } : null;
    },
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const jp = extractJsonLdJobPosting(r.body);
      if (!jp) throw new Error('no JSON-LD JobPosting on teamtailor page');
      return normalizeJsonLd(jp);
    },
  },

  // join.com (French/German multi-tenant job board, Next.js). JSON-LD gives
  // company/role/description but not workplace type or listing status;
  // the page's own __NEXT_DATA__ (props.pageProps.initialState.job) carries
  // both plus a structured city/region/country, so use it to enrich.
  join: {
    match(u) {
      const m = u.match(/^https?:\/\/(?:www\.)?join\.com\/companies\/([^/?#]+)\/(\d+)-/);
      return m ? { company: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(/\/(\d+)-[^/?#]*/);
      return m ? { id: m[1] } : {};
    },
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const jp = extractJsonLdJobPosting(r.body);
      if (!jp) throw new Error('no JSON-LD JobPosting on join.com page');
      const n = normalizeJsonLd(jp, 'xh (join.com JSON-LD)');
      try {
        const nd = r.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        const job = nd && JSON.parse(nd[1])?.props?.pageProps?.initialState?.job;
        if (job) {
          const city = job.city || {};
          const place = city.cityName || 'unspecified';
          n.location = [city.cityName, city.regionName, city.countryName]
            .filter(Boolean).join(', ') || n.location;
          n.remoteScope = job.workplaceType === 'REMOTE' ? 'full-remote-global'
            : job.workplaceType === 'HYBRID' ? `hybrid:${place}`
            : job.workplaceType === 'ONSITE' ? `onsite:${place}`
            : n.remoteScope;
          if (job.status && job.status !== 'ONLINE') n.jdStatus = 'expired';
          if (job.employmentType?.name) n.other = `Employment type: ${job.employmentType.name}`;
        }
      } catch { /* JSON-LD fields already populated; __NEXT_DATA__ is best-effort enrichment */ }
      return n;
    },
  },

  personio: {
    match(u) {
      const m = u.match(/https?:\/\/([^/.]+)\.jobs\.personio\.(?:de|com)\/job\/(\d+)/);
      return m ? { tenant: m[1], id: m[2] } : null;
    },
    extract(u) {
      const id = numericId(u);
      return id ? { id } : {};
    },
    async fetch({ tenant, id }) {
      const r = await fetchText(`https://${tenant}.jobs.personio.de/xml`);
      if (!r.ok) throw new Error(`HTTP ${r.status} on personio xml`);
      const positions = r.body.split(/<position>/i).slice(1);
      const block = positions.find(p => new RegExp(`<id>\\s*${id}\\s*</id>`).test(p));
      if (!block) return { expired: true, company: tenant, role: `job ${id}` };
      const tag = (name) => {
        const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
        return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : '';
      };
      const descs = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/gi)]
        .map(d => {
          const name = (d[1].match(/<name>([\s\S]*?)<\/name>/i) || [])[1] || '';
          const val = (d[1].match(/<value>([\s\S]*?)<\/value>/i) || [])[1] || '';
          return `### ${decodeEntities(name).replace(/<!\[CDATA\[|\]\]>/g, '').trim()}\n\n${htmlToText(val.replace(/<!\[CDATA\[|\]\]>/g, ''))}`;
        }).join('\n\n');
      return {
        company: tenant,
        role: tag('name') || 'Unknown role',
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location: tag('office') || 'unspecified',
        remoteScope: workplaceToScope(tag('office')),
        summary: descs || tag('description'),
        other: [tag('recruitingCategory'), tag('seniority'), tag('employmentType'),
          tag('schedule')].filter(Boolean).join(' · '),
      };
    },
  },

  workday: {
    match(u) {
      const host = u.match(/https?:\/\/([^/.]+)\.(wd\d+)\.myworkdayjobs\.com\//i);
      if (!host) return null;
      // The locale segment (en-US) is optional and NOT positionally
      // distinguishable from the site (External) by a simple optional
      // group — with /i a greedy `[a-z-]+` eats the site. Anchor on
      // `/job/` instead: site is the segment immediately before it,
      // jobPath everything after. Works with or without a locale.
      const seg = u.match(/myworkdayjobs\.com\/(?:[^/]+\/)*?([^/]+)\/job\/(.+?)(?:[?#]|$)/i);
      if (!seg) return null;
      return {
        tenant: host[1], wd: host[2],
        site: seg[1], jobPath: seg[2].replace(/\/+$/, ''), url: u,
      };
    },
    async fetch(p) {
      // Workday hosts a public CXS REST endpoint mirroring the browser URL.
      const jobPath = (p.jobPath
        || (p.url.match(/\/job\/(.+?)(?:[?#]|$)/) || [])[1] || ''
      ).replace(/\/+$/, '');
      const cxs = `https://${p.tenant}.${p.wd}.myworkdayjobs.com/wday/cxs/${p.tenant}/${p.site}/job/${jobPath}`;
      const j = await fetchJson(cxs);
      const info = j.jobPostingInfo || {};
      return {
        company: j.hiringOrganization?.name || p.tenant,
        role: info.title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: info.canApply === false ? 'expired' : 'active',
        postingAge: postingAge(info.startDate),
        location: [info.location, ...(info.additionalLocations || [])]
          .filter(Boolean).join(' | ') || 'unspecified',
        remoteScope: workplaceToScope(info.remoteType || info.location),
        summary: htmlToText(info.jobDescription),
        other: info.timeType ? `Time type: ${info.timeType}` : '',
      };
    },
  },

  rippling: {
    match(u) {
      const m = u.match(/ats\.rippling\.com\/([^/?#]+)\/jobs\/([^/?#]+)/);
      return m ? { tenant: m[1], uuid: m[2] } : null;
    },
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on rippling`);
      const m = r.body.match(
        /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
      );
      if (!m) throw new Error('no __NEXT_DATA__ on rippling page');
      const api = JSON.parse(m[1]).props?.pageProps?.apiData || {};
      const jp = api.jobPost || {};
      const locs = (api.workLocations || []).map(w => (typeof w === 'string' ? w : w?.label))
        .filter(Boolean);
      return {
        company: jp.companyName || api.jobBoard?.name || 'Unknown',
        role: jp.name || 'Unknown role',
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: postingAge(jp.createdOn),
        location: locs.join(' | ') || 'unspecified',
        remoteScope: workplaceToScope(locs.join(' ')),
        summary: htmlToText(jp.description?.role),
        other: jp.description?.company ? htmlToText(jp.description.company) : '',
      };
    },
  },

  recruitee: {
    match(u) {
      const m = u.match(/https?:\/\/([^/.]+)\.recruitee\.com\/o\/([^/?#]+)/i);
      return m ? { tenant: m[1], slug: m[2] } : null;
    },
    extract(u) {
      const m = u.match(/\/o\/([^/?#]+)/);
      return m ? { slug: m[1] } : {};
    },
    async fetch(p, url) {
      // tenant comes from the recruitee.com host, or the registry entry's
      // params for a custom careers domain. The public offers API is keyed
      // by the same slug that sits in the /o/{slug} path.
      const tenant = p.tenant || new URL(url).host.split('.')[0];
      const j = await fetchJson(`https://${tenant}.recruitee.com/api/offers/${p.slug}`);
      const o = j.offer;
      if (!o) return { expired: true, company: tenant, role: `offer ${p.slug}` };
      return {
        company: o.company_name || tenant,
        role: o.title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: o.status && o.status !== 'published' ? 'expired' : 'active',
        postingAge: postingAge(o.created_at),
        location: o.location || [o.city, o.country].filter(Boolean).join(', ') || 'unspecified',
        remoteScope: o.remote ? 'full-remote-global' : 'unspecified',
        summary: htmlToText(o.description),
        other: [o.department, o.employment_type_code].filter(Boolean).join(' · '),
      };
    },
  },

  pinpoint: {
    // Pinpoint ATS (pinpointhq.com). Every tenant subdomain exposes a free,
    // unauthenticated postings.json listing carrying the full JD body plus
    // workplace_type_text — the hybrid/onsite signal the location gate needs.
    // The page's own embedded JSON-LD omits workplace type, so postings.json
    // is the primary source; the page is only consulted for the company
    // name (hiringOrganization.name), which postings.json doesn't carry.
    match(u) {
      const m = u.match(/https?:\/\/([^/.]+)\.pinpointhq\.com\/(?:[a-z]{2}\/)?postings\/([0-9a-f-]{36})/i);
      return m ? { tenant: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(UUID_RE);
      return m ? { id: m[1] } : {};
    },
    async fetch(p, url) {
      const tenant = p.tenant || new URL(url).host.split('.')[0];
      const j = await fetchJson(`https://${tenant}.pinpointhq.com/postings.json`);
      const post = (j.data || []).find(x => (x.url || x.path || '').includes(p.id));
      if (!post) return { expired: true, company: tenant, role: `posting ${p.id}` };
      const loc = post.location || {};
      const locationStr = [loc.city, loc.province].filter(Boolean).join(', ') || 'unspecified';
      const wt = (post.workplace_type_text || '').toLowerCase();
      const remoteScope = wt.includes('remote')
        ? 'full-remote-global'
        : wt.includes('hybrid') ? `hybrid:${loc.city || 'unspecified'}`
        : (wt.includes('on-site') || wt.includes('onsite')) ? `onsite:${loc.city || 'unspecified'}`
        : 'unspecified';
      let company = tenant;
      try {
        const page = await fetchText(url);
        const jp = page.ok ? extractJsonLdJobPosting(page.body) : null;
        if (jp?.hiringOrganization?.name) company = jp.hiringOrganization.name;
      } catch { /* tenant slug fallback is fine */ }
      const summary = [
        htmlToText(post.description),
        post.key_responsibilities
          ? `### ${post.key_responsibilities_header || 'Key Responsibilities'}\n\n${htmlToText(post.key_responsibilities)}`
          : '',
        post.skills_knowledge_expertise
          ? `### ${post.skills_knowledge_expertise_header || 'Skills, Knowledge and Expertise'}\n\n${htmlToText(post.skills_knowledge_expertise)}`
          : '',
      ].filter(Boolean).join('\n\n');
      return {
        company,
        role: post.title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: post.deadline_at && new Date(post.deadline_at) < new Date() ? 'expired' : 'active',
        postingAge: 'unspecified',
        location: locationStr,
        remoteScope,
        summary,
        other: [
          post.reporting_to ? `Reports to: ${post.reporting_to}` : '',
          post.employment_type_text,
          post.job?.department?.name,
        ].filter(Boolean).join(' · '),
      };
    },
  },

  // JazzHR (formerly TheResumator) public job boards — {tenant}.applytojob.com.
  // Server-rendered HTML, no JS needed: no public JSON/XML feed and no
  // JobPosting JSON-LD (only an Organization block, used for company name).
  // The whole-page template is fixed across every tenant: title in the single
  // page <h2>, Location/Type/Experience chips in `.job-attributes-container`
  // (each `<div title="...">`), and the full JD body in one
  // `id="job-description"` div — customer rich text, so no nested <div>s to
  // worry about when isolating it from the sibling apply-form markup.
  jazzhr: {
    match(u) {
      const m = u.match(/https?:\/\/([^/.]+)\.applytojob\.com\/apply\/([^/?#]+)/i);
      return m ? { tenant: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(/\/apply\/([^/?#]+)/i);
      return m ? { id: m[1] } : {};
    },
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const html = r.body;

      const role = decodeEntities((html.match(/<h2>([^<]*)<\/h2>/i) || [])[1] || '').trim()
        || 'Unknown role';
      const orgM = html.match(/"@type":\s*"Organization"[^}]*"name":\s*"([^"]+)"/);
      const company = orgM ? decodeEntities(orgM[1]).trim() : 'Unknown';

      const attrs = {};
      const attrRe = /<div[^>]*title="(Location|Type|Experience)"[^>]*>\s*<i[^>]*><\/i>([\s\S]*?)<\/div>/gi;
      let am;
      while ((am = attrRe.exec(html))) {
        attrs[am[1]] = decodeEntities(am[2]).replace(/\s+/g, ' ').trim();
      }

      const descM = html.match(/id=["']job-description["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=["'][^"']*resumator-mobile-apply-wrapper/i);
      if (!descM) throw new Error(`no job-description block at ${url}`);

      const location = attrs.Location || 'unspecified';
      return {
        company,
        role,
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location,
        remoteScope: /remote/i.test(location) ? 'full-remote-global' : 'unspecified',
        summary: htmlToText(descM[1]),
        other: [attrs.Type, attrs.Experience].filter(Boolean).join(' · '),
      };
    },
  },

  linkedin: {
    match(u) {
      const byPath = u.match(/linkedin\.com\/jobs\/view\/(\d+)/);
      if (byPath) return { id: byPath[1] };
      const byQuery = u.match(/[?&]currentJobId=(\d+)/);
      return byQuery ? { id: byQuery[1] } : null;
    },
    async fetch({ id }) {
      // A pasted LinkedIn URL has no free JD source without auth (the four
      // unauthenticated tools we tested return no JD/ATS). Cookies are
      // required here; the scan path degrades gracefully, this one cannot.
      if (!hasVoyagerCookies()) {
        throw new Error(
          'LinkedIn needs LINKEDIN_LI_AT + LINKEDIN_JSESSIONID in .env ' +
          '(free authenticated Voyager). Set them, or paste the employer ' +
          'ATS URL (Greenhouse/Lever/Ashby/…) directly instead.',
        );
      }
      const r = await fetchJobPosting(id, { log });
      if (r.kind === 'auth-expired') {
        throw new Error(
          `LinkedIn cookies expired (HTTP ${r.status}) — re-grab ` +
          'LINKEDIN_LI_AT + LINKEDIN_JSESSIONID in .env (both).',
        );
      }
      if (r.kind !== 'ok' || !r.data) {
        throw new Error(
          `Voyager jobPostings/${id} failed` +
          `${r.status ? ` (HTTP ${r.status})` : ''}${r.detail ? `: ${r.detail}` : ''}`,
        );
      }
      const p = parseJobPosting(r.data);
      const ats = pickAts(p.applyMethod);
      const linkedinUrl = `https://www.linkedin.com/jobs/view/${id}`;
      // Resolved offsite ATS URL is already cleaned by li-voyager.pickAts
      // (cleanAtsUrl: tracking/apply-suffix stripped, identity params like
      // folderId/gh_jid kept). Easy-apply / unresolved ⇒ the LinkedIn URL
      // is canonical (URL-dedup still works).
      const canonical = ats.kind === 'offsite' && ats.atsUrl ? ats.atsUrl : linkedinUrl;
      const company = (await fetchGuestCompanyName(id, { log })) || 'Unknown Company';
      const role = p.title?.trim() || 'Unknown Role';
      // Re-shape into the LinkedIn detail shape buildJdMarkdown expects so the
      // JD format is identical to before (writer lives in scan-linkedin.mjs).
      const detail = {
        job_info: {
          title: role,
          location: p.location,
          listed_at: p.listedAt ? new Date(p.listedAt).toISOString() : null,
          expire_at: p.expireAt ? new Date(p.expireAt).toISOString() : null,
          job_state: p.jobState,
          description: p.descriptionText,
          workplace_types: p.workplaceTypes,
          job_posting_id: String(id),
          job_url: linkedinUrl,
        },
        company_info: { name: company, description: p.companyDescription },
        apply_details: {
          is_easy_apply: ats.kind === 'easy-apply',
          application_url: ats.kind === 'offsite' ? ats.atsUrl : null,
          total_applies: p.applies ?? undefined,
        },
      };
      // CLOSED/expired postings: Voyager still 200s with full data. Flag it
      // so fetch-jd marks the JD expired (Status: expired, emits 'expired')
      // instead of saving a dead role as active.
      return {
        _linkedinDetail: detail, canonicalUrl: canonical, company, role,
        expired: isJobExpired(p),
      };
    },
  },

  // Generic JSON-LD JobPosting extractor — registry-only (match() never
  // auto-fires). Most custom career domains and ATSes that embed a schema.org
  // JobPosting on the posting page (Workable /view, Jobvite, Breezy, …) resolve
  // through this. Throws on API-only pages so the agent falls back to
  // modes/_fetch.md and can teach a proper platform handler instead.
  xh: {
    match: () => null,
    // registry params.headers (optional) overrides the default UA/Accept —
    // some Akamai-fronted career sites (e.g. careers.se.com) bot-block the
    // default browser-style UA but allow an API-client-looking one.
    async fetch(p, url) {
      const r = await fetchText(url, p?.headers ? { headers: p.headers } : undefined);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const jp = extractJsonLdJobPosting(r.body);
      if (!jp) throw new Error(`no JSON-LD JobPosting at ${url}`);
      return normalizeJsonLd(jp);
    },
  },

  // Custom-CMS single-company career pages with no ATS API and no JSON-LD,
  // whose SSR'd HTML still renders the full JD as a rich-text field under a
  // fixed class name (registry `params.divClass`, default "wysiwyg" — seen
  // on getencube.com's Next.js site). Registry-only, one host per employer.
  // Company comes from registry params (falls back to the bare hostname);
  // role from <title>.
  wysiwygDiv: {
    match: () => null,
    async fetch(p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const div = extractDivByClass(r.body, p.divClass || 'wysiwyg');
      if (!div) throw new Error(`no .${p.divClass || 'wysiwyg'} content block at ${url}`);
      const locM = div.match(/<strong>\s*Location:?\s*<\/strong>\s*([^<]+)/i);
      const empM = div.match(/<strong>\s*Employment type:?\s*<\/strong>\s*([^<]+)/i);
      const titleM = r.body.match(/<title>([^<]*)<\/title>/i);
      // <title> is often a CTA sentence ("We are looking for a Product
      // Manager"), not a role name — strip the boilerplate lead-in.
      const role = titleM
        ? decodeEntities(titleM[1]).trim().replace(/^we(?:'re| are)\s+(looking for|hiring)\s+an?\s+/i, '')
        : 'Unknown role';
      return {
        company: p.company || new URL(url).host.replace(/^www\./, '').split('.')[0],
        role,
        fetchMethod: 'xh (wysiwyg div)',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location: locM ? decodeEntities(locM[1]).trim() : 'unspecified',
        remoteScope: 'unspecified',
        summary: htmlToText(div),
        other: empM ? `Employment type: ${decodeEntities(empM[1]).trim()}` : '',
      };
    },
  },

  // Breezy HR — single-tenant career portals ({tenant}.breezy.hr/p/{id}-{slug}).
  // Registry-only: one host per employer, no shared parent domain to
  // auto-fire on. Some tenants embed a full schema.org JobPosting (reuse the
  // xh extractor); others (e.g. yallaplay) serve none — the AngularJS portal
  // template still renders the JD body as plain static HTML server-side
  // (only the chrome strings like button labels stay as untranslated
  // %POLYGLOT_TOKEN% placeholders, since those need client-side JS to
  // resolve). Pull title/company/location straight from the page's
  // twitter:data1/data2 meta tags (Location/Company — present on every
  // Breezy tenant) and the `.description` div for the JD body. remoteScope
  // stays 'unspecified' — Breezy's own remote badge is coarse (e.g.
  // "Remote — Any") and can conflict with more specific prose (see
  // modes/_fetch.md "Prose wins"), so leave the nuanced call to the
  // location gate reading the body text.
  breezy: {
    match: () => null,
    extract(u) {
      const m = u.match(/\/p\/([0-9a-f]+)/i);
      return m ? { id: m[1] } : {};
    },
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const jp = extractJsonLdJobPosting(r.body);
      if (jp) return normalizeJsonLd(jp, 'ats-api (breezy JSON-LD)');
      const html = r.body;
      const title = (html.match(/<div class="banner"><h1>([^<]+)<\/h1>/) || [])[1];
      const company = (html.match(/<meta name="twitter:data2" content="([^"]*)"/) || [])[1];
      const location = (html.match(/<meta name="twitter:data1" content="([^"]*)"/) || [])[1];
      const descM = html.match(/<div class="description">([\s\S]*?)<\/div>\s*<div class="apply-container"/);
      if (!descM) throw new Error(`no JobPosting JSON-LD and no .description block at ${url}`);
      return {
        company: company ? decodeEntities(company) : 'Unknown',
        role: title ? decodeEntities(title) : 'Unknown role',
        fetchMethod: 'xh (breezy HTML)',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location: location ? decodeEntities(location) : 'unspecified',
        remoteScope: 'unspecified',
        summary: htmlToText(descM[1]),
      };
    },
  },

  // Jobgether — remote-jobs aggregator. Each `/offer/{id}-{slug}` page embeds
  // a full schema.org JobPosting (reuse xh's extractor) AND, separately, the
  // resolved employer ATS apply link in a `<body data-offer="{...}">` JSON
  // attribute — that's the piece the JobPosting JSON-LD itself never carries.
  // The default fetch-jd UA gets a 403 here; a realistic browser UA doesn't.
  jobgether: {
    match(u) {
      const m = u.match(/jobgether\.com\/offer\/([0-9a-f]{24})-/i);
      return m ? { id: m[1] } : null;
    },
    async fetch(_p, url) {
      const r = await fetchText(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const jp = extractJsonLdJobPosting(r.body);
      if (!jp) throw new Error(`no JSON-LD JobPosting at ${url}`);
      const n = normalizeJsonLd(jp, 'jobgether');
      const offerM = r.body.match(/data-offer="([^"]*)"/);
      let applyUrl = null;
      if (offerM) {
        try { applyUrl = JSON.parse(decodeEntities(offerM[1])).applyUrl || null; } catch { /* keep null */ }
      }
      if (applyUrl) {
        // Strip Jobgether's own tracking params, keep the rest of the ATS URL.
        const au = new URL(applyUrl);
        for (const k of [...au.searchParams.keys()]) {
          if (k === 'source' || k.startsWith('utm_')) au.searchParams.delete(k);
        }
        applyUrl = au.toString().replace(/\?$/, '');
      }
      // Resolve to the employer ATS URL when Jobgether found one; otherwise
      // the Jobgether page itself is canonical (still dedups by URL).
      return { ...n, canonicalUrl: applyUrl || url, sourceUrl: applyUrl ? url : undefined };
    },
  },

  // Remotive — free remote-jobs aggregator. Each posting page embeds a full
  // schema.org JobPosting JSON-LD (reuse the xh extractor), but the default
  // fetch-jd UA gets HTTP 400'd by Remotive's edge — needs a realistic
  // browser UA, same fix as jobgether. Two quirks JSON-LD alone doesn't
  // solve:
  //   1. The raw title is wrapped "[Hiring] {role} @{company}" — stripped
  //      below; hiringOrganization.name is the reliable company source.
  //   2. jobLocationType is always TELECOMMUTE (Remotive is remote-only) and
  //      applicantLocationRequirements is a country-code array, but the real
  //      eligibility scope is a "📍 Location: {text}" sentence in the
  //      description prose — same "prose wins over the JSON-LD country list"
  //      caveat as Recruitee/Greenhouse/Hostaway (see modes/_fetch.md).
  // The employer apply URL is never in the HTML — Remotive resolves it
  // client-side via a JSON-RPC POST to /job/application/{id}; call that
  // endpoint directly (best-effort: on any failure the Remotive page stays
  // canonical) to get the same URL a browser redirect would land on, and
  // promote it to **URL:** with the Remotive page kept as **Source:** (same
  // convention as the jobgether handler). Two URL path shapes reach the same
  // posting: `/remote-jobs/{category}/{slug}-{id}` (current) and
  // `/remote/jobs/{category}/{slug}-{id}` (older links) — the latter 410s
  // even when the id is still live under the current shape, so a 410/404 on
  // either form just means the posting itself is gone, not a bad URL shape.
  remotive: {
    match(u) {
      const m = u.match(/remotive\.com\/remote(?:-jobs|\/jobs)\/[^/?#]+\/[^/?#]*-(\d+)(?:[/?#]|$)/i);
      return m ? { id: m[1] } : null;
    },
    async fetch({ id }, url) {
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
      const r = await fetchText(url, { headers: { 'User-Agent': UA } });
      if (r.status === 410 || r.status === 404) {
        const slug = (url.match(/\/([^/?#]+)-\d+(?:[/?#]|$)/) || [])[1] || `job-${id}`;
        return {
          expired: true,
          company: 'Unknown',
          role: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          fetchMethod: 'remotive',
        };
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const jp = extractJsonLdJobPosting(r.body);
      if (!jp) throw new Error(`no JSON-LD JobPosting at ${url}`);

      const rawTitle = jp.title || 'Unknown role';
      const titleM = rawTitle.match(/^\[Hiring\]\s*(.+)\s@\s*(.+)$/);
      const role = titleM ? titleM[1].trim() : rawTitle;
      const company = jp.hiringOrganization?.name || (titleM ? titleM[2].trim() : 'Unknown');

      const summary = htmlToText(jp.description);
      const locM = summary.match(/📍\s*Location:\s*([^.\n]+)\.?/);
      const location = locM ? locM[1].trim() : 'unspecified';
      const countries = (jp.applicantLocationRequirements || [])
        .map(c => c.name).filter(Boolean);
      const remoteScope = jp.jobLocationType === 'TELECOMMUTE'
        ? (countries.length && countries.length <= 3
          ? `full-remote-countries:${countries.join(',')}`
          : 'full-remote-global')
        : workplaceToScope(jp.jobLocationType || '');

      let canonicalUrl = url;
      let sourceUrl;
      try {
        const api = await fetchText(`https://remotive.com/job/application/${id}`, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call', params: { source: 'job_detail_page' }, id: 1,
          }),
        });
        if (api.ok) {
          const data = JSON.parse(api.body);
          const applyUrl = data?.result?.url;
          if (data?.result?.apply_ok && applyUrl && !applyUrl.includes('remotive.com')) {
            const au = new URL(applyUrl);
            for (const k of [...au.searchParams.keys()]) {
              if (k === 'source' || k.startsWith('utm_')) au.searchParams.delete(k);
            }
            canonicalUrl = au.toString().replace(/\?$/, '');
            sourceUrl = url;
          }
        }
      } catch { /* apply-URL resolution is best-effort; Remotive page stays canonical */ }

      return {
        company,
        role,
        fetchMethod: 'remotive',
        jdStatus: 'active',
        postingAge: postingAge(jp.datePosted),
        location,
        remoteScope,
        summary,
        other: jp.employmentType
          ? `Employment type: ${[].concat(jp.employmentType).join(', ')}`
          : '',
        canonicalUrl,
        sourceUrl,
      };
    },
  },

  // Avature ATS portals — each customer runs on its own custom domain
  // (jobs.{company}.*), so there's no shared host to auto-detect; registry-only
  // like `xh` above. URL shape: `/{locale}/jobs/JobDetail/{slug}/{id}`. The
  // JD is server-rendered (no JS needed) as a sequence of `<article>` sections
  // (h2 title) each containing `<dl>` field blocks; most fields carry their
  // own `<dt>` label (Name, Ref #, Description, Requirements, …) but a few
  // single-field sections (Benefits, company blurb) omit the `<dt>` entirely —
  // those fall back to the enclosing section's h2 as the key.
  //
  // A second Avature template (seen on jobs.siemens.com) skips the <dl>/<dt>/
  // <dd> markup entirely: each field is a plain
  // `<div class="…__field"><div class="…__label">…</div><div class="…__value">…
  // </div></div>`, and the whole JD body (summary + responsibilities +
  // requirements) sits in one unlabeled `…__value` div instead of separate
  // Description/Requirements/Nice to Have fields. The fallback below only
  // runs when the <dl> pass above finds no Description.
  avature: {
    match: () => null,
    extract(u) {
      const m = u.match(/\/jobs\/JobDetail\/[^/]+\/(\d+)/i);
      return m ? { id: m[1] } : {};
    },
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const html = r.body;
      const company = (html.match(/property="og:site_name"\s+content="([^"]*)"/i) || [])[1] || 'Unknown';

      const walker = /<h2[^>]*class="[^"]*article__header__text__title[^"]*"[^>]*>([\s\S]*?)<\/h2>|<dl[^>]*class="[^"]*article__content__view__field[^"]*"[^>]*>([\s\S]*?)<\/dl>/gi;
      const fields = {};
      let section = '';
      let m;
      while ((m = walker.exec(html))) {
        if (m[1] !== undefined) { section = htmlToText(m[1]).trim(); continue; }
        const dt = (m[2].match(/<dt[^>]*>([\s\S]*?)<\/dt>/i) || [])[1];
        const dd = (m[2].match(/<dd[^>]*>([\s\S]*?)<\/dd>/i) || [])[1] || '';
        const label = htmlToText(dt || '').trim() || section;
        if (label) fields[label] = htmlToText(dd).trim();
      }

      if (!fields.Description) {
        const fieldRe = /<div[^>]*class="[^"]*article__content__view__field[^_][^"]*"[^>]*>\s*(?:<div[^>]*class="[^"]*article__content__view__field__label[^"]*"[^>]*>([\s\S]*?)<\/div>)?\s*<div[^>]*class="[^"]*article__content__view__field__value[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
        const flatten = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        let fm;
        while ((fm = fieldRe.exec(html))) {
          const label = flatten(fm[1] || '');
          const raw = fm[2] || '';
          if (!label) {
            // The JD body is the longest unlabeled value field on the page.
            const value = htmlToText(raw);
            if (value.length > (fields.Description || '').length) fields.Description = value;
            continue;
          }
          // Multi-item fields (e.g. a location list) render as <li>s — flatten
          // each item individually so they don't run together.
          const items = [...raw.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(x => flatten(x[1]));
          fields[label] = items.length ? items.join(' / ') : flatten(raw);
        }
      }
      if (!fields.Description) throw new Error(`no Avature job fields at ${url}`);

      const role = fields.Name
        || (html.match(/property="og:title"\s+content="([^"]*)"/i) || [])[1] || 'Unknown role';
      const location = fields['Location(s)']
        || [fields.City, fields.Region, fields.Country].filter(Boolean).join(', ') || 'unspecified';
      const remote = (fields['Remote Work'] || fields['Work mode'] || '').toLowerCase();
      const place = fields.City || (fields['Location(s)'] || '').split(' / ')[0].split(' - ')[0].trim() || 'unspecified';
      const remoteScope = remote.includes('hybrid') ? `hybrid:${place}`
        : remote.includes('remote') ? 'full-remote-global'
        : remote.includes('on-site') || remote.includes('onsite') ? `onsite:${place}`
        : 'unspecified';

      const known = new Set(['Name', 'Ref #', 'Posting Date', 'Country', 'Region', 'City',
        'Description', 'Requirements', 'Nice to Have', 'Remote Work',
        'Job ID', 'Posted since', 'Location(s)', 'Work mode']);
      const other = Object.entries(fields)
        .filter(([k, v]) => !known.has(k) && v)
        .map(([k, v]) => `**${k}:** ${v}`)
        .join('\n\n');

      return {
        company,
        role,
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: postingAge(fields['Posting Date'] || fields['Posted since']),
        location,
        remoteScope,
        summary: fields.Description || '',
        requirements: fields.Requirements ? bullets(fields.Requirements) : [],
        niceToHave: fields['Nice to Have'] ? bullets(fields['Nice to Have']) : [],
        other,
      };
    },
  },

  smartrecruiters: {
    // URL shape: jobs.smartrecruiters.com/{orgSlug}/{numericId}-{slug}
    match(u) {
      const m = u.match(/jobs\.smartrecruiters\.com\/([^/?#]+)\/(\d+)/);
      return m ? { org: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(/\/(\d{15,})/);
      return m ? { id: m[1] } : {};
    },
    async fetch({ org, id }) {
      let j;
      try {
        j = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${org}/postings/${id}`);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return { expired: true, company: org, role: `job ${id}` };
        throw e;
      }
      const loc = j.location || {};
      const locationStr = [loc.city, loc.region, loc.country ? loc.country.toUpperCase() : '']
        .filter(Boolean).join(', ') || 'unspecified';
      const remoteScope = loc.remote
        ? 'full-remote-global'
        : loc.hybrid
          ? `hybrid:${loc.city || 'unspecified'}`
          : loc.city ? `onsite:${loc.city}` : 'unspecified';
      const ads = j.jobAd?.sections || {};
      const description = htmlToText(ads.jobDescription?.text || '');
      const additionalInfo = htmlToText(ads.additionalInformation?.text || '');
      const qualifications = htmlToText(ads.qualifications?.text || '');
      const summary = [description, qualifications, additionalInfo].filter(Boolean).join('\n\n');
      return {
        company: j.company?.name || org,
        role: j.name || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: j.active === false ? 'expired' : 'active',
        postingAge: postingAge(j.releasedDate),
        location: locationStr,
        remoteScope,
        summary,
        other: [
          j.typeOfEmployment?.label,
          j.experienceLevel?.label,
          j.department?.label,
        ].filter(Boolean).join(' · '),
      };
    },
  },

  // Workable apply subdomain. URL: apply.workable.com/{account}/j/{shortcode}/
  // Free markdown endpoint — no auth, no JS rendering, clean structured markdown.
  workable: {
    match(u) {
      const m = u.match(/apply\.workable\.com\/([^/?#]+)\/j\/([^/?#]+)/);
      return m ? { account: m[1], shortcode: m[2] } : null;
    },
    async fetch({ account, shortcode }) {
      const mdUrl = `https://apply.workable.com/${account}/jobs/view/${shortcode}.md`;
      const r = await fetchText(mdUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${mdUrl}`);
      const md = r.body;
      const titleMatch = md.match(/^#\s+(.+)$/m);
      const role = titleMatch ? titleMatch[1].trim() : 'Unknown role';
      // Subtitle line: "> CompanyName · Location · Type · Posted YYYY-MM-DD"
      const subtitleMatch = md.match(/^>\s*([^·\n]+)\s*·/m);
      const company = subtitleMatch ? subtitleMatch[1].trim() : account;
      const locationMatch = md.match(/^>\s*[^·]+·\s*([^·\n]+)/m);
      const location = locationMatch ? locationMatch[1].trim() : 'unspecified';
      const workplaceMatch = md.match(/\*\*Workplace:\*\*\s*(\S+)/i);
      const workplace = workplaceMatch ? workplaceMatch[1].toLowerCase() : '';
      const remoteScope = workplace.includes('remote')
        ? 'full-remote-global'
        : workplace.includes('hybrid') ? 'hybrid:unspecified' : 'unspecified';
      const postedMatch = md.match(/Posted\s+([\d-]+)/i);
      return {
        company,
        role,
        fetchMethod: 'xh (workable-md)',
        jdStatus: 'active',
        postingAge: postedMatch ? postingAge(postedMatch[1]) : 'unspecified',
        location,
        remoteScope,
        summary: md.trim(),
      };
    },
  },

  // Oracle Fusion HCM Recruiting Cloud (ORC) candidate experience sites —
  // e.g. Honeywell's `{pod}.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/
  // {lang}/sites/{site}/(requisitions/)?job/{id}`. URL shape is generic
  // across every company on the platform, so match() auto-fires (no
  // per-tenant registry entry needed, unlike Workday's per-host learning).
  // The public REST API needs a `siteNumber` (e.g. "CX_1") that isn't in the
  // URL — scraped from the rendered page's `data-sitenumber` attribute.
  oracleOrc: {
    match(u) {
      const m = u.match(/https?:\/\/([^/]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/(?:requisitions\/)?job\/(\d+)/i);
      return m ? { host: m[1], site: m[2], id: m[3] } : null;
    },
    extract(u) {
      const m = u.match(/\/sites\/([^/]+)\/(?:requisitions\/)?job\/(\d+)/i);
      return m ? { site: m[1], id: m[2] } : {};
    },
    async fetch({ host, site, id }) {
      const pageUrl = `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${id}`;
      const page = await fetchText(pageUrl);
      if (!page.ok) throw new Error(`HTTP ${page.status} on ${pageUrl}`);
      const siteNumber = (page.body.match(/data-sitenumber="([^"]+)"/) || [])[1];
      if (!siteNumber) throw new Error('no data-sitenumber on Oracle ORC page');
      const company = (page.body.match(/property="og:site_name" content="([^"]+)"/) || [])[1] || site;
      const api = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
        `?finder=ById;Id=%22${id}%22,siteNumber=${siteNumber}&onlyData=true`;
      const j = await fetchJson(api);
      const item = j.items?.[0];
      if (!item) return { expired: true, company, role: `job ${id}` };
      const summary = [item.ExternalDescriptionStr, item.ExternalQualificationsStr, item.ExternalResponsibilitiesStr]
        .filter(Boolean).map(htmlToText).join('\n\n');
      return {
        company,
        role: item.Title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: 'active',
        postingAge: postingAge(item.ExternalPostedStartDate),
        location: item.PrimaryLocation || 'unspecified',
        remoteScope: workplaceToScope(item.WorkplaceType),
        summary,
        other: [item.JobSchedule, item.RequisitionType, item.Category].filter(Boolean).join(' · '),
      };
    },
  },

  // Saba TalentLink (Lumesse) — Cornerstone's EU-hosted apply flow, used by
  // Saint-Gobain and others. URL shape is generic across every pod
  // (emea9-apply.sabatalentlink.com, apac3-apply.sabatalentlink.com, …), so
  // match() auto-fires. The apply-app pages themselves are Cloudflare
  // challenge-walled, but `/apply-app/rest/*` is not — it's a free,
  // unauthenticated REST API that returns structured metadata (title,
  // reference, location, compensation, department, contract type) via the
  // `application-process` endpoint's `advertOverview`. That endpoint has no
  // JD prose or remote/hybrid/onsite tag though — those only exist on the
  // rendered `joinus.saint-gobain.com` description page (also Cloudflare
  // page-walled), so Firecrawl renders that one page for the prose body.
  sabatalentlink: {
    match(u) {
      const m = u.match(/https?:\/\/([^/]+\.sabatalentlink\.com)\/apply-app\/pages\/application-form/i);
      if (!m) return null;
      let id;
      try { id = new URL(u).searchParams.get('jobId'); } catch { return null; }
      return id ? { host: m[1], id } : null;
    },
    extract(u) {
      let id;
      try { id = new URL(u).searchParams.get('jobId'); } catch { return {}; }
      return id ? { id } : {};
    },
    async fetch({ host, id }) {
      const api = `https://${host}/apply-app/rest/jobs/${encodeURIComponent(id)}/application-process`;
      let j;
      try {
        j = await fetchJson(api);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return { expired: true, company: 'Saint-Gobain', role: `job ${id}` };
        throw e;
      }
      const ov = j.advertOverview || {};
      const fields = ov.fields || [];
      const loc = fields.find(f => f.type === 'Location');
      const comp = fields.find(f => f.type === 'Compensation');
      const std = fid => fields.find(f => f.type === 'Standard' && f.id === fid)?.value;
      const location = loc ? [loc.city, loc.region, loc.country].filter(Boolean).join(', ') : 'unspecified';
      const compStr = comp ? `${comp.minValue}-${comp.maxValue} ${comp.currency}/${comp.period}` : '';
      const company = std('standard_company') || 'Saint-Gobain';
      const role = ov.jobTitle || j.jobName || 'Unknown role';

      let summary = '';
      let remoteScope = 'unspecified';
      let usedFirecrawl = false;
      if (ov.jobDescriptionUrl && process.env.FIRECRAWL_API_KEY) {
        const out = `/tmp/fetch-jd-sabatalentlink-${Date.now()}.md`;
        try {
          execFileSync('firecrawl', ['scrape', ov.jobDescriptionUrl, '-o', out],
            { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
          if (existsSync(out)) {
            let md = readFileSync(out, 'utf-8');
            const h1 = md.search(/\n#\s+.+\n/);
            if (h1 >= 0) md = md.slice(h1);
            md = md.split(/\n##\s*A little more about us/i)[0].trim();
            if (md) {
              summary = md;
              usedFirecrawl = true;
              const wt = md.match(/\n-\s*(Remote|Hybrid|On[\s-]?site)\s*\n/i);
              if (wt) {
                const kind = wt[1].toLowerCase();
                remoteScope = kind.includes('remote') ? 'full-remote-global'
                  : kind.includes('hybrid') ? `hybrid:${loc?.city || 'unspecified'}`
                  : `onsite:${loc?.city || 'unspecified'}`;
              }
            }
          }
        } catch { /* fall through to structured-only summary below */ }
      }
      if (!summary) {
        summary = `${role} — reference ${ov.jobNumber || 'n/a'}.` +
          (compStr ? ` Compensation: ${compStr}.` : '') +
          ' JD prose unavailable (Firecrawl not configured or scrape failed) — structured metadata only.';
      }

      const endDate = j.postingEndDate ? new Date(j.postingEndDate.replace(/\//g, '-')) : null;
      return {
        company,
        role,
        fetchMethod: usedFirecrawl ? 'ats-api + firecrawl' : 'ats-api',
        jdStatus: endDate && endDate < new Date() ? 'expired' : 'active',
        postingAge: postingAge(j.postingStartDate?.replace(/\//g, '-')),
        location,
        remoteScope,
        summary,
        other: [std('standard_department'), std('standard_contract_type'), compStr]
          .filter(Boolean).join(' · '),
      };
    },
  },

  // BambooHR ATS — multi-tenant public careers API, generic host pattern
  // ({tenant}.bamboohr.com/careers/{id}), so match() auto-fires like
  // personio/workday. `/careers/{id}/detail` returns the full JD; its
  // `atsLocation` is the employer's registered/payroll entity, not the
  // eligibility scope (same caveat as Greenhouse/Recruitee
  // applicantLocationRequirements — see modes/_fetch.md), so remoteScope
  // is left unspecified and the prose (kept in full in summary) carries
  // the actual scope through to the location gate.
  bamboohr: {
    match(u) {
      const m = u.match(/https?:\/\/([^/.]+)\.bamboohr\.com\/careers\/(\d+)(?:[/?#]|$)/i);
      return m ? { tenant: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(/\/careers\/(\d+)/);
      return m ? { id: m[1] } : {};
    },
    async fetch({ tenant, id }) {
      let j;
      try {
        j = await fetchJson(`https://${tenant}.bamboohr.com/careers/${id}/detail`);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return { expired: true, company: tenant, role: `job ${id}` };
        throw e;
      }
      const jo = j.result?.jobOpening;
      if (!jo) return { expired: true, company: tenant, role: `job ${id}` };
      const loc = jo.atsLocation || {};
      const location = [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || 'unspecified';
      return {
        company: tenant.charAt(0).toUpperCase() + tenant.slice(1),
        role: jo.jobOpeningName || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: jo.jobOpeningStatus && !/open/i.test(jo.jobOpeningStatus) ? 'expired' : 'active',
        postingAge: postingAge(jo.datePosted),
        location,
        remoteScope: 'unspecified',
        summary: htmlToText(jo.description),
        other: jo.employmentStatusLabel ? `Employment type: ${jo.employmentStatusLabel}` : '',
      };
    },
  },

  // WP Job Manager plugin (wp-json/wp/v2/job-listings) — the free WordPress
  // job-board plugin many small aggregators run (first seen: euremotejobs.com).
  // Registry-only like avature/xh above: the host varies per site, so match()
  // stays null and a per-host --learn entry maps it here. The REST collection
  // endpoint takes ?slug= and returns the full JD (content.rendered), company
  // name (meta._company_name — WP Job Manager doesn't put it in title/excerpt),
  // and structured taxonomy classes in class_list: `job_listing_region-{slug}`
  // (geography — the only location signal on sites whose JD prose omits it
  // entirely), `job-type-{slug}` (employment type). No auth, no rate limit
  // seen. The "Apply" button in content.rendered is usually a relative path
  // on the SAME host (`/{company-slug}/{uuid}/application`, a client-rendered
  // SPA route that 404s on direct GET) — i.e. NOT an external employer ATS
  // redirect on this site; noted as internal in Other Details rather than
  // promoted to canonical URL.
  wpjobmanager: {
    match: () => null,
    extract(u) {
      const m = u.match(/\/job\/([^/?#]+)\/?(?:[?#]|$)/i);
      return m ? { slug: m[1] } : {};
    },
    async fetch({ slug }, url) {
      const host = new URL(url).host;
      const list = await fetchJson(
        `https://${host}/wp-json/wp/v2/job-listings?slug=${encodeURIComponent(slug)}`,
      );
      const post = list[0];
      if (!post) return { expired: true, company: host, role: `job ${slug}` };
      const meta = post.meta || {};
      const classes = post.class_list || [];
      const cls = prefix => (classes.find(c => c.startsWith(prefix)) || '').slice(prefix.length);
      const titleCase = s => s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const regionSlug = cls('job_listing_region-').replace(/^remote-jobs-/, '');
      const region = regionSlug ? titleCase(regionSlug) : '';
      const empType = titleCase(cls('job-type-'));
      const isRemote = meta._remote_position === 1 || meta._remote_position === '1' || !!regionSlug;
      // Strip the trailing "Apply for this Job" button — it's markup, not JD prose.
      const summary = htmlToText(post.content?.rendered)
        .replace(/\n?Apply for this Job\s*$/, '').trim();
      const applyHref = (post.content?.rendered.match(/<a[^>]+href="([^"]+)"[^>]*>\s*<button/i) || [])[1] || '';
      const applyIsExternal = /^https?:\/\//i.test(applyHref) && !applyHref.includes(host);
      return {
        company: meta._company_name || 'Unknown',
        role: post.title?.rendered || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: post.status === 'publish' ? 'active' : 'expired',
        postingAge: postingAge(post.date_gmt),
        location: region || 'unspecified',
        remoteScope: isRemote ? `full-remote-region:${region || 'unspecified'}` : 'unspecified',
        summary,
        other: [
          empType ? `Employment type: ${empType}` : '',
          applyIsExternal
            ? `Employer ATS apply URL: ${new URL(applyHref, url).href}`
            : 'Apply: internal application form on this site (no external employer ATS URL found)',
        ].filter(Boolean).join('\n'),
      };
    },
  },

  // Welcome to the Jungle (French job board; postings can be FR or EN) —
  // registry-only. URL shape: welcometothejungle.com/{locale}/companies/
  // {org}/jobs/{slug}. The rendered page itself is Cloudfront-fronted and
  // 403s `xh`/default fetches regardless of User-Agent, but the site's own
  // frontend calls a public, unauthenticated JSON API for the same data —
  // hit that directly instead of rendering. No JSON-LD/`__NEXT_DATA__`
  // exposed on the HTML page even when reachable.
  wttj: {
    match: () => null,
    extract(u) {
      const m = u.match(/welcometothejungle\.com\/[a-z]{2}\/companies\/([^/?#]+)\/jobs\/([^/?#]+)/i);
      return m ? { org: m[1], slug: m[2] } : {};
    },
    async fetch({ org, slug }) {
      let j;
      try {
        j = await fetchJson(`https://api.welcometothejungle.com/api/v1/organizations/${org}/jobs/${slug}`);
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return { expired: true, company: org, role: slug };
        throw e;
      }
      const job = j.job;
      if (!job) return { expired: true, company: org, role: slug };
      const offices = job.offices?.length ? job.offices : (job.office ? [job.office] : []);
      const location = offices.map(o => [o.city, o.country_code].filter(Boolean).join(', ')).join(' / ') || 'unspecified';
      const city = offices[0]?.city || 'unspecified';
      // `remote`: "full" | "partial" | "no" (WTTJ's own enum, distinct from
      // schema.org jobLocationType — not worth routing through workplaceToScope).
      const remote = String(job.remote || '').toLowerCase();
      const remoteScope = remote === 'full' ? 'full-remote-global'
        : remote === 'partial' ? `hybrid:${city}`
        : remote === 'no' ? `onsite:${city}`
        : 'unspecified';
      const other = [
        job.contract_type ? `Contract type: ${job.contract_type}` : '',
        // apply_url resolves to the employer's real ATS when WTTJ is just
        // listing (not hosting) the application — useful breadcrumb for the
        // apply step later, but the canonical **URL:** stays the WTTJ page
        // the caller actually gave us.
        job.apply_url && !job.apply_url.includes('welcometothejungle.com')
          ? `Apply via: ${job.apply_url}` : '',
      ].filter(Boolean).join('\n\n');
      return {
        company: job.organization?.name || org,
        role: job.name || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: job.archived_at ? 'expired' : 'active',
        postingAge: postingAge(job.published_at),
        location,
        remoteScope,
        summary: htmlToText(job.description),
        other,
      };
    },
  },

  // startup.jobs — remote-jobs aggregator. Registry-only like wttj: the page
  // embeds a full schema.org JobPosting (reuse xh's shared extractor), but
  // Node's own fetch (undici) gets a Cloudflare managed challenge on every
  // request regardless of User-Agent (verified: default UA and a full Chrome
  // UA both 403 with `cf-mitigated: challenge`) — a TLS/HTTP fingerprint
  // block, not a header one. The `xh` CLI (rustls) passes through cleanly, so
  // this handler shells out to it instead of the shared fetchText(). No
  // employer ATS to resolve to: applications are handled entirely in-house
  // (a Cloudflare Turnstile-protected POST to `/apply/{uuid}` on startup.jobs
  // itself) — unlike jobgether, the startup.jobs URL stays canonical, no
  // `**Source:**` line. `applicantLocationRequirements` (e.g. {"name":
  // "Anywhere"}) is the only location signal on fully-remote postings —
  // `jobLocation.address` comes back all-null for those — so it backfills
  // Location when the address gave nothing.
  startupjobs: {
    match: () => null,
    async fetch(_p, url) {
      let html;
      try {
        html = execFileSync('xh', ['GET', url, '--follow'],
          { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024, timeout: 30_000 });
      } catch (e) {
        throw new Error(`xh fetch failed for ${url}: ${e.message}`);
      }
      const jp = extractJsonLdJobPosting(html);
      if (!jp) throw new Error(`no JSON-LD JobPosting at ${url}`);
      const n = normalizeJsonLd(jp, 'xh (startup.jobs JSON-LD)');
      if (n.location === 'unspecified' && jp.applicantLocationRequirements) {
        const req = jp.applicantLocationRequirements;
        const names = (Array.isArray(req) ? req : [req]).map(r => r?.name).filter(Boolean);
        if (names.length) n.location = names.join(', ');
      }
      const sal = jp.baseSalary?.value;
      if (sal && (sal.minValue || sal.value)) {
        const range = sal.minValue && sal.maxValue ? `${sal.minValue}-${sal.maxValue}` : sal.value;
        const salaryLine = `Salary: ${range} ${jp.baseSalary.currency || ''}/${sal.unitText || ''}`.trim();
        n.other = [n.other, salaryLine].filter(Boolean).join(' · ');
      }
      return n;
    },
  },

  // Himalayas (himalayas.app) — remote-jobs aggregator. The rendered job page
  // is Cloudflare-fronted (`cf-mitigated: challenge` on every UA, xh and plain
  // fetch alike), and even a Firecrawl render of a closed/unlisted job slug
  // silently 302s to the generic /jobs listing (statusCode 200 but
  // `metadata.url` != the requested job URL, no real 404) — that redirect
  // *is* the "posting is gone" signal, worth knowing before reaching for a
  // browser. Himalayas instead ships a free, unauthenticated JSON search API
  // (documented at himalayas.app/api) — hit that directly. Unlike jobgether/
  // wttj, Himalayas's own "Apply now" always routes through its own signup
  // funnel (himalayas.app/signup/talent?...), never the employer's ATS —
  // there is no employer URL to resolve to here, so the Himalayas URL itself
  // stays canonical. The search endpoint only returns currently-active
  // listings, so "not found for this company" reliably means expired —
  // matches the known caveat that Himalayas keeps reposts live after the
  // employer closes the role (this one had also fallen out of Himalayas's
  // own index by the time it was fetched).
  himalayas: {
    match(u) {
      const m = u.match(/himalayas\.app\/companies\/([^/?#]+)\/jobs\/([^/?#]+)/i);
      return m ? { org: m[1], slug: m[2] } : null;
    },
    async fetch({ org, slug }) {
      const guid = `https://himalayas.app/companies/${org}/jobs/${slug}`;
      let job = null;
      let anyCompanyName = null;
      let seen = 0;
      for (let page = 1; page <= 20; page++) {
        const j = await fetchJson(
          `https://himalayas.app/jobs/api/search?company=${encodeURIComponent(org)}&page=${page}`,
        );
        const jobs = j.jobs || [];
        if (jobs.length && !anyCompanyName) anyCompanyName = jobs[0].companyName;
        job = jobs.find(x => x.guid === guid);
        if (job) break;
        seen += jobs.length;
        if (!jobs.length || seen >= (j.totalCount || 0)) break;
      }
      if (!job) return { expired: true, company: anyCompanyName || org, role: slug };
      const countries = job.locationRestrictions || [];
      return {
        company: job.companyName || org,
        role: job.title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: 'active',
        postingAge: postingAge(job.pubDate ? job.pubDate * 1000 : null),
        location: countries.join(', ') || 'unspecified',
        remoteScope: countries.length ? `full-remote-countries:${countries.join(', ')}` : 'full-remote-global',
        summary: htmlToText(job.description),
        other: [job.employmentType, (job.seniority || []).join(', ')].filter(Boolean).join(' · '),
      };
    },
  },

  // Generic SPA fallback — registry-only. Pages with no public JSON
  // (SuccessFactors, Deel, Workable apply pages) get scraped to markdown via
  // the firecrawl CLI (FIRECRAWL_API_KEY from .env). The prose body is enough
  // for the location gate + scorer; company/role come from the registry entry
  // params or the first markdown heading.
  firecrawl: {
    match: () => null,
    async fetch(p, url) {
      if (!process.env.FIRECRAWL_API_KEY) {
        throw new Error('firecrawl handler needs FIRECRAWL_API_KEY in .env');
      }
      const out = `/tmp/fetch-jd-firecrawl-${Date.now()}.md`;
      try {
        execFileSync('firecrawl', ['scrape', url, '-o', out],
          { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
      } catch (e) {
        throw new Error(`firecrawl scrape failed: ${e.message}`);
      }
      if (!existsSync(out)) throw new Error('firecrawl produced no output');
      const md = readFileSync(out, 'utf-8');
      return {
        company: p.company || new URL(url).host.replace(/^www\./, '').split('.')[0],
        role: p.role || (md.match(/^#\s+(.+)$/m) || [])[1] || 'Unknown role',
        fetchMethod: 'firecrawl',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location: p.location || 'unspecified',
        remoteScope: 'unspecified',
        summary: md.trim(),
      };
    },
  },

  // Oracle/Taleo "classic" job-detail pages (`{tenant}.taleo.net/careersection/
  // {id}/jobdetail.ftl?job={reqId}`) — legacy JSP templates whose labels
  // ("Description", "Qualifications", "Job Field"...) render server-side but
  // whose actual field values are populated by client-side AJAX, so a bare
  // xh/fetch returns empty table cells. Firecrawl's headless render waits for
  // that AJAX and also lets the page's client-side JS finish rewriting
  // `document.title` to a stable per-posting pattern: "Job Description -
  // {Role Title} ({ReqID})" — reliable across postings, unlike the markdown
  // body's first `#` heading (always the generic "# Job Description" section
  // header). Registry-only, like epam/avature: one Taleo host is one
  // employer, so `company` is supplied per tenant via `--learn ... --params`.
  taleo: {
    match: () => null,
    async fetch(p, url) {
      if (!process.env.FIRECRAWL_API_KEY) {
        throw new Error('taleo handler needs FIRECRAWL_API_KEY in .env');
      }
      const out = `/tmp/fetch-jd-taleo-${Date.now()}.json`;
      try {
        execFileSync('firecrawl', ['scrape', url, '--json', '-o', out],
          { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
      } catch (e) {
        throw new Error(`firecrawl scrape failed: ${e.message}`);
      }
      if (!existsSync(out)) throw new Error('firecrawl produced no output');
      const { markdown, metadata } = JSON.parse(readFileSync(out, 'utf-8'));
      const titleMatch = (metadata?.title || '').match(/Job Description\s*-\s*(.+?)\s*\((\d+)\)\s*$/);
      const reqId = titleMatch?.[2] || new URL(url).searchParams.get('job') || '';
      return {
        company: p.company || new URL(url).host.split('.')[0],
        role: titleMatch?.[1] || metadata?.ogTitle || 'Unknown role',
        fetchMethod: 'firecrawl (taleo)',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location: p.location || 'unspecified',
        remoteScope: 'unspecified',
        summary: (markdown || '').trim(),
        other: reqId ? `Requisition ID: ${reqId}` : '',
      };
    },
  },

  // EPAM's careers site (careers.epam.com) — a single-company Contentstack
  // CMS behind a Next.js frontend. No shared multi-tenant host pattern like
  // Teamtailor/Personio, so registry-only like avature/xh. The server-rendered
  // HTML embeds the full job record in <script id="__NEXT_DATA__"> at
  // props.pageProps.job (title, city/country, vacancy_type, description,
  // category.{responsibilities,requirements,nice_to_have}, is_expired,
  // created_at) — no separate API call needed.
  epam: {
    match: () => null,
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const m = r.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) throw new Error(`no __NEXT_DATA__ at ${url}`);
      let data;
      try { data = JSON.parse(m[1]); } catch { throw new Error(`unparseable __NEXT_DATA__ at ${url}`); }
      const job = data?.props?.pageProps?.job;
      if (!job) throw new Error(`no job payload in __NEXT_DATA__ at ${url}`);

      const city = job.city?.[0]?.name;
      const country = job.country?.[0]?.name;
      const location = [city, country].filter(Boolean).join(', ') || 'unspecified';
      const vacancyType = String(job.vacancy_type || '').toLowerCase();
      const remoteScope = vacancyType.includes('remote') ? 'full-remote-global'
        : vacancyType.includes('hybrid') ? `hybrid:${city || 'unspecified'}`
        : vacancyType.includes('on-site') || vacancyType.includes('onsite') ? `onsite:${city || 'unspecified'}`
        : 'unspecified';
      const cat = job.category || {};

      return {
        company: 'EPAM',
        role: job.name || 'Unknown role',
        fetchMethod: 'xh',
        jdStatus: job.is_expired ? 'expired' : 'active',
        postingAge: postingAge(job.created_at),
        location,
        remoteScope,
        summary: htmlToText(job.description || ''),
        responsibilities: cat.responsibilities || [],
        requirements: cat.requirements || [],
        niceToHave: cat.nice_to_have || [],
        other: job.relocation === false ? 'Relocation: not offered' : (job.relocation ? 'Relocation: offered' : ''),
      };
    },
  },

  // SAP SuccessFactors Career Site Builder (job2web / "j2w") — each customer
  // runs on its own vanity domain, so registry-only like avature. JD is
  // server-rendered (no JS needed): fields carry a stable
  // `data-careersite-propertyid="title|dept|location|description"` attribute,
  // a CSB platform convention (not customer-specific). No structured
  // remote-work field exists on this template — remoteScope is left
  // unspecified and falls through to the LLM location gate, which reads the
  // (often non-English) JD prose.
  successfactors_csb: {
    match: () => null,
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const html = r.body;
      const prop = (name) => {
        const m = html.match(new RegExp(`data-careersite-propertyid="${name}"[^>]*>([\\s\\S]*?)</span>`, 'i'));
        return m ? htmlToText(m[1]).trim() : '';
      };
      // The description field's rich-text body nests its own <span> tags
      // (inline font-size/color styling per run), so the naive "up to the
      // next </span>" match used by prop() above truncates at the first
      // nested close. Walk tag-balanced from the propertyid span's opening
      // tag to its true matching close instead.
      const propBalanced = (name) => {
        const openRe = new RegExp(`<span[^>]*data-careersite-propertyid="${name}"[^>]*>`, 'i');
        const om = openRe.exec(html);
        if (!om) return '';
        let i = om.index + om[0].length;
        let depth = 1;
        const tagRe = /<span\b[^>]*>|<\/span>/gi;
        tagRe.lastIndex = i;
        let tm;
        while ((tm = tagRe.exec(html))) {
          depth += /^<\/span>/i.test(tm[0]) ? -1 : 1;
          if (depth === 0) return html.slice(i, tm.index);
        }
        return html.slice(i);
      };
      const title = prop('title');
      const description = htmlToText(propBalanced('description')).trim();
      if (!title || !description) throw new Error(`no SuccessFactors CSB job fields at ${url}`);
      // No `dept` propertyid on every tenant (e.g. Hexion) — fall back to the
      // schema.org hiringOrganization meta tag, stripping the common
      // "{Company} Careers" site-name suffix.
      const hiringOrg = (html.match(/itemprop="hiringOrganization"\s+content="([^"]*)"/i) || [])[1];

      return {
        company: prop('dept') || (hiringOrg ? hiringOrg.replace(/\s+Careers$/i, '') : '') || 'Unknown',
        role: title,
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location: prop('location') || 'unspecified',
        remoteScope: 'unspecified',
        summary: description,
        other: '',
      };
    },
  },

  // SAP SuccessFactors — older "Recruiting Marketing" (RMK) job-display
  // template, a different rendering than successfactors_csb's
  // data-careersite-propertyid convention (same underlying platform: CSP
  // headers reference the same *.successfactors.eu/*.sapsf.eu/jobs2web.com
  // hosts). Server-rendered, no JS needed. Title/description carry
  // schema.org `itemprop="title"|"description"` microdata — description is
  // split across several `itemprop="description"` spans (one per content
  // block), each holding rich-text markup (H2/p/ul, no nested spans in
  // practice but walked tag-balanced defensively anyway); joined in
  // document order. A structured "Information at a Glance" sidebar
  // (`.joblayouttoken-label` + adjacent value span) supplies Request ID,
  // Posting Start Date, Job Area, Work Site, Contract Type, Brand, Job
  // Location as flat label→value pairs — Brand doubles as company name,
  // Work Site feeds workplaceToScope() for a coarse remoteScope.
  successfactors_rmk: {
    match: () => null,
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const html = r.body;
      const titleM = html.match(/itemprop="title"[^>]*>([\s\S]*?)<\/span>/i);
      const title = titleM ? htmlToText(titleM[1]).trim() : '';
      // Walk every itemprop="description" span tag-balanced (mirrors
      // successfactors_csb's propBalanced) and join in document order.
      const descBlocks = [];
      const openRe = /<span[^>]*itemprop="description"[^>]*>/gi;
      let om;
      while ((om = openRe.exec(html))) {
        let i = om.index + om[0].length;
        let depth = 1;
        const tagRe = /<span\b[^>]*>|<\/span>/gi;
        tagRe.lastIndex = i;
        let tm;
        while ((tm = tagRe.exec(html))) {
          depth += /^<\/span>/i.test(tm[0]) ? -1 : 1;
          if (depth === 0) { descBlocks.push(html.slice(i, tm.index)); openRe.lastIndex = tm.index; break; }
        }
      }
      const description = descBlocks.map(b => htmlToText(b).trim()).filter(Boolean).join('\n\n');
      if (!title || !description) throw new Error(`no SuccessFactors RMK job fields at ${url}`);
      const fields = {};
      const fieldRe = /<span class="joblayouttoken-label"[^>]*>([^<:]+):\s*<\/span>\s*<span[^>]*class="rtltextaligneligible">([\s\S]*?)<\/span>/gi;
      let fm;
      while ((fm = fieldRe.exec(html))) fields[fm[1].trim()] = htmlToText(fm[2]).trim();
      const hiringOrg = (html.match(/itemprop="hiringOrganization"\s+content="([^"]*)"/i) || [])[1];
      let age = 'unspecified';
      if (fields['Posting Start Date']) {
        const t = new Date(fields['Posting Start Date']).getTime();
        if (Number.isFinite(t)) age = postingAge(t);
      }
      return {
        company: fields['Brand'] || (hiringOrg ? hiringOrg.replace(/\s+Careers$/i, '') : '') || 'Unknown',
        role: title,
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: age,
        location: fields['Job Location'] || 'unspecified',
        remoteScope: fields['Work Site'] ? workplaceToScope(fields['Work Site']) : 'unspecified',
        summary: description,
        other: [
          fields['Contract Type'] ? `Contract type: ${fields['Contract Type']}` : '',
          fields['Job Area'] ? `Job area: ${fields['Job Area']}` : '',
          fields['Request ID'] ? `Request ID: ${fields['Request ID']}` : '',
        ].filter(Boolean).join('\n'),
      };
    },
  },

  // Amazon's own career site (amazon.jobs) — single company, so the host is
  // enough to auto-fire without a registry entry. URL shape:
  // amazon.jobs/{locale}/jobs/{id}/{slug}. The job-detail page is
  // server-rendered (no JS needed): title in `<title>{role} - Job ID: {id} |
  // Amazon.jobs</title>`, legal-entity/building code in
  // `<p class="meta">Job ID: {id} | {entity}</p>`, and Description/Basic
  // Qualifications/Preferred Qualifications each as a plain `<h2>{heading}
  // </h2><p>...</p>` pair. No structured remote/hybrid/onsite field exists on
  // this template (posting age is likewise absent) — both stay unspecified
  // and fall through to the LLM location gate. The cleanest structured
  // location signal is the analytics payload's `dimension8` field
  // ("SE, Stockholm" — country code + city), not the page's visible chrome.
  amazonJobs: {
    match(u) {
      const m = u.match(/amazon\.jobs\/([a-z]{2}(?:-[A-Z]{2})?)\/jobs\/(\d+)(?:\/([^/?#]+))?/i);
      return m ? { locale: m[1], id: m[2], slug: m[3] || '' } : null;
    },
    extract(u) {
      const id = numericId(u);
      return id ? { id } : {};
    },
    async fetch(_p, url) {
      const r = await fetchText(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
      const html = r.body;

      const titleM = html.match(/<title>([\s\S]*?)\s*-\s*Job ID:\s*\d+\s*\|\s*Amazon\.jobs<\/title>/i);
      const role = titleM ? decodeEntities(titleM[1]).trim() : 'Unknown role';
      const metaM = html.match(/class="meta">Job ID:\s*\d+\s*\|\s*([^<]+)<\/p>/i);
      // The meta line is "{legal entity} - {building/site code}", e.g.
      // "AWS EMEA SARL (Sweden Branch) - G54" — drop the site code and
      // collapse to the recognizable brand (AWS vs. Amazon retail/other),
      // matching the short-name convention already used in applications.md
      // ("Amazon", "Amazon Music").
      const entity = metaM ? decodeEntities(metaM[1]).replace(/\s*-\s*[A-Z0-9]+$/, '').trim() : '';
      const company = /\bAWS\b/.test(entity) ? 'AWS' : (entity || 'Amazon');

      const section = (heading) => {
        const m = html.match(new RegExp(`<h2>${heading}</h2>\\s*<p>([\\s\\S]*?)</p>`, 'i'));
        return m ? m[1] : '';
      };
      const descriptionRaw = section('Description');
      if (!descriptionRaw) throw new Error(`no Description section at ${url}`);
      const basicQualsRaw = section('Basic Qualifications');
      // Preferred Qualifications shares its <p> with Amazon's standard EEO /
      // accommodations boilerplate (no separate tag boundary in the source
      // HTML) — cut it off at the first boilerplate sentence so it doesn't
      // leak into Nice to Have.
      let prefQualsRaw = section('Preferred Qualifications');
      const boilerplateAt = prefQualsRaw.search(/Amazon is an equal opportunit/i);
      if (boilerplateAt >= 0) prefQualsRaw = prefQualsRaw.slice(0, boilerplateAt);

      const dimM = html.match(/dimension8["']?\s*:\s*"([^"]+)"/);
      const countryM = html.match(/countryCode:\s*"([A-Z]{2,3})"/);
      const location = dimM ? dimM[1] : (countryM ? countryM[1] : 'unspecified');

      return {
        company,
        role,
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: 'unspecified',
        location,
        remoteScope: 'unspecified',
        summary: htmlToText(descriptionRaw),
        requirements: basicQualsRaw ? bullets(basicQualsRaw) : [],
        niceToHave: prefQualsRaw ? bullets(prefQualsRaw) : [],
      };
    },
  },

  // HiBob-hosted careers pages ({tenant}.careers.hibob.com) — a multi-tenant
  // SPA, but the underlying job board is a free, unauthenticated JSON
  // endpoint: /api/job-ad returns every active posting for the tenant in one
  // call. The endpoint enforces a same-tenant Referer check (no API key).
  // Tenants can relabel the four content sections (description/requirements/
  // responsibilities/benefits) to whatever they like — sectionLabels carries
  // the tenant's own headings, so use those instead of assuming fixed
  // semantics (e.g. Element's "requirements" field actually holds
  // responsibilities prose).
  hibob: {
    match(u) {
      const m = u.match(/https?:\/\/([^/.]+)\.careers\.hibob\.com\/jobs\/([0-9a-f-]{36})/i);
      return m ? { tenant: m[1], id: m[2] } : null;
    },
    extract(u) {
      const m = u.match(UUID_RE);
      return m ? { id: m[1] } : {};
    },
    async fetch({ tenant, id }) {
      const base = `https://${tenant}.careers.hibob.com`;
      const j = await fetchJson(`${base}/api/job-ad`, { headers: { Referer: `${base}/` } });
      const post = (j.jobAdDetails || []).find(p => p.id === id);
      if (!post) return { expired: true, company: tenant, role: `job ${id}` };
      const labels = post.sectionLabels || {};
      const section = (key, fallback) => {
        const html = post[key];
        return html ? `### ${labels[key] || fallback}\n\n${htmlToText(html)}` : '';
      };
      const summary = [
        section('description', 'About the company'),
        section('requirements', 'About the role'),
        section('responsibilities', 'About you'),
      ].filter(Boolean).join('\n\n');
      const salary = post.payTransparencyMinSalary && post.payTransparencyMaxSalary
        ? `Salary range: ${post.payTransparencyMinSalary}–${post.payTransparencyMaxSalary} `
          + `${post.payTransparencySalaryCurrency || ''} (${post.payTransparencySalaryPayPeriod || 'unspecified period'})`
        : '';
      return {
        company: tenant.replace(/(^|[-_])([a-z])/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()),
        role: post.title || 'Unknown role',
        fetchMethod: 'ats-api',
        jdStatus: 'active',
        postingAge: postingAge(post.publishedAt),
        location: post.site || post.country || 'unspecified',
        remoteScope: workplaceToScope(post.workspaceTypeId || post.workspaceType),
        summary,
        other: [salary, post.employmentType, post.department, section('benefits', 'Benefits')]
          .filter(Boolean).join('\n\n'),
      };
    },
  },
};

// ── Registry (learned host → handler) ────────────────────────────────

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { version: 1, entries: [] };
  try {
    const r = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
    if (!Array.isArray(r.entries)) r.entries = [];
    return r;
  } catch {
    return { version: 1, entries: [] };
  }
}
function saveRegistry(r) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2) + '\n');
}

// Returns { handlerName, params } or null. Registry beats built-ins so a
// learned custom-domain mapping (careers.acme.com → greenhouse @ acme)
// wins over a generic guess.
function resolveHandler(url) {
  let host;
  try { host = new URL(url).host; } catch { return null; }

  for (const e of loadRegistry().entries) {
    const hit = e.matchType === 'regex'
      ? new RegExp(e.match).test(url)
      : host === e.match || host.endsWith(`.${e.match}`);
    if (hit && handlers[e.handler]) {
      // Registry already told us the provider. The strict match() is
      // host-anchored and won't fire on a custom domain, so prefer the
      // host-agnostic extract() (pulls just the per-posting id from the
      // path). Registry params (org/tenant slug) overlay on top.
      const h = handlers[e.handler];
      const fromUrl = (h.extract ? h.extract(url) : h.match(url)) || {};
      return { handlerName: e.handler, params: { ...fromUrl, ...(e.params || {}), url } };
    }
  }
  for (const [name, h] of Object.entries(handlers)) {
    const params = h.match(url);
    if (params) return { handlerName: name, params: { ...params, url } };
  }
  return null;
}

// ── Dedup (modes/_fetch.md Step 1) ───────────────────────────────────

// Single scan of data/jds/ for the first file whose body contains needle.
function findJdContaining(needle) {
  if (!needle || !existsSync(JDS_DIR)) return null;
  for (const f of readdirSafe(JDS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const body = readFileSync(join(JDS_DIR, f), 'utf-8');
    if (body.includes(needle)) {
      const num = (f.match(/^(\d+)/) || [])[1] || null;
      return { path: join(JDS_DIR, f), num };
    }
  }
  return null;
}
// Dedup key: canonicalizeUrl (fragment, tracking query, trailing slash,
// /application) plus scheme and `www.` folded, so variants of one posting match.
function urlKey(u) {
  const c = canonicalizeUrl(u);
  return c && c.replace(/^http:/, 'https:').replace(/^https:\/\/www\./, 'https://');
}
function jdPathForNum(num) {
  const f = readdirSafe(JDS_DIR).find(n => n.startsWith(`${num}-`) && n.endsWith('.md'));
  return f ? join(JDS_DIR, f) : null;
}
function findExistingJd(url) {
  const key = urlKey(url);
  if (!key || !existsSync(JDS_DIR)) return null;
  for (const f of readdirSafe(JDS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const m = readFileSync(join(JDS_DIR, f), 'utf-8').match(/^\*\*URL:\*\*\s*(\S+)/m);
    if (m && urlKey(m[1]) === key) {
      return { path: join(JDS_DIR, f), num: (f.match(/^(\d+)/) || [])[1] || null };
    }
  }
  return null;
}
// scan-history.db links URLs to NUMs (every NUM-reserving writer + backfill
// from JD files and report headers), so a URL stays known after its JD file
// is deleted. Several NUMs for one URL (re-fetch before dedup-tracker): prefer
// the newest that still has a tracker row.
function findKnownNum(urls) {
  const keys = new Set(urls.map(urlKey).filter(Boolean));
  if (!keys.size) return null;
  let rows;
  try {
    const db = openScanHistoryDb({ dryRun: false });
    rows = knownNums(db);
    db.close();
  } catch (e) {
    log(`scan-history lookup skipped: ${e.message}`);
    return null;
  }
  const nums = [...new Set(rows.filter(r => keys.has(urlKey(r.url))).map(r => r.num))]
    .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  if (!nums.length) return null;
  const num = nums.find(n => appStatusForNum(n) != null) || nums[0];
  return { num, path: jdPathForNum(num) };
}
function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}
// Tracker row for a NUM: `#` column (unpadded in the tracker: `| 6 |` for JD
// 006), else a row whose Report link points at it (re-evals: row 317 → [960]).
function appStatusForNum(num) {
  if (!num || !existsSync(APPLICATIONS_PATH)) return null;
  const n = parseInt(num, 10);
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const m = text.match(new RegExp(`^\\|\\s*0*${n}\\s*\\|([^\\n]*)`, 'm'))
    || text.match(new RegExp(`^\\|\\s*\\d+\\s*\\|([^\\n]*\\[0*${n}\\]\\(data/reports/[^\\n]*)`, 'm'));
  if (!m) return null;
  const cells = m[1].split('|').map(c => c.trim());
  // m[1] is everything after "| {num} |", so cells index from Date:
  // 0=Date 1=Company 2=Role 3=Score 4=Status 5=PDF 6=Report 7=Notes
  return cells[4] || null;
}

function sanitizeCell(s) { return String(s ?? '').replace(/\|/g, '/'); }
function appendApplicationRow({ num, company, role }) {
  appendFileSync(
    APPLICATIONS_PATH,
    `| ${num} | ${TODAY} | ${sanitizeCell(company)} | ${sanitizeCell(role)} |  | Fetched | ❌ |  |  |  |  |  |  |\n`,
  );
}

// Best-effort: keep scan-history.db the authoritative dedup index for every
// ingestion path. A fetch must NEVER fail because recording failed — the
// JD + applications row are the durable artifacts; this is just the index.
function recordFetchSafe({ canonicalUrl, company, role, url, status = 'added', num = null }) {
  try {
    let linkedInId = null;
    const cm = String(canonicalUrl || '').match(/linkedin\.com\/jobs\/view\/(\d+)/);
    if (cm) linkedInId = cm[1];
    else { const li = handlers.linkedin.match(url); if (li?.id) linkedInId = String(li.id); }
    const db = openScanHistoryDb({ dryRun: false });
    recordFetch(db, { canonicalUrl, linkedInId, portal: 'fetch-jd', title: role, company, status, num });
    db.close();
  } catch (e) {
    process.stderr.write(`[fetch-jd] scan-history record skipped: ${e.message}\n`);
  }
}

// ── Output ───────────────────────────────────────────────────────────

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// ── Subcommands ──────────────────────────────────────────────────────

function cmdLearn(argv) {
  const [, matchVal, handlerName] = argv;
  if (!matchVal || !handlerName) {
    emit({ status: 'error', reason: 'usage: --learn <hostOrPattern> <handler> [--params JSON] [--regex] [--note ...]' });
    process.exit(2);
  }
  if (!handlers[handlerName]) {
    emit({ status: 'error', reason: `unknown handler "${handlerName}". Known: ${Object.keys(handlers).join(', ')}` });
    process.exit(2);
  }
  const pIdx = argv.indexOf('--params');
  const nIdx = argv.indexOf('--note');
  const entry = {
    match: matchVal,
    matchType: argv.includes('--regex') ? 'regex' : 'host',
    handler: handlerName,
    params: pIdx > -1 ? JSON.parse(argv[pIdx + 1]) : {},
    note: nIdx > -1 ? argv[nIdx + 1] : '',
    source: 'learned',
    added: TODAY,
  };
  const reg = loadRegistry();
  const dup = reg.entries.find(e => e.match === entry.match && e.handler === entry.handler);
  if (dup) { emit({ status: 'ok', action: 'noop', reason: 'already in registry', entry }); return; }
  reg.entries.push(entry);
  saveRegistry(reg);
  emit({ status: 'ok', action: 'learned', entry });
}

function cmdList() {
  emit({
    status: 'ok',
    builtinHandlers: Object.keys(handlers),
    registry: loadRegistry().entries,
  });
}

// ── Main URL flow ────────────────────────────────────────────────────

async function cmdFetch(url, { dryRun }) {
  // Dedup BEFORE any provider call (modes/_fetch.md Step 1). Re-running an
  // already-saved URL must not re-hit the upstream — that spends a needless
  // Voyager call for LinkedIn and spuriously `error`s if the source has since
  // 404'd. The input URL canonicalizes to the stored `**URL:**` for every
  // non-LinkedIn provider and for easy-apply LinkedIn roles.
  const inputCanonical = canonicalizeUrl(url);
  let existing = inputCanonical ? findExistingJd(inputCanonical) : null;
  // Employer-resolved LinkedIn roles store the employer ATS URL as
  // canonical, but scan-linkedin.mjs also writes a `**LinkedIn job URL:**`
  // line — match the job id against that so we skip the Voyager call.
  if (!existing) {
    const li = handlers.linkedin.match(url);
    if (li?.id) existing = findJdContaining(`linkedin.com/jobs/view/${li.id}`);
  }
  // remotepmjobs (and similar) roles store the employer ATS URL as **URL:** and
  // the original aggregator URL on a **Source:** line — match that so the
  // dispatched/pasted aggregator URL still dedups to the on-disk JD.
  if (!existing && inputCanonical) {
    existing = findJdContaining(`**Source:** ${inputCanonical}`);
  }
  if (!existing) {
    const li = handlers.linkedin.match(url);
    existing = findKnownNum([url, ...(li?.id ? [`https://www.linkedin.com/jobs/view/${li.id}`] : [])]);
  }
  if (existing) {
    recordFetchSafe({ canonicalUrl: inputCanonical, url, num: existing.num });
    emit({
      status: 'exists', num: existing.num, path: existing.path,
      appStatus: appStatusForNum(existing.num),
    });
    return;
  }

  // Guard A — ban check BEFORE resolveHandler / any network call. A banned
  // URL never costs a fetch, never falls back to the LLM _fetch.md path,
  // and never creates a row. Logged as status='banned' so it is remembered
  // for dedup and never re-dispatched. Covers host AND ATS-slug forms
  // (e.g. mercor.com and careers-page.com/mercor).
  {
    const banned = isBanned({ url });
    if (banned) {
      recordFetchSafe({ canonicalUrl: inputCanonical || url, url, status: 'banned' });
      emit({ status: 'banned', company: banned, url });
      return;
    }
  }

  const resolved = resolveHandler(url);
  if (!resolved) {
    let host = '';
    try { host = new URL(url).host; } catch { /* noop */ }
    emit({ status: 'unknown-host', host, url,
      hint: 'resolve the structured source, then persist it: node lib/fetch-jd.mjs --learn <host> <handler> [--params ...]' });
    return;
  }

  const { handlerName, params } = resolved;
  let normalized;
  try {
    normalized = await handlers[handlerName].fetch(params, url);
  } catch (e) {
    emit({ status: 'error', handler: handlerName, url, reason: e.message });
    return;
  }

  const canonicalUrl = normalized.canonicalUrl || canonicalizeUrl(url);

  // Second-guard dedup: for LinkedIn, the employer ATS canonical is only
  // known after the Voyager call, so a *different* LinkedIn id that resolves
  // to an already-saved employer URL is caught only here.
  const existingResolved = findExistingJd(canonicalUrl) || findKnownNum([canonicalUrl]);
  if (existingResolved) {
    recordFetchSafe({ canonicalUrl, url, num: existingResolved.num });
    emit({
      status: 'exists', num: existingResolved.num, path: existingResolved.path,
      appStatus: appStatusForNum(existingResolved.num), handler: handlerName,
    });
    return;
  }

  // Guard B — ban check on the parsed company, after the (zero-token,
  // deterministic) handler fetch but BEFORE the applications.md row,
  // scoring, or CV-gen. Catches a banned company on a host the URL
  // substrings don't cover (e.g. a plain Greenhouse board).
  {
    const banned = isBanned({ url: canonicalUrl, company: normalized.company });
    if (banned) {
      recordFetchSafe({ canonicalUrl, url, status: 'banned' });
      emit({ status: 'banned', company: banned, url, handler: handlerName });
      return;
    }
  }

  if (normalized.expired) {
    normalized.jdStatus = 'expired';
    normalized.summary = normalized.summary || '_Posting expired — kept for the trail._';
  }

  if (dryRun) {
    emit({
      status: normalized.jdStatus === 'expired' ? 'expired' : 'ok',
      dryRun: true, handler: handlerName, canonicalUrl,
      company: normalized.company, role: normalized.role,
    });
    return;
  }

  mkdirSync(JDS_DIR, { recursive: true });
  let num;
  try {
    num = nextNum();
    const slug = `${slugify(normalized.company)}-${slugify(normalized.role)}`;
    const path = resolve(JDS_DIR, `${num}-${slug}.md`);
    const md = normalized._linkedinDetail
      ? buildJdMarkdown({ canonicalUrl, fetchedDate: TODAY, detail: normalized._linkedinDetail })
      : buildGenericJd({ ...normalized, canonicalUrl });
    writeFileSync(path, md);
    appendApplicationRow({ num, company: normalized.company, role: normalized.role });
    recordFetchSafe({ canonicalUrl, company: normalized.company, role: normalized.role, url, num });
    emit({
      status: normalized.jdStatus === 'expired' ? 'expired' : 'ok',
      num, path, handler: handlerName, canonicalUrl,
      company: normalized.company, role: normalized.role,
    });
  } catch (e) {
    emit({ status: 'error', handler: handlerName, url, reason: e.message });
  } finally {
    if (num) releaseNum(num);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--learn') return cmdLearn(argv);
  if (argv[0] === '--list') return cmdList();

  const url = argv.find(a => /^https?:\/\//.test(a));
  if (!url) {
    emit({ status: 'error', reason: 'no URL given. Usage: node lib/fetch-jd.mjs <url> [--dry-run]' });
    process.exit(2);
  }
  await cmdFetch(url, { dryRun: argv.includes('--dry-run') });
}

// Run only when executed directly, not when imported (e.g. by the test that
// exercises assertPublicTarget in isolation).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    emit({ status: 'error', reason: e.message });
    process.exit(1);
  });
}

export { assertPublicTarget };
