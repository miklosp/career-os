import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCvMarkdown, serializeCvJson, mergeAuthoredMetadata } from "../lib/cv-schema.mjs";

const cvMd = (company) => `# Jane Doe

::: headline
Senior Product Manager | AI agents & developer tools
:::

[jane.dev](https://jane.dev) / Stockholm

## Summary

Product leader.

## Experience

### Head of UX - ${company}

Jan 2020 – Dec 2022

**Platform** - GitOps UI

- Shipped the GitOps dashboard
- Ran user research with platform teams

### PM - Acme

- Took the product to $1M ARR
`;

test("basics.label round-trips md -> json -> md", () => {
  const md = cvMd("Acme Corp");
  const json = parseCvMarkdown(md);
  assert.equal(json.basics.label, "Senior Product Manager | AI agents & developer tools");
  assert.deepEqual(Object.keys(json.basics), ["name", "label", "contactLine", "summary"]);
  assert.equal(json.basics.contactLine, "[jane.dev](https://jane.dev) / Stockholm");
  assert.equal(serializeCvJson(json), md);
});

test("no label: basics has no label key and no headline block", () => {
  const md = cvMd("Acme").replace(/::: headline\n.*\n:::\n\n/, "");
  const json = parseCvMarkdown(md);
  assert.deepEqual(Object.keys(json.basics), ["name", "contactLine", "summary"]);
  assert.doesNotMatch(serializeCvJson(json), /headline/);
});

test("bullet ids, slugs and tags survive a company rename", () => {
  const prev = parseCvMarkdown(cvMd("Acme Corp"));
  const sub = prev.work[0].subEntries[0];
  assert.equal(sub.highlights[0].id, "acme-corp-platform-b1");
  sub.highlights[0].tier = "core";
  sub.highlights[1].archetypes = ["design"];

  const next = mergeAuthoredMetadata(parseCvMarkdown(cvMd("AcmeCorp")), prev);
  assert.equal(next.work[0].company, "AcmeCorp");
  assert.equal(next.work[0].slug, "acme-corp");
  const nsub = next.work[0].subEntries[0];
  assert.equal(nsub.slug, "acme-corp-platform");
  assert.deepEqual(
    nsub.highlights.map((h) => [h.id, h.tier, h.archetypes]),
    [
      ["acme-corp-platform-b1", "core", undefined],
      ["acme-corp-platform-b2", undefined, ["design"]],
    ],
  );
});

test("ids with gaps are kept; edited and new bullets never steal an id", () => {
  const prev = parseCvMarkdown(cvMd("Acme Corp"));
  // Simulate an earlier deletion: ids b1, b3 (no b2).
  prev.work[0].subEntries[0].highlights[1].id = "acme-corp-platform-b3";

  const md = cvMd("Acme Corp")
    .replace("- Shipped the GitOps dashboard", "- Shipped the GitOps dashboard to GA")
    .replace("- Ran user research with platform teams", "- Ran user research with platform teams\n- Brand new bullet");
  const next = mergeAuthoredMetadata(parseCvMarkdown(md), prev);
  assert.deepEqual(
    next.work[0].subEntries[0].highlights.map((h) => h.id),
    ["acme-corp-platform-b1", "acme-corp-platform-b3", "acme-corp-platform-b2"],
  );
});

test("core_competencies renders in cv.md; annotated view and migration keep full inventory", () => {
  const json = parseCvMarkdown(cvMd("Acme"));
  json.skills_inventory = ["Product Strategy", "User Research", "Jira"];
  json.core_competencies = ["User Research", "Product Strategy"];

  const md = serializeCvJson(json);
  assert.match(md, /## Core Competencies\n\nUser Research, Product Strategy\n/);
  assert.match(serializeCvJson(json, { annotateIds: true }), /\n\nProduct Strategy, User Research, Jira\n/);

  // Round-trip: cv.md -> cv.json restores the inventory, keeps the short list.
  const next = mergeAuthoredMetadata(parseCvMarkdown(md.replace("Product Strategy\n", "Product Strategy, OKRs\n")), json);
  assert.deepEqual(next.core_competencies, ["User Research", "Product Strategy", "OKRs"]);
  assert.deepEqual(next.skills_inventory, ["Product Strategy", "User Research", "Jira", "OKRs"]);
  assert.equal(serializeCvJson(next).includes("Jira"), false);
});

test("sub-entry dateRange round-trips md -> json -> md", () => {
  const md = cvMd("Acme").replace(
    "**Platform** - GitOps UI\n\n",
    "**Platform** - GitOps UI\n\nAug 2023 – Aug 2024\n\n",
  );
  const json = parseCvMarkdown(md);
  assert.equal(json.work[0].dateRange, "Jan 2020 – Dec 2022");
  assert.equal(json.work[0].subEntries[0].dateRange, "Aug 2023 – Aug 2024");
  assert.equal(json.work[0].subEntries[0].highlights.length, 2);
  assert.equal(serializeCvJson(json), md);
});
