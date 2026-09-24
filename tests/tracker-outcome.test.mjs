import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mergeOutcome } from "../lib/dedup-tracker.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HEADER =
  "# Applications Tracker\n\n" +
  "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | Applied Date | Channel | Furthest Stage | Rejection Reason |\n" +
  "|---|------|---------|------|-------|--------|-----|--------|-------|--------------|---------|----------------|------------------|\n";

// Seed a scratch user-data dir (data/applications.md); scripts run from the
// repo and resolve it via CAREER_OPS_USER_DIR (lib/paths.mjs).
function scratchUser(rows) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tracker-outcome-")));
  mkdirSync(join(dir, "data/tracker-additions"), { recursive: true });
  writeFileSync(join(dir, "data/applications.md"), HEADER + rows.join("\n") + "\n");
  return dir;
}
const run = (dir, script, args = []) =>
  execFileSync("node", [join(REPO, script), ...args], {
    stdio: "pipe",
    env: { ...process.env, CAREER_OPS_USER_DIR: dir },
  });
const row = (dir, num) =>
  readFileSync(join(dir, "data/applications.md"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`| ${num} |`));
const cells = (line) => line.split("|").slice(1, -1).map((c) => c.trim());

test("mergeOutcome keeps non-empty values and the furthest stage", () => {
  const keeper = { appliedDate: "", channel: "cold-ats", furthestStage: "screen", rejectionReason: "" };
  const merged = mergeOutcome(keeper, [
    { appliedDate: "2026-06-02", channel: "referral", furthestStage: "panel", rejectionReason: "" },
    { appliedDate: "2026-06-05", channel: "", furthestStage: "none", rejectionReason: "role pulled" },
  ]);
  assert.deepEqual(merged, {
    appliedDate: "2026-06-02",
    channel: "cold-ats",
    furthestStage: "panel",
    rejectionReason: "role pulled",
  });
});

test("dedup-tracker carries a removed duplicate's outcome onto the keeper", () => {
  const dir = scratchUser([
    "| 10 | 2026-06-01 | Acme | Senior Product Manager Platform Growth | 4.5/5 | Evaluated | ❌ |  | keeper |  |  |  |  |",
    "| 11 | 2026-05-01 | Acme | Senior Product Manager Platform Growth | 4.0/5 | Rejected | ❌ |  | dup | 2026-05-02 | referral | panel | no headcount |",
  ]);
  run(dir, "lib/dedup-tracker.mjs");
  assert.equal(row(dir, 11), undefined);
  assert.deepEqual(cells(row(dir, 10)).slice(9), ["2026-05-02", "referral", "panel", "no headcount"]);
});

test("merge-tracker promotion preserves the outcome columns", () => {
  const dir = scratchUser([
    "| 20 | 2026-06-01 | Acme | Product Manager Payments Platform | 3.0/5 | Evaluated | ❌ |  | old | 2026-06-03 | recruiter | screen |  |",
  ]);
  writeFileSync(
    join(dir, "data/tracker-additions/020-acme.tsv"),
    "20\t2026-06-10\tAcme\tProduct Manager Payments Platform\tEvaluated\t4.2/5\t❌\t[020](data/reports/020-acme-2026-06-10.md)\tre-eval\n",
  );
  writeFileSync(
    join(dir, "data/tracker-additions/021-beta.tsv"),
    "21\t2026-06-10\tBeta\tHead of Product\tEvaluated\t4.0/5\t❌\t[021](data/reports/021-beta-2026-06-10.md)\tnew\n",
  );
  run(dir, "merge-tracker.mjs");
  const updated = cells(row(dir, 20));
  assert.equal(updated[4], "4.2/5");
  assert.deepEqual(updated.slice(9), ["2026-06-03", "recruiter", "screen", ""]);
  assert.equal(cells(row(dir, 21)).length, 13);
});

test("normalize-statuses preserves the outcome columns", () => {
  const dir = scratchUser([
    "| 30 | 2026-06-01 | Acme | PM | 4.0/5 | **Rechazada** | ❌ |  | n | 2026-06-02 | cold-ats | hm | ghosted after HM |",
  ]);
  run(dir, "lib/normalize-statuses.mjs");
  const c = cells(row(dir, 30));
  assert.equal(c[5], "Rejected");
  assert.deepEqual(c.slice(9), ["2026-06-02", "cold-ats", "hm", "ghosted after HM"]);
});

test("location-gate SKIP rewrites Status/Notes only and strips pipes from evidence", () => {
  const dir = scratchUser([
    "| 400 | 2026-06-01 | Acme | PM |  | Fetched | ❌ |  |  |  |  |  |  |",
  ]);
  mkdirSync(join(dir, "config"));
  writeFileSync(
    join(dir, "config/profile.md"),
    "---\nlocation_policy:\n  home_country: \"Sweden\"\n  skip_on:\n    - hybrid_outside_home_country\n---\n",
  );
  mkdirSync(join(dir, "data/jds"));
  writeFileSync(
    join(dir, "data/jds/400-acme.md"),
    "# Acme — PM\n\n**Location:** London | Paris, France\n**Remote scope:** hybrid:3d\n\n## About\n",
  );
  try {
    run(dir, "lib/location-gate.mjs", ["400"]);
  } catch (e) {
    assert.equal(e.status, 10); // SKIP exit code
  }
  const c = cells(row(dir, 400));
  assert.equal(c.length, 13);
  assert.equal(c[5], "Skipped-Location");
  assert.equal(c[8], 'hybrid_outside_home_country: "London / Paris, France"');
});
