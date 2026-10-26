import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HEADER =
  "# Applications Tracker\n\n" +
  "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | Applied Date | Channel | Furthest Stage | Rejection Reason |\n" +
  "|---|------|---------|------|-------|--------|-----|--------|-------|--------------|---------|----------------|------------------|\n";

// Scratch user dir with applications.md rows and report files keyed by name.
function scratchUser(rows, reports = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dedup-tracker-")));
  mkdirSync(join(dir, "data/reports"), { recursive: true });
  writeFileSync(join(dir, "data/applications.md"), HEADER + rows.join("\n") + "\n");
  for (const [name, body] of Object.entries(reports)) {
    writeFileSync(join(dir, "data/reports", name), body);
  }
  return dir;
}
const run = (dir) =>
  execFileSync("node", [join(REPO, "lib/dedup-tracker.mjs")], {
    stdio: "pipe",
    env: { ...process.env, CAREER_OPS_USER_DIR: dir },
  });
const row = (dir, num) =>
  readFileSync(join(dir, "data/applications.md"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`| ${num} |`));
const report = (url, extra = "") => `**Score:** 3.6/5\n**ID:** 1\n**URL:** ${url}\n**Summary:** x\n${extra}`;
const link = (num, name) => `[${num}](data/reports/${name})`;

test("rows whose reports share a posting URL are duplicates even with a generic title", () => {
  const dir = scratchUser(
    [
      `| 278 | 2026-05-05 | Flower | Senior Product Manager | 3.6/5 | Discarded | ❌ | ${link(278, "278-flower.md")} | a |  |  |  |  |`,
      `| 364 | 2026-05-06 | Flower | Senior Product Manager | 3.7/5 | Discarded | ❌ | ${link(364, "364-flower.md")} | b |  |  |  |  |`,
    ],
    {
      "278-flower.md": report("https://flower.teamtailor.com/jobs/7403218-senior-product-manager"),
      "364-flower.md": report("https://flower.teamtailor.com/jobs/7403218-senior-product-manager"),
    },
  );
  run(dir);
  assert.ok(row(dir, 364));
  assert.equal(row(dir, 278), undefined);
});

test("same generic title with different posting URLs stays separate", () => {
  const dir = scratchUser(
    [
      `| 1 | 2026-05-05 | Acme | Senior Product Manager | 3.6/5 | Evaluated | ❌ | ${link(1, "1-acme.md")} | a |  |  |  |  |`,
      `| 2 | 2026-08-06 | Acme | Senior Product Manager | 3.7/5 | Evaluated | ❌ | ${link(2, "2-acme.md")} | b |  |  |  |  |`,
    ],
    {
      "1-acme.md": report("https://acme.example/jobs/1"),
      "2-acme.md": report("https://acme.example/jobs/2"),
    },
  );
  run(dir);
  assert.ok(row(dir, 1));
  assert.ok(row(dir, 2));
});

test("the row whose report holds Section G is kept over a higher score", () => {
  const url = "https://flower.teamtailor.com/jobs/7403218-senior-product-manager";
  const dir = scratchUser(
    [
      `| 278 | 2026-05-05 | Flower | Senior Product Manager | 3.6/5 | Rejected | ❌ | ${link(278, "278-flower.md")} | a | 2026-04-17 | cold-ats | none | final rounds |`,
      `| 364 | 2026-05-06 | Flower | Senior Product Manager | 3.7/5 | Discarded | ❌ | ${link(364, "364-flower.md")} | b |  |  |  |  |`,
    ],
    {
      "278-flower.md": report(url, "\n## Section G — Submitted Answers\n\n### Q\n\nA\n"),
      "364-flower.md": report(url),
    },
  );
  run(dir);
  assert.equal(row(dir, 364), undefined);
  assert.match(row(dir, 278), /\| Rejected \|.*\| 2026-04-17 \| cold-ats \| none \| final rounds \|$/);
});

test("a rejected application is not demoted to Evaluated by a re-evaluated duplicate", () => {
  const url = "https://acme.example/jobs/7";
  const dir = scratchUser(
    [
      `| 5 | 2026-04-22 | Acme | Principal Product Manager | 4.3/5 | Rejected | ❌ | ${link(5, "5-acme.md")} | a | 2026-04-23 | cold-ats | screen |  |`,
      `| 6 | 2026-05-16 | Acme | Principal Product Manager | 3.9/5 | Evaluated | ❌ | ${link(6, "6-acme.md")} | b |  |  |  |  |`,
    ],
    { "5-acme.md": report(url), "6-acme.md": report(url) },
  );
  run(dir);
  assert.equal(row(dir, 6), undefined);
  assert.match(row(dir, 5), /\| Rejected \|/);
});
