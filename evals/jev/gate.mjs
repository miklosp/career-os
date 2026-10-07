#!/usr/bin/env node
// Jev location-gate eval. Compares two Jev variants against the verdicts the
// current gate (deterministic + Sonnet _location-gate.md) already wrote into
// applications.md.
//
//   node evals/jev/gate.mjs            fetch missing Jev answers, then report
//   node evals/jev/gate.mjs --report   report from cache only (threshold tuning)
//   node evals/jev/gate.mjs --limit 50 cap NEW calls this run (smoke test)
//
// Labels (per tracker row with a JD on disk):
//   SKIP  = Skipped-Location, any rule except jd_language_not_allowed
//           (language is deterministic and stays out of Jev's job)
//   ALLOW = row reached scoring (has a report on disk)
//   rows that are neither are excluded.
// Segment = what `lib/location-gate.mjs --dry-run` says today: `llm` (NEEDS_LLM,
// i.e. Sonnet decided) vs `det` (deterministic rule decided). `llm` is the
// segment Jev would replace; `det` is a sanity check against high-quality labels.
//
// Variants (both via Bifrost POST /v1/decisions, typesafe/jev-latest):
//   A whole  — one Noul over the full JD: "can the candidate take this job?"
//              PASS if p >= t.
//   B para   — one Noul per paragraph: "does this paragraph rule the candidate
//              out?"  SKIP if max p >= t; that paragraph is the evidence.
//   C para+kw — as B, but only paragraphs passing mentionsLocation() are asked (all
//              paragraphs stay in the state as context). No match → p = 0, no
//              call. Run on segment `llm` only.
//   D facts   — Jev only extracts facts from the JD (no candidate policy in the
//              state): a Choice for where the hire must live/work, a Noul for
//              non-European working hours. Code maps them onto the policy:
//              SKIP / ALLOW when confident, otherwise Sonnet. Segment `llm` only.
//
// Raw answers cache: user/output/jev-eval/gate-raw.jsonl (one line per NUM+variant).

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { APPLICATIONS_FILE, JDS_DIR, REPORTS_DIR, CONFIG_DIR, OUTPUT_DIR, REPO_DIR } from '../../lib/paths.mjs';

const BIFROST = 'http://localhost:4444/v1/decisions';
const MODEL = 'typesafe/jev-latest';
const CONCURRENCY = 8;
const OUT_DIR = join(OUTPUT_DIR, 'jev-eval');
const RAW = join(OUT_DIR, 'gate-raw.jsonl');
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

// ── candidate policy as prose, rendered from profile.md location_policy ──
function policyText() {
  const fm = readFileSync(join(CONFIG_DIR, 'profile.md'), 'utf8').match(/^---\n([\s\S]+?)\n---/)[1];
  const doc = yaml.load(fm);
  const p = doc.location_policy;
  const city = doc.candidate?.location;
  return [
    `The candidate lives in ${city || p.home_country} (${p.home_timezone}) and will not move.`,
    `They can work fully remote, or onsite/hybrid only at an office in ${p.home_country}.`,
    `Remote roles are open to them only if remote hiring covers one of: ${p.remote_allowed_scopes.join(', ')}.`,
    p.us_work_authorization ? 'They are authorized to work in the US.' : 'They have no US work authorization and no work authorization outside the EU.',
    p.relocation_open ? 'They are open to relocation.' : 'They are not open to relocation.',
    `They need working hours within ${p.timezone_tolerance_hours ?? 1} hour(s) of ${p.home_timezone}.`,
  ].join(' ');
}

// ── dataset ──
function trackerRows() {
  const rows = [];
  for (const line of readFileSync(APPLICATIONS_FILE, 'utf8').split('\n')) {
    const c = line.split('|').map(s => s.trim());
    if (!/^\d+$/.test(c[1] || '')) continue;
    rows.push({ num: c[1], company: c[3], role: c[4], score: parseFloat(c[5]) || null, status: c[6], notes: c[9] });
  }
  return rows;
}

function buildDataset() {
  const jdFiles = new Map(readdirSync(JDS_DIR).map(f => [f.split('-')[0], f]));
  const reports = new Set(readdirSync(REPORTS_DIR).map(f => f.split('-')[0]));
  const items = [];
  for (const r of trackerRows()) {
    if (!jdFiles.has(r.num)) continue;
    let label = null;
    if (r.status === 'Skipped-Location' && !r.notes.startsWith('jd_language_not_allowed')) label = 'SKIP';
    else if (r.status !== 'Skipped-Location' && reports.has(r.num)) label = 'ALLOW';
    if (label) items.push({ ...r, label, file: jdFiles.get(r.num) });
  }
  // Segment from today's deterministic gate (dry-run never writes).
  const out = execFileSync('node', ['lib/location-gate.mjs', '--dry-run', ...items.map(i => i.num)],
    { cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  const verdict = new Map(out.split('\n').filter(Boolean).map(l => { const [n, v] = l.split('\t'); return [n, v]; }));
  for (const i of items) i.segment = verdict.get(i.num) === 'NEEDS_LLM' ? 'llm' : 'det';
  return items;
}

// ── JD → paragraphs (variant B). Drops fetch metadata lines and headings. ──
const META = /^\*\*(URL|Fetched|Fetch-method|Posting age|Status|Listed at|Easy apply|LinkedIn job URL|Resolved ATS URL):\*\*/;
function paragraphs(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !META.test(l) && l.split(/\s+/).length >= 3);
}

// Paragraphs that can carry a geographic restriction (variant C).
const LOCATION_RE = /\b(locat|remote|hybrid|on-?site|in-?person|office|headquarter|based|reside|residen|relocat|visa|sponsor|authori[sz]|right to work|permit|citizen|time ?zones?|hours|overlap|countr|region|europe|united states|north america|anywhere|commut|travel)/i;
const LOCATION_ACRONYM_RE = /\b(HQ|CET|CEST|[EPC]ST|UTC|GMT|EMEA|EU|US|USA|UK|LATAM|APAC)\b/;
const mentionsLocation = p => LOCATION_RE.test(p) || LOCATION_ACRONYM_RE.test(p);

// ── Jev ──
async function decide(state, questions) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BIFROST, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions }),
    });
    if (res.ok) return res.json();
    // Billing failure: every remaining call would fail too. Answers so far stay cached.
    if (res.status === 402) { console.error(`402 — stopping: ${await res.text()}`); process.exit(1); }
    if (attempt >= 4) throw new Error(`${res.status} ${await res.text()}`);
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
}

const Q_WHOLE = 'Can the candidate described in `candidate` take the job in `job_description` from where they live today, with no relocation, no office attendance outside their home country, and no work authorization they lack?';
const qPara = i => `Does \`paragraphs[${i}]\` state a hard requirement that rules out the candidate described in \`candidate\`: where they must live or be based, work authorization, office attendance, relocation, or required working hours? Soft preferences, optional office use, and occasional travel do not count.`;

async function runWhole(item, candidate) {
  const jd = readFileSync(join(JDS_DIR, item.file), 'utf8');
  const r = await decide({ candidate, job_description: jd }, { pass: { kind: 'noul', instructions: Q_WHOLE } });
  return { p: r.answers.pass.value, tokens: r.usage?.prompt_tokens, model: r.model };
}

async function runPara(item, candidate) {
  const paras = paragraphs(readFileSync(join(JDS_DIR, item.file), 'utf8'));
  const questions = Object.fromEntries(paras.map((_, i) => [`p${i}`, { kind: 'noul', instructions: qPara(i) }]));
  const r = await decide({ candidate, paragraphs: paras }, questions);
  const ps = paras.map((_, i) => r.answers[`p${i}`].value);
  const top = ps.indexOf(Math.max(...ps));
  return { p: ps[top], evidence: paras[top], n: paras.length, tokens: r.usage?.prompt_tokens, model: r.model };
}

// Variant D: where must the hire live or work from? Options rendered from the
// policy; ALLOWED_PLACES pass, the rest skip. `not_stated` passes (the gate never
// skips on ambiguity).
const ALLOWED_PLACES = new Set(['anywhere', 'allowed_region', 'home', 'not_stated']);
function factQuestions() {
  const p = yaml.load(readFileSync(join(CONFIG_DIR, 'profile.md'), 'utf8').match(/^---\n([\s\S]+?)\n---/)[1]).location_policy;
  const home = p.home_country;
  const regions = p.remote_allowed_scopes.filter(s => !/^(global|worldwide)$/i.test(s) && s !== home);
  return {
    place: { kind: 'choice', instructions: 'Where must the person hired for the job in `job_description` live or work from?', criteria: {
      anywhere: 'Fully remote from anywhere in the world, no country or region restriction',
      allowed_region: `Remote, restricted to a region that includes ${home}: ${regions.join(', ')}`,
      home: `${home}: remote within ${home}, or an office in ${home}`,
      other_country: `One specific country other than ${home}, or a list of countries that does not include ${home} (remote there, or an office there)`,
      americas: 'The United States, Canada, or the Americas only',
      other_region: `A region that does not include ${home}, such as APAC, LATAM, or the Middle East`,
      not_stated: 'The job description does not say',
    } },
    non_eu_hours: { kind: 'noul', instructions: 'Does the job in `job_description` require regular working hours in American or Asia-Pacific time zones?' },
  };
}

async function runFacts(item) {
  const r = await decide({ job_description: readFileSync(join(JDS_DIR, item.file), 'utf8') }, factQuestions());
  const { place, non_eu_hours } = r.answers;
  return { place: place.value, conf: place.confidence, probs: place.probabilities, hours: non_eu_hours.value, tokens: r.usage?.prompt_tokens, model: r.model };
}

// SKIP / ALLOW / SONNET for a variant-D record at threshold t. Gates on the
// summed probability of the allowed places, not the top option's confidence:
// code only needs allowed vs excluded.
const pAllowed = d => Object.entries(d.probs).reduce((s, [k, v]) => s + (ALLOWED_PLACES.has(k) ? v : 0), 0);
function factVerdict(d, t) {
  if (d.hours >= t || 1 - pAllowed(d) >= t) return 'SKIP';
  if (pAllowed(d) >= t && d.hours < 0.2) return 'ALLOW';
  return 'SONNET';
}

async function runParaLoc(item, candidate) {
  const paras = paragraphs(readFileSync(join(JDS_DIR, item.file), 'utf8'));
  const asked = paras.map((_, i) => i).filter(i => mentionsLocation(paras[i]));
  if (!asked.length) return { p: 0, evidence: null, n: 0, tokens: 0, model: null };
  const questions = Object.fromEntries(asked.map(i => [`p${i}`, { kind: 'noul', instructions: qPara(i) }]));
  const r = await decide({ candidate, paragraphs: paras }, questions);
  const top = asked.reduce((a, i) => (r.answers[`p${i}`].value > r.answers[`p${a}`].value ? i : a));
  return { p: r.answers[`p${top}`].value, evidence: paras[top], n: asked.length, tokens: r.usage?.prompt_tokens, model: r.model };
}

function loadCache() {
  const cache = new Map();
  if (existsSync(RAW)) for (const l of readFileSync(RAW, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(l); cache.set(`${j.num}:${j.variant}`, j);
  }
  return cache;
}

async function fetchMissing(items, cache) {
  const candidate = policyText();
  const jobs = [];
  for (const it of items) for (const [variant, fn] of [['A', runWhole], ['B', runPara], ['C', runParaLoc], ['D', runFacts]])
    if (!cache.has(`${it.num}:${variant}`) && (!'CD'.includes(variant) || it.segment === 'llm')) jobs.push({ it, variant, fn });
  const todo = jobs.slice(0, limit);
  console.error(`policy: ${candidate}\n${todo.length} Jev calls to make (${jobs.length} missing)`);
  let done = 0, failed = 0;
  const worker = async () => {
    while (todo.length) {
      const { it, variant, fn } = todo.shift();
      try {
        const res = await fn(it, candidate);
        const rec = { num: it.num, variant, ...res };
        appendFileSync(RAW, JSON.stringify(rec) + '\n');
        cache.set(`${it.num}:${variant}`, rec);
      } catch (e) { failed++; console.error(`${it.num} ${variant} FAIL ${e.message.slice(0, 200)}`); }
      if (++done % 50 === 0) console.error(`progress ${done}/${done + todo.length} (failed ${failed})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ── report ──
function report(items, cache) {
  const lines = [];
  const say = s => { lines.push(s); console.log(s); };
  const pred = (variant, p, t) => variant === 'A' ? (p >= t ? 'ALLOW' : 'SKIP') : (p >= t ? 'SKIP' : 'ALLOW');
  let tokens = 0;
  for (const r of cache.values()) tokens += r.tokens || 0;

  say(`# Jev location-gate eval — ${new Date().toISOString().slice(0, 10)}\n`);
  say(`Model: ${[...new Set([...cache.values()].map(r => r.model).filter(Boolean))].join(', ')} · input tokens so far: ${tokens.toLocaleString()} (~$${(tokens * 0.042e-6).toFixed(2)})\n`);
  say('False skip = Jev skips a row the current gate let through (costly: lost role). False allow = Jev passes a row the current gate skipped (cheap: one wasted Sonnet eval).\n');

  for (const segment of ['llm', 'det']) {
    const seg = items.filter(i => i.segment === segment);
    const nSkip = seg.filter(i => i.label === 'SKIP').length;
    say(`## Segment \`${segment}\` — ${seg.length} JDs (${nSkip} SKIP / ${seg.length - nSkip} ALLOW)\n`);
    for (const variant of segment === 'llm' ? ['A', 'B', 'C'] : ['A', 'B']) {
      const rows = seg.filter(i => cache.has(`${i.num}:${variant}`));
      say(`### Variant ${variant} (${{ A: 'whole JD, PASS if p ≥ t', B: 'per paragraph, SKIP if max p ≥ t', C: 'location paragraphs only, SKIP if max p ≥ t' }[variant]}) — ${rows.length} answered\n`);
      say('| t | accuracy | false skip | …of them scored ≥4.0 | false allow |');
      say('|---|---|---|---|---|');
      for (const t of THRESHOLDS) {
        let ok = 0, fs = 0, fs4 = 0, fa = 0;
        for (const i of rows) {
          const v = pred(variant, cache.get(`${i.num}:${variant}`).p, t);
          if (v === i.label) ok++;
          else if (v === 'SKIP') { fs++; if (i.score >= 4) fs4++; }
          else fa++;
        }
        say(`| ${t} | ${(100 * ok / (rows.length || 1)).toFixed(1)}% | ${fs} | ${fs4} | ${fa} |`);
      }
      say('');
    }
  }

  // Variant D: three-way routing, segment llm.
  const llm = items.filter(i => i.segment === 'llm' && cache.has(`${i.num}:D`));
  say(`## Variant D (facts → policy in code) — segment \`llm\`, ${llm.length} answered\n`);
  say('| t | decided by Jev | skip ok | wrong skip | …of them scored ≥4.0 | allow ok | wrong allow | to Sonnet |');
  say('|---|---|---|---|---|---|---|---|');
  for (const t of THRESHOLDS) {
    const c = { so: 0, ws: 0, ws4: 0, ao: 0, wa: 0, s: 0 };
    for (const i of llm) {
      const v = factVerdict(cache.get(`${i.num}:D`), t);
      if (v === 'SONNET') c.s++;
      else if (v === 'SKIP') i.label === 'SKIP' ? c.so++ : (c.ws++, i.score >= 4 && c.ws4++);
      else i.label === 'ALLOW' ? c.ao++ : c.wa++;
    }
    say(`| ${t} | ${llm.length - c.s} | ${c.so} | ${c.ws} | ${c.ws4} | ${c.ao} | ${c.wa} | ${(100 * c.s / (llm.length || 1)).toFixed(0)}% |`);
  }
  say('\n### Variant D errors at t = 0.8\n');
  say('| NUM | company — role | label | place (p allowed) | non-EU hours | current note |');
  say('|---|---|---|---|---|---|');
  for (const i of llm) {
    const d = cache.get(`${i.num}:D`), v = factVerdict(d, 0.8);
    if (v === 'SONNET' || v === i.label) continue;
    say(`| ${i.num} | ${i.company} — ${i.role}${i.score ? ` (${i.score})` : ''} | ${i.label} | ${d.place} (${pAllowed(d).toFixed(2)}) | ${d.hours} | ${(i.notes || '').replace(/\|/g, '/').slice(0, 140)} |`);
  }
  say('');

  // Disagreements at the default thresholds, for a human look (labels are Sonnet's, not truth).
  say('## Disagreements at t = 0.8 (segment `llm`)\n');
  say('| NUM | company — role | label | A p(pass) | B max p(excl) | B evidence / current note |');
  say('|---|---|---|---|---|---|');
  for (const i of items.filter(i => i.segment === 'llm')) {
    const a = cache.get(`${i.num}:A`), b = cache.get(`${i.num}:B`);
    if (!a || !b) continue;
    if (pred('A', a.p, 0.8) === i.label && pred('B', b.p, 0.8) === i.label) continue;
    const ev = (i.label === 'SKIP' ? i.notes : b.evidence || '').replace(/\|/g, '/').slice(0, 160);
    say(`| ${i.num} | ${i.company} — ${i.role}${i.score ? ` (${i.score})` : ''} | ${i.label} | ${a.p} | ${b.p} | ${ev} |`);
  }
  return lines.join('\n') + '\n';
}

mkdirSync(OUT_DIR, { recursive: true });
const items = buildDataset();
const cache = loadCache();
if (!reportOnly) await fetchMissing(items, cache);
const md = report(items, cache);
writeFileSync(join(OUT_DIR, 'gate-report.md'), md);
console.error(`\nreport → ${join(OUT_DIR, 'gate-report.md')}`);
