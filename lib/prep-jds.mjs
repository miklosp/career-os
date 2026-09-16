#!/usr/bin/env node
// prep-jds.mjs — Phase-1 batch prep: fetch + deterministic gate. Zero tokens.
//
// Runs lib/fetch-jd.mjs over every URL, then lib/location-gate.mjs over every
// fetched NUM, and emits the eval queue as ONE JSON line. This is what makes
// batch eval agents network-free: by the time an agent spawns, every JD it
// scores is already on disk.
//
// Per-URL branching (fetch-jd status → bucket):
//   ok                       → gate
//   expired                  → expired  (JD + row kept as trail; never scored)
//   exists, appStatus Fetched→ evaluated when a data/reports/{num}-*.md already
//                              exists (scored, awaiting user merge-tracker);
//                              otherwise gate (re-run completes the pending row)
//   exists, appStatus null   → deferred (orphaned JD — solo agent re-registers)
//   exists, terminal state   → done     (already handled; silent)
//   banned                   → banned   (logged by fetch-jd; no row, no JD)
//   unknown-host | error     → deferred (solo agent w/ modes/_fetch.md fallback)
//
// Gate exit code → bucket: 0 ready(gate:"allow") · 10 skipped (row already
// updated to Skipped-Location) · 20 ready(gate:"needs-llm") · other → deferred.
//
// stdout: one JSON line —
//   { ready:[{num,path,gate}], skipped:[{num}], expired:[{num}],
//     evaluated:[{num}], deferred:[{url,status,reason?}], done:<n>, banned:<n> }
// stderr: one progress line per URL.
//
// Usage: node lib/prep-jds.mjs <url> [<url> ...]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const urls = [...new Set(process.argv.slice(2))];
if (urls.length === 0) {
  console.error("usage: node lib/prep-jds.mjs <url> [<url> ...]");
  process.exit(1);
}

const out = { ready: [], skipped: [], expired: [], evaluated: [], deferred: [], done: 0, banned: 0 };
const reportsDir = join(root, "data/reports");
const reportFiles = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
const hasReport = (num) => reportFiles.some((f) => f.startsWith(`${num}-`));
const seenNums = new Set();
const log = (i, msg) => console.error(`[prep-jds] (${i + 1}/${urls.length}) ${msg}`);

function runNode(script, args) {
  return spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root, encoding: "utf8",
  });
}

function gate(i, num, path) {
  if (seenNums.has(num)) return log(i, `#${num} already queued this run`);
  seenNums.add(num);
  const res = runNode("lib/location-gate.mjs", [String(num)]);
  if (res.status === 0) {
    out.ready.push({ num, path, gate: "allow" });
    log(i, `#${num} gate: allow`);
  } else if (res.status === 10) {
    out.skipped.push({ num });
    log(i, `#${num} gate: SKIP (Skipped-Location row written)`);
  } else if (res.status === 20) {
    out.ready.push({ num, path, gate: "needs-llm" });
    log(i, `#${num} gate: needs-llm`);
  } else {
    out.deferred.push({ url: `#${num}`, status: "gate-error", reason: (res.stderr || "").trim().slice(-200) });
    log(i, `#${num} gate: ERROR (exit ${res.status})`);
  }
}

urls.forEach((url, i) => {
  const res = runNode("lib/fetch-jd.mjs", [url]);
  const jsonLine = (res.stdout || "").trim().split("\n").filter(Boolean).at(-1);
  let fetched;
  try {
    fetched = JSON.parse(jsonLine);
  } catch {
    out.deferred.push({ url, status: "error", reason: "fetch-jd emitted no JSON" });
    return log(i, `ERROR no JSON from fetch-jd: ${url}`);
  }
  switch (fetched.status) {
    case "ok":
      log(i, `fetched #${fetched.num}`);
      return gate(i, fetched.num, fetched.path);
    case "expired":
      out.expired.push({ num: fetched.num });
      return log(i, `#${fetched.num} expired (trail kept, not scored)`);
    case "exists":
      if (fetched.appStatus === "Fetched") {
        if (hasReport(fetched.num)) {
          out.evaluated.push({ num: fetched.num });
          return log(i, `#${fetched.num} already evaluated (report on disk — run merge-tracker)`);
        }
        log(i, `exists #${fetched.num} (Fetched)`);
        return gate(i, fetched.num, fetched.path);
      }
      if (fetched.appStatus == null) {
        out.deferred.push({ url, status: "orphan", reason: `JD #${fetched.num} has no applications.md row` });
        return log(i, `#${fetched.num} orphaned JD → deferred`);
      }
      out.done += 1;
      return log(i, `#${fetched.num} already ${fetched.appStatus}`);
    case "banned":
      out.banned += 1;
      return log(i, `banned: ${fetched.company}`);
    default: // unknown-host | error
      out.deferred.push({ url, status: fetched.status, reason: fetched.reason });
      return log(i, `${fetched.status} → deferred: ${url}`);
  }
});

console.log(JSON.stringify(out));
