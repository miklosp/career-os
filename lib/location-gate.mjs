#!/usr/bin/env node
// Deterministic location-skip — zero LLM tokens.
//
// Fires SKIP when the JD is written in a language outside
// `location_policy.jd_languages` (rule `jd_language_not_allowed`), or when:
//   - JD's `**Remote scope:**` starts with `onsite:` or `hybrid:`, AND
//   - JD's `**Location:**` does NOT name the candidate's home city, AND
//   - JD's `**Location:**` country segment is outside `location_policy.home_country`,
//     AND that country isn't covered by `remote_allowed_scopes`.
// or (rule `location_unspecified_outside_home_country`) when the scope is
// `unspecified`, the body never mentions remote work, and `**Location:**`
// carries a non-home country segment — a silent JD is an office role.
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
  const skipBlock = body.match(/skip_on:\n((?:\s+-\s+[^\n]+\n?)+)/);
  const skipOn = skipBlock
    ? [...skipBlock[1].matchAll(/-\s+([^\s]+)/g)].map(m => m[1])
    : [];
  // Candidate's home city (first segment of candidate.location, e.g.
  // "Stockholm, Sweden" → "Stockholm"). An onsite/hybrid role in the home city
  // is commutable even when the JD's Location header carries no country segment.
  const candLoc = (body.match(/^\s*location:\s*"?([^"\n]+?)"?\s*$/m) || [])[1]?.trim();
  const homeCities = candLoc ? [candLoc.split(',')[0].trim()] : [];
  // Languages the candidate can work in. Missing block → language rule off.
  const langBlock = body.match(/jd_languages:\n((?:\s+-\s+"?[^"\n]+"?\n)+)/);
  const jdLanguages = langBlock
    ? [...langBlock[1].matchAll(/-\s+"?([^"\n]+?)"?\s*$/gm)].map(m => m[1].trim())
    : [];
  return { home, allowed, skipOn, homeCities, jdLanguages };
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
// True when the JD Location string names a candidate home city on alphanumeric
// boundaries (so "Stockholm" ⊄ "Stockholmen"). Handles bare city headers
// ("Stockholm HQ") that carry no parseable country segment.
function mentionsHomeCity(loc, cities) {
  if (!loc || !cities?.length) return false;
  const hay = loc.toLowerCase();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return cities.some(c => new RegExp(`\\b${esc(c.toLowerCase())}\\b`).test(hay));
}
function countryFromLocation(loc) {
  if (!loc) return null;
  // Drop parenthetical addresses ("(Vasagatan 7, Stockholm 111 20)") whose
  // internal commas would otherwise be mistaken for the country segment.
  const cleaned = loc.replace(/\([^)]*\)/g, ' ');
  const segs = cleaned.split(',').map(s => s.trim()).filter(Boolean);
  return segs.length ? normalizeCountry(segs[segs.length - 1]) : null;
}

// --- Language ---------------------------------------------------------------
// Stopword-frequency identification. It only has to answer "is this JD written
// in a language the candidate reads?", so neighbouring languages (da/no/sv) may
// trade places without changing the verdict — the evidence string quotes the JD
// itself rather than leaning on the label.
const STOPWORDS = {
  English: 'the and of to in for with you we our are is as that will your from be have this or an it on at by they their',
  German: 'und die der das den dem ein eine einen für mit von ist sich zu im auf wir nicht oder sie bei als dass werden du deine unsere',
  Swedish: 'och att som för med en ett är av på du vi till om det inte har kan den de vår våra dina hos samt',
  Danish: 'og at som for med en et er af på du vi til om det ikke har kan den de vores dine hos samt ved',
  Norwegian: 'og at som for med en et er av på du vi til om det ikke har kan den de våre dine hos samt ved å',
  Dutch: 'en de het een van voor met je we is dat te op in aan niet zijn ook bij of ons jouw wij door als',
  French: 'et le la les des un une de du pour avec vous nous est dans sur en au aux qui que ce sont par votre notre plus',
  Spanish: 'y el la los las de del un una para con que en es por su se como más o al nuestro tu tus sobre',
  Italian: 'e il la di che un una per con non si del della sono nel alla come più dei in le gli tuo nostro',
  Portuguese: 'e o a os as de do da um uma para com que em é por seu como mais ou no na dos nossa',
  Polish: 'i w na z do nie to jest że dla oraz się jako przez lub są być ma o po',
  Finnish: 'ja on ei että sekä tai kanssa sinä me meidän olet myös kuin joka sinun työtä',
};
const STOPSETS = Object.fromEntries(
  Object.entries(STOPWORDS).map(([lang, ws]) => [lang, new Set(ws.split(' '))]),
);
const MIN_WORDS = 60;   // shorter bodies carry too little signal
const MIN_RATIO = 0.06; // winner must actually look like prose in that language
const MARGIN = 2;       // winner must beat the best allowed language by this factor

// The JD body only: everything above the first `## ` heading is fetcher-written
// English metadata (`**Location:**`, `**Remote scope:**` …) and would bias the
// count toward English on every posting.
function jdBody(text) {
  const i = text.search(/^## /m);
  const body = i === -1 ? text.replace(/^\*\*[^*]+:\*\*.*$/gm, '') : text.slice(i);
  return body.replace(/https?:\/\/\S+/g, ' ').replace(/[*#>`_|-]+/g, ' ');
}

function detectLanguage(text) {
  const words = jdBody(text).toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < MIN_WORDS) return { words: words.length, ratios: {} };
  const ratios = {};
  for (const [lang, set] of Object.entries(STOPSETS)) {
    ratios[lang] = words.filter(w => set.has(w)).length / words.length;
  }
  return { words: words.length, ratios };
}

// First prose sentence actually written in `lang`, for the audit trail — many
// foreign-language ads open with an English company tagline, which would prove
// nothing.
function firstSentence(text, lang) {
  const set = STOPSETS[lang];
  const sentences = jdBody(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim().replace(/\s+/g, ' '))
    .filter(s => s.split(' ').length >= 6);
  const hits = s => s.toLowerCase().split(/[^\p{L}]+/u).filter(w => set.has(w)).length;
  const sentence = sentences.find(s => hits(s) >= 3) || sentences[0];
  if (!sentence) return '';
  return sentence.replace(/"/g, "'").slice(0, 160);
}

function languageVerdict(jd, policy) {
  const ruleId = 'jd_language_not_allowed';
  if (!policy.jdLanguages.length || !policy.skipOn.includes(ruleId)) {
    return { verdict: 'ALLOW', reason: 'language rule off' };
  }
  const allowed = new Set(policy.jdLanguages.map(l => l.toLowerCase()));
  const { words, ratios } = detectLanguage(jd.text);
  const ranked = Object.entries(ratios).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { verdict: 'UNKNOWN', reason: `body too short (${words} words)` };
  const [topLang, topRatio] = ranked[0];
  const bestAllowed = Math.max(
    0,
    ...ranked.filter(([l]) => allowed.has(l.toLowerCase())).map(([, r]) => r),
  );
  if (allowed.has(topLang.toLowerCase())) {
    return { verdict: 'ALLOW', reason: `language=${topLang} (${topRatio.toFixed(2)})` };
  }
  if (topRatio < MIN_RATIO || topRatio < bestAllowed * MARGIN) {
    return {
      verdict: 'UNKNOWN',
      reason: `top=${topLang} ${topRatio.toFixed(2)} vs allowed ${bestAllowed.toFixed(2)} (inconclusive)`,
    };
  }
  return { verdict: 'SKIP', rule: ruleId, evidence: `${topLang} — ${firstSentence(jd.text, topLang)}` };
}

function decide(jd, policy) {
  const lang = languageVerdict(jd, policy);
  if (lang.verdict === 'SKIP') return lang;
  const loc = decideLocation(jd, policy);
  // An undetectable language can't be cleared deterministically — hand a
  // would-be ALLOW to the LLM gate so it can read the JD and judge.
  if (lang.verdict === 'UNKNOWN' && loc.verdict === 'ALLOW') {
    return { verdict: 'NEEDS_LLM', reason: `language undetermined: ${lang.reason}` };
  }
  return loc;
}

function decideLocation(jd, policy) {
  if (!jd.remoteScope) return { verdict: 'NEEDS_LLM', reason: 'no Remote scope header' };
  // unspecified scope: a JD that names a non-home country and never mentions
  // remote work anywhere is an office role in that country by default — skip
  // it when the rule is enabled. Any remote/WFH wording in the body, a bare
  // city with no country segment, or a "Remote"-style Location defers to the
  // LLM gate (body may also carry residency restrictions, Rule 6).
  if (jd.remoteScope === 'unspecified') {
    const ruleId = 'location_unspecified_outside_home_country';
    const bodyMentionsRemote = /\b(remote|remotely|work from home|wfh|distributed team)\b/i.test(jdBody(jd.text));
    const hasCountrySegment = jd.location && jd.location.includes(',')
      && !/\b(remote|anywhere|unspecified)\b/i.test(jd.location);
    if (policy.skipOn.includes(ruleId) && hasCountrySegment && !bodyMentionsRemote
        && !mentionsHomeCity(jd.location, policy.homeCities)) {
      const country = countryFromLocation(jd.location);
      const homeMatch = country.toLowerCase() === policy.home.toLowerCase();
      const literalCountryMatch = policy.allowed.some(s => s.toLowerCase() === country.toLowerCase());
      if (!homeMatch && !literalCountryMatch) {
        return { verdict: 'SKIP', rule: ruleId, evidence: jd.location };
      }
    }
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
  // A home-city Location is commutable even when the header has no country
  // segment ("Stockholm HQ") — check before the country heuristic so bare city
  // names don't false-skip.
  if (mentionsHomeCity(jd.location, policy.homeCities)) {
    return { verdict: 'ALLOW', reason: `${mode} in home city (${jd.location})` };
  }
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
  console.error(`policy: home=${policy.home} allowed=${policy.allowed.length} langs=${policy.jdLanguages.join(',') || 'off'} skipOn=${policy.skipOn.length} | ${targets.length} target(s) | ${dry ? 'DRY-RUN' : 'WRITE'}`);

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
