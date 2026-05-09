#!/usr/bin/env node
// Extract Block A (CV Match) bullets from all reports with score >= 3.5.
// Output: JSON array, one entry per qualifying report.
// Usage: node gap-analysis.mjs [min-score] > gap-input.json

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIN_SCORE = parseFloat(process.argv[2] ?? '3.5');
const ROOT = new URL('.', import.meta.url).pathname;

function parseApplications() {
  const raw = readFileSync(join(ROOT, 'data/applications.md'), 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cols = line.split('|').slice(1, -1).map(s => s.trim());
    const [num, date, company, role, score, status] = cols;
    const m = score.match(/^([\d.]+)\/5/);
    if (!m) continue;
    const s = parseFloat(m[1]);
    if (s < MIN_SCORE) continue;
    rows.push({ num: parseInt(num, 10), date, company, role, score: s, status });
  }
  return rows;
}

function findReport(num) {
  const padded = String(num).padStart(3, '0');
  const matches = readdirSync(join(ROOT, 'reports')).filter(f => f.startsWith(padded + '-'));
  return matches[0] ?? null;
}

function extractBlockA(filePath) {
  const text = readFileSync(filePath, 'utf8');
  // Find ## A: ... up to next ## heading
  const m = text.match(/^#{2,3}\s*A:[^\n]*\n([\s\S]*?)(?=^#{2,3}\s)/m);
  if (!m) return [];
  const body = m[1];
  return body
    .split('\n')
    .filter(l => l.trim().startsWith('- '))
    .map(l => l.trim().replace(/^-\s+/, ''));
}

const apps = parseApplications();
const out = [];
for (const app of apps) {
  const fname = findReport(app.num);
  if (!fname) continue;
  const bullets = extractBlockA(join(ROOT, 'reports', fname));
  if (bullets.length === 0) continue;
  out.push({ ...app, file: fname, bullets });
}

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.stderr.write(`Extracted ${out.length} reports at score >= ${MIN_SCORE}\n`);
