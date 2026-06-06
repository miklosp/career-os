/**
 * cv-schema.mjs — shared parse / serialize / id logic for the JSON Resume master.
 *
 * One source of truth for the cv.md <-> cv.json relationship so the migration
 * (cv-md-to-json), the derived view + id-annotated source (cv-json-to-md), the
 * generator, and the validator all agree on structure and IDs.
 *
 * config/cv.json is a JSON Resume v1.0.0 *superset*. We render it ourselves
 * (JSON Resume themes are deliberately unused), so we extend freely:
 *
 *   {
 *     "basics":   { "name", "contactLine", "summary" },
 *     "skills_inventory": [ "Product Strategy", ... ],   // verbatim Core Competencies
 *     "languages_line":   "English (fluent), ...",        // raw, round-trips as-is
 *     "evidence_refs":    { "<skill>": ["<bulletId>", ...] }, // deterministic overlap map
 *     "work": [
 *       {
 *         "headingRaw": "Fractional CPO/CDO - Product Leaps AB",
 *         "position":   "Fractional CPO/CDO",
 *         "company":    "Product Leaps AB",
 *         "slug":       "product-leaps-ab",          // stable id namespace
 *         "dateRange":  "May 2023 – Present",          // optional
 *         "metaRaw":    "Consultancy - Remote ...",    // optional
 *         "description":"Product and design ...",      // optional (::: description :::)
 *         "highlights": [ { "id": "product-leaps-ab-b1", "text": "...",
 *                           "tier": "core",            // optional, JSON-only
 *                           "archetypes": ["product"] } ], // optional, JSON-only
 *         "subEntries": [
 *           { "headingRaw": "**Botkube** - AI-powered ... , Seed",
 *             "slug": "botkube",
 *             "highlights": [ { "id": "product-leaps-ab-botkube-b1", "text": "..." } ] }
 *         ]
 *       }
 *     ],
 *     "education": [ { "institution": "...", "description": "..." } ]
 *   }
 *
 * IDs are persisted in cv.json (assigned once at migration, never recomputed by
 * index afterwards) so they stay stable across later edits. The serializer is
 * the canonical formatter: cv.md is whatever serializeCvJson() emits. The
 * migration's contract is *no semantic loss*, not byte-identity (canonical
 * whitespace is intended normalization, same class as ATS unicode stripping).
 *
 * Authored highlight metadata — `tier` ("core" | "default" | "depth") and
 * `archetypes` (string[]; empty/absent = universal) — is JSON-only: it never
 * renders into cv.md (same class as skills_inventory / evidence_refs). Unlike
 * evidence_refs (recomputed deterministically), tier/archetypes are *authored*
 * and cannot be regenerated, so cv-md-to-json must merge them back from the
 * prior cv.json by stable bullet id (see mergeAuthoredMetadata). The projector
 * (lib/cv-project.mjs) reads these to emit length-bounded, archetype-scoped
 * deterministic CV variants.
 */

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SECTION_RE = /^##\s+(.+?)\s*$/;
const ROLE_RE = /^###\s+(.+?)\s*$/;
const DESC_OPEN_RE = /^:::\s*description\s*$/;
const DESC_CLOSE_RE = /^:::\s*$/;
const SUBHEAD_RE = /^\*\*(.+?)\*\*(.*)$/; // **Name** - rest
const BULLET_RE = /^-\s+(.+?)\s*$/;

/** Split a "### Position - Company" heading on the first " - ". */
function splitHeading(h) {
  const i = h.indexOf(" - ");
  if (i === -1) return { position: h.trim(), company: h.trim() };
  return { position: h.slice(0, i).trim(), company: h.slice(i + 3).trim() };
}

/**
 * Parse the canonical cv.md into the JSON Resume superset.
 * Tolerant of optional dateRange / metaRaw / description and the three bullet
 * container shapes (direct bullets, client sub-entries, dated sub-roles).
 */
export function parseCvMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = {
    basics: { name: "", contactLine: "", summary: "" },
    skills_inventory: [],
    languages_line: "",
    evidence_refs: {},
    work: [],
    education: [],
  };

  let i = 0;
  // H1 name
  while (i < lines.length && !lines[i].startsWith("# ")) i++;
  if (i < lines.length) out.basics.name = lines[i].replace(/^#\s+/, "").trim();
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && !lines[i].startsWith("#"))
    out.basics.contactLine = lines[i].trim();

  let section = null;
  const workSlugs = new Set();

  const peekParagraph = (start) => {
    let j = start;
    while (j < lines.length && lines[j].trim() === "") j++;
    const buf = [];
    while (j < lines.length && lines[j].trim() !== "" && !lines[j].startsWith("#") && !lines[j].startsWith(":::")) {
      buf.push(lines[j].trim());
      j++;
    }
    return { text: buf.join(" "), next: j };
  };

  const readDescription = (start) => {
    let j = start;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length || !DESC_OPEN_RE.test(lines[j].trim())) return null;
    j++;
    const buf = [];
    while (j < lines.length && !DESC_CLOSE_RE.test(lines[j].trim())) {
      buf.push(lines[j].trim());
      j++;
    }
    j++; // consume closing :::
    return { text: buf.join(" ").trim(), next: j };
  };

  while (i < lines.length) {
    const line = lines[i];
    const secM = line.match(SECTION_RE);
    if (secM) {
      section = secM[1].toLowerCase();
      i++;
      if (section === "summary") {
        const p = peekParagraph(i);
        out.basics.summary = p.text;
        i = p.next;
      } else if (section === "core competencies") {
        const p = peekParagraph(i);
        // First paragraph = competencies CSV; a following **Languages:** line.
        out.skills_inventory = p.text
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i = p.next;
        while (i < lines.length && lines[i].trim() === "") i++;
        const lm = i < lines.length && lines[i].match(/^\*\*Languages:\*\*\s*(.+?)\s*$/);
        if (lm) {
          out.languages_line = lm[1].trim();
          i++;
        }
      }
      continue;
    }

    const roleM = line.match(ROLE_RE);
    if (roleM && section === "experience") {
      const headingRaw = roleM[1].trim();
      const { position, company } = splitHeading(headingRaw);
      let base = slugify(company) || slugify(position);
      let slug = base;
      let n = 2;
      while (workSlugs.has(slug)) slug = `${base}-${n++}`;
      workSlugs.add(slug);
      const entry = { headingRaw, position, company, slug, highlights: [], subEntries: [] };
      i++;
      // Pre-body: lone lines (blank-separated) before description/bullets/subs.
      // First date-looking line -> dateRange; the next non-date line -> metaRaw.
      const looksDate = (t) =>
        /\b(19|20)\d{2}\b/.test(t) && /[–—-]|Present/.test(t) && t.length < 50;
      while (i < lines.length) {
        while (i < lines.length && lines[i].trim() === "") i++;
        if (i >= lines.length) break;
        const t = lines[i].trim();
        if (
          DESC_OPEN_RE.test(t) || BULLET_RE.test(t) || SUBHEAD_RE.test(t) ||
          t.startsWith("#")
        )
          break;
        if (!entry.dateRange && looksDate(t)) entry.dateRange = t;
        else if (!entry.metaRaw) entry.metaRaw = t;
        else break;
        i++;
      }
      const d = readDescription(i);
      if (d) {
        entry.description = d.text;
        i = d.next;
      }
      // Body: bullets and/or sub-entries until next ### or ##.
      let bIdx = 1;
      let cur = entry; // where bullets land (entry or a subEntry)
      while (i < lines.length && !ROLE_RE.test(lines[i]) && !SECTION_RE.test(lines[i])) {
        const raw = lines[i];
        if (raw.trim() === "") { i++; continue; }
        const sub = raw.match(SUBHEAD_RE);
        const bul = raw.match(BULLET_RE);
        if (sub && !bul) {
          const subHeadingRaw = raw.trim();
          const nameOnly = sub[1].trim();
          let sb = `${slug}-${slugify(nameOnly)}`;
          const se = { headingRaw: subHeadingRaw, slug: sb, highlights: [] };
          entry.subEntries.push(se);
          cur = se;
          bIdx = 1;
          i++;
          continue;
        }
        if (bul) {
          const idBase = cur === entry ? slug : `${slug}-${slugify(cur.headingRaw.match(SUBHEAD_RE)?.[1] || "x")}`;
          cur.highlights.push({ id: `${idBase}-b${bIdx++}`, text: bul[1].trim() });
          i++;
          continue;
        }
        i++; // skip anything unexpected
      }
      if (entry.subEntries.length === 0) delete entry.subEntries;
      out.work.push(entry);
      continue;
    }

    const roleEdu = line.match(ROLE_RE);
    if (roleEdu && section === "education") {
      const institution = roleEdu[1].trim();
      i++;
      const ed = { institution };
      const d = readDescription(i);
      if (d) {
        ed.description = d.text;
        i = d.next;
      }
      out.education.push(ed);
      continue;
    }

    i++;
  }

  out.evidence_refs = buildEvidenceRefs(out);
  return out;
}

/** Deterministic skill -> [bulletId] map by content-word overlap (zero-token). */
export function buildEvidenceRefs(json) {
  const refs = {};
  const norm = (s) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const allBullets = [];
  for (const w of json.work || []) {
    for (const h of w.highlights || []) allBullets.push(h);
    for (const se of w.subEntries || []) for (const h of se.highlights || []) allBullets.push(h);
  }
  for (const skill of json.skills_inventory || []) {
    const terms = new Set(norm(skill));
    if (terms.size === 0) continue;
    const hits = [];
    for (const b of allBullets) {
      const words = new Set(norm(b.text));
      let overlap = 0;
      for (const t of terms) if (words.has(t)) overlap++;
      if (overlap / terms.size >= 0.6) hits.push(b.id);
    }
    if (hits.length) refs[skill] = hits;
  }
  return refs;
}

/** Collect every resolvable source id (cv.json bullet ids). */
export function collectSourceIds(json) {
  const ids = new Set();
  for (const w of json.work || []) {
    for (const h of w.highlights || []) ids.add(h.id);
    for (const se of w.subEntries || []) for (const h of se.highlights || []) ids.add(h.id);
  }
  return ids;
}

/** Yield every highlight object across work + subEntries (mutation-safe). */
export function eachHighlight(json) {
  const out = [];
  for (const w of json.work || []) {
    for (const h of w.highlights || []) out.push(h);
    for (const se of w.subEntries || []) for (const h of se.highlights || []) out.push(h);
  }
  return out;
}

/**
 * Re-attach authored, non-markdown highlight metadata (tier, archetypes) from a
 * prior cv.json onto a freshly-parsed one, keyed by stable bullet id. cv.md is
 * a lossy view that carries neither field, so without this every `cv-migrate`
 * (cv.md -> cv.json) would silently wipe authored prioritization. Bullet ids
 * are deterministic from structure, so an unchanged cv.md re-parses to the same
 * ids and the merge is exact; bullets whose id no longer exists are dropped
 * (their text changed enough to warrant re-tiering anyway).
 */
export function mergeAuthoredMetadata(parsed, prev) {
  if (!prev) return parsed;
  const byId = new Map();
  for (const h of eachHighlight(prev)) byId.set(h.id, h);
  for (const h of eachHighlight(parsed)) {
    const p = byId.get(h.id);
    if (!p) continue;
    if (p.tier != null) h.tier = p.tier;
    if (Array.isArray(p.archetypes)) h.archetypes = p.archetypes;
  }
  return parsed;
}

/**
 * Identity projection shared by the derived-view renderer and the projector:
 * name + contact line rebuilt from config/profile.md frontmatter. `loadYaml`
 * is injected so this module stays dependency-free.
 */
export function identityFromProfile(profileRaw, loadYaml) {
  const fm = profileRaw.match(/^---\s*\n([\s\S]*?)\n---/);
  const c = (loadYaml(fm ? fm[1] : profileRaw) || {}).candidate || {};
  const parts = [];
  if (c.portfolio_url)
    parts.push(`[${c.portfolio_url.replace(/^https?:\/\//, "")}](${c.portfolio_url})`);
  if (c.email) parts.push(`[${c.email}](mailto:${c.email})`);
  if (c.phone) parts.push(`[${c.phone}](tel:${c.phone.replace(/\s+/g, "")})`);
  if (c.linkedin)
    parts.push(
      `[${c.linkedin}](${c.linkedin.startsWith("http") ? c.linkedin : `https://${c.linkedin}`})`,
    );
  if (c.location) parts.push(c.location);
  return { name: c.full_name || "", contactLine: parts.join(" / ") };
}

/**
 * Canonical cv.md serializer.
 * @param {object} json
 * @param {object} [opts]
 * @param {string} [opts.contactLine] override identity contact (from profile.md)
 * @param {string} [opts.name] override name (from profile.md)
 * @param {boolean} [opts.annotateIds] append `[id]` after each bullet (for the
 *        generator/validator/eval source view; never for the human cv.md)
 */
export function serializeCvJson(json, opts = {}) {
  const out = [];
  const name = opts.name || json.basics?.name || "";
  const contact = opts.contactLine || json.basics?.contactLine || "";
  out.push(`# ${name}`, "");
  if (contact) out.push(contact, "");
  if (json.basics?.summary) out.push("## Summary", "", json.basics.summary, "");
  if (json.skills_inventory?.length) {
    out.push("## Core Competencies", "", json.skills_inventory.join(", "), "");
    if (json.languages_line) out.push(`**Languages:** ${json.languages_line}`, "");
  }
  const bullet = (h) => (opts.annotateIds ? `- ${h.text} [${h.id}]` : `- ${h.text}`);
  if (json.work?.length) {
    out.push("## Experience", "");
    for (const w of json.work) {
      out.push(`### ${w.headingRaw}`, "");
      if (w.dateRange) out.push(w.dateRange, "");
      if (w.metaRaw) out.push(w.metaRaw, "");
      if (w.description) out.push("::: description", w.description, ":::", "");
      for (const h of w.highlights || []) out.push(bullet(h));
      if ((w.highlights || []).length) out.push("");
      for (const se of w.subEntries || []) {
        out.push(se.headingRaw, "");
        for (const h of se.highlights || []) out.push(bullet(h));
        if ((se.highlights || []).length) out.push("");
      }
    }
  }
  if (json.education?.length) {
    out.push("## Education", "");
    for (const e of json.education) {
      out.push(`### ${e.institution}`, "");
      if (e.description) out.push("::: description", e.description, ":::", "");
    }
  }
  // collapse 3+ blank lines, ensure single trailing newline
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "") + "\n";
}
