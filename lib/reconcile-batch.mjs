// reconcile-batch.mjs — one-off: retro-apply the URL-clean + repost-collapse
// fixes to an already-written scan batch (the buggy pre-fix live run).
//
// Operates on CURRENT state only — idempotent, never resurrects anything you
// manually discarded, tolerant of JD/row desync. Dry-run by default; nothing
// is written without --apply (which first backs up applications.md +
// scan-history.db and snapshots every JD it deletes).
//
//   node lib/reconcile-batch.mjs [--date YYYY-MM-DD] [--apply]
//
// What it does, scoped to JDs whose **Fetched:** == date:
//  1. Clean each JD **URL:** via li-voyager.cleanAtsUrl; mirror the change
//     into scan-history offers.url (UPDATE, or DELETE the junky row if the
//     clean URL already exists). /jobs/view/{id} rows are NEVER touched.
//  2. Collapse duplicates among the surviving JDs:
//       - ATS canonicals: group by identical cleaned URL
//       - bare LinkedIn canonicals (easy-apply/deferred): group by
//         slugify(company)|slugify(role)   (mirrors the in-scan fix)
//     keep the lowest NUM; the rest: delete the JD file + remove its exact
//     applications.md row. scan-history id-rows for the dropped dups are
//     KEPT so future scans still skip them.
//
// Exit 0 always (dry-run); 0 on a clean apply.

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import Database from 'better-sqlite3';
import { cleanAtsUrl, resolveAts } from './li-voyager.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PRUNE_EXPIRED = argv.includes('--prune-expired');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DATE = (argv[argv.indexOf('--date') + 1] && argv.includes('--date'))
  ? argv[argv.indexOf('--date') + 1]
  : new Date().toISOString().slice(0, 10);
const JDS_DIR = 'data/jds';
const APPLICATIONS = 'data/applications.md';
const DB_PATH = 'data/scan-history.db';

// --prune-expired needs LinkedIn cookies; load .env so the caller need not
// source it (the recurring env-not-inherited footgun).
if (PRUNE_EXPIRED && existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    if (process.env[k]) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
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

const isLinkedInUrl = (u) => /^https?:\/\/[^/]*linkedin\.com\/jobs\/view\//i.test(u || '');

// ── 1. Gather today's JDs from current disk state ────────────────────
const jds = [];
for (const f of readdirSync(JDS_DIR)) {
  if (!f.endsWith('.md')) continue;
  const numM = f.match(/^(\d+)-/);
  if (!numM) continue;
  const path = join(JDS_DIR, f);
  const body = readFileSync(path, 'utf-8');
  if (!new RegExp(`^\\*\\*Fetched:\\*\\* ${DATE}\\b`, 'm').test(body)) continue;
  const url = (body.match(/^\*\*URL:\*\*\s*(\S+)/m) || [])[1] || '';
  const head = body.match(/^#\s+(.+?)\s+—\s+(.+?)\s*$/m) || [];
  jds.push({
    num: Number(numM[1]), file: f, path, body,
    company: head[1] || 'Unknown', role: head[2] || 'Unknown',
    oldUrl: url, newUrl: cleanAtsUrl(url) || url,
  });
}
jds.sort((a, b) => a.num - b.num);

// ── 2. Plan URL rewrites + dedup groups ──────────────────────────────
const urlRewrites = jds.filter(j => j.newUrl && j.newUrl !== j.oldUrl);

const groups = new Map(); // key → [jd...] (in NUM order)
for (const j of jds) {
  const key = isLinkedInUrl(j.newUrl)
    ? `LI:${slugify(j.company)}|${slugify(j.role)}`
    : `URL:${j.newUrl}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(j);
}
const keep = [];
const drop = [];
for (const arr of groups.values()) {
  keep.push(arr[0]);
  for (const d of arr.slice(1)) drop.push(d);
}

// ── 2b. Prune expired/CLOSED (opt-in; re-queries Voyager) ────────────
// Only the bare-LinkedIn survivors (Easy-Apply/deferred) can be silently
// dead; offsite ones point at the employer ATS. Serial + paced.
const expiredDrop = [];
if (PRUNE_EXPIRED) {
  const cands = keep.filter(j => isLinkedInUrl(j.newUrl));
  console.error(`[prune-expired] re-checking ${cands.length} bare-LinkedIn survivors via Voyager…`);
  for (const j of cands) {
    const id = (j.newUrl.match(/jobs\/view\/(\d+)/) || [])[1];
    if (!id) continue;
    const r = await resolveAts(id, { log: () => {} });
    if (r.kind === 'auth-expired') {
      console.error('[prune-expired] Voyager auth-expired — stopping prune (cookies stale).');
      break;
    }
    if (r.expired) expiredDrop.push(j);
    await sleep(1200);
  }
  const exPaths = new Set(expiredDrop.map(j => j.path));
  for (let i = keep.length - 1; i >= 0; i--) if (exPaths.has(keep[i].path)) keep.splice(i, 1);
}

// ── 3. scan-history plan (read-only here) ────────────────────────────
const db = new Database(DB_PATH, { readonly: !APPLY });
const histPlan = []; // {action:'update'|'merge-delete', oldUrl, newUrl}
for (const j of urlRewrites) {
  if (isLinkedInUrl(j.oldUrl)) continue; // never touch id-rows
  const oldRow = db.prepare('SELECT 1 FROM offers WHERE url=?').get(j.oldUrl);
  if (!oldRow) continue;
  const clash = db.prepare('SELECT 1 FROM offers WHERE url=?').get(j.newUrl);
  histPlan.push({ action: clash ? 'merge-delete' : 'update', oldUrl: j.oldUrl, newUrl: j.newUrl });
}

// ── 4. Report ────────────────────────────────────────────────────────
console.log(`reconcile-batch — date=${DATE} mode=${APPLY ? 'APPLY' : 'dry-run'}`);
console.log(`today's JDs on disk: ${jds.length}`);
console.log(`URL rewrites (junky → clean): ${urlRewrites.length}`);
console.log(`duplicate JDs to drop: ${drop.length}  (keep ${keep.length} unique)`);
if (PRUNE_EXPIRED) {
  console.log(`expired/CLOSED JDs to prune: ${expiredDrop.length}`);
  for (const e of expiredDrop) console.log(`  ${e.num} — ${e.company} | ${e.role}`);
}
console.log(`scan-history: ${histPlan.filter(h => h.action === 'update').length} url-updates, ` +
  `${histPlan.filter(h => h.action === 'merge-delete').length} junky-row deletes (clean already present)`);
if (drop.length) {
  console.log('\nDropped duplicates (NUM — company | role  ← kept NUM):');
  for (const d of drop) {
    const k = (isLinkedInUrl(d.newUrl)
      ? groups.get(`LI:${slugify(d.company)}|${slugify(d.role)}`)
      : groups.get(`URL:${d.newUrl}`))[0];
    console.log(`  ${d.num} — ${d.company} | ${d.role}  ← ${k.num}`);
  }
}

if (!APPLY) {
  console.log('\n(dry-run — re-run with --apply to write; backups are taken automatically)');
  process.exit(0);
}

// ── 5. APPLY (backups first) ─────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bakDir = resolve(`data/.reconcile-bak-${stamp}`);
mkdirSync(bakDir, { recursive: true });
copyFileSync(APPLICATIONS, join(bakDir, 'applications.md'));
copyFileSync(DB_PATH, join(bakDir, 'scan-history.db'));
for (const d of [...drop, ...expiredDrop]) copyFileSync(d.path, join(bakDir, d.file));
console.log(`\nbackup → ${bakDir}`);

// 5a. JD URL rewrites (skip files being dropped or pruned)
const dropPaths = new Set([...drop, ...expiredDrop].map(d => d.path));
let rewrote = 0;
for (const j of urlRewrites) {
  if (dropPaths.has(j.path)) continue;
  const nb = j.body.replace(/^(\*\*URL:\*\*\s*)\S+/m, `$1${j.newUrl}`);
  if (nb !== j.body) { writeFileSync(j.path, nb); rewrote++; }
}

// 5b. scan-history mirror (transaction)
const tx = db.transaction(() => {
  for (const h of histPlan) {
    if (h.action === 'update') db.prepare('UPDATE offers SET url=? WHERE url=?').run(h.newUrl, h.oldUrl);
    else db.prepare('DELETE FROM offers WHERE url=?').run(h.oldUrl);
  }
});
tx();

// 5c. delete dup JD files + their exact applications.md rows
let appLines = readFileSync(APPLICATIONS, 'utf-8').split('\n');
let removedRows = 0;
for (const d of drop) {
  if (existsSync(d.path)) unlinkSync(d.path);
  const rowRe = new RegExp(`^\\|\\s*${d.num}\\s*\\|\\s*${DATE}\\s*\\|`);
  const before = appLines.length;
  appLines = appLines.filter(l => !rowRe.test(l));
  removedRows += before - appLines.length;
}
// 5d. prune expired: delete JD + app row; mark scan-history skipped_expired
// (KEEP the linkedin id row so future scans still skip it).
const markExpired = db.prepare(
  "UPDATE offers SET status='skipped_expired' WHERE url=?",
);
for (const e of expiredDrop) {
  if (existsSync(e.path)) unlinkSync(e.path);
  const rowRe = new RegExp(`^\\|\\s*${e.num}\\s*\\|\\s*${DATE}\\s*\\|`);
  const before = appLines.length;
  appLines = appLines.filter(l => !rowRe.test(l));
  removedRows += before - appLines.length;
  markExpired.run(e.newUrl);
}
writeFileSync(APPLICATIONS, appLines.join('\n'));

console.log(`applied: ${rewrote} JD URLs rewritten, ${drop.length} dup JDs deleted, ` +
  `${expiredDrop.length} expired JDs pruned, ` +
  `${removedRows} applications.md rows removed, ${histPlan.length} scan-history rows reconciled.`);
console.log(`restore: cp ${bakDir}/applications.md ${APPLICATIONS}; cp ${bakDir}/scan-history.db ${DB_PATH}; cp ${bakDir}/*.md ${JDS_DIR}/`);
