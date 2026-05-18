#!/usr/bin/env node

/**
 * generate-cv-llm.mjs — ATS-optimized CV via Opus 4.7 on Bifrost proxy.
 *
 * Usage:
 *   node generate-cv-llm.mjs --jd <file-or-text> [--num 064] [--slug legora-product-lead] [--format a4|letter] [--no-pdf]
 *
 * Flow:
 *   1. LLM (Opus via Bifrost) rewrites config/cv.md against the JD, returning *markdown*.
 *   2. Identity header (name + contact line) is force-overwritten from config/profile.md
 *      so the LLM cannot delete or mutate the candidate's real contact details.
 *   3. ATS unicode normalization (em-dash, smart quotes, zero-width, nbsp).
 *   4. Python subprocess (render-cv-pdf.py via uv) renders the markdown to PDF with
 *      style/cv-template.css through WeasyPrint.
 *
 * Output:
 *   output/customized-cvs/{NUM}-{slug}-cv.md
 *   output/customized-cvs/{NUM}-{slug}-cv.pdf
 *
 * Env vars (from .env or environment):
 *   BIFROST_URL   — proxy base URL  (default: http://localhost:4444)
 *   BIFROST_MODEL — model ID        (default: claude-opus-4-7)
 */

import { readFile, writeFile, readdir, stat } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { normalizeAtsText, normalizationSummary } from "./normalize-text.mjs";

// `__dirname` here is the project root (one level above lib/), since every path below is project-relative.
const __dirname = dirname(dirname(fileURLToPath(import.meta.url)));

// Load .env (direnv also does this, but we want it in plain node runs too)
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

const BIFROST_URL = process.env.BIFROST_URL ?? "http://localhost:4444";
const BIFROST_MODEL = process.env.BIFROST_MODEL ?? "claude-opus-4-7";

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let jdArg = null,
  slug = null,
  num = null,
  format = "a4",
  noPdf = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--jd" && args[i + 1]) jdArg = args[++i];
  else if (args[i] === "--slug" && args[i + 1]) slug = args[++i];
  else if (args[i] === "--company" && args[i + 1])
    slug = args[++i]; // legacy alias
  else if (args[i] === "--num" && args[i + 1]) num = args[++i];
  else if (args[i] === "--format" && args[i + 1]) format = args[++i];
  else if (args[i] === "--no-pdf") noPdf = true;
}

if (!jdArg) {
  console.error(
    "Usage: node generate-cv-llm.mjs --jd <file-or-text> [--num 064] [--slug company-role] [--format a4|letter] [--no-pdf]",
  );
  process.exit(1);
}

if (!["a4", "letter"].includes(format)) {
  console.error(`Invalid format "${format}". Use: a4, letter`);
  process.exit(1);
}

// ── Read JD (file path or inline text) ──────────────────────────────────────

let jdText = jdArg;
const maybeFile = resolve(jdArg);
if (existsSync(maybeFile)) {
  jdText = await readFile(maybeFile, "utf-8");
  console.log(`📋 JD from file: ${maybeFile}`);

  // Derive num + slug from "{NUM}-{slug}.md" filename when not passed explicitly
  const fname = basename(maybeFile).replace(/\.(md|txt)$/i, "");
  const m = fname.match(/^(\d{3})-(.+)$/);
  if (m) {
    num = num ?? m[1];
    slug = slug ?? m[2];
  }
}

if (!num || !slug) {
  console.error(
    'Missing --num and/or --slug. Either pass them explicitly, or point --jd at a file named like "064-legora-product-lead.md".',
  );
  process.exit(1);
}

if (!/^\d{3}$/.test(num)) {
  console.error(
    `Invalid --num "${num}". Must be 3-digit zero-padded (e.g. 064).`,
  );
  process.exit(1);
}

// ── Locate the evaluation report ─────────────────────────────────────────────
// Pattern: data/reports/{NUM}-{slug}-{YYYY-MM-DD}.md (slug may differ from JD
// slug if the eval normalized it; match by NUM prefix and take the most-recent
// by mtime).

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
if (!reportPath) {
  console.error(
    `❌ No evaluation report found at data/reports/${num}-*.md.\n   Run /career-ops on the JD URL first to produce one — Block A is now load-bearing for CV generation.`,
  );
  process.exit(1);
}
console.log(`📑 Report: ${basename(reportPath)}`);

// Stale-report check: report should be newer than (or close to) the JD.
const [reportStat, jdStat] = await Promise.all([
  stat(reportPath),
  existsSync(maybeFile) ? stat(maybeFile) : Promise.resolve(null),
]);
if (jdStat && reportStat.mtimeMs + 60_000 < jdStat.mtimeMs) {
  console.warn(
    `⚠ Report is older than the JD by ${Math.round((jdStat.mtimeMs - reportStat.mtimeMs) / 1000)}s — JD may have changed since evaluation. Consider re-running /career-ops to refresh the report.`,
  );
}

// ── Read source files in parallel ────────────────────────────────────────────
// Source of truth is config/cv.json; the model receives the *id-annotated*
// markdown projection so every bullet carries its stable [src] handle.

import { serializeCvJson } from "./cv-schema.mjs";
import {
  buildContext,
  validateCv,
  stripSrcTags,
  failedConstraintsBlock,
} from "./cv-validate.mjs";

const storyBankPath = resolve(__dirname, "config/story-bank.md");
const notesPath = resolve(__dirname, "config/notes.yml");
const aliasesPath = resolve(__dirname, "config/aliases.yml");

const [cvJsonRaw, atsPrompt, profileRaw, reportMd, storyBankMd, notesRaw, aliasesRaw] =
  await Promise.all([
    readFile(resolve(__dirname, "config/cv.json"), "utf-8"),
    readFile(resolve(__dirname, "lib/prompts/ats-prompt.md"), "utf-8"),
    readFile(resolve(__dirname, "config/profile.md"), "utf-8"),
    readFile(reportPath, "utf-8"),
    existsSync(storyBankPath)
      ? readFile(storyBankPath, "utf-8")
      : Promise.resolve("(story bank not yet created)"),
    existsSync(notesPath) ? readFile(notesPath, "utf-8") : Promise.resolve("notes: []"),
    existsSync(aliasesPath) ? readFile(aliasesPath, "utf-8") : Promise.resolve("aliases: []"),
  ]);

const { load: yamlLoad } = await import("js-yaml");
const cvJson = JSON.parse(cvJsonRaw);
const notesYml = yamlLoad(notesRaw) || { notes: [] };
const aliasesYml = yamlLoad(aliasesRaw) || { aliases: [] };

// config/profile.md = markdown with YAML frontmatter; parse the frontmatter.
const fmMatch = profileRaw.match(/^---\s*\n([\s\S]*?)\n---/);
const profile = yamlLoad(fmMatch ? fmMatch[1] : profileRaw);
const c = profile.candidate;

// id-annotated source CV ("- bullet text [id]")
const cvAnnotated = serializeCvJson(cvJson, { annotateIds: true });

// Structured notes rendered with their citation ids (n1, n2 … in list order).
const notesContent = (() => {
  const ns = notesYml.notes || [];
  if (!ns.length) return "(no structured personal notes)";
  return ns
    .map((n, i) => {
      const ev = n.confirmed === true ? "EVIDENCE" : "IGNORE (confirmed:false)";
      return `n${i + 1} [${ev}] (${n.source_type || "?"}): ${n.claim || ""}${
        n.supporting_detail ? ` — ${n.supporting_detail}` : ""
      }`;
    })
    .join("\n");
})();

// ── Build prompt ─────────────────────────────────────────────────────────────
const basePrompt = atsPrompt
  .replace("{cv_content}", cvAnnotated)
  .replace("{report_content}", reportMd)
  .replace("{story_bank_content}", storyBankMd)
  .replace("{notes_content}", notesContent)
  .replace("{job_content}", jdText);

// Deterministic validation context (shared across retries).
const valCtx = buildContext({ cvJson, storyBankMd, notesYml, reportMd, aliasesYml });

// ── Call Bifrost (with deterministic validation + retry-with-diff) ───────────

console.log(`🤖  Model : ${BIFROST_MODEL}`);
console.log(`🔌  Proxy : ${BIFROST_URL}`);

async function callModel(promptText) {
  const response = await fetch(`${BIFROST_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: BIFROST_MODEL,
      messages: [{ role: "user", content: promptText }],
      max_tokens: 8192,
    }),
  });
  if (!response.ok) {
    const b = await response.text().catch(() => "");
    console.error(`❌ Bifrost ${response.status}: ${b.slice(0, 400)}`);
    process.exit(1);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (!content) {
    console.error("❌ Empty response from model");
    process.exit(1);
  }
  if (payload.usage)
    console.log(
      `📊 Tokens: ${payload.usage.prompt_tokens ?? "?"} in / ${payload.usage.completion_tokens ?? "?"} out`,
    );
  return content;
}

// Pull a tolerant JSON array out of a <tag>…</tag> block; returns {list, rest}.
function extractBlock(md, tag, key) {
  const m = md.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  if (!m) return { list: [], rest: md };
  const rest = md.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  let raw = m[1].trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(raw);
    return { list: Array.isArray(parsed[key]) ? parsed[key] : [], rest };
  } catch (e) {
    console.warn(`⚠ Could not parse <${tag}> JSON: ${e.message}.`);
    return { list: [], rest };
  }
}

let markdown, bridges, gaps, valResult;
const MAX_RETRIES = 2;
let attempt = 0;
for (; attempt <= MAX_RETRIES; attempt++) {
  const prompt =
    attempt === 0
      ? basePrompt
      : `${basePrompt}\n\n${failedConstraintsBlock(valResult, valCtx)}`;
  if (attempt > 0)
    console.log(`🔁 Validation retry ${attempt}/${MAX_RETRIES} (prior: ${valResult.hard.length} hard)`);

  let out = (await callModel(prompt))
    .replace(/^```(?:markdown|md)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();

  ({ list: bridges, rest: out } = extractBlock(out, "bridges", "bridges"));
  ({ list: gaps, rest: out } = extractBlock(out, "gaps", "gaps"));
  markdown = out; // still carries [src: id] tags — validate before stripping

  valResult = validateCv(markdown, valCtx, { bridges });
  console.log(
    `🌉 Bridges: ${bridges.length} · 🕳 Gaps: ${gaps.length} · ` +
      `🔎 Validator: ${valResult.passed ? "PASS" : "FAIL"} ` +
      `(${valResult.hard.length} hard, ${valResult.soft.length} soft)`,
  );
  if (valResult.passed) break;
}

// Build the bullet→src trace from the tagged markdown before stripping.
const traceBullets = markdown
  .split("\n")
  .filter((l) => /^-\s+/.test(l.trim()))
  .map((l) => {
    const sm = l.match(/\[src:\s*([^\]]+)\]\s*$/i);
    return {
      text: l.replace(/^-\s+/, "").replace(/\s*\[src:\s*[^\]]+\]\s*$/i, "").trim(),
      src: sm ? sm[1].split(",").map((s) => s.trim()) : [],
    };
  });

// Keep the tagged body for the failure-inspection artifact, then strip
// [src: id] tags — they never appear in the rendered CV.
const taggedMarkdown = markdown;
markdown = stripSrcTags(markdown).replace(/\n{3,}/g, "\n\n").trim();

if (!valResult.passed) {
  console.error(
    `❌ Validation still failing after ${MAX_RETRIES} retries — ` +
      `${valResult.hard.length} hard finding(s). NOT auto-revised; surfaced for you:`,
  );
  for (const f of valResult.hard)
    console.error(`   [HARD ${f.rule}] ${f.reason}\n      ${f.text}`);
}

// ── Force-overwrite identity header from profile.md ──────────────────────────
// The LLM cannot be trusted with static identity. We rebuild the first two
// markdown blocks (H1 + contact line) from profile.md and prepend them to
// whatever body the LLM produced below.

const contactParts = [];
if (c.portfolio_url) {
  const displayUrl = c.portfolio_url.replace(/^https?:\/\//, "");
  contactParts.push(`[${displayUrl}](${c.portfolio_url})`);
}
if (c.email) contactParts.push(`[${c.email}](mailto:${c.email})`);
if (c.phone) {
  const telUrl = `tel:${c.phone.replace(/\s+/g, "")}`;
  contactParts.push(`[${c.phone}](${telUrl})`);
}
if (c.linkedin) {
  const liUrl = c.linkedin.startsWith("http")
    ? c.linkedin
    : `https://${c.linkedin}`;
  contactParts.push(`[${c.linkedin}](${liUrl})`);
}
if (c.location) contactParts.push(c.location);

const identityHeader = `# ${c.full_name}\n\n${contactParts.join(" / ")}`;

// Drop everything up to and including the first blank line *after* the LLM's
// identity block (its H1 and contact line), then prepend our canonical header.
const body = markdown
  .replace(/^#\s+[^\n]*\n+[^\n]+\n+/, "")
  .replace(/^\n+/, "");
markdown = `${identityHeader}\n\n${body}`;

// ── ATS unicode normalization ─────────────────────────────────────────

{
  const result = normalizeAtsText(markdown);
  markdown = result.text;
  const summary = normalizationSummary(result);
  if (summary) console.log(summary);
}

// ── Save markdown ─────────────────────────────────────────────────────────────

mkdirSync(resolve(__dirname, "output/customized-cvs"), { recursive: true });
const mdPath = resolve(__dirname, `output/customized-cvs/${num}-${slug}-cv.md`);
await writeFile(mdPath, markdown, "utf-8");
console.log(`✅ MD   : ${mdPath}`);

// Canonical audit trace: bullet→src mapping, gaps, bridges, validator chain.
// Single source of truth (no separate audit.log). cv-fact-check.mjs reads
// this; a compat bridges.json is also written until that rewires (Phase 3).
const tracePath = resolve(
  __dirname,
  `output/customized-cvs/${num}-${slug}-trace.json`,
);
await writeFile(
  tracePath,
  JSON.stringify(
    {
      num,
      slug,
      generatedAt: new Date().toISOString(),
      report: basename(reportPath),
      bullets: traceBullets,
      gaps,
      bridges,
      validator: {
        passed: valResult.passed,
        retries: attempt,
        hard: valResult.hard,
        soft: valResult.soft,
      },
    },
    null,
    2,
  ),
  "utf-8",
);
console.log(`🧾 Trace: ${tracePath}`);
const bridgesPath = resolve(
  __dirname,
  `output/customized-cvs/${num}-${slug}-cv-bridges.json`,
);
await writeFile(bridgesPath, JSON.stringify({ bridges }, null, 2), "utf-8");

// On unresolved hard failures: persist the tagged CV for inspection and exit
// non-zero so the dashboard treats it as an error and does NOT auto-chain the
// review/render of a structurally-unvalidated CV (surfaced, never silent).
if (!valResult.passed) {
  const unvalPath = resolve(
    __dirname,
    `output/customized-cvs/${num}-${slug}-cv.UNVALIDATED.md`,
  );
  await writeFile(unvalPath, taggedMarkdown, "utf-8");
  console.error(`⚠ Tagged CV with findings saved for review: ${unvalPath}`);
  process.exit(1);
}

// ── Generate PDF via WeasyPrint ───────────────────────────────────────────────

if (!noPdf) {
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
        mdPath,
        "--out",
        pdfPath,
        "--css",
        cssPath,
        "--format",
        format,
      ],
      { stdio: "inherit", cwd: __dirname },
    );
  } catch (e) {
    console.error("❌ PDF generation failed:", e.message);
    process.exit(1);
  }
}
