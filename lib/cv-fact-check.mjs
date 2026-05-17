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
 *   BIFROST_URL           — proxy base URL (default: http://localhost:4444)
 *   BIFROST_REVIEW_MODEL  — reviewer model alias (default: gemini-pro)
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

const BIFROST_URL = process.env.BIFROST_URL ?? "http://localhost:4444";
const REVIEW_MODEL = process.env.BIFROST_REVIEW_MODEL ?? "gemini-pro";

// mergeGeneratorBridges folds generate-cv-llm.mjs's <bridges> output (saved at
// {NUM}-{slug}-cv-bridges.json) into the reviewer's findings list. Bridges are
// vocabulary substitutions the generator made deliberately; we surface them in
// the same walkthrough as fabricated/stretched findings so the user can decide
// per-finding whether to upgrade to the JD vocabulary. The reviewer can also
// emit `severity: "bridge"` findings; both sources coexist in the merged list.
async function mergeGeneratorBridges(review, bridgesPath) {
  if (!existsSync(bridgesPath)) return normalizeSummary(review);
  let bridgeList = [];
  try {
    const parsed = JSON.parse(await readFile(bridgesPath, "utf-8"));
    bridgeList = Array.isArray(parsed.bridges) ? parsed.bridges : [];
  } catch {
    return normalizeSummary(review);
  }
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
      source_cv_evidence: b.source_cv_evidence ?? "",
      issue: b.issue ?? "",
      proposed_fix: b.proposed_fix ?? "",
    });
  }
  return normalizeSummary({ ...review, findings });
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
const m = fname.match(/^(\d{3})-(.+)$/);
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

// ── Bridges JSON (from generate-cv-llm.mjs) ─────────────────────────────────
const bridgesPath = resolve(
  __dirname,
  `output/customized-cvs/${num}-${slug}-cv-bridges.json`,
);

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
} else {
  // Call Gemini (fresh review).
  const [sourceCv, jdText, reviewPrompt, reportMd] = await Promise.all([
    readFile(resolve(__dirname, "config/cv.md"), "utf-8"),
    readFile(jdPath, "utf-8"),
    readFile(resolve(__dirname, "lib/prompts/cv-review-prompt.md"), "utf-8"),
    reportPath
      ? readFile(reportPath, "utf-8")
      : Promise.resolve("(no evaluation report found — Block A grounding unavailable)"),
  ]);

  const filledPrompt = reviewPrompt
    .replace("{source_cv}", sourceCv)
    .replace("{report_content}", reportMd)
    .replace("{generated_cv}", generatedCv)
    .replace("{jd}", jdText);

  console.log(
    `${C.cyan}🔍${C.reset} Reviewing ${C.bold}${basename(cvPath)}${C.reset}`,
  );
  console.log(`${C.dim}   Source: config/cv.md${C.reset}`);
  console.log(`${C.dim}   JD:     data/jds/${num}-${slug}.md${C.reset}`);
  console.log(
    `${C.dim}   Model:  ${REVIEW_MODEL} via ${BIFROST_URL}${C.reset}`,
  );
  console.log("");

  // Bifrost-routed Gemini occasionally returns HTTP 200 with `choices: null`
  // (an upstream hiccup with reasoning models). Retry on empty/invalid
  // responses before giving up — auto-pipeline runs are unattended and the
  // alternative is a stuck `error` row in the dashboard.
  const MAX_ATTEMPTS = 3;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(`${BIFROST_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        messages: [{ role: "user", content: filledPrompt }],
        max_tokens: 8192,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      lastErr = `Bifrost ${response.status}: ${body.slice(0, 400)}`;
    } else {
      const payload = await response.json();
      let raw = payload.choices?.[0]?.message?.content ?? "";
      if (!raw) {
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
          review = await mergeGeneratorBridges(review, bridgesPath);
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
  console.log("");
  // Bridge findings: proposed_fix is the JD-vocabulary upgrade (apply = adopt
  // JD wording). Fabricated/stretched: proposed_fix is the conservative
  // downgrade (apply = remove or soften). Empty string always means "delete".
  const fixDisplay =
    f.proposed_fix === ""
      ? `${C.dim}(remove the text)${C.reset}`
      : f.proposed_fix;
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
      replacement = f.proposed_fix;
      approved++;
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
