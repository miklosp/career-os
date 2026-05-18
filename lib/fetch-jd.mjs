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
 *   1. Dedup — already in data/jds/? emit {status:"exists",...}
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
import { nextNum, releaseNum } from './next-num.mjs';
import { canonicalizeUrl, buildJdMarkdown } from './scan-linkedin.mjs';
import { openScanHistoryDb, recordFetch } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';
import {
  hasVoyagerCookies, fetchJobPosting, parseJobPosting, pickAts, fetchGuestCompanyName,
} from './li-voyager.mjs';

const JDS_DIR = 'data/jds';
const APPLICATIONS_PATH = 'data/applications.md';
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
  // Decode first so the tag-stripping below actually sees tags.
  if (/&lt;|&gt;/.test(s)) s = decodeEntities(s);
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

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (career-ops fetch-jd)', ...opts.headers },
      ...opts,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, finalUrl: res.url };
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
      const m = r.body.match(
        /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i,
      );
      if (!m) throw new Error('no JSON-LD JobPosting on teamtailor page');
      const ld = JSON.parse(m[1].trim());
      const jp = Array.isArray(ld) ? ld.find(x => x['@type'] === 'JobPosting') : ld;
      if (!jp) throw new Error('JSON-LD present but not a JobPosting');
      const loc = jp.jobLocation?.address;
      return {
        company: jp.hiringOrganization?.name || 'Unknown',
        role: jp.title || 'Unknown role',
        fetchMethod: 'xh',
        jdStatus: 'active',
        postingAge: postingAge(jp.datePosted),
        location: loc
          ? [loc.addressLocality, loc.addressCountry].filter(Boolean).join(', ')
          : 'unspecified',
        remoteScope: workplaceToScope(jp.jobLocationType || ''),
        summary: htmlToText(jp.description),
        other: jp.employmentType ? `Employment type: ${jp.employmentType}` : '',
      };
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
      // Re-shape into the Apify-detail shape buildJdMarkdown expects so the
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
      return { _linkedinDetail: detail, canonicalUrl: canonical, company, role };
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
      const num = (f.match(/^(\d{3})/) || [])[1] || null;
      return { path: join(JDS_DIR, f), num };
    }
  }
  return null;
}
function findExistingJd(canonicalUrl) {
  return findJdContaining(`**URL:** ${canonicalUrl}`);
}
function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}
function appStatusForNum(num) {
  if (!num || !existsSync(APPLICATIONS_PATH)) return null;
  const re = new RegExp(`^\\|\\s*${num}\\s*\\|([^\\n]*)`, 'm');
  const m = readFileSync(APPLICATIONS_PATH, 'utf-8').match(re);
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
    `| ${num} | ${TODAY} | ${sanitizeCell(company)} | ${sanitizeCell(role)} |  | Fetched | ❌ |  |  |\n`,
  );
}

// Best-effort: keep scan-history.db the authoritative dedup index for every
// ingestion path. A fetch must NEVER fail because recording failed — the
// JD + applications row are the durable artifacts; this is just the index.
function recordFetchSafe({ canonicalUrl, company, role, url, status = 'added' }) {
  try {
    let linkedInId = null;
    const cm = String(canonicalUrl || '').match(/linkedin\.com\/jobs\/view\/(\d+)/);
    if (cm) linkedInId = cm[1];
    else { const li = handlers.linkedin.match(url); if (li?.id) linkedInId = String(li.id); }
    const db = openScanHistoryDb({ dryRun: false });
    recordFetch(db, { canonicalUrl, linkedInId, portal: 'fetch-jd', title: role, company, status });
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
  // line — match the job id against that so we skip the Apify call.
  if (!existing) {
    const li = handlers.linkedin.match(url);
    if (li?.id) existing = findJdContaining(`linkedin.com/jobs/view/${li.id}`);
  }
  if (existing) {
    recordFetchSafe({ canonicalUrl: inputCanonical, url });
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
  const existingResolved = findExistingJd(canonicalUrl);
  if (existingResolved) {
    recordFetchSafe({ canonicalUrl, url });
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
    recordFetchSafe({ canonicalUrl, company: normalized.company, role: normalized.role, url });
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

main().catch(e => {
  emit({ status: 'error', reason: e.message });
  process.exit(1);
});
