import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, validateCv } from "../lib/cv-validate.mjs";

const ctx = buildContext({
  cvJson: {
    work: [
      {
        highlights: [
          { id: "acme-b1", text: "Took the product from 0 to $1M ARR" },
          { id: "acme-b2", text: "Released GA in 3 months" },
        ],
      },
    ],
    skills_inventory: ["Product Strategy"],
  },
  aliasesYml: { aliases: [] },
});

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

const cv = ({ summary = `Product lead who took a product to $1M ARR. ${words(20)}`, bullet = "- Took the product from 0 to $1M ARR [src: acme-b1]" } = {}) => `# Name

## Summary

${summary} [src: acme-b1, acme-b2]

## Core Competencies

Product Strategy

## Experience

### Acme

${bullet}
`;

const rules = (res) => res.hard.map((f) => `${f.rule}: ${f.reason}`);

test("compliant CV passes (composite src on Summary is allowed)", () => {
  const res = validateCv(cv(), ctx);
  assert.deepEqual(rules(res), []);
  assert.equal(res.passed, true);
});

test("25-word bullet passes, 26-word bullet fails", () => {
  const ok = validateCv(cv({ bullet: `- Took the product to $1M ARR ${words(19)} [src: acme-b1]` }), ctx);
  assert.equal(ok.hard.filter((f) => f.rule === "L").length, 0);
  const bad = validateCv(cv({ bullet: `- Took the product to $1M ARR ${words(20)} [src: acme-b1]` }), ctx);
  assert.equal(bad.passed, false);
  assert.match(rules(bad).join("\n"), /L: bullet is 26 words/);
});

test("[src:] tags and bare punctuation are not counted as words", () => {
  const res = validateCv(cv({ bullet: `- Took the product to $1M ARR — ${words(19)} [src: acme-b1]` }), ctx);
  assert.equal(res.hard.filter((f) => f.rule === "L").length, 0);
});

test("bullet citing two ids fails", () => {
  const res = validateCv(cv({ bullet: "- Took the product to $1M ARR and released GA in 3 months [src: acme-b1, acme-b2]" }), ctx);
  assert.equal(res.passed, false);
  assert.match(rules(res).join("\n"), /A: bullet cites 2 ids/);
});

test("85-word Summary passes, 86-word Summary fails", () => {
  const ok = validateCv(cv({ summary: words(85) }), ctx);
  assert.equal(ok.hard.filter((f) => f.rule === "L").length, 0);
  const bad = validateCv(cv({ summary: words(86) }), ctx);
  assert.equal(bad.passed, false);
  assert.match(rules(bad).join("\n"), /L: Summary is 86 words/);
});
