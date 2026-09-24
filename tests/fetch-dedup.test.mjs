import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HEADER =
  "# Applications Tracker\n\n" +
  "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | Applied Date | Channel | Furthest Stage | Rejection Reason |\n" +
  "|---|------|---------|------|-------|--------|-----|--------|-------|--------------|---------|----------------|------------------|\n";
// Unknown host on purpose: if dedup misses, fetch-jd stops at `unknown-host`
// instead of touching the network.
const STORED_URL = "https://careers.acme.test/jobs/product-manager-42";
const INPUT_URL = "http://www.careers.acme.test/jobs/product-manager-42/?utm_source=linkedin";

// The #3234 Encube shape: tracker row (terminal) + report with the URL header,
// JD file deleted, scan-history holding the URL as a plain `added` row in the
// pre-`num` schema.
function scratchUser({ num = "3234", rowNum = num, status = "Discarded" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fetch-dedup-")));
  mkdirSync(join(dir, "data/jds"), { recursive: true });
  mkdirSync(join(dir, "data/reports"), { recursive: true });
  writeFileSync(
    join(dir, "data/applications.md"),
    HEADER +
      `| ${rowNum} | 2026-09-04 | Acme | Product Manager | 3.4/5 | ${status} | ❌ | [${num}](data/reports/${num}-acme-2026-09-04.md) | n |  |  |  |  |\n`,
  );
  writeFileSync(
    join(dir, `data/reports/${num}-acme-2026-09-04.md`),
    `# Evaluation: Acme — Product Manager\n\n**URL:** ${STORED_URL}\n**Score:** 3.4/5\n`,
  );
  const db = new Database(join(dir, "data/scan-history.db"));
  db.exec(`CREATE TABLE offers (url TEXT PRIMARY KEY, first_seen TEXT NOT NULL, portal TEXT,
    title TEXT, company TEXT, status TEXT NOT NULL DEFAULT 'added')`);
  db.prepare("INSERT INTO offers VALUES (?, '2026-09-04', 'linkedin-jobspy', 'Product Manager', 'Acme', 'added')")
    .run(STORED_URL);
  db.close();
  return dir;
}
const run = (dir, script, args) =>
  execFileSync("node", [join(REPO, script), ...args], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CAREER_OPS_USER_DIR: dir },
  });

test("fetch-jd recognises a URL known only via report header + scan-history", () => {
  const dir = scratchUser();
  const before = readFileSync(join(dir, "data/applications.md"), "utf8");
  const out = JSON.parse(run(dir, "lib/fetch-jd.mjs", [INPUT_URL]).trim().split("\n").at(-1));
  assert.equal(out.status, "exists");
  assert.equal(out.num, "3234");
  assert.equal(out.appStatus, "Discarded");
  assert.deepEqual(readdirSync(join(dir, "data/jds")), []); // no JD, no .reserved marker
  assert.equal(readFileSync(join(dir, "data/applications.md"), "utf8"), before);
  // The pre-existing `added` row is now linked to its NUM; status untouched.
  const db = new Database(join(dir, "data/scan-history.db"), { readonly: true });
  assert.deepEqual({ ...db.prepare("SELECT num, status FROM offers WHERE url = ?").get(STORED_URL) },
    { num: "3234", status: "added" });
  db.close();
});

test("prep-jds treats the known terminal URL as done", () => {
  const dir = scratchUser();
  const out = JSON.parse(run(dir, "lib/prep-jds.mjs", [INPUT_URL]).trim());
  assert.equal(out.done, 1);
  assert.deepEqual([out.ready, out.deferred], [[], []]);
  assert.deepEqual(readdirSync(join(dir, "data/jds")), []);
});

test("tracker row is found for an unpadded # and for a re-eval report link", () => {
  for (const [opts, want] of [
    [{ num: "006", rowNum: "6", status: "Rejected" }, "Rejected"],
    [{ num: "960", rowNum: "317", status: "SKIP" }, "SKIP"],
  ]) {
    const out = JSON.parse(run(scratchUser(opts), "lib/fetch-jd.mjs", [INPUT_URL]).trim().split("\n").at(-1));
    assert.deepEqual([out.status, out.num, out.appStatus], ["exists", opts.num, want]);
  }
});

test("prep-jds: report but no tracker row is done; JD with no report and no row is an orphan", () => {
  const deduped = scratchUser();
  writeFileSync(join(deduped, "data/applications.md"), HEADER);
  const a = JSON.parse(run(deduped, "lib/prep-jds.mjs", [INPUT_URL]).trim());
  assert.deepEqual([a.done, a.ready, a.deferred], [1, [], []]);

  const orphan = scratchUser();
  writeFileSync(join(orphan, "data/applications.md"), HEADER);
  rmSync(join(orphan, "data/reports/3234-acme-2026-09-04.md"));
  writeFileSync(join(orphan, "data/jds/3234-acme-product-manager.md"), `# Acme — Product Manager\n\n**URL:** ${STORED_URL}\n`);
  const b = JSON.parse(run(orphan, "lib/prep-jds.mjs", [INPUT_URL]).trim());
  assert.equal(b.done, 0);
  assert.deepEqual(b.deferred.map((d) => d.status), ["orphan"]);
});
