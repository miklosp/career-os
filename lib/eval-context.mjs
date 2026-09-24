#!/usr/bin/env node
// eval-context.mjs — one-shot eval context assembly. Deterministic, zero-token.
//
// Emits everything a batch eval agent needs to score 1–N JDs, on stdout, in a
// single call — so the agent spends one tool round-trip instead of seven
// sequential Reads. Sections, in order:
//   1. ID-ANNOTATED CV        — lib/cv-json-to-md.mjs --annotate-ids --stdout
//   2. PROFILE                — config/profile.md (frontmatter + prose)
//   3. STORY BANK DIGEST      — id / title / skills / strength / Result per
//                               story, parsed from config/story-bank.md. NOT
//                               the full STAR narratives (~1k tokens vs ~12k);
//                               S0xx ids remain citable [src:] targets.
//   4. CONFIRMED NOTES        — config/notes.yml verbatim (n# citable in list order)
//   5. REPORT EXAMPLE         — templates/report.example.md (target look & feel)
//   6. JD {NUM}               — one section per requested NUM (data/jds/{NUM}-*.md)
//
// Usage: node lib/eval-context.mjs <NUM> [<NUM> ...]
// A NUM with no JD on disk → exit 1 before any output.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { CONFIG_DIR, DATA_DIR, USER_DIR, displayPath } from "./paths.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const U = displayPath(USER_DIR);
const nums = process.argv.slice(2);
if (nums.length === 0) {
  console.error("usage: node lib/eval-context.mjs <NUM> [<NUM> ...]");
  process.exit(1);
}

// Resolve every JD up front — fail fast before emitting anything.
const jdFiles = readdirSync(join(DATA_DIR, "jds"));
const jds = nums.map((num) => {
  const file = jdFiles.find((f) => f.startsWith(`${num}-`));
  if (!file) {
    console.error(`eval-context: no JD on disk for NUM ${num} (${U}/data/jds/${num}-*.md)`);
    process.exit(1);
  }
  return { num, file, text: readFileSync(join(DATA_DIR, "jds", file), "utf8") };
});

function storyBankDigest() {
  const raw = readFileSync(join(CONFIG_DIR, "story-bank.md"), "utf8");
  const stories = raw.slice(raw.indexOf("## Stories")).split(/\n### /).slice(1);
  const field = (block, name) =>
    (block.match(new RegExp(`\\*\\*${name.replace(/[()]/g, "\\$&")}:\\*\\* (.+)`)) || [])[1]?.trim();
  const lines = [];
  for (const block of stories) {
    const id = field(block, "ID");
    if (!id) continue;
    const skills = [field(block, "Primary Skill"), field(block, "Secondary Skill")]
      .filter(Boolean).join(" · ");
    lines.push(
      `- **${id}** ${field(block, "Title")} — ${skills} (strength ${field(block, "Strength")})`,
      `  Result: ${field(block, "R (Result)")}`,
    );
  }
  return lines.join("\n");
}

const section = (title, body) =>
  `\n════════ SECTION: ${title} ════════\n\n${body.trimEnd()}\n`;

const annotatedCv = execFileSync(
  process.execPath,
  [join(root, "lib/cv-json-to-md.mjs"), "--annotate-ids", "--stdout"],
  { encoding: "utf8" },
);

let out = "EVAL CONTEXT — all inputs for this eval batch. Do not re-read these files.\n";
out += section("ID-ANNOTATED CV", annotatedCv);
out += section(`PROFILE (${U}/config/profile.md)`, readFileSync(join(CONFIG_DIR, "profile.md"), "utf8"));
out += section(
  "STORY BANK DIGEST (S0xx ids citable; full STAR text intentionally omitted)",
  storyBankDigest(),
);
out += section(`CONFIRMED NOTES (${U}/config/notes.yml)`, readFileSync(join(CONFIG_DIR, "notes.yml"), "utf8"));
out += section("REPORT EXAMPLE (templates/report.example.md)", readFileSync(join(root, "templates/report.example.md"), "utf8"));
for (const jd of jds) out += section(`JD ${jd.num} (${U}/data/jds/${jd.file})`, jd.text);

process.stdout.write(out);
