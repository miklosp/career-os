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
 *   LLM_PROVIDER_URL — LLM provider/proxy base URL (.env; required)
 *   GENERATION_MODEL — generator model ID (.env; required, no hardcoded fallback)
 */

import { readFile, writeFile, readdir, stat } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname, basename, sep } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { Agent, fetch as undiciFetch } from "undici";
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

const LLM_PROVIDER_URL = process.env.LLM_PROVIDER_URL;
const GENERATION_MODEL = process.env.GENERATION_MODEL;
if (!LLM_PROVIDER_URL) {
  console.error("❌ LLM_PROVIDER_URL is not set — define it in .env (no hardcoded fallback).");
  process.exit(1);
}
if (!GENERATION_MODEL) {
  console.error("❌ GENERATION_MODEL is not set — define it in .env (no hardcoded fallback).");
  process.exit(1);
}

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
let jdFile = null;
const maybeFile = resolve(jdArg);
if (existsSync(maybeFile)) {
  jdText = await readFile(maybeFile, "utf-8");
  jdFile = maybeFile;
  console.log(`📋 JD from file: ${maybeFile}`);

  // Derive num + slug from "{NUM}-{slug}.md" filename when not passed explicitly
  const fname = basename(maybeFile).replace(/\.(md|txt)$/i, "");
  const m = fname.match(/^(\d+)-(.+)$/);
  if (m) {
    num = num ?? m[1];
    // The filename slug is best-effort: fetch-jd's SPA fallback derives it from
    // the host (jobs.deel.com → "jobs") with an "unknown-role" role. The JD body
    // heading ("# {company} — {role}") is the authoritative, agent-corrected
    // value, so prefer it for the output CV filename; fall back to the filename.
    slug = slug ?? headingSlug(jdText) ?? m[2];
  }
}

// Build a "{company}-{role}" slug from the JD body heading written by fetch-jd
// ("# {company} — {role}"). Returns null when the first heading has no em/en-dash
// company–role split, so a hyphenated title keeps the filename slug untouched.
function headingSlug(text) {
  const m = String(text).match(/^#\s+(.+?)\s+[—–]\s+(.+?)\s*$/m);
  if (!m) return null;
  const s = (x) =>
    String(x)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);
  const parts = [s(m[1]), s(m[2])].filter(Boolean);
  return parts.length ? parts.join("-") : null;
}

if (!num || !slug) {
  console.error(
    'Missing --num and/or --slug. Either pass them explicitly, or point --jd at a file named like "064-legora-product-lead.md".',
  );
  process.exit(1);
}

if (!/^\d{3,}$/.test(num)) {
  console.error(
    `Invalid --num "${num}". Must be a 3+ digit zero-padded sequence (e.g. 064, 1085).`,
  );
  process.exit(1);
}

// slug can arrive from --slug or a JD filename and is interpolated straight
// into output/customized-cvs/{num}-{slug}-cv.md. Reduce it to a filename-safe
// charset so it can never introduce a path separator or `..` and escape the
// output directory.
slug = String(slug)
  .replace(/[^a-zA-Z0-9._-]+/g, "-")
  .replace(/\.{2,}/g, "-")
  .replace(/^[-.]+|[-.]+$/g, "")
  .slice(0, 80) || "cv";

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

const [cvJsonRaw, atsPrompt, profileRaw, reportMd, storyBankMd, notesRaw, aliasesRaw, writingMd] =
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
    readFile(resolve(__dirname, "modes/_writing.md"), "utf-8"),
  ]);

// Writing craft rules = §§1–4 of modes/_writing.md; §5 onward is ATS-Unicode
// (enforced in code) + a self-check step, not generation guidance. Fall back to
// the whole file if the section markers ever change.
const writingStandards = (writingMd.match(/## 1\. Voice[\s\S]*?(?=\n## 5\.)/) || [writingMd])[0].trim();

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
  .replace("{writing_standards}", writingStandards)
  .replace("{job_content}", jdText);

// Deterministic validation context (shared across retries).
const valCtx = buildContext({ cvJson, storyBankMd, notesYml, reportMd, aliasesYml });

// ── Call Bifrost (with deterministic validation + retry-with-diff) ───────────

console.log(`🤖  Model : ${GENERATION_MODEL}`);
console.log(`🔌  Proxy : ${LLM_PROVIDER_URL}`);

// Non-streamed completions send headers only once generation finishes; undici's
// 300s default headersTimeout kills long Opus runs mid-flight.
const llmDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

async function callModel(promptText) {
  const response = await undiciFetch(`${LLM_PROVIDER_URL}/v1/chat/completions`, {
    method: "POST",
    dispatcher: llmDispatcher,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GENERATION_MODEL,
      messages: [{ role: "user", content: promptText }],
      // Reasoning models bill hidden reasoning against max_tokens; at 8192 a
      // hard prompt can burn the whole budget and return empty content.
      max_tokens: Number(process.env.GENERATION_MAX_TOKENS ?? 32000),
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
// The closing tag is optional: models occasionally emit the opening <tag> and
// JSON body but drop </tag> (the <gaps> block is emitted last, so its close tag
// is the one most often lost). Without the `|$` alternation the match would fail
// and the whole block would leak into the rendered CV. Absent </tag> → consume
// to end-of-string.
function extractBlock(md, tag, key) {
  const m = md.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*(?:</${tag}>|$)`));
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
  // Defense in depth: an audit-only block must never reach the rendered CV.
  // extractBlock already tolerates a dropped closing tag; this is the backstop
  // for any residual <bridges>/<gaps> (both are emitted after the CV body, so
  // stripping from the first such tag to EOF is safe).
  if (/<\/?(?:bridges|gaps)>/i.test(out)) {
    console.warn("⚠ Residual <bridges>/<gaps> tag after extraction — stripping from CV body.");
    out = out.replace(/\n*<\/?(?:bridges|gaps)>[\s\S]*$/i, "").trim();
  }
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

// `description` is the only fenced div the renderer knows. The generator
// occasionally emits a stray one with another class; drop it here so it can
// never reach the PDF.
{
  const stray = /^::: (?!description[ \t]*$)\w+[ \t]*\n(?:(?!^:::)[^\n]*\n)*?^:::[ \t]*$\n?/gm;
  if (stray.test(markdown)) {
    console.warn("⚠ Stray fenced div in generated CV — stripping.");
    markdown = markdown.replace(stray, "").replace(/\n{3,}/g, "\n\n");
  }
}

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

const outDir = resolve(__dirname, "output/customized-cvs");
mkdirSync(outDir, { recursive: true });
const mdPath = resolve(outDir, `${num}-${slug}-cv.md`);
// Belt-and-suspenders: slug is already sanitized above, but assert the
// resolved path never escapes outDir before any write.
if (mdPath !== outDir && !mdPath.startsWith(outDir + sep)) {
  console.error(`❌ Refusing to write outside ${outDir}: ${mdPath}`);
  process.exit(1);
}
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
      jd: jdFile ? basename(jdFile) : null,
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
