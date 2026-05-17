// ── Shared ATS Unicode normalization ──────────────────────────────────────────
//
// Em-dashes, en-dashes, smart quotes, ellipses, zero-width chars and nbsp break
// Workday/Greenhouse/Lever resume parsers and are a strong AI-writing tell.
// Catch them deterministically at every point where generated or user-edited
// candidate-facing markdown is written to disk — never rely on the LLM to
// "remember" not to emit them.
//
// Consumers: lib/generate-cv-llm.mjs (post-generation), lib/cv-fact-check.mjs
// (after user-applied edits, before PDF regen). Add new write paths here too.

const RULES = [
  { key: "em-dash", re: /—/g, to: "-" },
  { key: "en-dash", re: /–/g, to: "-" },
  { key: "smart-double-quote", re: /[“”„‟]/g, to: '"' },
  { key: "smart-single-quote", re: /[‘’‚‛]/g, to: "'" },
  { key: "ellipsis", re: /…/g, to: "..." },
  { key: "zero-width", re: /[​‌‍⁠﻿]/g, to: "" },
  { key: "nbsp", re: / /g, to: " " },
];

/**
 * Normalize ATS-hostile Unicode to ASCII equivalents.
 * @param {string} input
 * @returns {{ text: string, replacements: Record<string, number>, total: number }}
 */
export function normalizeAtsText(input) {
  const replacements = {};
  let text = input;
  for (const { key, re, to } of RULES) {
    text = text.replace(re, () => {
      replacements[key] = (replacements[key] || 0) + 1;
      return to;
    });
  }
  const total = Object.values(replacements).reduce((a, b) => a + b, 0);
  return { text, replacements, total };
}

/** One-line "🧹 ATS normalization: …" summary, or null when nothing changed. */
export function normalizationSummary({ replacements, total }) {
  if (total === 0) return null;
  const breakdown = Object.entries(replacements)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `🧹 ATS normalization: ${total} replacements (${breakdown})`;
}
