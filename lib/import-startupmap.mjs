#!/usr/bin/env node
// import-startupmap.mjs — seed portals.yml `tracked_companies` from
// startupmap.one (zero-token, one-off / re-runnable).
//
// startupmap.one's sitemap lists every startup page as /startup/{slug}_{cc};
// each page embeds `"website_careers_url":"…"` (often a direct ATS board) and a
// schema.org Organization block with the name. robots.txt allows /startup/*
// (Content-Signal ai-input=yes) and disallows only /api, so this reads the
// public pages serially with a delay and never touches /api.
//
// A startup is kept when scan.mjs's detectApi() recognises its careers URL, or
// when a custom careers domain serves a Teamtailor `/jobs.json` feed. Every
// kept board is probed once (HTTP 200 + parseable) before it is emitted.
// Companies already in portals.yml (by name or api URL) are skipped.
//
// Output: a YAML block of new tracked_companies entries on stdout (paste /
// append it into user/config/portals.yml), plus a summary on stderr.
//
// Usage: node lib/import-startupmap.mjs [country-code=se] [--delay-ms 800]

import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { CONFIG_DIR } from './paths.mjs';
import { detectApi } from '../scan.mjs';

const args = process.argv.slice(2);
const cc = (args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'se').toLowerCase();
const di = args.indexOf('--delay-ms');
const DELAY_MS = di !== -1 ? Number(args[di + 1]) : 800;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) career-ops/import-startupmap';
const log = (...a) => console.error('[startupmap]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decodeJsonString(s) {
  try { return JSON.parse(`"${s}"`); } catch { return s; }
}

// Probe a list endpoint once: must return 200 and parse as JSON (or Personio XML).
async function probe(api) {
  try {
    const body = await get(api.url);
    if (api.type === 'personio') return body.includes('<position>');
    const j = JSON.parse(body);
    if (api.type === 'teamtailor') return Array.isArray(j.items);
    if (api.type === 'ashby') return Array.isArray(j.jobs);
    if (api.type === 'greenhouse') return Array.isArray(j.jobs);
    return true;
  } catch { return false; }
}

const portals = yaml.load(readFileSync(resolve(CONFIG_DIR, 'portals.yml'), 'utf-8'));
const tracked = portals.tracked_companies || [];
const knownNames = new Set(tracked.map(c => c.name.toLowerCase()));
const knownApis = new Set(tracked.map(c => detectApi(c)?.url).filter(Boolean));

const sitemap = await get('https://startupmap.one/sitemap.xml');
const slugs = [...new Set(
  [...sitemap.matchAll(/<loc>https:\/\/startupmap\.one\/startup\/([a-z0-9_-]+)<\/loc>/g)]
    .map(m => m[1])
    .filter(s => s.endsWith(`_${cc}`)),
)];
log(`${slugs.length} startups with suffix _${cc}`);

const stats = { pages: 0, failed: 0, noCareers: 0, unsupported: 0, known: 0, deadBoard: 0, added: 0 };
const unsupported = [];
const out = [];

for (const slug of slugs) {
  await sleep(DELAY_MS);
  let html;
  try { html = await get(`https://startupmap.one/startup/${slug}`); stats.pages++; }
  catch (err) { stats.failed++; log(`${slug}: ${err.message}`); continue; }

  const name = decodeJsonString(
    (html.match(/"@type":"Organization","name":"((?:[^"\\]|\\.)*)"/) || [])[1] || slug,
  ).trim();
  const careers = decodeJsonString((html.match(/"website_careers_url":"((?:[^"\\]|\\.)*)"/) || [])[1] || '').trim();
  if (!careers) { stats.noCareers++; continue; }

  let entry = { name, careers_url: careers };
  let api = detectApi(entry);
  if (!api) {
    // Custom careers domain: Teamtailor serves /jobs.json on any career site.
    try {
      const tt = { type: 'teamtailor', url: `${new URL(careers).origin}/jobs.json` };
      if (await probe(tt)) { api = tt; entry.api = tt.url; }
    } catch { /* malformed careers URL */ }
  }
  if (!api) { stats.unsupported++; unsupported.push(`${name} — ${careers}`); continue; }
  if (knownNames.has(name.toLowerCase()) || knownApis.has(api.url)) { stats.known++; continue; }
  if (!entry.api && !(await probe(api))) { stats.deadBoard++; log(`${name}: board did not respond (${api.url})`); continue; }

  knownNames.add(name.toLowerCase());
  knownApis.add(api.url);
  out.push({ ...entry, enabled: true });
  stats.added++;
  log(`+ ${name} (${api.type})`);
}

const date = new Date().toISOString().slice(0, 10);
console.log(`  # -- Imported from startupmap.one (_${cc}), ${date} — lib/import-startupmap.mjs --\n`);
for (const e of out) {
  console.log(`  - name: ${JSON.stringify(e.name)}`);
  console.log(`    careers_url: ${e.careers_url}`);
  if (e.api) console.log(`    api: ${e.api}`);
  console.log('    enabled: true\n');
}
log('stats:', JSON.stringify(stats));
if (unsupported.length) log(`unsupported careers URLs (no list parser):\n  ${unsupported.join('\n  ')}`);
