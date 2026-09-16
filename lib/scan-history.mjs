/**
 * scan-history.mjs — the single shared persistence layer for the
 * URL-level dedupe log (data/scan-history.db).
 *
 * Every writer goes through here: scan.mjs (Level-1 ATS), scan-linkedin.mjs
 * (Level-2 LinkedIn), scan-remoteineurope.mjs (Level-2b), and fetch-jd.mjs (the
 * deterministic fetcher — the path that historically did NOT record, which
 * is what allowed the 434/536 Curoflow duplicate). One module owns the
 * schema, the open/migration, and the canonical INSERT, so the DB is a
 * complete and authoritative index — a single query gives the whole list,
 * no filesystem corpus walk required.
 *
 * Schema (single table, PK = url):
 *   offers(url, first_seen, portal, title, company, status)
 *
 * Subcommand:
 *   node lib/scan-history.mjs --backfill        seed the DB from data/jds/*.md
 *   node lib/scan-history.mjs --backfill --dry-run
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';

const DB_PATH = 'data/scan-history.db';
const TSV_LEGACY = 'data/scan-history.tsv';
const APPLICATIONS_PATH = 'data/applications.md';
const JDS_DIR = 'data/jds';
const TODAY = () => new Date().toISOString().slice(0, 10);

// ── open / schema / one-shot TSV migration ──────────────────────────

export function openScanHistoryDb({ dryRun = false } = {}) {
  const dbExisted = existsSync(DB_PATH);
  if (dryRun && !dbExisted) {
    throw new Error(
      '--dry-run requires an initialized data/scan-history.db. ' +
      'Run a real scan once first to create it.',
    );
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS offers (
      url        TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      portal     TEXT,
      title      TEXT,
      company    TEXT,
      status     TEXT NOT NULL DEFAULT 'added'
    );
    CREATE INDEX IF NOT EXISTS idx_offers_first_seen ON offers(first_seen);
    CREATE INDEX IF NOT EXISTS idx_offers_company    ON offers(company);
  `);

  if (!dryRun) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM offers').get();
    if (n === 0 && existsSync(TSV_LEGACY)) {
      const lines = readFileSync(TSV_LEGACY, 'utf-8').split('\n');
      const insert = db.prepare(
        `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
         VALUES (@url, @first_seen, @portal, @title, @company, @status)`,
      );
      const tx = db.transaction(rows => { for (const r of rows) insert.run(r); });
      const rows = [];
      for (const line of lines.slice(1)) {
        const f = line.split('\t');
        if (!f[0] || f[0] === 'url') continue;
        rows.push({
          url: f[0],
          first_seen: f[1] || TODAY(),
          portal: f[2] || null,
          title: f[3] || null,
          company: f[4] || null,
          status: f[5] || 'added',
        });
      }
      tx(rows);
      const bak = `${TSV_LEGACY}.bak-${TODAY()}`;
      renameSync(TSV_LEGACY, bak);
      console.error(`📦 Migrated ${rows.length} rows from ${TSV_LEGACY} → ${DB_PATH}`);
      console.error(`   Legacy TSV preserved at ${bak}`);
    }
  }

  return db;
}

// ── the one canonical writer ────────────────────────────────────────

const RECORD_SQL =
  `INSERT OR IGNORE INTO offers (url, first_seen, portal, title, company, status)
   VALUES (@url, @firstSeen, @portal, @title, @company, @status)`;

/** Record one offer URL. Idempotent (PK = url, INSERT OR IGNORE). */
export function recordOffer(db, { url, firstSeen, portal = null, title = null, company = null, status = 'added' }) {
  if (!url) return;
  db.prepare(RECORD_SQL).run({
    url, firstSeen: firstSeen || TODAY(), portal, title, company, status,
  });
}

/** Record a batch in a single transaction. */
export function recordOffers(db, offers, { firstSeen, portal = null, status = 'added' } = {}) {
  const stmt = db.prepare(RECORD_SQL);
  const fs = firstSeen || TODAY();
  db.transaction(items => {
    for (const o of items) {
      stmt.run({
        url: o.url,
        firstSeen: o.firstSeen || fs,
        portal: o.portal ?? portal,
        title: o.title ?? null,
        company: o.company ?? null,
        status: o.status ?? status,
      });
    }
  })(offers.filter(o => o?.url));
}

/**
 * What fetch-jd.mjs calls on every successful fetch. Records the canonical
 * URL and — when the role is/resolves-from LinkedIn — the
 * linkedin.com/jobs/view/<id> row too, so the LinkedIn scanner's skipJobId
 * pool covers ATS-first roles (the 434/536 fix, done at the source).
 */
export function recordFetch(db, { canonicalUrl, linkedInId, portal = 'fetch-jd', title = null, company = null, firstSeen, status = 'added' }) {
  const fs = firstSeen || TODAY();
  if (canonicalUrl) recordOffer(db, { url: canonicalUrl, firstSeen: fs, portal, title, company, status });
  if (linkedInId) {
    recordOffer(db, {
      url: `https://www.linkedin.com/jobs/view/${linkedInId}`,
      firstSeen: fs, portal, title, company, status,
    });
  }
}

// ── readers ─────────────────────────────────────────────────────────

/** Every URL ever seen — DB ∪ inline URLs in applications.md. */
export function loadSeenUrls(db, { applicationsPath = APPLICATIONS_PATH } = {}) {
  const seen = new Set();
  for (const row of db.prepare('SELECT url FROM offers').all()) seen.add(row.url);
  if (existsSync(applicationsPath)) {
    const text = readFileSync(applicationsPath, 'utf-8');
    for (const m of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(m[0]);
  }
  return seen;
}

/** LinkedIn job ids already seen, for scan-side skipJobId dedup. */
export function linkedInSkipIds(db) {
  const ids = new Set();
  for (const r of db
    .prepare(`SELECT url FROM offers WHERE url LIKE 'https://www.linkedin.com/jobs/view/%'`)
    .all()) {
    const m = r.url.match(/jobs\/view\/(\d+)/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

// ── one-time backfill from the JD corpus ────────────────────────────

/**
 * Seed the DB from data/jds/*.md so roles fetched before every-writer-records
 * was wired (≈475 pre-existing JDs, incl. all the ATS-first ones fetch-jd
 * never recorded) become part of the authoritative index. Idempotent.
 */
export function backfillFromJds(db, { jdsDir = JDS_DIR, dryRun = false } = {}) {
  let files = 0, urls = 0, liIds = 0;
  const offers = [];
  for (const f of readdirSync(jdsDir)) {
    if (!f.endsWith('.md')) continue;
    files++;
    const body = readFileSync(join(jdsDir, f), 'utf-8');
    const urlLine = body.match(/^\*\*URL:\*\*\s*(\S+)/m);
    const company = (body.match(/^#\s+(.+?)\s+—/m) || [])[1] || null;
    if (urlLine) { offers.push({ url: urlLine[1], company, portal: 'jd-backfill' }); urls++; }
    const ids = new Set();
    for (const m of body.matchAll(/linkedin\.com\/jobs\/view\/(\d+)/g)) ids.add(m[1]);
    for (const id of ids) {
      offers.push({ url: `https://www.linkedin.com/jobs/view/${id}`, company, portal: 'jd-backfill' });
      liIds++;
    }
  }
  if (!dryRun) recordOffers(db, offers);
  return { files, urls, liIds, rows: offers.length };
}

// ── CLI: --backfill ─────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--backfill')) {
    console.error('usage: node lib/scan-history.mjs --backfill [--dry-run]');
    process.exit(2);
  }
  const dryRun = argv.includes('--dry-run');
  const before = existsSync(DB_PATH) ? new Database(DB_PATH).prepare('SELECT COUNT(*) AS n FROM offers').get().n : 0;
  const db = openScanHistoryDb({ dryRun: false });
  const r = backfillFromJds(db, { dryRun });
  const after = db.prepare('SELECT COUNT(*) AS n FROM offers').get().n;
  console.error(
    `backfill${dryRun ? ' (dry-run)' : ''}: scanned ${r.files} JD files → ` +
    `${r.urls} canonical URLs + ${r.liIds} linkedin ids (${r.rows} rows). ` +
    `offers: ${before} → ${after} (+${after - before}).`,
  );
}
