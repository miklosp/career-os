// scan-weworkremotely.mjs — zero-token discovery + JD prefetch from
// weworkremotely.com category RSS feeds (free, no paid vendor).
//
// WWR publishes a full per-category RSS feed (e.g. /categories/
// remote-product-jobs.rss). Each <item> carries the ENTIRE job description in
// <description> (entity-encoded HTML), plus <expires_at>, employer name (title
// prefix `Company: Role`), and a clean Headquarters/URL block in the body. So
// — like the LinkedIn JobSpy path — we can prefetch the JD straight to disk
// with no second fetch and no LLM tokens.
//
// Apply URL is WWR-internal only (weworkremotely.com/remote-jobs/{slug}); WWR
// never exposes the employer ATS in the feed. The canonical URL we store and
// dispatch IS that WWR detail page; external-ATS resolution defers to
// apply-time (same as LinkedIn-without-Voyager). The category bucket is loose
// (a "product" feed contains sales/eng noise) — the global title_filter from
// portals.yml does the precise include/exclude, exactly as for every level.
//
// Flow per feed URL in portals.yml `weworkremotely_feeds`:
//   1. GET the .rss, parse <item> blocks.
//   2. Dedup the WWR detail URL against scan-history.db + applications.md.
//   3. Drop expired (<expires_at> in the past), title-filtered, banned.
//   4. For each survivor: reserve NUM, write data/jds/{NUM}-{slug}.md with the
//      decoded JD body, append a Fetched row, record in scan-history.
//   5. Return the WWR detail URLs for DISPATCH_URLS — the agent's fetch-jd.mjs
//      matches `**URL:**` on disk and skips _fetch.md straight to gate+score.
//
// canonicalizeUrl is reused from scan-linkedin.mjs so the `**URL:**` written
// here is byte-identical to what fetch-jd.mjs canonicalizes the dispatched URL
// to — that string match is the whole dedup contract.

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { resolve } from 'path';
import { nextNum, releaseNum } from './next-num.mjs';
import { loadSeenUrls, recordOffer, recordFetch } from './scan-history.mjs';
import { isBanned } from './ban-list.mjs';
import { canonicalizeUrl } from './scan-linkedin.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36';

// ── HTML entity decode + tag strip ───────────────────────────────────

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  hellip: '…', deg: '°', eacute: 'é', egrave: 'è',
};

function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isNaN(code) ? m : String.fromCodePoint(code);
    }
    return ENTITY_MAP[name.toLowerCase()] ?? m;
  });
}

// description is entity-encoded HTML — decode once to real HTML, convert block
// tags to newlines / list markers, strip remaining tags, decode once more to
// catch double-encoded entities (&amp;nbsp; → &nbsp; → space).
function htmlToText(encoded) {
  if (!encoded) return '';
  let s = decodeEntities(encoded);
  s = s
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|ul|ol|tr|table|section)\s*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\/\s*li\s*>/gi, '')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Feed parse ───────────────────────────────────────────────────────

function field(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

export function parseFeed(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const rawTitle = decodeEntities(field(block, 'title') || '').trim();
    const link = (field(block, 'link') || field(block, 'guid') || '').trim();
    if (!rawTitle || !link) continue;

    // "Company: Role | brand | location" → company before first ": ",
    // role after, with trailing " | …" brand/location segments dropped.
    let company = null;
    let role = rawTitle;
    const ci = rawTitle.indexOf(': ');
    if (ci > 0) {
      company = rawTitle.slice(0, ci).trim();
      role = rawTitle.slice(ci + 2).trim();
    }
    role = role.split(' | ')[0].trim();

    const descHtml = field(block, 'description') || '';
    const bodyFull = htmlToText(descHtml);
    // cut the redundant trailing "To apply: {wwr url}" line.
    const body = bodyFull.split(/\n?\s*To apply:/i)[0].trim();

    const decoded = decodeEntities(descHtml);
    const hqLocation = (decoded.match(/Headquarters:\s*<\/strong>\s*([^<]+)/i)?.[1] || '').trim() || null;
    const employerUrl = (decoded.match(/URL:\s*<\/strong>\s*<a[^>]*href="([^"]+)"/i)?.[1] || '').trim() || null;

    items.push({
      company,
      role,
      region: decodeEntities(field(block, 'region') || '').trim() || null,
      country: decodeEntities(field(block, 'country') || '').trim() || null,
      type: decodeEntities(field(block, 'type') || '').trim() || null,
      link,
      pubDate: field(block, 'pubDate'),
      expiresAt: field(block, 'expires_at'),
      hqLocation,
      employerUrl,
      body,
    });
  }
  return items;
}

// ── Title filter (same contract as the other levels) ─────────────────

function passesTitleFilter(title, titleFilter) {
  if (!titleFilter) return true;
  const lower = (title ?? '').toLowerCase();
  const positive = (titleFilter.positive ?? []).map(s => s.toLowerCase());
  const negative = (titleFilter.negative ?? []).map(s => s.toLowerCase());
  if (positive.length > 0 && !positive.some(k => lower.includes(k))) return false;
  if (negative.some(k => lower.includes(k))) return false;
  return true;
}

// ── JD writer (matches the **URL:**/**Status:** shape fetch-jd expects) ──

function slugify(s, max = 50) {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

function postingAgeStr(pubDate) {
  if (!pubDate) return 'unspecified';
  const t = new Date(pubDate).getTime();
  if (Number.isNaN(t)) return 'unspecified';
  const days = Math.max(0, Math.round((Date.now() - t) / 86400_000));
  return days === 0 ? 'today' : `${days} days ago`;
}

function buildWwrJd({ canonicalUrl, fetchedDate, item }) {
  const company = item.company || 'Unknown Company';
  const role = item.role || 'Unknown Role';
  const lines = [];
  lines.push(`# ${company} — ${role}`);
  lines.push('');
  lines.push(`**URL:** ${canonicalUrl}`);
  lines.push(`**Fetched:** ${fetchedDate}`);
  lines.push(`**Fetch-method:** weworkremotely-rss`);
  lines.push(`**Posting age:** ${postingAgeStr(item.pubDate)}`);
  lines.push(`**Status:** active`);
  lines.push('');
  lines.push(`**Location:** ${item.region || item.hqLocation || 'unspecified'}`);
  lines.push(`**Remote scope:** full-remote-region:unspecified`);
  lines.push(`**Timezone:** unspecified`);
  lines.push(`**Visa/authorization:** unspecified`);
  lines.push(`**Relocation offered:** unspecified`);
  lines.push('');
  lines.push(`**Job type:** ${item.type || 'unspecified'}`);
  lines.push(`**Listed at:** ${item.pubDate || 'unspecified'}`);
  lines.push(`**Expires at:** ${item.expiresAt || 'unspecified'}`);
  if (item.hqLocation) lines.push(`**Headquarters:** ${item.hqLocation}`);
  if (item.employerUrl) lines.push(`**Employer homepage:** ${item.employerUrl}`);
  lines.push(`**WWR apply page:** ${canonicalUrl}`);
  lines.push('');
  lines.push('## Role Summary');
  lines.push('');
  lines.push(item.body || '_No description in feed._');
  lines.push('');
  return lines.join('\n');
}

function sanitizeCell(s) {
  return String(s ?? '').replace(/\|/g, '/');
}

function appendApplicationRow({ applicationsPath, num, fetchedDate, company, role }) {
  const row = `| ${num} | ${fetchedDate} | ${sanitizeCell(company)} | ${sanitizeCell(role)} |  | Fetched | ❌ |  |  |\n`;
  appendFileSync(applicationsPath, row);
}

// ── HTTP ─────────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
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
 *   stats: { feeds, itemsSeen, alreadySeen, prefetched, skippedTitle,
 *            banned, expired, failed }
 * }>}
 */
export async function runWeWorkRemotelyScan({
  db,
  portalsCfg,
  applicationsPath,
  jdsDir,
  dryRun = false,
  log = (...args) => console.error('[weworkremotely]', ...args),
}) {
  const feeds = (portalsCfg.weworkremotely_feeds ?? []).filter(f => f.enabled !== false);
  const titleFilter = portalsCfg.title_filter ?? null;
  const stats = {
    feeds: feeds.length, itemsSeen: 0, alreadySeen: 0, prefetched: 0,
    skippedTitle: 0, banned: 0, expired: 0, failed: 0,
  };

  if (feeds.length === 0) {
    log('no enabled weworkremotely_feeds in portals.yml');
    return { newUrls: [], stats };
  }

  const seenCanonical = new Set(loadSeenUrls(db, { applicationsPath }));
  const fetchedDate = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const newUrls = [];

  for (const feed of feeds) {
    if (!feed.url) { log(`feed entry "${feed.name ?? '?'}" has no url`); continue; }
    let xml;
    try {
      xml = await fetchText(feed.url);
    } catch (err) {
      stats.failed++;
      log(`feed ${feed.url} failed: ${err.message}`);
      continue;
    }
    const items = parseFeed(xml);
    stats.itemsSeen += items.length;
    log(`${feed.name ?? feed.url}: ${items.length} items`);

    for (const item of items) {
      const canonical = canonicalizeUrl(item.link);
      if (!canonical) continue;

      if (seenCanonical.has(canonical)) { stats.alreadySeen++; continue; }
      seenCanonical.add(canonical);

      // expired listing — log + skip, never dispatch.
      if (item.expiresAt) {
        const exp = new Date(item.expiresAt).getTime();
        if (!Number.isNaN(exp) && exp < now) {
          stats.expired++;
          if (!dryRun) recordOffer(db, { url: canonical, firstSeen: fetchedDate, portal: 'weworkremotely', title: item.role, company: item.company, status: 'skipped_expired' });
          continue;
        }
      }

      if (isBanned({ company: item.company, url: canonical })) {
        stats.banned++;
        if (!dryRun) recordOffer(db, { url: canonical, firstSeen: fetchedDate, portal: 'weworkremotely', title: item.role, company: item.company, status: 'banned' });
        continue;
      }

      if (!passesTitleFilter(item.role, titleFilter)) {
        stats.skippedTitle++;
        if (!dryRun) recordOffer(db, { url: canonical, firstSeen: fetchedDate, portal: 'weworkremotely', title: item.role, company: item.company, status: 'skipped_title' });
        continue;
      }

      if (dryRun) {
        newUrls.push(canonical);
        stats.prefetched++;
        log(`+ (dry) ${item.company ?? '?'} | ${item.role} → ${canonical}`);
        continue;
      }

      let num;
      try {
        num = nextNum();
      } catch (err) {
        log(`nextNum() failed: ${err.message}`);
        continue;
      }
      const company = item.company?.trim() || 'Unknown Company';
      const role = item.role?.trim() || 'Unknown Role';
      const slug = `${slugify(company)}-${slugify(role)}`;
      const jdPath = resolve(jdsDir, `${num}-${slug}.md`);
      try {
        writeFileSync(jdPath, buildWwrJd({ canonicalUrl: canonical, fetchedDate, item }));
        appendApplicationRow({ applicationsPath, num, fetchedDate, company, role });
        recordFetch(db, { canonicalUrl: canonical, portal: 'weworkremotely', title: role, company, firstSeen: fetchedDate });
        newUrls.push(canonical);
        stats.prefetched++;
        log(`+ NUM ${num} ${company} | ${role} → ${canonical}`);
      } catch (err) {
        log(`failed to write NUM ${num} (${company} / ${role}): ${err.message}`);
      } finally {
        releaseNum(num);
      }
    }
  }

  return { newUrls, stats };
}

// ── CLI mode (ad-hoc testing) ────────────────────────────────────────
// `node lib/scan-weworkremotely.mjs --dry-run` uses data/scan-history.db,
// config/portals.yml, data/applications.md, data/jds/ from the project root.

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import('better-sqlite3')).default;
  const yaml = (await import('js-yaml')).default;
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database('data/scan-history.db');
  const portalsCfg = yaml.load(readFileSync('config/portals.yml', 'utf-8'));
  const { newUrls, stats } = await runWeWorkRemotelyScan({
    db, portalsCfg, applicationsPath: 'data/applications.md', jdsDir: resolve('data/jds'), dryRun,
  });
  console.log('\nstats:', stats);
  console.log('\nnewUrls:', newUrls);
}
