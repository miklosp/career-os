// paths.mjs — the single resolver for user-data locations.
//
// User data (config/, data/, output/, transcripts/) lives in its own git repo at
// `user/`, gitignored by this repo. Set CAREER_OPS_USER_DIR to point at a
// different checkout. Every script resolves user paths through this module —
// never join the repo root with 'config'/'data'/'output'/'transcripts'.
//
// Paths stored INSIDE user data (tracker report links `[NUM](data/reports/…)`,
// TSV link columns, trace/review JSON) are relative to USER_DIR, so the data
// repo is self-contained; resolve them with userPath(). Code comments that say
// `data/jds/…` etc. mean USER_DIR-relative.
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const USER_DIR = process.env.CAREER_OPS_USER_DIR
  ? resolve(process.env.CAREER_OPS_USER_DIR)
  : join(REPO_DIR, 'user');

export const CONFIG_DIR = join(USER_DIR, 'config');
export const DATA_DIR = join(USER_DIR, 'data');
export const OUTPUT_DIR = join(USER_DIR, 'output');
export const TRANSCRIPTS_DIR = join(USER_DIR, 'transcripts');

export const APPLICATIONS_FILE = join(DATA_DIR, 'applications.md');
export const JDS_DIR = join(DATA_DIR, 'jds');
export const REPORTS_DIR = join(DATA_DIR, 'reports');
export const TRACKER_ADDITIONS_DIR = join(DATA_DIR, 'tracker-additions');
export const SCAN_HISTORY_DB = join(DATA_DIR, 'scan-history.db');

/** Absolute path for a USER_DIR-relative path (e.g. a stored tracker link). */
export const userPath = (...rel) => join(USER_DIR, ...rel);

/** Path for messages and agent prompts: repo-relative inside the repo, else absolute. */
export const displayPath = (abs) => {
  const rel = relative(REPO_DIR, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
};
