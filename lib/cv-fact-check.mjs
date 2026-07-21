#!/usr/bin/env node

/**
 * cv-fact-check.mjs — independent reviewer pass for ATS-optimized CV output.
 *
 * Two phases, designed for use by the dashboard TUI:
 *
 *   Phase 1 (non-interactive):  call Gemini, save review JSON to disk.
 *     Triggered by --review-only. Used by the `g` auto-chain in the dashboard
 *     so the review runs in the background after CV generation.
 *
 *   Phase 2 (interactive):      walk through findings, apply approved fixes,
 *                               regenerate PDF, delete the review JSON when
 *                               done (marking it as processed).
 *     Default mode. Reads an existing review JSON if present; otherwise
 *     runs Phase 1 first.
 *
 * CLI mode (no flags) runs both phases back to back.
 *
 * Usage:
 *   node cv-fact-check.mjs <cv-path>                  # both phases
 *   node cv-fact-check.mjs --review-only <cv-path>    # phase 1 only
 *
 * Env vars (from .env or environment):
 *   LLM_PROVIDER_URL         — LLM provider/proxy base URL (.env; required)
 *   LLM_REVIEW_PROVIDER_URL  — reviewer provider URL (.env; optional → LLM_PROVIDER_URL)
 *   GENERATION_MODEL         — generator model ID (.env; required)
 *   REVIEW_MODEL             — reviewer model ID (.env; optional → GENERATION_MODEL).
 *                              Keep this a different model family from the
 *                              generator — the judge is cross-family by design.
 */

import { readFile, writeFile, unlink, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { normalizeAtsText } from "./normalize-text.mjs";
import { execFileSync } from "child_process";
import readline from "readline";

// `__dirname` here is the project root (one level above lib/), since every path below is project-relative.
const __dirname = dirname(dirname(fileURLToPath(import.meta.url)));

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = resolve(__dirname, ".env");
if (existsSync(envPath)) {
  const lines = (await readFile(envPath, "utf-8")).split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const LLM_PROVIDER_URL = process.env.LLM_PROVIDER_URL;
if (!LLM_PROVIDER_URL) {
  console.error("❌ LLM_PROVIDER_URL is not set — define it in .env (no hardcoded fallback).");
  process.exit(1);
}
const REVIEW_URL = process.env.LLM_REVIEW_PROVIDER_URL ?? LLM_PROVIDER_URL;
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? process.env.GENERATION_MODEL;
if (!REVIEW_MODEL) {
  console.error(
    "❌ Neither REVIEW_MODEL nor GENERATION_MODEL is set — define one in .env (no hardcoded fallback).",
  );
  process.exit(1);
}

// mergeGeneratorBridges folds generate-cv-llm.mjs's <bridges> output (saved at
// {NUM}-{slug}-cv-bridges.json) into the reviewer's findings list. Bridges are
// vocabulary substitutions the generator made deliberately; we surface them in
// the same walkthrough as fabricated/stretched findings so the user can decide
// per-finding whether to upgrade to the JD vocabulary. The reviewer can also
// emit `severity: "bridge"` findings; both sources coexist in the merged list.
function mergeGeneratorBridges(review, trace) {
  const bridgeList = Array.isArray(trace?.bridges) ? trace.bridges : [];
  const findings = Array.isArray(review.findings) ? review.findings : [];
  // Dedup: if the reviewer already produced a bridge finding for the same
  // generated_text, prefer the reviewer's version (it has independent eyes).
  const existingBridgeText = new Set(
    findings
      .filter((f) => f.severity === "bridge")
      .map((f) => f.generated_text),
  );
  for (const b of bridgeList) {
    if (!b || !b.generated_text || existingBridgeText.has(b.generated_text)) continue;
    findings.push({
      id: b.id || `gen-${findings.length + 1}`,
      severity: "bridge",
      section: b.section ?? "",
      generated_text: b.generated_text,
      source_type: b.source_type ?? "cv",
      source_cv_evidence: b.source_cv_evidence ?? "",
      issue: b.issue ?? "",
      // `replacement` post-rename; `proposed_fix` for traces written before it.
      replacement: b.replacement ?? b.proposed_fix ?? "",
    });
  }
  // Carry the generator's honest gaps and the validator chain through for the
  // walkthrough/verdict display (informational — not interactive findings).
  return normalizeSummary({
    ...review,
    findings,
    gaps: Array.isArray(trace?.gaps) ? trace.gaps : [],
    validator: trace?.validator ?? null,
  });
}

function normalizeSummary(review) {
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const fabricated = findings.filter((f) => f.severity === "fabricated").length;
  const stretched = findings.filter((f) => f.severity === "stretched").length;
  const bridges = findings.filter((f) => f.severity === "bridge").length;
  let verdict = "ready_to_send";
  if (fabricated > 0) verdict = "do_not_send";
  else if (stretched > 0) verdict = "needs_review";
  return {
    ...review,
    findings,
    summary: {
      fabricated_count: fabricated,
      stretched_count: stretched,
      bridge_count: bridges,
      overall_verdict: verdict,
    },
  };
}

// vetReplacement detects a "prose-shaped" replacement — one where the LLM wrote
// a recommendation sentence ("Could upgrade to 'X' — defensible from id") into
// the field instead of the bare drop-in phrase. Splicing such a string verbatim
// would inject the whole sentence into the CV. Returns { suspicious, clean }
// where `clean` is the best-guess replacement (the longest quote-wrapped span)
// or "" when nothing could be salvaged.
function vetReplacement(replacement, generatedText) {
  const r = (replacement ?? "").trim();
  if (!r) return { suspicious: false, clean: "" };
  const quoted =
    [...r.matchAll(/['"“”‘’]([^'"“”‘’]{3,})['"“”‘’]/g)]
      .map((m) => m[1].trim())
      .sort((a, b) => b.length - a.length)[0] || "";
  const hasOutsideText = quoted && r.replace(/['"“”‘’]/g, "").trim() !== quoted;
  const telltale =
    /(^\s*(could|consider|recommend|you could)\s)|(\bdefensible from\b)|(\bupgrade to\b)/i.test(
      r,
    );
  const tooLong = generatedText && r.length > generatedText.length * 2 + 40;
  return {
    suspicious: Boolean((quoted && hasOutsideText) || telltale || tooLong),
    clean: quoted,
  };
}

// annotateFindings runs once over the final findings list (both the fresh-review
// and the cached-JSON paths). It (1) normalizes each finding's `generated_text`
// and `replacement` to the same ATS-normalized form the on-disk CV was written
// in — repairing the judge's re-punctuated quotes and the pre-normalization
// generator-trace bridges so find/replace can actually match; and (2) flags any
// finding whose (normalized) quote still isn't a substring of the CV as
// `unusable`, so it can't silently no-op at apply time. Returns true if it
// mutated the review (so the cached path knows whether to write back).
function annotateFindings(review, cvText) {
  const list = Array.isArray(review.findings) ? review.findings : [];
  let changed = false;
  for (const f of list) {
    const gt = normalizeAtsText(f.generated_text ?? "").text;
    if (gt !== f.generated_text) {
      f.generated_text = gt;
      changed = true;
    }
    if (f.replacement !== undefined) {
      const rep = normalizeAtsText(f.replacement).text;
      if (rep !== f.replacement) {
        f.replacement = rep;
        changed = true;
      }
    }
    const unusable = gt !== "" && !cvText.includes(gt);
    if (unusable) {
      if (!f.unusable) {
        f.unusable = true;
        changed = true;
      }
      console.log(
        `${C.yellow}⚠ [${f.id ?? "?"}] quote not found in CV — cannot auto-apply${C.reset}`,
      );
    }
  }
  return changed;
}

// parseAtsTargets extracts the tiered "### ATS Targets" section of an eval
// report into { mustCover: [term], bridges: [[cvTerm, jdTerm]], doNotClaim:
// [term] }. Returns null for reports that predate the format (they carry a flat
// "### Extracted Keywords" list instead, handled by the legacy path).
function parseAtsTargets(reportTxt) {
  const secM = reportTxt.match(
    /(?:^|\n)### ATS Targets[^\n]*\n([\s\S]*?)(?:\n##|\n#|\n---|\s*$)/,
  );
  if (!secM) return null;
  // Strip a trailing " — [src: …]" / " - …" tail; leave in-word hyphens
  // ("Open-core") intact by only splitting on whitespace-flanked dashes.
  const bareTerm = (s) => s.split(/\s+[—-]\s+|\s*\[src:/)[0].trim();
  const mustCover = [];
  const bridges = [];
  const doNotClaim = [];
  let bucket = null;
  for (const line of secM[1].split("\n")) {
    const t = line.trim();
    if (/^Must cover\b/i.test(t)) { bucket = "must"; continue; }
    if (/^Bridge vocabulary\b/i.test(t)) { bucket = "bridge"; continue; }
    if (/^Do not claim\b/i.test(t)) { bucket = "skip"; continue; }
    if (!t.startsWith("- ")) continue;
    const item = t.slice(2).trim();
    if (!item) continue;
    if (bucket === "must") {
      const term = bareTerm(item);
      if (term) mustCover.push(term);
    } else if (bucket === "bridge") {
      // Two quoted sides joined by ↔ / -> / →; either side present = covered.
      const sides = [...item.matchAll(/["“”]([^"“”]+)["“”]/g)].map((mm) =>
        mm[1].trim(),
      );
      if (sides.length >= 2) bridges.push([sides[0], sides[1]]);
    } else if (bucket === "skip") {
      const term = bareTerm(item);
      if (term) doNotClaim.push(term);
    }
  }
  return { mustCover, bridges, doNotClaim };
}

// ── ANSI colors ──────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

// ── CLI args ─────────────────────────────────────────────────────────────────
let reviewOnly = false;
let cvArg = null;
for (const a of process.argv.slice(2)) {
  if (a === "--review-only") reviewOnly = true;
  else if (!cvArg && !a.startsWith("--")) cvArg = a;
}

if (!cvArg) {
  console.error("Usage: node lib/cv-fact-check.mjs [--review-only] <cv-path>");
  console.error(
    "Example: node lib/cv-fact-check.mjs output/customized-cvs/210-dash0-principal-product-manager-cv.md",
  );
  process.exit(1);
}

const cvPath = resolve(cvArg);
if (!existsSync(cvPath)) {
  console.error(`❌ File not found: ${cvPath}`);
  process.exit(1);
}

// Derive NUM and slug from "{NUM}-{slug}-cv.md"
const fname = basename(cvPath).replace(/-cv\.md$/, "");
const m = fname.match(/^(\d+)-(.+)$/);
if (!m) {
  console.error(`❌ Cannot derive NUM and slug from filename: ${fname}`);
  console.error('   Expected pattern: "{NUM}-{slug}-cv.md"');
  process.exit(1);
}
const num = m[1];
const slug = m[2];

const jdPath = resolve(__dirname, `data/jds/${num}-${slug}.md`);
if (!existsSync(jdPath)) {
  console.error(`❌ JD not found at expected path: ${jdPath}`);
  console.error(`   Cannot fact-check without the originating JD.`);
  process.exit(1);
}

// ── Locate the evaluation report (same logic as generate-cv-llm.mjs) ────────
async function findLatestReport(num) {
  const reportsDir = resolve(__dirname, "data/reports");
  if (!existsSync(reportsDir)) return null;
  const entries = await readdir(reportsDir);
  const candidates = entries.filter(
    (n) => n.startsWith(`${num}-`) && n.endsWith(".md"),
  );
  if (candidates.length === 0) return null;
  const stats = await Promise.all(
    candidates.map(async (n) => ({
      name: n,
      mtime: (await stat(resolve(reportsDir, n))).mtimeMs,
    })),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return resolve(reportsDir, stats[0].name);
}

const reportPath = await findLatestReport(num);

// ── Audit trace (from generate-cv-llm.mjs) ──────────────────────────────────
// Canonical: {num}-{slug}-trace.json (bullets→src, gaps, bridges, validator).
// Fall back to the legacy bridges.json for artifacts generated before trace.
const tracePath = resolve(
  __dirname,
  `output/customized-cvs/${num}-${slug}-trace.json`,
);
const bridgesPath = resolve(
  __dirname,
  `output/customized-cvs/${num}-${slug}-cv-bridges.json`,
);
async function loadTrace() {
  for (const p of [tracePath, bridgesPath]) {
    if (!existsSync(p)) continue;
    try {
      const t = JSON.parse(await readFile(p, "utf-8"));
      return {
        bridges: Array.isArray(t.bridges) ? t.bridges : [],
        gaps: Array.isArray(t.gaps) ? t.gaps : [],
        bullets: Array.isArray(t.bullets) ? t.bullets : [],
        validator: t.validator ?? null,
      };
    } catch {
      /* try next */
    }
  }
  return { bridges: [], gaps: [], bullets: [], validator: null };
}
const trace = await loadTrace();

// ── Review JSON path ─────────────────────────────────────────────────────────
const reviewJsonPath = resolve(
  __dirname,
  `output/customized-cvs/${num}-${slug}-cv-review.json`,
);
const reviewJsonExists = existsSync(reviewJsonPath);

// The generated CV markdown is needed in both paths: the fresh-review path
// feeds it into the reviewer prompt, and the interactive walkthrough seeds
// `cvContent` from it to apply edits.
const generatedCv = await readFile(cvPath, "utf-8");

// ── Load or call reviewer ────────────────────────────────────────────────────
let review;

if (reviewJsonExists && !reviewOnly) {
  // Use existing review — skip the LLM call.
  console.log(
    `${C.cyan}📋${C.reset} Using existing review: ${C.bold}${basename(reviewJsonPath)}${C.reset}`,
  );
  console.log(
    `${C.dim}   (delete the file to force a fresh review)${C.reset}`,
  );
  try {
    review = JSON.parse(await readFile(reviewJsonPath, "utf-8"));
  } catch (e) {
    console.error(
      `${C.red}❌ Existing review JSON is malformed: ${e.message}${C.reset}`,
    );
    process.exit(1);
  }
  // Normalize + match-verify the cached findings so the Go dashboard (which
  // reads this JSON) and the walkthrough below both act on a repaired list.
  if (annotateFindings(review, generatedCv)) {
    await writeFile(
      reviewJsonPath,
      JSON.stringify(review, null, 2),
      "utf-8",
    ).catch(() => {});
  }
} else {
  // Call Gemini (fresh review) on the CLOSED-WORLD evidence set.
  const { serializeCvJson } = await import("./cv-schema.mjs");
  const { buildContext } = await import("./cv-validate.mjs");
  const { load: yamlLoad } = await import("js-yaml");
  const readMaybe = async (p, d = "") => (existsSync(p) ? readFile(p, "utf-8") : d);

  const [cvJsonRaw, jdText, reviewPrompt, reportMd, storyBankMd, notesRaw, aliasesRaw] =
    await Promise.all([
      readFile(resolve(__dirname, "config/cv.json"), "utf-8"),
      readFile(jdPath, "utf-8"),
      readFile(resolve(__dirname, "lib/prompts/cv-review-prompt.md"), "utf-8"),
      reportPath
        ? readFile(reportPath, "utf-8")
        : Promise.resolve("(no evaluation report found — Block A grounding unavailable)"),
      readMaybe(resolve(__dirname, "config/story-bank.md"), "(no story bank)"),
      readMaybe(resolve(__dirname, "config/notes.yml"), "notes: []"),
      readMaybe(resolve(__dirname, "config/aliases.yml"), "aliases: []"),
    ]);

  const cvJson = JSON.parse(cvJsonRaw);
  const notesYml = yamlLoad(notesRaw) || { notes: [] };
  const aliasesYml = yamlLoad(aliasesRaw) || { aliases: [] };

  // id-annotated source CV — the judge grounds on the same ids as the validator.
  const sourceCv = serializeCvJson(cvJson, { annotateIds: true });

  // Notes rendered with evidence/ignore status (only confirmed = evidence).
  const notesRendered =
    (notesYml.notes || [])
      .map((n, i) => {
        const ev = n.confirmed === true ? "EVIDENCE" : "IGNORE";
        return `n${i + 1} [${ev}] (${n.source_type || "?"}): ${n.claim || ""}${
          n.supporting_detail ? ` — ${n.supporting_detail}` : ""
        }`;
      })
      .join("\n") || "(no structured personal notes)";

  // Citation map: each generated bullet → its cited id(s) → the source text
  // behind each id (resolved from the same closed-world context the validator
  // used). This is the judge's highest-signal input.
  const ctx = buildContext({ cvJson, storyBankMd, notesYml, reportMd, aliasesYml });
  const citationMap =
    (trace.bullets || [])
      .map((b) => {
        const srcTxt = (b.src || [])
          .map((id) => `      ${id} ⇒ ${(ctx.textById.get(id) || "‹UNRESOLVED›").slice(0, 240)}`)
          .join("\n");
        return `• "${b.text}"\n   cited: [${(b.src || []).join(", ")}]\n${srcTxt}`;
      })
      .join("\n\n") || "(no citation map — trace.json missing; ground on Source CV directly)";

  const gapsRendered =
    (trace.gaps || [])
      .map((g) => `- ${g.requirement || g.id}: ${g.why_no_source || ""}`)
      .join("\n") || "(no gaps recorded)";

  const filledPrompt = reviewPrompt
    .replace("{source_cv}", sourceCv)
    .replace("{story_bank}", storyBankMd)
    .replace("{notes}", notesRendered)
    .replace("{report_content}", reportMd)
    .replace("{citation_map}", citationMap)
    .replace("{gaps}", gapsRendered)
    .replace("{generated_cv}", generatedCv)
    .replace("{jd}", jdText);

  console.log(
    `${C.cyan}🔍${C.reset} Reviewing ${C.bold}${basename(cvPath)}${C.reset}`,
  );
  console.log(`${C.dim}   Source: config/cv.json (id-annotated) + story-bank + confirmed notes${C.reset}`);
  console.log(`${C.dim}   JD:     data/jds/${num}-${slug}.md${C.reset}`);
  console.log(
    `${C.dim}   Model:  ${REVIEW_MODEL} via ${REVIEW_URL}${C.reset}`,
  );
  console.log("");

  // Bifrost-routed Gemini occasionally returns HTTP 200 with `choices: null`
  // (an upstream hiccup with reasoning models). Retry on empty/invalid
  // responses before giving up — auto-pipeline runs are unattended and the
  // alternative is a stuck `error` row in the dashboard.
  const MAX_ATTEMPTS = 3;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(`${REVIEW_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        messages: [{ role: "user", content: filledPrompt }],
        // Reasoning Gemini models (e.g. gemini-3.x-pro) spend this budget on
        // hidden reasoning before the JSON body; 8192 truncated the output
        // mid-string → unparseable. 16384 leaves room for reasoning + verdict.
        max_tokens: 16384,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      lastErr = `Bifrost ${response.status}: ${body.slice(0, 400)}`;
    } else {
      const payload = await response.json();
      const finishReason = payload.choices?.[0]?.finish_reason;
      let raw = payload.choices?.[0]?.message?.content ?? "";
      if (finishReason === "length") {
        // Truncated at max_tokens — reasoning exhausted the budget. Surface a
        // diagnosable error instead of the misleading "Invalid JSON" the
        // parse would otherwise throw on the cut-off body.
        lastErr = `Reviewer truncated at max_tokens (finish_reason:length) — raise max_tokens or lower the model's reasoning for ${REVIEW_MODEL}`;
      } else if (!raw) {
        lastErr = "Empty response from reviewer (choices: null)";
      } else {
        const usage = payload.usage;
        if (usage) {
          console.log(
            `${C.dim}📊 Tokens: ${usage.prompt_tokens ?? "?"} in / ${usage.completion_tokens ?? "?"} out${C.reset}`,
          );
        }
        raw = raw
          .replace(/^```(?:json)?\s*\n/, "")
          .replace(/\n```\s*$/, "")
          .trim();
        try {
          review = JSON.parse(raw);
          review = mergeGeneratorBridges(review, trace);
          annotateFindings(review, generatedCv);
          await writeFile(
            reviewJsonPath,
            JSON.stringify(review, null, 2),
            "utf-8",
          );
          break;
        } catch (e) {
          lastErr = `Invalid JSON from reviewer: ${e.message}`;
        }
      }
    }

    if (attempt < MAX_ATTEMPTS) {
      const backoffMs = 2000 * attempt; // 2s, 4s
      console.log(
        `${C.yellow}⚠ ${lastErr}. Retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})${C.reset}`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  if (!review) {
    console.error(`${C.red}❌ ${lastErr || "Unknown reviewer error"}${C.reset}`);
    process.exit(1);
  }
}

const findings = review.findings ?? [];
const summary = review.summary ?? {};

// ── Keyword-survival audit (report-only — NEVER injects) ────────────────────
// Drucker's gap: the generator is *instructed* to place Block-A keywords but
// nothing verifies they survived generation → normalization → review → render.
// Diff the report's ATS Targets (or legacy Extracted Keywords) against the
// rendered CV text (and the PDF text layer if one exists). We only REPORT.
async function keywordSurvival() {
  if (!reportPath || !existsSync(reportPath)) return null;
  const reportTxt = await readFile(reportPath, "utf-8");

  // Which section drives the audit? Prefer the tiered ATS Targets format; only
  // pre-format reports fall back to the flat Extracted Keywords list.
  const ats = parseAtsTargets(reportTxt);
  const legacyM = ats
    ? null
    : reportTxt.match(/extracted keywords[^\n]*\n([\s\S]*?)(?:\n##|\n#|\n---|\s*$)/i);
  let legacyKws = null;
  if (!ats) {
    if (!legacyM) return null;
    legacyKws = [
      ...new Set(
        legacyM[1]
          .split(/\n|,/)
          .map((s) => s.replace(/^[\s\-*•]+/, "").trim())
          .filter((s) => s && s.length > 1 && !s.startsWith("#")),
      ),
    ];
    if (!legacyKws.length) return null;
  }

  const haystacks = [normalizeAtsText(await readFile(cvPath, "utf-8")).text.toLowerCase()];
  const pdfP = cvPath.replace(/-cv\.md$/, "-cv.pdf");
  if (existsSync(pdfP)) {
    try {
      haystacks.push(
        execFileSync("pdftotext", [pdfP, "-"], { encoding: "utf-8" }).toLowerCase(),
      );
    } catch {
      /* pdftotext optional */
    }
  }
  // A keyword counts as present if ANY meaningful variant literally appears:
  // the full phrase, each "/"-segment, the (ACRONYM), or the paren-stripped
  // form. Still pure presence detection — only ever moves a keyword from
  // "missing" to "present" on a real textual hit; never injects, never
  // asserts unsupported coverage.
  const variants = (k) => {
    const v = new Set();
    const lc = k.toLowerCase().trim();
    v.add(lc);
    const acro = k.match(/\(([^)]+)\)/);
    if (acro) v.add(acro[1].toLowerCase().trim());
    const noParen = lc.replace(/\([^)]*\)/g, "").trim();
    if (noParen) v.add(noParen);
    for (const seg of noParen.split("/")) {
      const s = seg.trim();
      if (s.length > 2) v.add(s);
    }
    return [...v].filter(Boolean);
  };
  const present = (k) =>
    variants(k).some((vv) => haystacks.some((h) => h.includes(vv)));

  if (ats) {
    // Audit set = must-cover terms + bridge pairs (either side counts, since the
    // CV keeps the conservative side by design). Do-not-claim terms are NEVER
    // counted missing — instead any that DO appear are red-flag violations.
    const missing = [];
    for (const term of ats.mustCover) {
      if (!present(term)) missing.push(term);
    }
    for (const [a, b] of ats.bridges) {
      if (!present(a) && !present(b)) missing.push(`${a} ↔ ${b}`);
    }
    const violations = ats.doNotClaim.filter((t) => present(t));
    return {
      total: ats.mustCover.length + ats.bridges.length,
      missing,
      excluded: ats.doNotClaim.length,
      violations,
    };
  }

  const missing = legacyKws.filter((k) => !present(k));
  return { total: legacyKws.length, missing };
}
const kwCoverage = await keywordSurvival();
if (kwCoverage) review.keyword_coverage = kwCoverage;
// Persist the enriched review so the dashboard/cached path sees coverage too.
if (existsSync(reviewJsonPath)) {
  try {
    await writeFile(reviewJsonPath, JSON.stringify(review, null, 2), "utf-8");
  } catch {
    /* non-fatal */
  }
}

console.log("");
console.log(`${C.bold}Findings:${C.reset}`);
console.log(
  `  ${C.red}● ${summary.fabricated_count ?? 0} fabricated${C.reset}`,
);
console.log(
  `  ${C.yellow}● ${summary.stretched_count ?? 0} stretched${C.reset}`,
);
console.log(
  `  ${C.cyan}● ${summary.bridge_count ?? 0} bridge${C.reset}`,
);
console.log(
  `  ${C.dim}Verdict: ${summary.overall_verdict ?? "unknown"}${C.reset}`,
);
if (review.validator) {
  const v = review.validator;
  const vc = v.passed ? C.green : C.red;
  console.log(
    `  ${vc}Validator: ${v.passed ? "PASS" : "FAIL"}${C.reset}${C.dim}` +
      ` (${(v.hard || []).length} hard, ${(v.soft || []).length} soft, ${v.retries ?? 0} retries)${C.reset}`,
  );
}
if (Array.isArray(review.gaps) && review.gaps.length) {
  console.log(
    `  ${C.dim}Honest gaps (${review.gaps.length}, informational): ` +
      `${review.gaps.map((g) => g.requirement || g.id).join("; ").slice(0, 120)}${C.reset}`,
  );
}
if (kwCoverage) {
  const miss = kwCoverage.missing.length;
  const kc = miss === 0 ? C.green : C.yellow;
  console.log(
    `  ${kc}Keyword survival: ${kwCoverage.total - miss}/${kwCoverage.total} present${C.reset}` +
      (miss
        ? `${C.dim} — missing (review only, not auto-added): ${kwCoverage.missing.join(", ")}${C.reset}`
        : ""),
  );
  const excluded = kwCoverage.excluded ?? 0;
  const violations = kwCoverage.violations ?? [];
  if (excluded > 0 && violations.length === 0) {
    console.log(
      `  ${C.dim}${excluded} do-not-claim term${excluded === 1 ? "" : "s"} correctly absent${C.reset}`,
    );
  }
  if (violations.length) {
    console.log(
      `  ${C.red}⚠ do-not-claim terms present (red flag — review): ${violations.join(", ")}${C.reset}`,
    );
  }
}
console.log(`  ${C.dim}Saved to: ${basename(reviewJsonPath)}${C.reset}`);

// Phase 1 only: exit after saving JSON.
if (reviewOnly) {
  console.log("");
  if (findings.length === 0) {
    console.log(
      `${C.green}✅ No issues found. CV is ready to send.${C.reset}`,
    );
    // No pending review to walk through — remove the JSON so the dashboard
    // doesn't show a "review-pending" state with zero findings.
    await unlink(reviewJsonPath).catch(() => {});
  } else {
    console.log(
      `${C.dim}Review saved. Open the walkthrough in the dashboard or re-run without --review-only.${C.reset}`,
    );
  }
  process.exit(0);
}

if (findings.length === 0) {
  console.log("");
  console.log(`${C.green}✅ No issues found. CV is ready to send.${C.reset}`);
  await unlink(reviewJsonPath).catch(() => {});
  process.exit(0);
}

// ── Interactive review ──────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const ask = (q) => new Promise((res) => rl.question(q, res));

let cvContent = generatedCv;
let approved = 0,
  edited = 0,
  rejected = 0,
  skipped = 0;
let quit = false;

for (let i = 0; i < findings.length; i++) {
  if (quit) break;
  const f = findings[i];
  // `replacement` is the literal drop-in (post-rename); fall back to the legacy
  // `proposed_fix` key for any review JSON cached before the rename.
  const fix = f.replacement ?? f.proposed_fix ?? "";

  console.log("");
  const sev =
    f.severity === "fabricated"
      ? `${C.red}FABRICATED${C.reset}`
      : f.severity === "bridge"
        ? `${C.cyan}BRIDGE${C.reset}`
        : `${C.yellow}STRETCHED${C.reset}`;
  console.log(
    `${C.bold}[${i + 1}/${findings.length}]${C.reset} ${sev}  ·  ${f.section ?? "?"}`,
  );
  console.log(
    `${C.dim}─────────────────────────────────────────────────────────────${C.reset}`,
  );
  console.log(`${C.bold}In CV:${C.reset}      ${f.generated_text}`);
  console.log(`${C.bold}Source CV:${C.reset}  ${f.source_cv_evidence}`);
  console.log(`${C.bold}Issue:${C.reset}      ${f.issue}`);
  if (f.unusable) {
    console.log(
      `${C.yellow}⚠ quote not found in CV — auto-apply will skip; use [e]dit to fix by hand.${C.reset}`,
    );
  }
  console.log("");
  // Bridge findings: `fix` is the JD-vocabulary upgrade (apply = adopt JD
  // wording). Fabricated/stretched: `fix` is the conservative downgrade
  // (apply = remove or soften). Empty string always means "delete".
  const fixDisplay =
    fix === "" ? `${C.dim}(remove the text)${C.reset}` : fix;
  const fixLabel =
    f.severity === "bridge" ? "Upgrade to:" : "Proposed: ";
  console.log(`${C.bold}${fixLabel}${C.reset}  ${fixDisplay}`);
  if (f.severity === "bridge") {
    console.log(
      `${C.dim}            (default: keep the CV text; apply to upgrade)${C.reset}`,
    );
  }
  console.log("");

  const answer = (
    await ask(
      `${C.cyan}[a]${C.reset}pprove  ${C.cyan}[r]${C.reset}eject  ${C.cyan}[e]${C.reset}dit  ${C.cyan}[s]${C.reset}kip  ${C.cyan}[q]${C.reset}uit > `,
    )
  )
    .trim()
    .toLowerCase();

  if (answer === "q") {
    quit = true;
    break;
  }

  if (answer === "a" || answer === "e") {
    if (!cvContent.includes(f.generated_text)) {
      console.log(
        `${C.red}⚠️  Generated text not found in CV (may have been changed by an earlier fix). Skipping.${C.reset}`,
      );
      skipped++;
      continue;
    }
    let replacement;
    if (answer === "e") {
      replacement = await ask("Replacement text > ");
      edited++;
    } else {
      // Guard: a `replacement` that reads as a recommendation sentence
      // ("Could upgrade to 'X' — defensible from id") would splice the whole
      // sentence into the CV. Surface it instead of blind-applying — show the
      // best-guess phrase and let the user confirm or rewrite.
      const vet = vetReplacement(fix, f.generated_text);
      if (vet.suspicious) {
        console.log(
          `${C.yellow}⚠  Replacement looks like prose, not a drop-in phrase. Review before applying.${C.reset}`,
        );
        if (vet.clean) {
          console.log(`${C.dim}   Best guess:${C.reset} ${vet.clean}`);
        }
        const typed = await ask(
          `Replacement text${vet.clean ? " (blank = use best guess)" : ""} > `,
        );
        replacement = typed.trim() === "" ? vet.clean : typed;
        if (!replacement) {
          console.log(`${C.dim}↷ Skipped (no replacement)${C.reset}`);
          skipped++;
          continue;
        }
        edited++;
      } else {
        replacement = fix;
        approved++;
      }
    }
    // Reviewer fixes and hand-typed edits can reintroduce ATS-hostile
    // Unicode the generator already stripped — normalize before splicing.
    cvContent = cvContent.replace(
      f.generated_text,
      normalizeAtsText(replacement).text,
    );
    await writeFile(cvPath, cvContent, "utf-8");
    console.log(`${C.green}✓ Applied${C.reset}`);
  } else if (answer === "r") {
    console.log(`${C.dim}✗ Kept generated text${C.reset}`);
    rejected++;
  } else {
    console.log(`${C.dim}↷ Skipped${C.reset}`);
    skipped++;
  }
}

console.log("");
console.log(`${C.bold}Review complete:${C.reset}`);
console.log(`  ${C.green}✓ ${approved} approved${C.reset}`);
console.log(`  ${C.green}✏ ${edited} edited${C.reset}`);
console.log(`  ${C.dim}✗ ${rejected} rejected${C.reset}`);
console.log(`  ${C.dim}↷ ${skipped} skipped${C.reset}`);

// ── Regenerate PDF ──────────────────────────────────────────────────────────
if (approved + edited > 0) {
  console.log("");
  const yn = (await ask(`Regenerate PDF? [Y/n] > `)).trim().toLowerCase();
  if (yn === "" || yn === "y" || yn === "yes") {
    const pdfPath = resolve(__dirname, `output/customized-cvs/${num}-${slug}-cv.pdf`);
    const cssPath = resolve(__dirname, "style/cv-template.css");
    try {
      execFileSync(
        "uv",
        [
          "run",
          "--project",
          __dirname,
          resolve(__dirname, "render-cv-pdf.py"),
          "--in",
          cvPath,
          "--out",
          pdfPath,
          "--css",
          cssPath,
          "--format",
          "a4",
        ],
        { stdio: "inherit", cwd: __dirname },
      );
    } catch (e) {
      console.error(`${C.red}❌ PDF generation failed: ${e.message}${C.reset}`);
    }
  } else {
    console.log(`${C.dim}Skipped PDF regeneration. Markdown is up to date.${C.reset}`);
  }
}

// Mark the review as processed by removing the JSON so the dashboard no
// longer shows the row as "review-pending". Only do this when the user
// actioned every finding (a/r/e/s); a `q` quit preserves the JSON so the
// next session can resume the walkthrough.
if (!quit) {
  await unlink(reviewJsonPath).catch(() => {});
}

rl.close();
