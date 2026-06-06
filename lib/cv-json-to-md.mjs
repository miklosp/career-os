#!/usr/bin/env node
/**
 * cv-json-to-md.mjs — deterministic, zero-token render of config/cv.json.
 *
 * Two products from one canonical serializer (lib/cv-schema.mjs):
 *   (default)     regenerate the human-readable derived view config/cv.md,
 *                 identity (name + contact) projected from config/profile.md.
 *   --annotate-ids --stdout
 *                 emit the id-annotated source view ("- bullet [id]") consumed
 *                 by the generator, validator, and modes/_eval.md.
 *   --check       round-trip gate: parse cv.md, serialize, diff; non-zero exit
 *                 if anything beyond canonical-whitespace normalization differs.
 *
 * Usage:
 *   node lib/cv-json-to-md.mjs                       # write config/cv.md
 *   node lib/cv-json-to-md.mjs --annotate-ids --stdout
 *   node lib/cv-json-to-md.mjs --check
 */
import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseCvMarkdown, serializeCvJson, identityFromProfile } from "./cv-schema.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const annotateIds = args.includes("--annotate-ids");
const toStdout = args.includes("--stdout");
const check = args.includes("--check");

const jsonPath = resolve(root, "config/cv.json");
const mdPath = resolve(root, "config/cv.md");
const profilePath = resolve(root, "config/profile.md");

/** Identity projection: name + contact line rebuilt from profile.md frontmatter. */
async function identity() {
  const raw = await readFile(profilePath, "utf-8");
  const { load } = await import("js-yaml");
  return identityFromProfile(raw, load);
}

if (check) {
  const original = await readFile(mdPath, "utf-8");
  const reparsed = serializeCvJson(parseCvMarkdown(original));
  const normalize = (s) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "") + "\n";
  if (normalize(original) === normalize(reparsed)) {
    console.log("✅ round-trip clean (no semantic loss; canonical whitespace only)");
    process.exit(0);
  }
  console.error("❌ round-trip differs beyond canonical normalization:");
  const a = normalize(original).split("\n");
  const b = normalize(reparsed).split("\n");
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    if (a[k] !== b[k]) console.error(`  L${k + 1}\n   - ${a[k] ?? "∅"}\n   + ${b[k] ?? "∅"}`);
  }
  process.exit(1);
}

const json = JSON.parse(await readFile(jsonPath, "utf-8"));
const opts = annotateIds
  ? { annotateIds: true }
  : await identity();
const out = serializeCvJson(json, opts);

if (toStdout) {
  process.stdout.write(out);
} else {
  await writeFile(mdPath, out, "utf-8");
  console.log(`✅ ${mdPath} (derived from cv.json)`);
}
