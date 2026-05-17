/**
 * ban-list.mjs — the one shared "never spend on this company" predicate.
 *
 * The inverse of tracked_companies. Read from config/portals.yml →
 * `banned_companies`. Consulted at the earliest zero-cost point of every
 * ingestion path (fetch front door + all scanners) so a banned company
 * never costs a network call, an Apify credit, or an LLM token.
 *
 *   banned_companies:
 *     - name: Mercor
 *       match: [mercor.com, careers-page.com/mercor]
 *       enabled: true
 *
 * Each `match` term (plus `name` itself) is a case-insensitive substring
 * tested against BOTH the raw URL (covers host AND ATS slug) and the
 * parsed company name. `enabled: false` disables an entry without
 * deleting it. Parsed once per process.
 */

import { existsSync, readFileSync } from 'fs';
import yaml from 'js-yaml';

const DEFAULT_PATH = 'config/portals.yml';

let _cache = null;
let _cachePath = null;

/** Normalized ban entries: [{ name, terms: string[] }] (terms lowercased). */
export function loadBanList(path = DEFAULT_PATH) {
  if (_cache && _cachePath === path) return _cache;
  let entries = [];
  try {
    if (existsSync(path)) {
      const cfg = yaml.load(readFileSync(path, 'utf-8')) || {};
      entries = (cfg.banned_companies || [])
        .filter(e => e && e.enabled !== false)
        .map(e => {
          const terms = [
            ...(Array.isArray(e.match) ? e.match : []),
            e.name,
          ]
            .filter(Boolean)
            .map(t => String(t).trim().toLowerCase())
            .filter(Boolean);
          return { name: e.name || terms[0] || 'banned', terms };
        })
        .filter(e => e.terms.length > 0);
    }
  } catch {
    entries = [];
  }
  _cache = entries;
  _cachePath = path;
  return entries;
}

/**
 * Returns the matched ban-entry name (truthy) or null. Case-insensitive
 * substring of any term against the URL or the company.
 */
export function isBanned({ url = '', company = '' } = {}, path = DEFAULT_PATH) {
  const hay = `${url}\n${company}`.toLowerCase();
  for (const entry of loadBanList(path)) {
    if (entry.terms.some(t => hay.includes(t))) return entry.name;
  }
  return null;
}

/** Test seam — drop the cached parse. */
export function _resetBanListCache() {
  _cache = null;
  _cachePath = null;
}
