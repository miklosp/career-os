#!/usr/bin/env node
// Jev fit eval: can Jev pre-screen JDs before the Sonnet eval?
//
//   node evals/jev/fit.mjs            fetch missing Jev answers, then report
//   node evals/jev/fit.mjs --report   report from cache only
//   node evals/jev/fit.mjs --limit 20 cap NEW calls this run (smoke test)
//
// Dataset: every tracker row with a numeric score, a JD and a report on disk.
// Label: the Sonnet global score already in applications.md.
//
// One Jev call per JD, state = { cv: user/config/cv.md, job_description: JD }.
// Questions are atomic and generic (no profile text): JD facts (role type,
// domain, stage, UX ownership, required industry tenure) plus two CV-vs-JD
// signals (single match Noul, requirement coverage Score). How much each answer
// matters to this user is learned, not hand-coded: a ridge regression from Jev
// answers to Sonnet score, 2-fold cross-validated, so every prediction comes
// from a model that never saw that row.
//
// Screening question answered by the report: if JDs below a predicted-score
// cutoff skip the Sonnet eval, how many evals are saved and how many ≥4.0
// roles are lost?
//
// Sends cv.md to TypeSafe via Bifrost. Cache: user/output/jev-eval/fit-raw.jsonl.

import { readFileSync, readdirSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APPLICATIONS_FILE, JDS_DIR, REPORTS_DIR, CONFIG_DIR, OUTPUT_DIR } from '../../lib/paths.mjs';

const BIFROST = 'http://localhost:4444/v1/decisions';
const MODEL = 'typesafe/jev-latest';
const CONCURRENCY = 8;
const OUT_DIR = join(OUTPUT_DIR, 'jev-eval');
const RAW = join(OUT_DIR, 'fit-raw.jsonl');

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const JD = '`job_description`';
const QUESTIONS = {
  role: { kind: 'choice', instructions: `What kind of role is ${JD}?`, criteria: {
    pm_junior: 'Product Manager below senior level (Associate PM, PM, PM II)',
    pm_senior: 'Senior, Staff, Principal or Lead Product Manager (individual contributor)',
    pm_manager: 'Group PM or Product Manager who manages other PMs',
    head_of_product: 'Head of Product, the top product person, hands-on',
    director_vp: 'Director, VP or Chief Product Officer overseeing product teams',
    design_lead: 'Head, Director or VP of Design / UX',
    design_ic: 'Individual contributor designer or UX researcher',
    other: 'Not a product management or design role (marketing, engineering, program management, sales, consulting)',
  } },
  domain: { kind: 'choice', instructions: `What is the main domain of the product in ${JD}?`, criteria: {
    ai_platform: 'AI / LLM / agent products or B2B AI platforms',
    devtools_infra: 'Developer tools, cloud infrastructure, observability, data platforms',
    security: 'Cybersecurity, identity, compliance',
    b2b_saas: 'Other B2B SaaS (HR, marketing, sales, collaboration, operations software)',
    fintech: 'Fintech, payments, banking, insurance, trading, lending, crypto',
    consumer: 'Consumer, mobile apps, gaming, e-commerce, marketplaces, media',
    vertical: 'Healthcare, pharma, legal, energy, logistics, manufacturing, education or another industry vertical',
    public_sector: 'Government, defense, public sector',
  } },
  stage: { kind: 'choice', instructions: `What size or stage is the company hiring in ${JD}?`, criteria: {
    early: 'Seed or Series A startup, roughly 60 people or fewer',
    growth: 'Series B to D scale-up',
    enterprise: 'Large or public company, or enterprise',
    agency: 'Consultancy, agency or recruiter hiring for an unnamed client',
    not_stated: 'The job description does not say',
  } },
  ux: { kind: 'score', instructions: `How much does the role in ${JD} own user experience and design?`, criteria: [
    'Not at all, or only boilerplate about working with designers',
    'Design partnership, UX research or design systems are explicitly emphasised, but someone else owns design',
    'The role itself owns UX or design (product and design scope, no separate design lead)',
  ] },
  tenure: { kind: 'noul', instructions: `Does ${JD} require prior years of experience in a specific industry, such as healthcare, finance, gaming or logistics?` },
  match: { kind: 'noul', instructions: `Is the candidate in \`cv\` a strong match for the role in ${JD}: the experience, seniority, and domain the job asks for are clearly shown in the CV?` },
  coverage: { kind: 'score', instructions: `How many of the must-have requirements in ${JD} are clearly shown in \`cv\`?`, criteria: [
    'None', 'A few', 'About half', 'Most', 'All of them',
  ] },
};

// ── dataset ──
function dataset() {
  const jdFiles = new Map(readdirSync(JDS_DIR).map(f => [f.split('-')[0], f]));
  const reports = new Set(readdirSync(REPORTS_DIR).map(f => f.split('-')[0]));
  return readFileSync(APPLICATIONS_FILE, 'utf8').split('\n')
    .map(l => l.split('|').map(s => s.trim()))
    .filter(c => /^\d+$/.test(c[1] || ''))
    .map(c => ({ num: c[1], company: c[3], role: c[4], score: parseFloat(c[5]), file: jdFiles.get(c[1]) }))
    .filter(r => !isNaN(r.score) && r.file && reports.has(r.num));
}

// ── Jev ──
async function decide(state) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BIFROST, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
    });
    if (res.ok) return res.json();
    // Billing failure: every remaining call would fail too. Answers so far stay cached.
    if (res.status === 402) { console.error(`402 — stopping: ${await res.text()}`); process.exit(1); }
    if (attempt >= 4) throw new Error(`${res.status} ${await res.text()}`);
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
}

function loadCache() {
  const cache = new Map();
  if (existsSync(RAW)) for (const l of readFileSync(RAW, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(l); cache.set(j.num, j);
  }
  return cache;
}

async function fetchMissing(items, cache) {
  const cv = readFileSync(join(CONFIG_DIR, 'cv.md'), 'utf8');
  const missing = items.filter(i => !cache.has(i.num));
  const todo = missing.slice(0, limit);
  console.error(`${todo.length} Jev calls to make (${missing.length} missing)`);
  let done = 0, failed = 0;
  const worker = async () => {
    while (todo.length) {
      const it = todo.shift();
      try {
        const r = await decide({ cv, job_description: readFileSync(join(JDS_DIR, it.file), 'utf8') });
        const rec = { num: it.num, answers: r.answers, tokens: r.usage?.prompt_tokens, model: r.model };
        appendFileSync(RAW, JSON.stringify(rec) + '\n');
        cache.set(it.num, rec);
      } catch (e) { failed++; console.error(`${it.num} FAIL ${e.message.slice(0, 200)}`); }
      if (++done % 50 === 0) console.error(`progress ${done}/${done + todo.length} (failed ${failed})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// ── features: choice probabilities, score values, noul values ──
function features(a) {
  const f = [1]; // intercept
  for (const [id, q] of Object.entries(QUESTIONS)) {
    if (q.kind === 'choice') for (const k of Object.keys(q.criteria)) f.push(a[id].probabilities?.[k] ?? 0);
    else f.push(a[id].value);
  }
  return f;
}

// Ridge regression via normal equations + Gaussian elimination.
function fitRidge(X, y, lambda = 1) {
  const n = X[0].length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    X.reduce((s, x) => s + x[i] * x[j], 0) + (i === j && i > 0 ? lambda : 0)));
  const b = Array.from({ length: n }, (_, i) => X.reduce((s, x, k) => s + x[i] * y[k], 0));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < n; r++) if (r !== c) {
      const m = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= m * A[c][k];
      b[r] -= m * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);

const rank = xs => { const s = [...xs].sort((a, b) => a - b); return xs.map(x => (s.indexOf(x) + s.lastIndexOf(x)) / 2); };
const pearson = (a, b) => {
  const m = v => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = m(a), mb = m(b);
  const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  return cov / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
};
const spearman = (a, b) => pearson(rank(a), rank(b));

// ── report ──
function report(items, cache) {
  const rows = items.filter(i => cache.has(i.num)).map(i => ({ ...i, a: cache.get(i.num).answers }));
  const lines = [];
  const say = s => { lines.push(s); console.log(s); };
  const y = rows.map(r => r.score);
  const tokens = [...cache.values()].reduce((s, r) => s + (r.tokens || 0), 0);

  say(`# Jev fit eval — ${new Date().toISOString().slice(0, 10)}\n`);
  say(`${rows.length} JDs with a Sonnet score · ${rows.filter(r => r.score >= 4).length} scored ≥4.0 · input tokens: ${tokens.toLocaleString()} (~$${(tokens * 0.042e-6).toFixed(2)})\n`);

  // 2-fold cross-validated composite: even rows train → predict odd, and back.
  const X = rows.map(r => features(r.a));
  const pred = new Array(rows.length);
  for (const fold of [0, 1]) {
    const tr = rows.map((_, i) => i).filter(i => i % 2 !== fold);
    const w = fitRidge(tr.map(i => X[i]), tr.map(i => y[i]));
    rows.forEach((_, i) => { if (i % 2 === fold) pred[i] = dot(w, X[i]); });
  }

  say('## Rank agreement with Sonnet score (Spearman ρ)\n');
  say('| signal | ρ |'); say('|---|---|');
  say(`| match (single Noul, JD + CV) | ${spearman(rows.map(r => r.a.match.value), y).toFixed(2)} |`);
  say(`| coverage (Score, must-haves shown in CV) | ${spearman(rows.map(r => r.a.coverage.value), y).toFixed(2)} |`);
  say(`| **composite (all answers, cross-validated)** | **${spearman(pred, y).toFixed(2)}** |\n`);

  say('## Screening: skip the Sonnet eval when the signal is below a cutoff\n');
  say('Cutoff chosen as the lowest signal value among ≥4.0 roles you are willing to lose none / 5% of.\n');
  say('| signal | keep ≥4.0 roles | evals saved | ≥3.5 roles dropped |'); say('|---|---|---|---|');
  for (const [name, sig] of [['match', rows.map(r => r.a.match.value)], ['coverage', rows.map(r => r.a.coverage.value)], ['composite', pred]]) {
    const good = rows.map((r, i) => [sig[i], r.score]).filter(([, s]) => s >= 4).map(([v]) => v).sort((a, b) => a - b);
    for (const keep of [1, 0.95]) {
      const cut = good[Math.floor(good.length * (1 - keep))];
      const dropped = rows.filter((_, i) => sig[i] < cut);
      say(`| ${name} | ${keep * 100}% | ${dropped.length} (${(100 * dropped.length / rows.length).toFixed(0)}%) | ${dropped.filter(r => r.score >= 3.5).length} |`);
    }
  }

  say('\n## Composite vs Sonnet, by Sonnet band\n');
  say('| Sonnet band | n | mean composite |'); say('|---|---|---|');
  for (const [lo, hi] of [[0, 2.5], [2.5, 3], [3, 3.5], [3.5, 4], [4, 6]]) {
    const b = rows.map((r, i) => [r.score, pred[i]]).filter(([s]) => s >= lo && s < hi);
    say(`| ${lo}–${hi === 6 ? '5' : hi} | ${b.length} | ${(b.reduce((s, [, p]) => s + p, 0) / (b.length || 1)).toFixed(2)} |`);
  }

  // Weights from a fit on all rows, to see what Jev's answers say about this user.
  const w = fitRidge(X, y);
  const names = ['intercept'];
  for (const [id, q] of Object.entries(QUESTIONS)) {
    if (q.kind === 'choice') for (const k of Object.keys(q.criteria)) names.push(`${id}=${k}`); else names.push(id);
  }
  say('\n## Learned weights (fit on all rows; + raises predicted score)\n');
  say('| feature | weight |'); say('|---|---|');
  names.map((n, i) => [n, w[i]]).slice(1).sort((a, b) => b[1] - a[1]).forEach(([n, v]) => say(`| ${n} | ${v >= 0 ? '+' : ''}${v.toFixed(2)} |`));

  // Worst misses: ≥4.0 roles the composite ranks lowest.
  say('\n## ≥4.0 roles the composite ranks lowest\n');
  say('| NUM | company — role | Sonnet | composite | role | domain |'); say('|---|---|---|---|---|---|');
  rows.map((r, i) => ({ ...r, p: pred[i] })).filter(r => r.score >= 4).sort((a, b) => a.p - b.p).slice(0, 10)
    .forEach(r => say(`| ${r.num} | ${r.company} — ${r.role} | ${r.score} | ${r.p.toFixed(2)} | ${r.a.role.value} | ${r.a.domain.value} |`));
  return lines.join('\n') + '\n';
}

mkdirSync(OUT_DIR, { recursive: true });
const items = dataset();
const cache = loadCache();
if (!reportOnly) await fetchMissing(items, cache);
writeFileSync(join(OUT_DIR, 'fit-report.md'), report(items, cache));
console.error(`\nreport → ${join(OUT_DIR, 'fit-report.md')}`);
