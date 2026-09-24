#!/usr/bin/env node
// Cluster Block A bullets from 3.5+ reports into a ranked gap analysis.
// Uses REVIEW_MODEL via the LLM provider. One call. Output: data/reports/_gap-analysis.md
//
// Usage (run from project root):
//   node lib/gap-analysis.mjs 3.5 > /tmp/gap-input.json
//   node lib/gap-synthesize.mjs /tmp/gap-input.json

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { REPORTS_DIR, CONFIG_DIR } from './paths.mjs';
import { identityFromProfile } from './cv-schema.mjs';

const INPUT = process.argv[2] ?? '/tmp/gap-input.json';
const OUTPUT = join(REPORTS_DIR, '_gap-analysis.md');
const LLM_PROVIDER_URL = process.env.LLM_PROVIDER_URL;
const MODEL = process.env.REVIEW_MODEL;
if (!LLM_PROVIDER_URL || !MODEL) {
  console.error('❌ LLM_PROVIDER_URL and REVIEW_MODEL must both be set in the environment.');
  process.exit(1);
}

const data = JSON.parse(readFileSync(INPUT, 'utf8'));
const NAME = identityFromProfile(readFileSync(join(CONFIG_DIR, 'profile.md'), 'utf8'), load).name || 'the candidate';

// Compact each entry: score | company / role -> bullets
const corpus = data
  .map(d => {
    const head = `[${d.num}] ${d.score}/5 — ${d.company} / ${d.role}`;
    const bullets = d.bullets.map(b => `  - ${b}`).join('\n');
    return `${head}\n${bullets}`;
  })
  .join('\n\n');

const prompt = `You are a career strategist analyzing CV gaps from a corpus of pre-scored job evaluations.

INPUT: ${data.length} job evaluations (score >= 3.5/5) for the same candidate (${NAME}). Each entry shows the role and the evaluator's Block A "CV Match" bullets — these already mix matches AND gaps. Your job is to extract and rank the GAPS only.

CORPUS:
---
${corpus}
---

TASK:
1. Read every bullet. Identify gaps: missing domain knowledge, missing skills/tools, scale mismatches, archetype/seniority mismatches, missing proof points the candidate likely *has* but didn't surface in the CV.
2. Cluster recurring gaps. Two bullets that say "no fintech background" and "lacks payments domain" are the same cluster.
3. Rank clusters by:
   - Frequency (how many JDs name it)
   - Score weight (a gap mentioned in a 4.5/5 job matters more than one in a 3.5/5 job)
   - Decisiveness (was it framed as "real hole" / "screener risk" vs "modest miss")
4. Distinguish two gap types:
   - **TRUE GAPS** — things ${NAME} actually doesn't have (e.g. fintech domain, FDA/medtech regulatory)
   - **SURFACING GAPS** — things they probably have but the CV doesn't make legible (e.g. customer interview counts, mobile experience hidden inside other roles)
   This distinction matters because surfacing gaps are CV edits; true gaps require strategic positioning or job filtering.

OUTPUT (markdown, no preamble, no closing summary). Be ruthlessly compact — every line must earn its place. Use ONE evidence quote per cluster, not three.

# Gap Analysis — Jobs Scored 3.5+ vs Current CV

**Corpus:** ${data.length} evaluations | **Date:** ${new Date().toISOString().slice(0, 10)}

## True Gaps (rank by impact)

For each cluster (aim for 6-8), output exactly this 3-line block:
### {N}. {Gap name} — {N mentions, scores X.X–Y.Y}
**Deficit:** one sentence.
**Evidence:** "verbatim quote" [num].
**Action:** apply / avoid / reposition — one short sentence.

## Surfacing Gaps — CV Edits That Close Apparent Gaps

For each (aim for 4-5), output exactly this 3-line block:
### {N}. {Gap name} — {N mentions, scores X.X–Y.Y}
**Pattern:** one sentence on what evaluators noticed but the CV doesn't say.
**CV edit:** specific WHERE + WHAT.
**Closes:** [num], [num], [num].

## By Score Band

- **3.5–3.9** (worth applying?): one paragraph, 3 sentences max, naming what fails most often.
- **4.0+** (best fits): one paragraph, 3 sentences max.

## Top 5 CV Edits (Prioritized)

Numbered 1-5. One line each: WHERE → WHAT → WHY (cluster ref).

End the document immediately after the 5th edit. No closing summary.`;

console.error(`Model: ${MODEL}`);
console.error(`Proxy: ${LLM_PROVIDER_URL}`);
console.error(`Corpus: ${data.length} reports, ${prompt.length.toLocaleString()} chars`);

const res = await fetch(`${LLM_PROVIDER_URL}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 16384,
    stream: true,
  }),
});

if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error(`Bifrost ${res.status}: ${body.slice(0, 600)}`);
  process.exit(1);
}

let md = '';
let usage = null;
const decoder = new TextDecoder();
let buf = '';
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload);
      const delta = ev.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        md += delta;
        process.stderr.write('.');
      }
      if (ev.usage) usage = ev.usage;
    } catch {}
  }
}
process.stderr.write('\n');

if (!md) {
  console.error('Empty response');
  process.exit(1);
}
if (usage) console.error(`Tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out`);

writeFileSync(OUTPUT, md.trim() + '\n');
console.error(`Wrote ${OUTPUT}`);
