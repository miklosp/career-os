#!/usr/bin/env node
/**
 * cv-draft.mjs — deterministic bookends for the in-session tailored CV draft.
 * Zero-token: the interactive tailor session (modes/tailor.md) writes the
 * draft itself; this script only assembles its inputs and finalizes its output.
 *
 *   context <NUM>
 *     Prints everything the session needs to draft, in one call: the NUM,
 *     JD / report paths, the draft path to write, and lib/prompts/ats-prompt.md
 *     with every input filled in (id-annotated CV, latest report, story bank,
 *     notes with n# ids, writing standards §§1–4 of modes/_writing.md, JD).
 *     No report on disk → exit 1 (tailoring needs an evaluation).
 *
 *   finalize <draft.md>
 *     Draft = the tagged CV markdown + <bridges> + <gaps> blocks, named
 *     output/customized-cvs/{NUM}-{slug}-cv-draft.md. Steps:
 *       1. extract <bridges>/<gaps> JSON (closing tag optional); strip residue
 *       2. lib/cv-validate.mjs against cv.json, story bank, notes, aliases,
 *          and the latest report. Hard fail → print <failed_constraints>,
 *          exit 1, write nothing. The session fixes the draft and reruns.
 *       3. bullet→src trace from the tagged body, then strip [src:] tags
 *       4. projection: the draft contributes only the Summary, the Core
 *          Competencies selection, and the bullets (placed under the roles /
 *          sub-entries they sit under, in draft order). Everything else is
 *          re-serialized from canonical data: name + contact line from
 *          profile.md; headline (basics.label), role headings, dates, meta
 *          lines, descriptions, sub-entry headings + dateRange, languages and
 *          education from cv.json. A draft heading with no cv.json match
 *          (role by headingRaw, then slug; sub-entry by **Name**) → exit 1.
 *       5. ATS unicode normalization (lib/normalize-text.mjs)
 *       6. write {NUM}-{slug}-cv.md + {NUM}-{slug}-trace.json (bullets, gaps,
 *          bridges, validator result — consumed by lib/cv-fact-check.mjs),
 *          then delete the draft (the trace carries its provenance)
 *     PDF rendering is a separate step (render-cv-pdf.py) after the review.
 *
 * Usage:
 *   node lib/cv-draft.mjs context <NUM>
 *   node lib/cv-draft.mjs finalize <path/to/{NUM}-{slug}-cv-draft.md>
 */
import { readFile, writeFile, readdir, stat, unlink } from "fs/promises";
import { existsSync, mkdirSync } from "fs";
import { resolve, basename } from "path";
import { load as yamlLoad } from "js-yaml";
import { parseCvMarkdown, serializeCvJson, identityFromProfile } from "./cv-schema.mjs";
import { buildContext, validateCv, stripSrcTags, failedConstraintsBlock } from "./cv-validate.mjs";
import { normalizeAtsText, normalizationSummary } from "./normalize-text.mjs";
import { CONFIG_DIR, JDS_DIR, REPORTS_DIR, OUTPUT_DIR, REPO_DIR, displayPath } from "./paths.mjs";

const OUT_DIR = resolve(OUTPUT_DIR, "customized-cvs");
const readMaybe = async (p, d) => (existsSync(p) ? readFile(p, "utf-8") : d);

/** Newest `{num}-*.md` in dir by mtime, or null. */
async function newestByNum(dir, num) {
  if (!existsSync(dir)) return null;
  const names = (await readdir(dir)).filter((n) => n.startsWith(`${num}-`) && n.endsWith(".md"));
  if (!names.length) return null;
  const withTime = await Promise.all(
    names.map(async (n) => ({ n, t: (await stat(resolve(dir, n))).mtimeMs })),
  );
  withTime.sort((a, b) => b.t - a.t);
  return resolve(dir, withTime[0].n);
}

// "{company}-{role}" slug from the JD body heading "# {company} — {role}"
// written by fetch-jd (authoritative, agent-corrected); null when absent.
function headingSlug(text) {
  const m = String(text).match(/^#\s+(.+?)\s+[—–]\s+(.+?)\s*$/m);
  if (!m) return null;
  const s = (x) =>
    String(x).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  const parts = [s(m[1]), s(m[2])].filter(Boolean);
  return parts.length ? parts.join("-") : null;
}

// Filename-safe: no path separators, no `..`.
const safeSlug = (slug) =>
  String(slug).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/\.{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "cv";

async function loadSources(num) {
  const reportPath = await newestByNum(REPORTS_DIR, num);
  const [cvJsonRaw, profileRaw, reportMd, storyBankMd, notesRaw, aliasesRaw] = await Promise.all([
    readFile(resolve(CONFIG_DIR, "cv.json"), "utf-8"),
    readFile(resolve(CONFIG_DIR, "profile.md"), "utf-8"),
    reportPath ? readFile(reportPath, "utf-8") : "",
    readMaybe(resolve(CONFIG_DIR, "story-bank.md"), "(story bank not yet created)"),
    readMaybe(resolve(CONFIG_DIR, "notes.yml"), "notes: []"),
    readMaybe(resolve(CONFIG_DIR, "aliases.yml"), "aliases: []"),
  ]);
  return {
    reportPath,
    jdPath: await newestByNum(JDS_DIR, num),
    cvJson: JSON.parse(cvJsonRaw),
    profileRaw,
    reportMd,
    storyBankMd,
    notesYml: yamlLoad(notesRaw) || { notes: [] },
    aliasesYml: yamlLoad(aliasesRaw) || { aliases: [] },
  };
}

// ── context ─────────────────────────────────────────────────────────────────
async function context(num) {
  const src = await loadSources(num);
  if (!src.reportPath) {
    console.error(`❌ No evaluation report at ${displayPath(REPORTS_DIR)}/${num}-*.md — run /career-ops on the JD URL first.`);
    process.exit(1);
  }
  if (!src.jdPath) {
    console.error(`❌ No JD at ${displayPath(JDS_DIR)}/${num}-*.md.`);
    process.exit(1);
  }
  const jdText = await readFile(src.jdPath, "utf-8");
  const slug = safeSlug(headingSlug(jdText) ?? basename(src.jdPath, ".md").replace(/^\d+-/, ""));
  const draftPath = resolve(OUT_DIR, `${num}-${slug}-cv-draft.md`);

  const [atsPrompt, writingMd] = await Promise.all([
    readFile(resolve(REPO_DIR, "lib/prompts/ats-prompt.md"), "utf-8"),
    readFile(resolve(REPO_DIR, "modes/_writing.md"), "utf-8"),
  ]);
  // §§1–4 are craft rules; §5 onward is ATS-Unicode (enforced in code) + self-check.
  const writingStandards = (writingMd.match(/## 1\. Voice[\s\S]*?(?=\n## 5\.)/) || [writingMd])[0].trim();
  const notesContent =
    (src.notesYml.notes || [])
      .map((n, i) =>
        `n${i + 1} [${n.confirmed === true ? "EVIDENCE" : "IGNORE (confirmed:false)"}] (${n.source_type || "?"}): ${n.claim || ""}${
          n.supporting_detail ? ` — ${n.supporting_detail}` : ""
        }`)
      .join("\n") || "(no structured personal notes)";
  // Function replacers: inputs may contain `$&`-style sequences.
  const filled = atsPrompt
    .replace("{cv_content}", () => serializeCvJson(src.cvJson, { annotateIds: true }))
    .replace("{report_content}", () => src.reportMd)
    .replace("{story_bank_content}", () => src.storyBankMd)
    .replace("{notes_content}", () => notesContent)
    .replace("{writing_standards}", () => writingStandards)
    .replace("{job_content}", () => jdText);

  const [rs, js] = await Promise.all([stat(src.reportPath), stat(src.jdPath)]);
  const stale = rs.mtimeMs + 60_000 < js.mtimeMs
    ? `\n⚠ Report is older than the JD by ${Math.round((js.mtimeMs - rs.mtimeMs) / 1000)}s — the JD may have changed since evaluation.\n`
    : "";

  process.stdout.write(
    `CV DRAFT CONTEXT — NUM ${num}. All generator inputs; do not re-read these files.\n\n` +
      `JD:       ${displayPath(src.jdPath)}\n` +
      `Report:   ${displayPath(src.reportPath)}\n` +
      `Draft:    ${displayPath(draftPath)}   (write the three-part output here)\n` +
      `Finalize: node lib/cv-draft.mjs finalize ${displayPath(draftPath)}\n` +
      stale +
      `\n════════ CONTRACT + INPUTS (lib/prompts/ats-prompt.md, filled) ════════\n\n` +
      filled.trimEnd() + "\n",
  );
}

// ── finalize ────────────────────────────────────────────────────────────────

// Tolerant JSON array out of a <tag>…</tag> block (closing tag optional → EOF).
function extractBlock(md, tag, key) {
  const m = md.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*(?:</${tag}>|$)`));
  if (!m) return { list: [], rest: md };
  const rest = md.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  const raw = m[1].trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
  try {
    const parsed = JSON.parse(raw);
    return { list: Array.isArray(parsed[key]) ? parsed[key] : [], rest };
  } catch (e) {
    console.error(`❌ <${tag}> is not valid JSON: ${e.message}. Fix the block and rerun.`);
    process.exit(1);
  }
}

async function finalize(draftPath) {
  const m = basename(draftPath).match(/^(\d{3,})-(.+)-cv-draft\.md$/);
  if (!m || !existsSync(draftPath)) {
    console.error(`❌ Expected an existing {NUM}-{slug}-cv-draft.md, got: ${draftPath}`);
    process.exit(1);
  }
  const num = m[1];
  const slug = safeSlug(m[2]);
  const src = await loadSources(num);
  if (!src.reportPath) {
    console.error(`❌ No evaluation report at ${displayPath(REPORTS_DIR)}/${num}-*.md.`);
    process.exit(1);
  }

  let out = (await readFile(draftPath, "utf-8"))
    .replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
  let bridges, gaps;
  ({ list: bridges, rest: out } = extractBlock(out, "bridges", "bridges"));
  ({ list: gaps, rest: out } = extractBlock(out, "gaps", "gaps"));
  // Audit-only blocks must never reach the CV; both come after the body.
  out = out.replace(/\n*<\/?(?:bridges|gaps)>[\s\S]*$/i, "").trim();

  const valCtx = buildContext({
    cvJson: src.cvJson, storyBankMd: src.storyBankMd, notesYml: src.notesYml,
    reportMd: src.reportMd, aliasesYml: src.aliasesYml,
  });
  const val = validateCv(out, valCtx, { bridges });
  console.log(
    `🌉 Bridges: ${bridges.length} · 🕳 Gaps: ${gaps.length} · 🔎 Validator: ${val.passed ? "PASS" : "FAIL"} ` +
      `(${val.hard.length} hard, ${val.soft.length} soft)`,
  );
  if (!val.passed) {
    console.error(failedConstraintsBlock(val, valCtx));
    process.exit(1);
  }
  for (const f of val.soft) console.log(`  [SOFT ${f.rule}] ${f.reason}\n     ${f.text}`);

  const traceBullets = out.split("\n").filter((l) => /^-\s+/.test(l.trim())).map((l) => {
    const sm = l.match(/\[src:\s*([^\]]+)\]\s*$/i);
    return {
      text: l.replace(/^-\s+/, "").replace(/\s*\[src:\s*[^\]]+\]\s*$/i, "").trim(),
      src: sm ? sm[1].split(",").map((s) => s.trim()) : [],
    };
  });

  // Project everything but the authored parts. The draft contributes the
  // Summary, the Core Competencies selection, and the bullets (which roles /
  // sub-entries they sit under, in draft order); identity, headline, role
  // headings, dates, meta lines, descriptions, sub-entry headings + dates,
  // languages and education come from profile.md + cv.json.
  const parsed = parseCvMarkdown(stripSrcTags(out));
  const subName = (h) => (h.match(/^\*\*(.+?)\*\*/) || [])[1]?.trim();
  const unmatched = [];
  const work = parsed.work.map((dw) => {
    const cw = src.cvJson.work.find((w) => w.headingRaw === dw.headingRaw) ||
      src.cvJson.work.find((w) => w.slug === dw.slug);
    if (!cw) return unmatched.push(`### ${dw.headingRaw}`);
    const { highlights, subEntries, ...header } = cw;
    return {
      ...header,
      highlights: dw.highlights,
      subEntries: (dw.subEntries || []).map((ds) => {
        const cs = (cw.subEntries || []).find((s) => subName(s.headingRaw) === subName(ds.headingRaw));
        if (!cs) return unmatched.push(`${ds.headingRaw} (under ### ${cw.headingRaw})`);
        return { ...cs, highlights: ds.highlights };
      }),
    };
  });
  if (unmatched.length) {
    const known = src.cvJson.work.flatMap((w) => [`### ${w.headingRaw}`, ...(w.subEntries || []).map((s) => `  ${s.headingRaw}`)]);
    console.error(
      `❌ Draft heading(s) not in cv.json — copy role and sub-entry headings verbatim from the source CV:\n` +
        unmatched.map((u) => `   ${u}`).join("\n") + `\n   Known headings:\n` + known.map((k) => `     ${k}`).join("\n"),
    );
    process.exit(1);
  }
  const { name, contactLine } = identityFromProfile(src.profileRaw, yamlLoad);
  const norm = normalizeAtsText(
    serializeCvJson(
      {
        basics: { ...src.cvJson.basics, summary: parsed.basics.summary },
        skills_inventory: parsed.skills_inventory,
        core_competencies: parsed.skills_inventory,
        languages_line: src.cvJson.languages_line,
        work,
        education: src.cvJson.education,
      },
      { name, contactLine },
    ),
  );
  const summary = normalizationSummary(norm);
  if (summary) console.log(summary);

  mkdirSync(OUT_DIR, { recursive: true });
  const mdPath = resolve(OUT_DIR, `${num}-${slug}-cv.md`);
  const tracePath = resolve(OUT_DIR, `${num}-${slug}-trace.json`);
  await writeFile(mdPath, norm.text, "utf-8");
  await writeFile(
    tracePath,
    JSON.stringify(
      {
        num,
        slug,
        generatedAt: new Date().toISOString(),
        report: basename(src.reportPath),
        jd: src.jdPath ? basename(src.jdPath) : null,
        bullets: traceBullets,
        gaps,
        bridges,
        validator: { passed: true, hard: val.hard, soft: val.soft },
      },
      null,
      2,
    ),
    "utf-8",
  );
  await unlink(draftPath);
  console.log(`✅ MD   : ${displayPath(mdPath)}`);
  console.log(`🧾 Trace: ${displayPath(tracePath)}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "context" && /^\d{3,}$/.test(arg || "")) await context(arg);
else if (cmd === "finalize" && arg) await finalize(resolve(arg));
else {
  console.error("Usage:\n  node lib/cv-draft.mjs context <NUM>\n  node lib/cv-draft.mjs finalize <{NUM}-{slug}-cv-draft.md>");
  process.exit(2);
}
