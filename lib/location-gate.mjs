#!/usr/bin/env node
// Deterministic location-skip — zero LLM tokens.
//
// Fires SKIP when:
//   - JD's `**Remote scope:**` starts with `onsite:` or `hybrid:` (any city), AND
//   - JD's `**Location:**` country segment is outside `location_policy.home_country`,
//     AND that country isn't covered by `remote_allowed_scopes`.
//
// On SKIP, updates the matching applications.md row to:
//   Status → Skipped-Location
//   Notes  → {rule-id}: "{quoted location string}"
//
// On ALLOW (or when the script can't decide deterministically), exits 0 and
// returns ALLOW — the caller (auto-pipeline → LLM _location-gate.md) handles
// edge cases (ambiguous Remote scope, soft preference language, etc.).
//
// CLI:
//   node lib/location-gate.mjs <NUM>            # single
//   node lib/location-gate.mjs --all-fetched    # every applications.md row with Status=Fetched
//   node lib/location-gate.mjs --dry-run ...    # report without writing

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const APPS = path.join(REPO, 'data/applications.md');
const JD_DIR = path.join(REPO, 'data/jds');
const PROFILE = path.join(REPO, 'config/profile.md');

function parseLocationPolicy() {
  const text = readFileSync(PROFILE, 'utf8');
  const fm = text.match(/^---\n([\s\S]+?)\n---/);
  if (!fm) throw new Error('profile.md: no frontmatter');
  const body = fm[1];

  const home = (body.match(/home_country:\s*"?([^"\n]+)"?/) || [])[1]?.trim() || 'Sweden';
  const allowedBlock = body.match(/remote_allowed_scopes:\n((?:\s+-\s+"?[^"\n]+"?\n)+)/);
  const allowed = allowedBlock
    ? [...allowedBlock[1].matchAll(/-\s+"?([^"\n]+?)"?\s*$/gm)].map(m => m[1].trim())
    : [home];
  const skipBlock = body.match(/skip_on:\n((?:\s+-\s+[^\n]+\n)+)/);
  const skipOn = skipBlock
    ? [...skipBlock[1].matchAll(/-\s+([^\s]+)/g)].map(m => m[1])
    : [];
  return { home, allowed, skipOn };
}

function readJd(num) {
  const files = readdirSync(JD_DIR).filter(f => f.startsWith(`${num}-`) && f.endsWith('.md'));
  if (!files.length) return null;
  const p = path.join(JD_DIR, files[0]);
  const text = readFileSync(p, 'utf8');
  return {
    path: p,
    file: files[0],
    text,
    remoteScope: (text.match(/^\*\*Remote scope:\*\*\s*(.+)$/m) || [])[1]?.trim() || null,
    location: (text.match(/^\*\*Location:\*\*\s*(.+)$/m) || [])[1]?.trim() || null,
  };
}

// ISO-3166 alpha-2/3 → canonical country name, for locations written "City, SE".
// Unknown codes fall through unchanged (and correctly skip as non-home).
const COUNTRY_ALIASES = {
  se: 'Sweden', swe: 'Sweden',
  dk: 'Denmark', no: 'Norway', nor: 'Norway', fi: 'Finland', is: 'Iceland',
  de: 'Germany', deu: 'Germany', nl: 'Netherlands', ie: 'Ireland', irl: 'Ireland',
  gb: 'United Kingdom', uk: 'United Kingdom', fr: 'France', es: 'Spain', it: 'Italy',
  pl: 'Poland', be: 'Belgium', at: 'Austria', pt: 'Portugal', ch: 'Switzerland',
  cz: 'Czechia', us: 'United States', usa: 'United States',
};
function normalizeCountry(c) {
  if (!c) return c;
  const key = c.toLowerCase().replace(/[.\s]/g, '');
  return COUNTRY_ALIASES[key] || c;
}
function countryFromLocation(loc) {
  if (!loc) return null;
  // Drop parenthetical addresses ("(Vasagatan 7, Stockholm 111 20)") whose
  // internal commas would otherwise be mistaken for the country segment.
  const cleaned = loc.replace(/\([^)]*\)/g, ' ');
  const segs = cleaned.split(',').map(s => s.trim()).filter(Boolean);
  return segs.length ? normalizeCountry(segs[segs.length - 1]) : null;
}

function decide(jd, policy) {
  if (!jd.remoteScope) return { verdict: 'NEEDS_LLM', reason: 'no Remote scope header' };
  // unspecified scope still needs the LLM gate — the body may contain hard
  // residency restrictions (Rule 6) the fetcher didn't extract into the header.
  if (jd.remoteScope === 'unspecified') {
    return { verdict: 'NEEDS_LLM', reason: 'scope=unspecified (body may have residency lang)' };
  }
  // full-remote-* needs care: the *header* says remote, but the *body* may
  // still carry a hard residency restriction (Rule 6). Only deterministic
  // ALLOW when the region is explicitly Global / Worldwide. Anything else
  // (including the common `full-remote-region:unspecified`) falls through to
  // the LLM gate so it can read the body.
  if (jd.remoteScope.startsWith('full-remote-region:')) {
    const region = jd.remoteScope.slice('full-remote-region:'.length).trim();
    if (/^(global|worldwide)$/i.test(region)) {
      return { verdict: 'ALLOW', reason: `scope=${jd.remoteScope}` };
    }
    return { verdict: 'NEEDS_LLM', reason: `scope=${jd.remoteScope} (region needs body check)` };
  }
  if (jd.remoteScope.startsWith('full-remote-countries:')) {
    const listRaw = jd.remoteScope.slice('full-remote-countries:'.length).trim();
    // Non-committal values carry no geographic signal — the body may still open
    // (or close) the role, so defer to the LLM gate.
    if (!listRaw || /^(null|unspecified|remote|anywhere)$/i.test(listRaw)) {
      return { verdict: 'NEEDS_LLM', reason: `scope=${jd.remoteScope} (ambiguous list)` };
    }
    // If a home/allowed token (Sweden, EU, Europe, EMEA, Global, Nordic…) appears
    // anywhere in the list, the role MAY cover the candidate — defer rather than
    // risk a false skip (e.g. "United Kingdom & EU").
    const hay = listRaw.toLowerCase();
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const eligibleHint = [policy.home, ...policy.allowed]
      .some(t => new RegExp(`\\b${esc(t.toLowerCase())}\\b`).test(hay));
    if (eligibleHint) {
      return { verdict: 'NEEDS_LLM', reason: `scope=${jd.remoteScope} (allowed token present)` };
    }
    // A country allowlist with NO eligible token excludes the home country. The
    // body can only narrow an allowlist further, never widen it to include
    // Sweden — so SKIP is sound deterministically, no LLM body check needed.
    const ruleId = 'remote_scope_excludes_home_country';
    if (!policy.skipOn.includes(ruleId)) {
      return { verdict: 'NEEDS_LLM', reason: `${ruleId} not enabled in skip_on` };
    }
    return { verdict: 'SKIP', rule: ruleId, evidence: listRaw };
  }
  const m = jd.remoteScope.match(/^(onsite|hybrid):(.+)$/);
  if (!m) return { verdict: 'NEEDS_LLM', reason: `unrecognized scope=${jd.remoteScope}` };
  const mode = m[1]; // onsite | hybrid
  const country = countryFromLocation(jd.location);
  if (!country) return { verdict: 'NEEDS_LLM', reason: `${mode}:${m[2]} but no country in Location` };
  // For onsite/hybrid the city must be physically commutable. Treat remote_allowed_scopes
  // region/wildcard tokens (Global, Worldwide, EU, Europe, EMEA, Nordic…) as a *remote*
  // policy, NOT a willingness to commute. Only an exact literal country match (e.g. "Sweden")
  // counts.
  const homeMatch = country.toLowerCase() === policy.home.toLowerCase();
  const literalCountryMatch = policy.allowed.some(s => s.toLowerCase() === country.toLowerCase());
  if (homeMatch || literalCountryMatch) {
    return { verdict: 'ALLOW', reason: `${mode} in ${country} (home/literal-allowed)` };
  }
  const ruleId = mode === 'onsite' ? 'onsite_outside_home_country' : 'hybrid_outside_home_country';
  if (!policy.skipOn.includes(ruleId)) {
    return { verdict: 'ALLOW', reason: `${ruleId} not enabled in skip_on` };
  }
  return {
    verdict: 'SKIP',
    rule: ruleId,
    evidence: jd.location,
  };
}

function updateAppsRow(num, status, notes) {
  let text = readFileSync(APPS, 'utf8');
  const rowRe = new RegExp(`^(\\| ${num} \\| [^|]+ \\| [^|]+ \\| [^|]+ \\|)( [^|]* )\\|( [^|]* )\\|( [^|]* )\\|( [^|]* )\\|( [^|]* )\\|$`, 'm');
  const m = text.match(rowRe);
  if (!m) return { changed: false, reason: 'no row' };
  const repl = `${m[1]}${m[2]}| ${status} |${m[4]}|${m[5]}| ${notes} |`;
  text = text.slice(0, m.index) + repl + text.slice(m.index + m[0].length);
  writeFileSync(APPS, text);
  return { changed: true };
}

function fetchedNums() {
  const text = readFileSync(APPS, 'utf8');
  const re = /^\| (\d+) \| [^|]+ \| [^|]+ \| [^|]+ \|[^|]*\| Fetched \|/gm;
  const nums = [];
  let m;
  while ((m = re.exec(text))) nums.push(m[1]);
  return nums;
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const all = args.includes('--all-fetched');
  let targets;
  if (all) targets = fetchedNums();
  else targets = args.filter(a => /^\d+$/.test(a));
  if (!targets.length) {
    console.error('usage: location-gate.mjs <NUM>... | --all-fetched [--dry-run]');
    process.exit(2);
  }
  const policy = parseLocationPolicy();
  console.error(`policy: home=${policy.home} allowed=${policy.allowed.length} skipOn=${policy.skipOn.length} | ${targets.length} target(s) | ${dry ? 'DRY-RUN' : 'WRITE'}`);

  const tally = { SKIP: 0, ALLOW: 0, NEEDS_LLM: 0, NO_JD: 0 };
  const skipped = [];
  for (const num of targets) {
    const jd = readJd(num);
    if (!jd) { tally.NO_JD++; console.log(`${num}\tNO_JD`); continue; }
    const d = decide(jd, policy);
    tally[d.verdict]++;
    if (d.verdict === 'SKIP') {
      const notes = `${d.rule}: "${d.evidence}"`;
      if (!dry) {
        const u = updateAppsRow(num, 'Skipped-Location', notes);
        if (!u.changed) console.log(`${num}\tSKIP\tWARN no row to update (${jd.remoteScope})`);
        else { console.log(`${num}\tSKIP\t${d.rule}\t${d.evidence}`); skipped.push({num, ...d}); }
      } else {
        console.log(`${num}\tSKIP (dry)\t${d.rule}\t${d.evidence}`);
      }
    } else {
      console.log(`${num}\t${d.verdict}\t${d.reason}`);
    }
  }
  console.error(`\n=== ${JSON.stringify(tally)} ===`);
  // Single-NUM mode: surface the verdict via exit code for the auto-pipeline.
  // 0  = ALLOW (continue to LLM gate or score)
  // 10 = SKIP (deterministic; stop the pipeline)
  // 20 = NEEDS_LLM (no deterministic answer; caller must run LLM _location-gate.md)
  if (!all && targets.length === 1) {
    if (tally.SKIP) process.exit(10);
    if (tally.NEEDS_LLM) process.exit(20);
  }
}

main();
