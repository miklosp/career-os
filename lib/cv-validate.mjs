#!/usr/bin/env node
/**
 * cv-validate.mjs — deterministic provenance validator for generated CVs.
 *
 * Runs on the *tagged* generated markdown (every bullet ending `[src: id]`,
 * the Summary ending a composite `[src: id, ...]`) BEFORE the tags are
 * stripped. It is structural code, not an LLM: it is the hard guarantee that
 * every line traces to a real source. Separate from (not replaced by) the
 * Gemini judge.
 *
 * Rules (see .notes/new-cv-gen-flow-implementation-plan.md, item 3):
 *   A — every bullet has a trailing [src: id]; Summary ends a composite [src:].
 *   B — every cited id resolves: cv.json bullet | story-bank S0xx | note n# |
 *       Block-A match id.
 *   C — high-risk entities (languages, SDK, frameworks, year counts, language
 *       proficiency) must appear verbatim/alias in the cited source. General
 *       bullet prose: low token-overlap is a SOFT flag (judge, not hard fail).
 *       The Summary is strict — no soft softening.
 *   D — every Core Competency ∈ cv.json.skills_inventory ∪ aliases.
 *   L — length caps, counted after stripping [src:] tags: Summary ≤ 85 words,
 *       each Experience bullet ≤ 25 words. Each bullet cites exactly ONE id
 *       (Rule A); only the Summary carries a composite.
 *
 * Library:  import { buildContext, validateCv, stripSrcTags } from cv-validate
 * CLI:      node lib/cv-validate.mjs <tagged-cv.md> [--num NNN]
 *           (exit 0 = pass, 1 = hard fail; prints a usable failure report)
 */
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, basename } from "path";
import { collectSourceIds } from "./cv-schema.mjs";
import { CONFIG_DIR, DATA_DIR } from "./paths.mjs";

// High-risk lexicons — kept tight on purpose. A miss here is a safe false
// flag the user resolves; an over-broad list hard-fails honest prose.
const PROG_LANGS = [
  "javascript", "typescript", "python", "java", "c++", "c#", "ruby", "rust",
  "golang", "scala", "kotlin", "swift", "php", "perl", "haskell", "elixir",
  "react", "vue", "angular", "svelte", "django", "flask", "rails", "spring",
  "node.js", "nodejs", "graphql",
];
const HIGH_RISK_PHRASES = ["sdk", "backwards compatibility", "backward compatibility"];
const PROFICIENCY_RE = /\b(native|fluent|bilingual|c1|c2|b2|professional working proficiency|full professional)\b/gi;
const YEARCOUNT_RE = /\b\d{1,2}\+?\s*years?\b/gi;
const SUMMARY_MAX_WORDS = 85;
const BULLET_MAX_WORDS = 25;

const norm = (s) => String(s).toLowerCase();
const words = (s) =>
  norm(s).replace(/[^a-z0-9+#./ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);

/** Build alias resolver: any surface form -> set of all equivalent forms. */
function buildAliasIndex(aliasesYml) {
  const idx = new Map();
  for (const a of aliasesYml?.aliases || []) {
    const group = [a.canonical, ...(a.forms || [])].map(norm);
    for (const g of group) idx.set(g, new Set(group));
  }
  return idx;
}

/** Does `needle` appear in `hay` directly or via an alias group? */
function presentWithAlias(needle, hay, aliasIdx) {
  const n = norm(needle);
  const h = norm(hay);
  if (h.includes(n)) return true;
  const grp = aliasIdx.get(n);
  if (grp) for (const form of grp) if (h.includes(form)) return true;
  return false;
}

function jaccard(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (A.size === 0) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / A.size;
}

/**
 * Assemble validation context from the canonical sources.
 * @param {object} o {cvJson, storyBankMd, notesYml, reportMd, aliasesYml}
 */
export function buildContext({ cvJson, storyBankMd = "", notesYml, reportMd = "", aliasesYml }) {
  const textById = new Map();

  // cv.json bullets
  for (const w of cvJson.work || []) {
    for (const h of w.highlights || []) textById.set(h.id, h.text);
    for (const se of w.subEntries || [])
      for (const h of se.highlights || []) textById.set(h.id, h.text);
  }
  const ids = new Set(collectSourceIds(cvJson));

  // story-bank S0xx — capture the whole entry block as supporting text
  const sbBlocks = storyBankMd.split(/^###\s+/m);
  for (const blk of sbBlocks) {
    const m = blk.match(/\*\*ID:\*\*\s*(S\d+)/i);
    if (m) {
      const id = m[1].toUpperCase();
      ids.add(id);
      textById.set(id, blk.replace(/\s+/g, " ").trim());
    }
  }

  // confirmed notes -> n1, n2 ... in list order
  const notes = notesYml?.notes || [];
  notes.forEach((nt, i) => {
    if (nt && nt.confirmed === true) {
      const id = `n${i + 1}`;
      ids.add(id);
      textById.set(id, `${nt.claim || ""} ${nt.supporting_detail || ""}`.trim());
    }
  });

  // Block-A match ids: any [src: <id>] appearing in the report. The match
  // bullet text becomes supporting context for that id too.
  for (const line of reportMd.split("\n")) {
    const mm = line.match(/\[src:\s*([^\]]+)\]/i);
    if (mm) {
      for (const raw of mm[1].split(",")) {
        const id = raw.trim();
        if (!id) continue;
        ids.add(id);
        const prev = textById.get(id) || "";
        textById.set(id, `${prev} ${line}`.trim());
      }
    }
  }

  const inventory = new Set((cvJson.skills_inventory || []).map(norm));
  return {
    ids,
    textById,
    inventory,
    aliasIdx: buildAliasIndex(aliasesYml),
  };
}

const SRC_RE = /\s*\[src:\s*([^\]]+)\]\s*$/i;

/** Parse the tagged markdown into Summary text + Core Competencies + bullets. */
function parseTagged(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let section = null;
  let summary = "";
  let competencies = [];
  const bullets = [];
  for (let i = 0; i < lines.length; i++) {
    const sec = lines[i].match(/^##\s+(.+?)\s*$/);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }
    const t = lines[i].trim();
    if (!t) continue;
    if (section === "summary" && !t.startsWith("#")) {
      summary += (summary ? " " : "") + t;
    } else if (section === "core competencies" && !t.startsWith("**") && !t.startsWith("#")) {
      if (!competencies.length)
        competencies = t.replace(SRC_RE, "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (section === "experience" && t.startsWith("- ")) {
      bullets.push({ line: i + 1, raw: t });
    }
  }
  return { summary, competencies, bullets };
}

/** Words in rendered text: [src:] tags and a leading "- " removed; pure punctuation (e.g. "—") is not a word. */
function wordCount(s) {
  return String(s)
    .replace(/\[src:[^\]]*\]/gi, " ")
    .replace(/^\s*-\s+/, "")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function citedIds(s) {
  const m = String(s).match(/\[src:\s*([^\]]+)\]/i);
  return m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : null;
}

/**
 * Validate tagged markdown. Returns { passed, hard:[], soft:[] }.
 * `bridges` = parsed generator bridges (their generated_text is an allowed
 * conservative phrasing, exempt from the strict Summary entity check).
 */
export function validateCv(taggedMd, ctx, { bridges = [] } = {}) {
  const { ids, textById, inventory, aliasIdx } = ctx;
  const { summary, competencies, bullets } = parseTagged(taggedMd);
  const hard = [];
  const soft = [];
  const bridgeText = (bridges || []).map((b) => norm(b.generated_text || ""));

  const srcUnion = (idList) =>
    idList.map((id) => textById.get(id) || "").join(" ");

  // Rule A + B + C — bullets
  for (const b of bullets) {
    const n = wordCount(b.raw);
    if (n > BULLET_MAX_WORDS)
      hard.push({ rule: "L", line: b.line, reason: `bullet is ${n} words (max ${BULLET_MAX_WORDS}) — keep one outcome, cut the trailing clauses`, text: b.raw });
    const ids2 = citedIds(b.raw);
    if (!ids2 || ids2.length === 0) {
      hard.push({ rule: "A", line: b.line, reason: "bullet missing [src: id]", text: b.raw });
      continue;
    }
    if (ids2.length > 1) {
      hard.push({ rule: "A", line: b.line, reason: `bullet cites ${ids2.length} ids [${ids2.join(", ")}] — exactly one allowed; keep the claim the primary source supports or split into separate bullets`, text: b.raw });
      continue;
    }
    const unknown = ids2.filter((id) => !ids.has(id));
    if (unknown.length) {
      hard.push({ rule: "B", line: b.line, reason: `unresolved id(s): ${unknown.join(", ")}`, text: b.raw });
      continue;
    }
    const src = srcUnion(ids2);
    const body = b.raw.replace(SRC_RE, "");
    const lc = norm(body);

    // Rule C — high-risk entities must be backed by the cited source.
    const risks = [];
    for (const pl of PROG_LANGS)
      if (new RegExp(`(^|[^a-z0-9])${pl.replace(/[.+#]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(lc)) risks.push(pl);
    for (const ph of HIGH_RISK_PHRASES) if (lc.includes(ph)) risks.push(ph);
    for (const m of body.match(YEARCOUNT_RE) || []) risks.push(m.trim());
    for (const m of body.match(PROFICIENCY_RE) || []) risks.push(m.trim());
    for (const r of risks) {
      if (!presentWithAlias(r, src, aliasIdx))
        hard.push({ rule: "C", line: b.line, reason: `high-risk entity "${r}" not in cited source [${ids2.join(", ")}]`, text: b.raw });
    }
    // General prose: low overlap is a SOFT flag (judge), unless it's a bridge.
    if (jaccard(body, src) < 0.12 && !bridgeText.some((bt) => bt && norm(body).includes(bt)))
      soft.push({ rule: "C-weak", line: b.line, reason: `low token-overlap with cited source [${ids2.join(", ")}] — judge should confirm`, text: b.raw });
  }

  // Rule A + B + C(strict) — Summary
  if (summary) {
    const n = wordCount(summary);
    if (n > SUMMARY_MAX_WORDS)
      hard.push({ rule: "L", line: 0, reason: `Summary is ${n} words (max ${SUMMARY_MAX_WORDS})`, text: summary.slice(0, 120) });
    const sIds = citedIds(summary);
    if (!sIds || sIds.length === 0) {
      hard.push({ rule: "A", line: 0, reason: "Summary missing composite [src: ...]", text: summary.slice(0, 120) });
    } else {
      const unknown = sIds.filter((id) => !ids.has(id));
      if (unknown.length)
        hard.push({ rule: "B", line: 0, reason: `Summary unresolved id(s): ${unknown.join(", ")}`, text: summary.slice(0, 120) });
      const src = srcUnion(sIds);
      const body = summary.replace(SRC_RE, "");
      const risks = [];
      for (const pl of PROG_LANGS)
        if (new RegExp(`(^|[^a-z0-9])${pl.replace(/[.+#]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(norm(body))) risks.push(pl);
      for (const ph of HIGH_RISK_PHRASES) if (norm(body).includes(ph)) risks.push(ph);
      for (const m of body.match(YEARCOUNT_RE) || []) risks.push(m.trim());
      for (const r of risks) {
        const ok = presentWithAlias(r, src, aliasIdx) || bridgeText.some((bt) => bt && norm(body).includes(bt));
        if (!ok)
          hard.push({ rule: "C-strict", line: 0, reason: `Summary entity "${r}" not in cited sources [${sIds.join(", ")}] and not a registered bridge`, text: summary.slice(0, 160) });
      }
    }
  }

  // Rule D — closed-world Core Competencies
  for (const c of competencies) {
    const lc = norm(c);
    let ok = inventory.has(lc);
    if (!ok) {
      const grp = aliasIdx.get(lc);
      if (grp) for (const f of grp) if (inventory.has(f)) ok = true;
    }
    if (!ok)
      hard.push({ rule: "D", line: 0, reason: `Core Competency "${c}" not in skills_inventory ∪ aliases`, text: c });
  }

  return { passed: hard.length === 0, hard, soft };
}

/** Remove `[src: ...]` from bullets and the Summary; tidy whitespace. */
export function stripSrcTags(md) {
  return md
    .split("\n")
    .map((l) => l.replace(/\s*\[src:\s*[^\]]+\]\s*$/i, ""))
    .join("\n")
    .replace(/[ \t]+$/gm, "");
}

/** Render hard+soft findings into a <failed_constraints> block for retry. */
export function failedConstraintsBlock(result, ctx) {
  const lines = ["<failed_constraints>"];
  for (const f of result.hard)
    lines.push(`- [HARD ${f.rule}] ${f.reason}\n  bullet: ${f.text}`);
  for (const f of result.soft)
    lines.push(`- [SOFT ${f.rule}] ${f.reason}\n  bullet: ${f.text}`);
  lines.push(
    "Fix each: cite the correct existing [src: id], or rephrase to what the",
    "cited source actually supports, or move the claim to <bridges>/<gaps>.",
    `Length (L): Summary ≤ ${SUMMARY_MAX_WORDS} words, each bullet ≤ ${BULLET_MAX_WORDS} words — cut, don't merge.`,
    "Do not invent new ids. Re-output the full CV + <bridges> + <gaps>.",
    "</failed_constraints>",
  );
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const cvPath = args.find((a) => !a.startsWith("--"));
  if (!cvPath || !existsSync(cvPath)) {
    console.error("Usage: node lib/cv-validate.mjs <tagged-cv.md> [--num NNN]");
    process.exit(2);
  }
  const numArg = (() => {
    const i = args.indexOf("--num");
    return i !== -1 ? args[i + 1] : (basename(cvPath).match(/^(\d+)-/) || [])[1];
  })();

  const { load } = await import("js-yaml");
  const readMaybe = async (p, d = "") => (existsSync(p) ? readFile(p, "utf-8") : d);
  const cvJson = JSON.parse(await readFile(resolve(CONFIG_DIR, "cv.json"), "utf-8"));
  const storyBankMd = await readMaybe(resolve(CONFIG_DIR, "story-bank.md"));
  const notesYml = load(await readMaybe(resolve(CONFIG_DIR, "notes.yml"), "notes: []")) || { notes: [] };
  const aliasesYml = load(await readMaybe(resolve(CONFIG_DIR, "aliases.yml"), "aliases: []")) || { aliases: [] };

  let reportMd = "";
  if (numArg) {
    const rdir = resolve(DATA_DIR, "reports");
    if (existsSync(rdir)) {
      const cand = (await readdir(rdir)).filter((n) => n.startsWith(`${numArg}-`) && n.endsWith(".md"));
      if (cand.length) reportMd = await readFile(resolve(rdir, cand.sort().at(-1)), "utf-8");
    }
  }

  const ctx = buildContext({ cvJson, storyBankMd, notesYml, reportMd, aliasesYml });
  const md = await readFile(cvPath, "utf-8");
  const res = validateCv(md, ctx);
  if (res.passed && res.soft.length === 0) {
    console.log("✅ validation passed (no hard or soft findings)");
    process.exit(0);
  }
  if (res.passed) {
    console.log(`✅ validation passed — ${res.soft.length} soft flag(s) for the judge:`);
    for (const f of res.soft) console.log(`  [${f.rule}] L${f.line}: ${f.reason}`);
    process.exit(0);
  }
  console.error(`❌ validation FAILED — ${res.hard.length} hard, ${res.soft.length} soft`);
  for (const f of res.hard) console.error(`  [HARD ${f.rule}] L${f.line}: ${f.reason}\n     ${f.text}`);
  for (const f of res.soft) console.error(`  [SOFT ${f.rule}] L${f.line}: ${f.reason}`);
  process.exit(1);
}
