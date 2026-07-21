#!/usr/bin/env node
// Zero-token keyword frequency analysis across all evaluation reports.
//
// Parses the "Extracted Keywords" (legacy) or "ATS Targets" section of every
// data/reports/*.md, normalizes and de-dupes terms, counts how many distinct
// reports each appears in, then
// classifies coverage against the candidate corpus (cv.md + cv.json
// skills_inventory + story-bank.md) as: strong (full phrase present) /
// partial (all content words present, scattered) / gap (not represented).
//
// Pure string ops — no LLM, no network. Output: console table + a markdown
// artifact at output/_keyword-analysis.md (mirrors lib/gap-analysis.mjs).
//
// Usage:
//   node lib/keyword-frequency.mjs            # full table + write artifact
//   node lib/keyword-frequency.mjs --top 40   # console: top N only
//   node lib/keyword-frequency.mjs --gaps     # console: only uncovered (gap), min freq 3
//   node lib/keyword-frequency.mjs --min 3    # only keywords seen in >=3 reports
//   node lib/keyword-frequency.mjs --min-score 3.7  # only reports scored > 3.7
//   node lib/keyword-frequency.mjs --json     # machine-readable to stdout, no artifact

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const TOP = parseInt(opt('--top', '0'), 10);
const ONLY_GAPS = flag('--gaps');
const MIN_FREQ = parseInt(opt('--min', ONLY_GAPS ? '3' : '1'), 10);
const MIN_SCORE = parseFloat(opt('--min-score', 'NaN')); // exclusive: keep reports with score > MIN_SCORE
const AS_JSON = flag('--json');

const STOP = new Set(('a an the of and or for to in with on at by as is are be from into per via ' +
  'across within using based driven led level scale end full high low new across that this').split(' '));

// ---- normalization -------------------------------------------------------

// Split a raw bullet into atomic keyword strings. Split only on spaced
// delimiters (" / ", " · ", " & ", " + ", ", ") so "A/B Testing",
// "go-to-market", "build-test-learn" stay intact.
function atomize(raw) {
  let s = raw.replace(/^[-*]\s+/, '').trim();
  s = s.replace(/\s*\([^)]*token[^)]*\)\s*$/i, ''); // drop trailing "(for CV...)" noise
  if (!s) return [];
  const parts = s.split(/\s+[/·&+]\s+|,\s+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    out.push(p);
    // expand "Customer Data Platform (CDP)" -> phrase + "CDP"
    const m = p.match(/^(.+?)\s*\(([A-Za-z][A-Za-z0-9./-]{1,12})\)$/);
    if (m) { out[out.length - 1] = m[1].trim(); out.push(m[2].trim()); }
  }
  return out;
}

// Canonical key for counting/dedupe: lowercase, strip punctuation, singularize.
function canon(s) {
  return s.toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function contentTokens(key) {
  return key.split(/[ /+#.-]+/).filter((t) => t && !STOP.has(t)).map(singular);
}

// ---- gather report keywords ---------------------------------------------

const reportsDir = join(ROOT, 'data', 'reports');
const files = readdirSync(reportsDir).filter((f) => /^\d+-.*\.md$/.test(f));

const freq = new Map();   // canonKey -> { count, display:Map(orig->n), tokens }
let withKw = 0;

let scoreFiltered = 0;

// Raw keyword strings a single report contributes — from the legacy
// "Extracted Keywords" section (bullet lines verbatim) and/or the newer
// "ATS Targets" section (each must-cover term minus its `— [src: id]` tail,
// both sides of every bridge pair, each do-not-claim term). Every returned
// string is fed through atomize()/canon() exactly like a legacy bullet line,
// so both formats share one counting path.
function reportKeywordSources(lines) {
  const out = [];

  const legacy = lines.findIndex((l) => /^#+\s+Extracted Keywords/i.test(l));
  if (legacy !== -1) {
    for (let i = legacy + 1; i < lines.length; i++) {
      if (/^#+\s/.test(lines[i])) break;              // next section
      if (/^\s*[-*]\s+/.test(lines[i])) out.push(lines[i]);
    }
  }

  const ats = lines.findIndex((l) => /^#+\s+ATS Targets/i.test(l));
  if (ats !== -1) {
    for (let i = ats + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^#+\s/.test(l)) break;              // next section
      if (!/^\s*[-*]\s+/.test(l)) continue;    // only bullets (skip intro lines)
      const body = l.replace(/^\s*[-*]\s+/, '').trim();
      const bridge = body.match(/^"([^"]+)"\s*↔\s*"([^"]+)"/);
      if (bridge) { out.push(bridge[1], bridge[2]); continue; }
      let term = body;                         // must-cover / do-not-claim
      const s = term.search(/\[src:/i);
      if (s !== -1) term = term.slice(0, s);   // drop the [src: id] tail
      term = term.replace(/\s*[—–-]\s*$/, '').trim(); // drop the dash before it
      if (term) out.push(term);
    }
  }

  return out;
}

for (const f of files) {
  const text = readFileSync(join(reportsDir, f), 'utf8');
  if (!Number.isNaN(MIN_SCORE)) {
    const sm = text.match(/^\*\*Score:\*\*\s*([0-9.]+)\s*\/\s*5/m);
    const sc = sm ? parseFloat(sm[1]) : NaN;
    if (Number.isNaN(sc) || sc <= MIN_SCORE) { scoreFiltered++; continue; }
  }
  const lines = text.split('\n');
  const sources = reportKeywordSources(lines);
  if (sources.length === 0) continue;
  const seen = new Set(); // dedupe within a single report
  let any = false;
  for (const src of sources) {
    for (const atom of atomize(src)) {
      const key = canon(atom);
      if (!key || key.length < 2) continue;
      any = true;
      if (seen.has(key)) continue;
      seen.add(key);
      let e = freq.get(key);
      if (!e) { e = { count: 0, display: new Map(), tokens: contentTokens(key) }; freq.set(key, e); }
      e.count++;
      e.display.set(atom, (e.display.get(atom) || 0) + 1);
    }
  }
  if (any) withKw++;
}

// ---- candidate corpus & coverage ----------------------------------------

function loadCorpus(rel, extra = '') {
  let t = '';
  try { t = readFileSync(join(ROOT, rel), 'utf8'); } catch { /* optional */ }
  return canon(t + ' ' + extra);
}
let skillsLine = '';
try {
  const cvj = JSON.parse(readFileSync(join(ROOT, 'config/cv.json'), 'utf8'));
  skillsLine = (cvj.skills_inventory || cvj.skills || []).join(' ');
} catch { /* optional */ }

const CV = loadCorpus('config/cv.md', skillsLine);
const SB = loadCorpus('config/story-bank.md');
const BOTH = CV + ' ' + SB;

function classify(key, tokens) {
  const phrase = key.replace(/\s+/g, ' ').trim();
  const inCV = CV.includes(phrase);
  const inSB = SB.includes(phrase);
  if (inCV || inSB) return { tier: 'strong', where: inCV ? (inSB ? 'cv+sb' : 'cv') : 'sb' };
  if (tokens.length && tokens.every((t) => BOTH.includes(t))) {
    const cv = tokens.every((t) => CV.includes(t));
    const sb = tokens.every((t) => SB.includes(t));
    return { tier: 'partial', where: cv ? (sb ? 'cv+sb' : 'cv') : sb ? 'sb' : 'mixed' };
  }
  return { tier: 'gap', where: '—' };
}

// ---- assemble rows -------------------------------------------------------

let rows = [...freq.entries()].map(([key, e]) => {
  const display = [...e.display.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const { tier, where } = classify(key, e.tokens);
  return { key, display, count: e.count, tier, where };
});
rows.sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));

const totalTerms = rows.length;
const summary = { strong: 0, partial: 0, gap: 0 };
for (const r of rows) summary[r.tier]++;

let view = rows.filter((r) => r.count >= MIN_FREQ);
if (ONLY_GAPS) view = view.filter((r) => r.tier === 'gap');
if (TOP > 0) view = view.slice(0, TOP);

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    reports: { total: files.length, withKeywords: withKw },
    distinctTerms: totalTerms, coverage: summary, rows: view,
  }, null, 2) + '\n');
  process.exit(0);
}

// ---- console + artifact --------------------------------------------------

const ICON = { strong: '✅', partial: '🟡', gap: '❌' };
const scoreNote = Number.isNaN(MIN_SCORE) ? '' :
  ` · score > ${MIN_SCORE} only (${scoreFiltered} excluded)`;
const head = `${withKw}/${files.length} reports carried keywords${scoreNote} · ${totalTerms} distinct terms · ` +
  `coverage: ✅ ${summary.strong} strong / 🟡 ${summary.partial} partial / ❌ ${summary.gap} gap`;

console.log('\n' + head + '\n');
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('#', 4) + pad('keyword', 42) + pad('cov', 5) + pad('where', 8) + 'tier');
console.log('-'.repeat(72));
for (const r of view) {
  console.log(pad(r.count, 4) + pad(r.display.slice(0, 40), 42) + pad(ICON[r.tier], 5) +
    pad(r.where, 8) + r.tier);
}

if (!TOP && !ONLY_GAPS && MIN_FREQ <= 1) {
  const top = rows.slice(0, 60);
  const gaps = rows.filter((r) => r.tier === 'gap' && r.count >= 3);
  const md = [
    '# Keyword Frequency Analysis',
    '',
    `_Generated ${new Date().toISOString().slice(0, 10)} · zero-token · ` +
      `\`node lib/keyword-frequency.mjs${Number.isNaN(MIN_SCORE) ? '' : ` --min-score ${MIN_SCORE}`}\`_`,
    '',
    head.replace(/✅|🟡|❌/g, (m) => m),
    '',
    '## Top 60 keywords by report frequency',
    '',
    '| Reports | Keyword | Coverage | Where |',
    '|--:|---|:--:|---|',
    ...top.map((r) => `| ${r.count} | ${r.display} | ${ICON[r.tier]} | ${r.where} |`),
    '',
    `## High-frequency gaps (≥3 reports, absent from CV & story bank) — ${gaps.length}`,
    '',
    'These are the terms the market asks for most that your materials do not yet evidence.',
    '',
    '| Reports | Keyword |',
    '|--:|---|',
    ...gaps.map((r) => `| ${r.count} | ${r.display} |`),
    '',
  ].join('\n');
  const fname = Number.isNaN(MIN_SCORE)
    ? '_keyword-analysis.md'
    : `_keyword-analysis-score-gt-${MIN_SCORE}.md`;
  const outPath = join(ROOT, 'output', fname);
  writeFileSync(outPath, md);
  console.log(`\nArtifact: output/${fname} (top 60 + ${gaps.length} high-freq gaps)`);
}
