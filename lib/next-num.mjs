// next-num.mjs — single source of truth for the sequential JD/report number.
//
// Scans every place a number might already be reserved:
//   - jds/NNN-*.md            (JD files written at fetch time)
//   - jds/NNN.reserved        (active reservations from concurrent agents)
//   - reports/NNN-*.md        (evaluation reports)
//   - data/applications.md    (tracker — column 1 or column 8 report link)
//   - data/tracker-additions/NNN*.tsv (pending TSV drops before merge)
//
// `nextNum()` atomically reserves a NUM by creating `jds/{NUM}.reserved`
// via O_EXCL. Parallel agents cannot grab the same number — if the
// exclusive create races and loses, the caller retries with the
// incremented value. Callers should invoke `releaseNum(NUM)` after
// writing the real `jds/{NUM}-{slug}.md`. Orphaned markers are harmless:
// they simply advance the counter.
//
// Usage:
//   import { nextNum, releaseNum, currentMax } from './lib/next-num.mjs';
//   const n = nextNum();               // "073" — reservation created
//   // ... write jds/073-foo-bar.md ...
//   releaseNum(n);                      // remove the marker

import {
  existsSync, readdirSync, readFileSync,
  openSync, closeSync, unlinkSync, mkdirSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CWD = resolve(__dirname, '..');

const LEADING_NUM = /^(\d{3,})/;
const REPORT_LINK = /\[(\d{3,})\]/;

function maxFromDir(dir) {
  if (!existsSync(dir)) return 0;
  let max = 0;
  for (const f of readdirSync(dir)) {
    const m = f.match(LEADING_NUM);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

function maxFromApplications(appsFile) {
  if (!existsSync(appsFile)) return 0;
  let max = 0;
  for (const line of readFileSync(appsFile, 'utf-8').split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cols = line.split('|').map(c => c.trim());
    const numCol = parseInt(cols[1], 10);
    if (Number.isFinite(numCol) && numCol > max) max = numCol;
    for (const c of cols) {
      const r = c.match(REPORT_LINK);
      if (r) {
        const n = parseInt(r[1], 10);
        if (n > max) max = n;
      }
    }
  }
  return max;
}

export function currentMax({ cwd = DEFAULT_CWD } = {}) {
  return Math.max(
    maxFromDir(join(cwd, 'jds')),
    maxFromDir(join(cwd, 'reports')),
    maxFromDir(join(cwd, 'data', 'tracker-additions')),
    maxFromApplications(join(cwd, 'data', 'applications.md')),
  );
}

export function nextNum({ cwd = DEFAULT_CWD, maxAttempts = 100 } = {}) {
  const jdsDir = join(cwd, 'jds');
  mkdirSync(jdsDir, { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const n = currentMax({ cwd }) + 1;
    const padded = String(n).padStart(3, '0');
    const reservation = join(jdsDir, `${padded}.reserved`);
    try {
      const fd = openSync(reservation, 'wx');
      closeSync(fd);
      return padded;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Lost the race. Loop — currentMax() will now see the new .reserved
      // file and return N+1.
    }
  }
  throw new Error(
    `next-num: failed to reserve a NUM after ${maxAttempts} attempts — ` +
    `check jds/ for stale .reserved files`,
  );
}

export function releaseNum(num, { cwd = DEFAULT_CWD } = {}) {
  const reservation = join(cwd, 'jds', `${num}.reserved`);
  try { unlinkSync(reservation); } catch { /* already gone — fine */ }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(nextNum() + '\n');
}
