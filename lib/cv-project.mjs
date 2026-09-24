#!/usr/bin/env node
/**
 * cv-project.mjs — deterministic, zero-token projection of config/cv.json into a
 * length-bounded, archetype-scoped CV variant. No LLM, no validator: the output
 * is a strict subset of the canonical master, so it is source-true by
 * construction. This is the safe path for unsupervised artifacts (the generic
 * CV sent to recruiters / posted publicly / mirrored to LinkedIn).
 *
 * Selection authority is the authored per-bullet metadata in cv.json:
 *   tier        "core"    always included, every variant (the CV's spine)
 *               "default" included unless trimmed by --budget or --tier
 *               "depth"   long-tail; only with --tier depth (or JD generation)
 *   archetypes  []/absent  universal — kept for any --archetype
 *               ["product"|"ai"|"design", ...]  kept only when --archetype
 *                          is unset or listed here
 *
 * --budget never drops `core` (contractually always-in); it trims `default`
 * then `depth`, lowest-priority last, preserving original bullet order. If
 * `core` alone exceeds the budget it is still emitted in full (with a warning).
 *
 * Usage:
 *   node lib/cv-project.mjs                                  # all, tier<=default, markdown
 *   node lib/cv-project.mjs --archetype design --budget 18   # design CV, max 18 bullets
 *   node lib/cv-project.mjs --tier core                      # tightest spine only
 *   node lib/cv-project.mjs --archetype ai --json            # filtered cv.json to stdout
 *   node lib/cv-project.mjs --archetype product --out user/output/cv-product.md
 *
 * Flags:
 *   --archetype <product|ai|design>   scope (default: all)
 *   --tier <core|default|depth>       deepest tier to include (default: default)
 *   --budget <N>                      max total bullets (default: unbounded)
 *   --json                            emit filtered cv.json (default: markdown)
 *   --out <path>                      write instead of stdout
 */
import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { serializeCvJson, identityFromProfile } from "./cv-schema.mjs";
import { CONFIG_DIR } from "./paths.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const ARCHETYPE = opt("--archetype", null);
const MAX_TIER = opt("--tier", "default");
const BUDGET = parseInt(opt("--budget", "0"), 10) || 0;
const AS_JSON = args.includes("--json");
const OUT = opt("--out", null);

const TIER_RANK = { core: 1, default: 2, depth: 3 };
const VALID_ARCH = new Set(["product", "ai", "design"]);

if (!(MAX_TIER in TIER_RANK)) {
  console.error(`--tier must be one of core|default|depth (got "${MAX_TIER}")`);
  process.exit(2);
}
if (ARCHETYPE && !VALID_ARCH.has(ARCHETYPE)) {
  console.error(`--archetype must be one of product|ai|design (got "${ARCHETYPE}")`);
  process.exit(2);
}
const maxRank = TIER_RANK[MAX_TIER];

const json = JSON.parse(await readFile(resolve(CONFIG_DIR, "cv.json"), "utf-8"));

/** A highlight passes the tier + archetype filter (budget applied separately). */
function passes(h) {
  const tier = h.tier || "default";
  if ((TIER_RANK[tier] || 2) > maxRank) return false;
  if (!ARCHETYPE) return true;
  const a = h.archetypes;
  if (!Array.isArray(a) || a.length === 0) return true; // universal
  return a.includes(ARCHETYPE);
}

// Pass 1: which ids survive tier+archetype.
const surviving = [];
let order = 0;
for (const w of json.work || []) {
  for (const h of w.highlights || []) if (passes(h)) surviving.push({ h, order: order++ });
  for (const se of w.subEntries || [])
    for (const h of se.highlights || []) if (passes(h)) surviving.push({ h, order: order++ });
}

// Pass 2: apply budget. core is never trimmed; fill default then depth in
// original order until the budget is spent.
let keptIds;
if (BUDGET > 0 && surviving.length > BUDGET) {
  const core = surviving.filter((s) => (s.h.tier || "default") === "core");
  const rest = surviving
    .filter((s) => (s.h.tier || "default") !== "core")
    .sort(
      (a, b) =>
        TIER_RANK[a.h.tier || "default"] - TIER_RANK[b.h.tier || "default"] ||
        a.order - b.order,
    );
  if (core.length > BUDGET) {
    console.error(
      `⚠️  ${core.length} core bullets exceed --budget ${BUDGET}; emitting all core anyway.`,
    );
  }
  const room = Math.max(0, BUDGET - core.length);
  keptIds = new Set([...core, ...rest.slice(0, room)].map((s) => s.h.id));
} else {
  keptIds = new Set(surviving.map((s) => s.h.id));
}

// Pass 3: structurally rebuild, preserving original order; drop emptied
// subEntries and roles so the projection has no hollow headings.
const projected = { ...json };
projected.work = (json.work || [])
  .map((w) => {
    const nw = { ...w };
    nw.highlights = (w.highlights || []).filter((h) => keptIds.has(h.id));
    const subs = (w.subEntries || [])
      .map((se) => ({ ...se, highlights: (se.highlights || []).filter((h) => keptIds.has(h.id)) }))
      .filter((se) => se.highlights.length > 0);
    if (subs.length) nw.subEntries = subs;
    else delete nw.subEntries;
    return nw;
  })
  .filter((w) => (w.highlights || []).length > 0 || (w.subEntries || []).length > 0);

const kept = keptIds.size;
console.error(
  `📐 projection: ${kept}/${order} bullets` +
    ` · tier≤${MAX_TIER}` +
    (ARCHETYPE ? ` · archetype=${ARCHETYPE}` : " · all archetypes") +
    (BUDGET ? ` · budget=${BUDGET}` : "") +
    ` · ${projected.work.length} roles`,
);

let outStr;
if (AS_JSON) {
  outStr = JSON.stringify(projected, null, 2) + "\n";
} else {
  const profileRaw = await readFile(resolve(CONFIG_DIR, "profile.md"), "utf-8");
  const { load } = await import("js-yaml");
  outStr = serializeCvJson(projected, identityFromProfile(profileRaw, load));
}

if (OUT) {
  await writeFile(resolve(root, OUT), outStr, "utf-8");
  console.error(`✅ ${OUT}`);
} else {
  process.stdout.write(outStr);
}
