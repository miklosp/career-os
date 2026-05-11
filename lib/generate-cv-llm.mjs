#!/usr/bin/env node

/**
 * generate-cv-llm.mjs — ATS-optimized CV via Opus 4.7 on Bifrost proxy.
 *
 * Usage:
 *   node generate-cv-llm.mjs --jd <file-or-text> [--num 064] [--slug legora-product-lead] [--format a4|letter] [--no-pdf]
 *
 * Flow:
 *   1. LLM (Opus via Bifrost) rewrites config/cv.md against the JD, returning *markdown*.
 *   2. Identity header (name + contact line) is force-overwritten from config/profile.yml
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

import { readFile, writeFile } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

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

// ── Read source files in parallel ────────────────────────────────────────────

const [cvMd, atsPrompt, profileRaw] = await Promise.all([
  readFile(resolve(__dirname, "config/cv.md"), "utf-8"),
  readFile(resolve(__dirname, "config/ats-prompt.md"), "utf-8"),
  readFile(resolve(__dirname, "config/profile.yml"), "utf-8"),
]);

// ── Parse profile ─────────────────────────────────────────────────────────────

const { load: yamlLoad } = await import("js-yaml");
const profile = yamlLoad(profileRaw);
const c = profile.candidate;

// ── Build prompt ─────────────────────────────────────────────────────────────
// config/ats-prompt.md ends with placeholders {cv_content} and {job_content} already.

const filledPrompt = atsPrompt
  .replace("{cv_content}", cvMd)
  .replace("{job_content}", jdText);

// ── Call Bifrost ──────────────────────────────────────────────────────────────

console.log(`🤖  Model : ${BIFROST_MODEL}`);
console.log(`🔌  Proxy : ${BIFROST_URL}`);

const response = await fetch(`${BIFROST_URL}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: BIFROST_MODEL,
    messages: [{ role: "user", content: filledPrompt }],
    max_tokens: 8192,
  }),
});

if (!response.ok) {
  const body = await response.text().catch(() => "");
  console.error(`❌ Bifrost ${response.status}: ${body.slice(0, 400)}`);
  process.exit(1);
}

const payload = await response.json();
let markdown = payload.choices?.[0]?.message?.content ?? "";

if (!markdown) {
  console.error("❌ Empty response from model");
  process.exit(1);
}

const usage = payload.usage;
if (usage) {
  console.log(
    `📊 Tokens: ${usage.prompt_tokens ?? "?"} in / ${usage.completion_tokens ?? "?"} out`,
  );
}

// Strip accidental markdown fences if the model wraps the whole CV in ```markdown … ```
markdown = markdown
  .replace(/^```(?:markdown|md)?\s*\n/, "")
  .replace(/\n```\s*$/, "")
  .trim();

// ── Force-overwrite identity header from profile.yml ─────────────────────────
// The LLM cannot be trusted with static identity. We rebuild the first two
// markdown blocks (H1 + contact line) from profile.yml and prepend them to
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

// ── ATS unicode normalization ─────────────────────────────────────────────────
// Em-dashes, smart quotes, zero-width, nbsp break Workday/Greenhouse parsers.

const replacements = {};
const bump = (key, n) => {
  replacements[key] = (replacements[key] || 0) + n;
};

markdown = markdown
  .replace(/—/g, () => {
    bump("em-dash", 1);
    return "-";
  })
  .replace(/–/g, () => {
    bump("en-dash", 1);
    return "-";
  })
  .replace(/[“”„‟]/g, () => {
    bump("smart-double-quote", 1);
    return '"';
  })
  .replace(/[‘’‚‛]/g, () => {
    bump("smart-single-quote", 1);
    return "'";
  })
  .replace(/…/g, () => {
    bump("ellipsis", 1);
    return "...";
  })
  .replace(/[​‌‍⁠﻿]/g, () => {
    bump("zero-width", 1);
    return "";
  })
  .replace(/ /g, () => {
    bump("nbsp", 1);
    return " ";
  });

const totalReplacements = Object.values(replacements).reduce((a, b) => a + b, 0);
if (totalReplacements > 0) {
  const breakdown = Object.entries(replacements)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(`🧹 ATS normalization: ${totalReplacements} replacements (${breakdown})`);
}

// ── Save markdown ─────────────────────────────────────────────────────────────

mkdirSync(resolve(__dirname, "output/customized-cvs"), { recursive: true });
const mdPath = resolve(__dirname, `output/customized-cvs/${num}-${slug}-cv.md`);
await writeFile(mdPath, markdown, "utf-8");
console.log(`✅ MD   : ${mdPath}`);

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
