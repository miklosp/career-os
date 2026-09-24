#!/usr/bin/env node
// letter-context.mjs — compact cover-letter context. Deterministic, zero-token.
//
// A cover letter that is fed the whole story bank + CV cites everything and
// reads as a CV recital. This script emits only what the letter needs, in one
// call, so the drafting agent reads one output instead of five files:
//   1. REPORT           — header, Block A, Criteria ledger, and the elicited
//                         `### Motivation` / Section G if present
//   2. STORY RANKING    — S0xx ids ranked by how often the report cites them
//                         (Block A + Criteria). Top stories are the default
//                         proofs; the agent confirms the pick with the user.
//   3. STORIES          — full STAR text of the top-N ranked stories
//   4. CITED CV BULLETS — text of every cv.json bullet id the report cites
//   5. CITED NOTES      — confirmed config/notes.yml entries the report cites
//   6. VOICE            — config/profile.md → candidate frontmatter + Voice & Branding
//   7. SAMPLE LETTERS   — the N most recent files in config/cover-letters/
//                         (accepted, candidate-edited letters; the bar to match)
//                         plus a one-line index of the rest
//   8. JD               — data/jds/{NUM}-*.md
//
// Usage: node lib/letter-context.mjs <NUM> [--stories N] [--samples N]   (defaults 3, 2)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eachHighlight } from "./cv-schema.mjs";
import { CONFIG_DIR, DATA_DIR, USER_DIR, displayPath } from "./paths.mjs";

const U = displayPath(USER_DIR);
const args = process.argv.slice(2);
const num = args.find((a) => !a.startsWith("--"));
const flag = (name, dflt) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : dflt);
const topN = flag("--stories", 3);
const sampleN = flag("--samples", 2);
if (!num) {
  console.error("usage: node lib/letter-context.mjs <NUM> [--stories N] [--samples N]");
  process.exit(1);
}

const find = (dir) => readdirSync(join(DATA_DIR, dir)).find((f) => f.startsWith(`${num}-`));
const reportFile = find("reports");
const jdFile = find("jds");
if (!reportFile || !jdFile) {
  console.error(`letter-context: missing ${reportFile ? "JD" : "report"} for NUM ${num}`);
  process.exit(1);
}
const report = readFileSync(join(DATA_DIR, "reports", reportFile), "utf8");

// Cited ids in Block A + Criteria (not Blocks B–D, which cite nothing useful).
const cited = [];
const scope = report.match(/### A:[\s\S]*?(?=### B:)/)?.[0] + (report.match(/### Criteria[\s\S]*?(?=\n### |$)/)?.[0] ?? "");
for (const m of scope.matchAll(/\[src: ([^\]]+)\]/g)) cited.push(...m[1].split(",").map((s) => s.trim()));

const counts = new Map();
for (const id of cited) counts.set(id, (counts.get(id) || 0) + 1);
const storyRank = [...counts].filter(([id]) => /^S\d{3}$/.test(id)).sort((a, b) => b[1] - a[1]);

// Story bank: id → full block.
const bank = readFileSync(join(CONFIG_DIR, "story-bank.md"), "utf8");
const stories = new Map();
for (const block of bank.slice(bank.indexOf("## Stories")).split(/\n(?=### )/)) {
  const id = block.match(/\*\*ID:\*\* (S\d{3})/)?.[1];
  if (id) stories.set(id, block.trim());
}

const cv = JSON.parse(readFileSync(join(CONFIG_DIR, "cv.json"), "utf8"));
const bullets = new Map(eachHighlight(cv).map((h) => [h.id, h.text]));

const notesRaw = readFileSync(join(CONFIG_DIR, "notes.yml"), "utf8");
const noteClaims = [...notesRaw.matchAll(/- claim: "(.*)"/g)].map((m) => m[1]);

const profile = readFileSync(join(CONFIG_DIR, "profile.md"), "utf8");
const frontmatter = profile.match(/^---\n[\s\S]*?\ncandidate:[\s\S]*?(?=\n\S)/)?.[0] ?? "";
const voice = profile.match(/## Voice & Branding[\s\S]*?(?=\n## )/)?.[0] ?? "";

const lettersDir = join(CONFIG_DIR, "cover-letters");
const letters = readdirSync(lettersDir).filter((f) => f.endsWith(".md"))
  .map((f) => ({ f, mtime: statSync(join(lettersDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
const sample = letters.slice(0, sampleN).map(({ f }) => `<!-- ${f} -->\n${readFileSync(join(lettersDir, f), "utf8").trim()}`).join("\n\n---\n\n")
  + (letters.length > sampleN ? `\n\n(also on file, pass --samples N to include: ${letters.slice(sampleN).map(({ f }) => f).join(", ")})` : "")
  || `(none — ${U}/config/cover-letters/ is empty)`;

const section = (title, body) => `\n════════ SECTION: ${title} ════════\n\n${body.trimEnd()}\n`;

let out = `LETTER CONTEXT for ${num}. Do not re-read these files; ask for more only if a chosen story is missing below.\n`;
out += section(`REPORT (${U}/data/reports/${reportFile})`, report);
out += section(
  "STORY RANKING (citations in Block A + Criteria; top stories = default proofs, confirm with the user)",
  storyRank.length ? storyRank.map(([id, n]) => `- ${id} × ${n} — ${stories.get(id)?.match(/\*\*Title:\*\* (.+)/)?.[1] ?? "?"}`).join("\n") : "(report cites no stories — pick from the JD needs + cited bullets)",
);
for (const [id] of storyRank.slice(0, topN)) out += section(`STORY ${id}`, stories.get(id) ?? "(not in story bank)");
out += section(
  "CITED CV BULLETS",
  [...counts.keys()].filter((id) => bullets.has(id)).map((id) => `- ${id}: ${bullets.get(id)}`).join("\n") || "(none)",
);
out += section(
  "CITED NOTES",
  [...counts.keys()].filter((id) => /^n\d+$/.test(id)).map((id) => `- ${id}: ${noteClaims[Number(id.slice(1)) - 1] ?? "?"}`).join("\n") || "(none)",
);
out += section(`VOICE (${U}/config/profile.md)`, `${frontmatter}\n\n${voice}`);
out += section(`SAMPLE LETTERS (${U}/config/cover-letters/ — accepted letters, the bar to hit)`, sample);
out += section(`JD (${U}/data/jds/${jdFile})`, readFileSync(join(DATA_DIR, "jds", jdFile), "utf8"));
process.stdout.write(out);
