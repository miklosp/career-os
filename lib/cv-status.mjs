#!/usr/bin/env node
/**
 * cv-status.mjs — deterministic, zero-token CV health & optimality report.
 *
 * Consumed by `modes/cv.md` to drive the interactive CV mode; usable
 * standalone as a sanity check. Reads only files; never writes.
 *
 * Inputs (all relative to repo root):
 *   config/cv.json            canonical CV (required)
 *   config/cv.md              derived markdown view (optional, presence checked)
 *   config/story-bank.md      STAR+R bank (optional)
 *   config/profile.md         archetype vocabulary + identity (optional)
 *   data/applications.md      to count scored-≥3.5 apps for keyword-agg gating
 *   output/_keyword-analysis*.md  presence flag (kw-analysis already run)
 *
 * Sections + max points (sum 100):
 *   files          5   cv.json present (gate), cv.md present, story-bank present
 *   coverage      20   totalBullets≥30, every role ≥3 bullets, per-archetype ≥10
 *   tiering       15   core≥8, default≥12, 0 untagged
 *   quantified    10   ≥40% of bullets contain a digit/%
 *   skills        10   skills_inventory≥25, evidence_refs cover most skills
 *   storybank     15   ≥12 stories, 0 underrepresented (no distinctive-token
 *                       overlap with cv.json bullets), 0 duplicate ids
 *   writing       10   0 bullets >40 words, 0 <6 words, avg ∈ [12,25]
 *   keywords       5   not eligible OR (eligible AND analysis artifact exists)
 *   integrity     10   0 duplicate bullet ids, 0 invalid tiers/archetypes
 *
 * Story underrepresentation heuristic: a story is flagged if NONE of its
 * distinctive tokens (numbers with optional unit suffix; capitalized proper
 * nouns ≥4 chars excluding a small stop list) appear in the union of cv.json
 * bullet texts. Conservative — it's a prompt, not a verdict.
 *
 * Usage:
 *   node lib/cv-status.mjs            # human-readable report (default)
 *   node lib/cv-status.mjs --json     # machine-readable, for modes/cv.md
 */
import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { eachHighlight, collectSourceIds } from "./cv-schema.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");

const VALID_TIERS = ["core", "default", "depth"];
const VALID_ARCHETYPES = ["product", "ai", "design"];

// ── helpers ──────────────────────────────────────────────────────────────────
const rd = async (p) => {
  try {
    return await readFile(resolve(root, p), "utf-8");
  } catch {
    return null;
  }
};
const rdJson = async (p) => {
  const t = await rd(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const words = (s) => s.trim().split(/\s+/).filter(Boolean);
const clip01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Distinctive-token extractor: numbers with optional unit suffix, and
// capitalized proper-noun-ish tokens (3+ alpha chars, not in stop list).
const PROPER_STOP = new Set(
  ("A An The And Or But So Now Then Today When Where What Which Who Why How " +
    "This That These Those Here There My Our His Her Their Its Your I We They " +
    "Built Led Designed Shipped Released Launched Owned Hired Managed Joined " +
    "Year Month Week Day Years Months Weeks Days Senior Head Lead Director " +
    "Product Design Engineering Team Teams Project Projects Company Companies " +
    "Customer Customers User Users Market Strategy Series Stage Pilot")
    .split(/\s+/),
);
function distinctiveTokens(text) {
  const out = new Set();
  if (!text) return out;
  // numbers ($1M, 1M, 30%, 6, 2024, 0-1M etc.) — pre-tokenize to preserve symbols
  for (const m of text.matchAll(/\$?[\d][\d.,]*[KkMmBb%]?\b/g)) {
    const t = m[0].toLowerCase();
    if (/[\dkmb%]/.test(t)) out.add(t);
  }
  // proper-noun-ish: capitalized 3+ char alpha (incl. CamelCase / acronyms)
  for (const m of text.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)) {
    const t = m[0];
    if (PROPER_STOP.has(t)) continue;
    out.add(t.toLowerCase());
  }
  return out;
}
const intersects = (a, b) => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

// Parse data/applications.md scored rows. Matches the format from
// lib/gap-analysis.mjs: pipe-delimited, score column "N.N/5".
function countScoredApps(appsRaw, minScore) {
  if (!appsRaw) return 0;
  let n = 0;
  for (const line of appsRaw.split("\n")) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cols = line.split("|").slice(1, -1).map((s) => s.trim());
    const sm = (cols[4] || "").match(/^([\d.]+)\s*\/\s*5/);
    if (!sm) continue;
    if (parseFloat(sm[1]) >= minScore) n++;
  }
  return n;
}

function parseStoryBank(raw) {
  if (!raw) return { stories: [], duplicates: [] };
  const stories = [];
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!/^###\s+/.test(lines[i])) { i++; continue; }
    const heading = lines[i].trim();
    let id = null;
    const buf = [heading];
    i++;
    while (i < lines.length && !/^###\s+/.test(lines[i])) {
      buf.push(lines[i]);
      const m = lines[i].match(/^\*\*ID:\*\*\s*(\S+)\s*$/);
      if (m && !id) id = m[1];
      i++;
    }
    if (!id) continue;
    if (/^S0+X+$/i.test(id)) continue; // template placeholder
    stories.push({ id, heading, body: buf.join("\n") });
  }
  const seen = new Map();
  for (const s of stories) seen.set(s.id, (seen.get(s.id) || 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  return { stories, duplicates };
}

// ── load ─────────────────────────────────────────────────────────────────────
const cvJson = await rdJson("config/cv.json");
const cvMd = await rd("config/cv.md");
const sbRaw = await rd("config/story-bank.md");
const profileRaw = await rd("config/profile.md");
const appsRaw = await rd("data/applications.md");

// Onboarding gate: without cv.json there is nothing to score.
if (!cvJson) {
  const report = {
    onboarding: true,
    message:
      "config/cv.json is missing. Copy templates/cv.example.md to config/cv.md, " +
      "fill in your CV, then run `pnpm cv-migrate` to produce the canonical cv.json.",
    score: 0,
  };
  if (AS_JSON) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    console.log("⚠️  No config/cv.json — onboarding required.");
    console.log("    " + report.message);
  }
  process.exit(0);
}

// ── sections ─────────────────────────────────────────────────────────────────
const sections = [];
const actions = []; // { gain, priority, message, command? }

// 1. Files (5)
{
  const max = 5;
  const findings = [];
  let pts = 2; // cv.json present
  if (cvMd) pts += 1;
  else findings.push("cv.md missing — run `pnpm cv-build`.");
  if (sbRaw) pts += 1;
  else findings.push("story-bank.md missing — copy from templates/story-bank.example.md.");
  if (profileRaw) pts += 1;
  else findings.push("profile.md missing — copy from templates/profile.example.md.");
  sections.push({ id: "files", label: "Files", score: pts, max, findings });
  if (!cvMd) actions.push({ gain: 1, priority: 90, message: "Regenerate cv.md", command: "pnpm cv-build" });
  if (!sbRaw) actions.push({ gain: 1, priority: 85, message: "Initialize story bank", command: "cp templates/story-bank.example.md config/story-bank.md" });
}

// 2. Coverage (20): total bullets, roles ≥3, per-archetype ≥10
const allBullets = eachHighlight(cvJson);
const totalBullets = allBullets.length;
const roles = (cvJson.work || []).map((w) => {
  const direct = (w.highlights || []).length;
  const sub = (w.subEntries || []).reduce((a, se) => a + (se.highlights || []).length, 0);
  return { position: w.position, company: w.company, bullets: direct + sub };
});
const shortRoles = roles.filter((r) => r.bullets > 0 && r.bullets < 3);
const archCounts = { product: 0, ai: 0, design: 0, universal: 0 };
for (const b of allBullets) {
  const a = Array.isArray(b.archetypes) ? b.archetypes : [];
  if (a.length === 0) {
    archCounts.universal++;
    archCounts.product++;
    archCounts.ai++;
    archCounts.design++;
  } else {
    for (const x of a) if (x in archCounts) archCounts[x]++;
  }
}
{
  const max = 20;
  const pTot = clip01(totalBullets / 30) * 5;
  const pShort =
    roles.length === 0 ? 0 : 5 * (1 - shortRoles.length / Math.max(1, roles.length));
  const pArch =
    (clip01(archCounts.product / 10) + clip01(archCounts.ai / 10) + clip01(archCounts.design / 10)) *
    (10 / 3);
  const pts = +(pTot + pShort + pArch).toFixed(1);
  const findings = [
    `${totalBullets} bullets across ${roles.length} roles`,
    `per archetype: product=${archCounts.product} · ai=${archCounts.ai} · design=${archCounts.design} (universal=${archCounts.universal})`,
  ];
  if (shortRoles.length) findings.push(`roles under 3 bullets: ${shortRoles.map((r) => r.position + "@" + r.company).join(", ")}`);
  sections.push({ id: "coverage", label: "Coverage", score: pts, max, findings, detail: { totalBullets, roles, archCounts, shortRoles } });
  if (totalBullets < 30) actions.push({ gain: +(5 - pTot).toFixed(1), priority: 80, message: `Expand to ≥30 bullets (you have ${totalBullets}) — more selection material per JD; aim for 5+ per role.` });
  for (const r of shortRoles) actions.push({ gain: +((5 / Math.max(1, roles.length)).toFixed(1)), priority: 75, message: `Add bullets to ${r.position} @ ${r.company} (only ${r.bullets})` });
  for (const a of ["product", "ai", "design"]) {
    if (archCounts[a] < 10)
      actions.push({ gain: +(10 / 3 - clip01(archCounts[a] / 10) * (10 / 3)).toFixed(1), priority: 70, message: `Expand ${a}-archetype coverage (currently ${archCounts[a]}, target ≥10) — add bullets or tag universal ones to ${a}.` });
  }
}

// 3. Tiering (15)
const tierCounts = { core: 0, default: 0, depth: 0, untagged: 0 };
for (const b of allBullets) {
  const t = b.tier;
  if (!t) tierCounts.untagged++;
  else if (t in tierCounts) tierCounts[t]++;
  else tierCounts.untagged++; // invalid handled by integrity
}
{
  const max = 15;
  const pCore = clip01(tierCounts.core / 8) * 6;
  const pDef = clip01(tierCounts.default / 12) * 6;
  const tagged = totalBullets - tierCounts.untagged;
  const pAll = totalBullets === 0 ? 0 : 3 * (tagged / totalBullets);
  const pts = +(pCore + pDef + pAll).toFixed(1);
  const findings = [
    `core=${tierCounts.core} · default=${tierCounts.default} · depth=${tierCounts.depth}` +
      (tierCounts.untagged ? ` · untagged=${tierCounts.untagged}` : ""),
  ];
  sections.push({ id: "tiering", label: "Tiering", score: pts, max, findings, detail: { tierCounts } });
  if (tierCounts.untagged > 0)
    actions.push({ gain: +(3 - pAll).toFixed(1), priority: 88, message: `Tier ${tierCounts.untagged} untagged bullets (core/default/depth) — drives the deterministic projector + the LLM JD path.` });
  if (tierCounts.core < 8)
    actions.push({ gain: +(6 - pCore).toFixed(1), priority: 78, message: `Promote bullets to core (currently ${tierCounts.core}, target ≥8) — core is the always-include spine.` });
  if (tierCounts.default < 12)
    actions.push({ gain: +(6 - pDef).toFixed(1), priority: 65, message: `Tag more bullets as default (currently ${tierCounts.default}, target ≥12).` });
}

// 4. Quantification (10)
const withDigits = allBullets.filter((b) => /\d/.test(b.text)).length;
const qRatio = totalBullets ? withDigits / totalBullets : 0;
{
  const max = 10;
  const pts = +(clip01(qRatio / 0.4) * 10).toFixed(1);
  const unq = allBullets.filter((b) => !/\d/.test(b.text)).map((b) => b.id);
  sections.push({ id: "quantified", label: "Quantification", score: pts, max, findings: [`${withDigits}/${totalBullets} bullets carry a number (${Math.round(qRatio * 100)}%; target 40%+)`], detail: { unquantified: unq } });
  if (qRatio < 0.4)
    actions.push({ gain: +(10 - pts).toFixed(1), priority: 72, message: `Add real metrics to unquantified bullets — record numbers you already know, never invent. ${unq.slice(0, 4).join(", ")}${unq.length > 4 ? `, +${unq.length - 4} more` : ""}.` });
}

// 5. Skills (10). A skill is "covered" when its canonical or any aliases.yml
// form has all content tokens present across the bullet corpus, with simple
// plural-stem and acronym tolerance. Compound canonicals split on `/` and `&`
// as OR (`Cloud Native / Kubernetes` covers if either side fully matches).
// `evidence_refs` in cv.json is *not* consulted — its per-bullet ≥0.6 rule
// can't see whole-corpus evidence; see lib/CV-PIPELINE.md.
const inventory = cvJson.skills_inventory || [];
let aliasesYml = null;
{
  const raw = await rd("config/aliases.yml");
  if (raw) {
    try {
      const { load } = await import("js-yaml");
      aliasesYml = load(raw);
    } catch {
      /* malformed aliases — treat as none */
    }
  }
}
const aliasMap = new Map();
for (const a of aliasesYml?.aliases || []) {
  aliasMap.set(a.canonical, [a.canonical, ...(a.forms || [])]);
}
const STOP_SHORT = new Set(
  ("a an the and or but if of to in on at by as is are was were be been being for from into with " +
    "without via per over under across within using based driven led new this that these those " +
    "my our your its their it not no")
    .split(/\s+/),
);
const tokenize = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_SHORT.has(w))
    .map((w) => (w.length >= 4 && w.endsWith("s") ? w.slice(0, -1) : w));
const corpusSet = new Set();
for (const b of allBullets) for (const t of tokenize(b.text)) corpusSet.add(t);
const skillCovered = (skill) => {
  const forms = aliasMap.get(skill) || [skill];
  for (const form of forms) {
    for (const sp of form.split(/[\/&]/).map((s) => s.trim()).filter(Boolean)) {
      const toks = tokenize(sp);
      if (!toks.length) continue;
      if (toks.every((t) => corpusSet.has(t))) return true;
    }
  }
  return false;
};
const uncoveredSkills = inventory.filter((s) => !skillCovered(s));
const skillsCovered = inventory.length - uncoveredSkills.length;
{
  const max = 10;
  const pSize = clip01(inventory.length / 25) * 5;
  const pCov = inventory.length ? 5 * (skillsCovered / inventory.length) : 0;
  const pts = +(pSize + pCov).toFixed(1);
  sections.push({
    id: "skills",
    label: "Skills inventory",
    score: pts,
    max,
    findings: [
      `${inventory.length} skills (target ≥25)`,
      `${skillsCovered}/${inventory.length} evidenced in the corpus (canonical + aliases)`,
    ],
    detail: { inventorySize: inventory.length, skillsCovered, uncoveredSkills },
  });
  if (inventory.length < 25)
    actions.push({ gain: +(5 - pSize).toFixed(1), priority: 82, message: `Expand skills_inventory (currently ${inventory.length}, target ≥25). Rule D requires every Core Competency to live here.` });
  if (uncoveredSkills.length)
    actions.push({
      gain: +(5 - pCov).toFixed(1),
      priority: 50,
      message:
        `${uncoveredSkills.length} skills aren't evidenced anywhere in the bullet corpus: ` +
        uncoveredSkills.slice(0, 6).join(", ") +
        (uncoveredSkills.length > 6 ? `, +${uncoveredSkills.length - 6} more` : "") +
        ". Either add an alias for a legitimate synonym, expand a bullet to mention them, or drop them if aspirational.",
    });
}

// 6. Story bank (15)
const { stories, duplicates: storyDups } = parseStoryBank(sbRaw);
const cvCorpus = allBullets.map((b) => b.text).join("\n");
const cvTokens = distinctiveTokens(cvCorpus);
const underrep = [];
for (const s of stories) {
  const stoks = distinctiveTokens(s.body);
  if (stoks.size === 0) continue; // can't tell
  if (!intersects(stoks, cvTokens)) underrep.push({ id: s.id, heading: s.heading });
}
{
  const max = 15;
  const pCount = clip01(stories.length / 12) * 5;
  const pUnder = stories.length === 0 ? 0 : 7 * (1 - underrep.length / stories.length);
  const pDups = storyDups.length === 0 ? 3 : 0;
  const pts = +(pCount + pUnder + pDups).toFixed(1);
  const findings = [`${stories.length} stories (target ≥12)`, `${underrep.length} underrepresented in CV`];
  if (storyDups.length) findings.push(`duplicate ids: ${storyDups.join(", ")}`);
  sections.push({ id: "storybank", label: "Story bank", score: pts, max, findings, detail: { stories: stories.length, underrep, duplicates: storyDups } });
  for (const u of underrep.slice(0, 6))
    actions.push({ gain: +(7 / Math.max(1, stories.length)).toFixed(1), priority: 76, message: `Surface story ${u.id} in the CV — none of its distinctive tokens appear in any cv.json bullet (${u.heading.replace(/^###\s*/, "")})` });
  if (storyDups.length)
    actions.push({ gain: 3, priority: 92, message: `Renumber duplicate story ids in story-bank.md: ${storyDups.join(", ")} — duplicates make [src:] citations ambiguous for the validator.` });
}

// 7. Writing heuristics (10)
const wcs = allBullets.map((b) => words(b.text).length);
const longB = allBullets.filter((b) => words(b.text).length > 40);
const shortB = allBullets.filter((b) => words(b.text).length < 6);
const avg = wcs.length ? wcs.reduce((a, b) => a + b, 0) / wcs.length : 0;
{
  const max = 10;
  const pLong = totalBullets === 0 ? 0 : 5 * (1 - longB.length / totalBullets);
  const pShort = totalBullets === 0 ? 0 : 2.5 * (1 - shortB.length / totalBullets);
  const pAvg = avg >= 12 && avg <= 25 ? 2.5 : 0;
  const pts = +(pLong + pShort + pAvg).toFixed(1);
  sections.push({
    id: "writing",
    label: "Writing",
    score: pts,
    max,
    findings: [
      `avg ${avg.toFixed(1)} words/bullet (target 12–25)`,
      `${longB.length} bullets > 40 words · ${shortB.length} bullets < 6 words`,
    ],
    detail: { avgWords: +avg.toFixed(1), longBullets: longB.map((b) => b.id), shortBullets: shortB.map((b) => b.id) },
  });
  if (longB.length)
    actions.push({ gain: +(5 - pLong).toFixed(1), priority: 60, message: `Split run-on bullets >40 words (atomic bullets cite cleaner under Rule A): ${longB.slice(0, 4).map((b) => b.id).join(", ")}${longB.length > 4 ? "…" : ""}` });
  if (shortB.length)
    actions.push({ gain: +(2.5 - pShort).toFixed(1), priority: 45, message: `Expand bullets <6 words with concrete context: ${shortB.slice(0, 4).map((b) => b.id).join(", ")}` });
  if (!(avg >= 12 && avg <= 25))
    actions.push({ gain: 2.5, priority: 40, message: `Tune average bullet length (now ${avg.toFixed(1)}; aim 12–25 words).` });
}

// 8. Keyword aggregation (5)
const scoredApps = countScoredApps(appsRaw, 3.5);
const eligible = scoredApps >= 10;
let kwArtifact = false;
try {
  const outDir = resolve(root, "output");
  for (const f of await readdir(outDir)) {
    if (/^_keyword-analysis.*\.md$/.test(f)) {
      const st = await stat(join(outDir, f));
      // Treat as fresh only if newer than cv.json (otherwise it predates current state)
      try {
        const cvSt = await stat(resolve(root, "config/cv.json"));
        if (st.mtimeMs >= cvSt.mtimeMs - 7 * 24 * 3600 * 1000) kwArtifact = true;
      } catch {
        kwArtifact = true;
      }
    }
  }
} catch {
  /* output/ may not exist yet */
}
{
  const max = 5;
  let pts, finding;
  if (!eligible) {
    pts = 5;
    finding = `${scoredApps} scored-≥3.5 applications — keyword aggregation gated until ≥10`;
  } else if (kwArtifact) {
    pts = 5;
    finding = `${scoredApps} apps ≥3.5 · keyword analysis artifact present`;
  } else {
    pts = 2.5;
    finding = `${scoredApps} apps ≥3.5 · keyword analysis not run yet`;
  }
  sections.push({ id: "keywords", label: "Keyword aggregation", score: pts, max, findings: [finding], detail: { scoredApps, eligible, kwArtifact } });
  if (eligible && !kwArtifact)
    actions.push({ gain: 2.5, priority: 55, message: "Run keyword aggregation to surface market gaps", command: "pnpm kw-analysis --min-score 3.5" });
}

// 9. Integrity (10)
const ids = allBullets.map((b) => b.id);
const idCounts = new Map();
for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);
const dupBulletIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
const invalidTiers = allBullets.filter((b) => b.tier != null && !VALID_TIERS.includes(b.tier)).map((b) => ({ id: b.id, tier: b.tier }));
const invalidArchs = [];
for (const b of allBullets) {
  if (!Array.isArray(b.archetypes)) continue;
  for (const a of b.archetypes) if (!VALID_ARCHETYPES.includes(a)) invalidArchs.push({ id: b.id, archetype: a });
}
{
  const max = 10;
  const pts = +(
    (dupBulletIds.length === 0 ? 4 : 0) +
    (invalidTiers.length === 0 ? 3 : 0) +
    (invalidArchs.length === 0 ? 3 : 0)
  ).toFixed(1);
  const findings = [];
  if (dupBulletIds.length) findings.push(`duplicate bullet ids: ${dupBulletIds.join(", ")}`);
  if (invalidTiers.length) findings.push(`invalid tiers: ${invalidTiers.map((t) => `${t.id}=${t.tier}`).join(", ")}`);
  if (invalidArchs.length) findings.push(`invalid archetypes: ${invalidArchs.map((a) => `${a.id}=${a.archetype}`).join(", ")}`);
  if (!findings.length) findings.push("clean");
  sections.push({ id: "integrity", label: "Integrity", score: pts, max, findings, detail: { dupBulletIds, invalidTiers, invalidArchs } });
  if (dupBulletIds.length) actions.push({ gain: 4, priority: 95, message: `Resolve duplicate bullet ids: ${dupBulletIds.join(", ")}` });
  if (invalidTiers.length) actions.push({ gain: 3, priority: 94, message: `Fix invalid tier values: ${invalidTiers.map((t) => `${t.id}=${t.tier}`).join(", ")}` });
  if (invalidArchs.length) actions.push({ gain: 3, priority: 93, message: `Fix invalid archetypes: ${invalidArchs.map((a) => `${a.id}=${a.archetype}`).join(", ")}` });
}

// ── composite ────────────────────────────────────────────────────────────────
const total = +sections.reduce((a, s) => a + s.score, 0).toFixed(1);
const totalMax = sections.reduce((a, s) => a + s.max, 0);
actions.sort((a, b) => b.gain - a.gain || b.priority - a.priority);

// ── output ───────────────────────────────────────────────────────────────────
const report = {
  score: total,
  max: totalMax,
  sections,
  next_actions: actions,
  meta: {
    scoredAppsAt35: scoredApps,
    keywordAggEligible: eligible,
    keywordAggHasArtifact: kwArtifact,
    totalBullets,
    storyCount: stories.length,
  },
};

if (AS_JSON) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}

function rating(pct) {
  if (pct >= 0.9) return "✅";
  if (pct >= 0.7) return "🟢";
  if (pct >= 0.5) return "🟡";
  return "🔴";
}
function bar(pct, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(pct * width)));
  return "█".repeat(n) + "░".repeat(width - n);
}

console.log(`\n  CV health · ${total}/${totalMax}  ${bar(total / totalMax, 30)}\n`);
for (const s of sections) {
  const pct = s.max ? s.score / s.max : 0;
  console.log(`  ${rating(pct)}  ${s.label.padEnd(22)} ${String(s.score).padStart(5)} / ${s.max}`);
  for (const f of s.findings) console.log(`        ${f}`);
}
console.log("\n  Next actions (highest gain first):");
if (!actions.length) console.log("    ✨ none — your CV is at the target.\n");
else {
  for (const a of actions.slice(0, 10)) {
    console.log(`    +${a.gain.toFixed(1)}  ${a.message}`);
    if (a.command) console.log(`           $ ${a.command}`);
  }
  if (actions.length > 10) console.log(`    … +${actions.length - 10} more (use --json for the full list)\n`);
  else console.log();
}
