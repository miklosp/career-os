#!/usr/bin/env node
/**
 * cv-md-to-json.mjs — one-time (re-runnable) migration: config/cv.md -> config/cv.json.
 *
 * Deterministic, zero-token. Assigns stable per-bullet IDs and a verbatim
 * skills_inventory (Core Competencies) plus a deterministic evidence_refs map.
 * After this runs, config/cv.json is the canonical master; config/cv.md becomes
 * a derived view (regenerate it with cv-json-to-md.mjs).
 *
 * Usage: node lib/cv-md-to-json.mjs [--in config/cv.md] [--out config/cv.json]
 *        node lib/cv-md-to-json.mjs --print   # parse + print JSON, write nothing
 */
import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseCvMarkdown, mergeAuthoredMetadata } from "./cv-schema.mjs";
import { CONFIG_DIR } from "./paths.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const getOpt = (n, d) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};
const inPath = resolve(root, getOpt("--in", resolve(CONFIG_DIR, "cv.md")));
const outPath = resolve(root, getOpt("--out", resolve(CONFIG_DIR, "cv.json")));
const printOnly = args.includes("--print");

const md = await readFile(inPath, "utf-8");
const json = parseCvMarkdown(md);

// Preserve authored, non-markdown metadata (tier / archetypes) from the prior
// cv.json — cv.md cannot carry it, so re-parsing alone would wipe it.
let prev = null;
try {
  prev = JSON.parse(await readFile(outPath, "utf-8"));
} catch {
  /* no prior cv.json (first migration) — nothing to preserve */
}
mergeAuthoredMetadata(json, prev);

const bulletCount = json.work.reduce(
  (a, w) =>
    a +
    (w.highlights?.length || 0) +
    (w.subEntries || []).reduce((b, s) => b + (s.highlights?.length || 0), 0),
  0,
);

if (printOnly) {
  console.log(JSON.stringify(json, null, 2));
} else {
  await writeFile(outPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  console.log(`✅ ${outPath}`);
}
console.log(
  `📊 ${json.work.length} roles, ${bulletCount} bullets, ` +
    `${json.skills_inventory.length} competencies, ` +
    `${Object.keys(json.evidence_refs).length} evidence_refs, ` +
    `${json.education.length} education`,
);
