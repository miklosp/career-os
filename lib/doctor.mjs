#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-ops
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_DIR, USER_DIR, displayPath } from './paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
// Display prefix for user-data paths (user/ unless CAREER_OPS_USER_DIR moves it).
const U = displayPath(USER_DIR);

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 18) {
    return { pass: true, label: `Node.js >= 18 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 18 (found v${process.versions.node})`,
    fix: 'Install Node.js 18 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'Dependencies installed' };
  }
  return {
    pass: false,
    label: 'Dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (existsSync(execPath)) {
      return { pass: true, label: 'Playwright chromium installed' };
    }
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  }
}

function checkUserDir() {
  if (existsSync(join(USER_DIR, '.git'))) {
    return { pass: true, label: `${U}/ user-data repo found` };
  }
  return {
    pass: false,
    label: `${U}/ user-data repo not found`,
    fix: [
      'Existing data repo: git clone <private-data-remote> user',
      `Or, first run: mkdir -p ${U} && cp -R user-template/. ${U}/ && git -C ${U} init`,
    ],
  };
}

function checkCv() {
  const cvPath = join(CONFIG_DIR, 'cv.json');
  if (!existsSync(cvPath)) {
    return {
      pass: false,
      label: `${U}/config/cv.json not found`,
      fix: `Copy the starter from user-template/config/, or run /career-ops onboarding`,
    };
  }
  if (readFileSync(cvPath, 'utf-8').includes('"Your Name"')) {
    return {
      warn: true,
      label: `${U}/config/cv.json is still the template placeholder ("Your Name")`,
      fix: 'Run /career-ops onboarding to replace it with your CV',
    };
  }
  return { pass: true, label: `${U}/config/cv.json found` };
}

function checkProfile() {
  const profilePath = join(CONFIG_DIR, 'profile.md');
  if (!existsSync(profilePath)) {
    return {
      pass: false,
      label: `${U}/config/profile.md not found`,
      fix: [
        `Run: cp user-template/config/profile.md ${U}/config/profile.md`,
        'Then edit it with your details',
      ],
    };
  }
  const content = readFileSync(profilePath, 'utf-8');
  if (content.includes('"Jane Smith"') || content.includes('jane@example.com')) {
    return {
      warn: true,
      label: `${U}/config/profile.md still contains template placeholders ("Jane Smith" / "jane@example.com")`,
      fix: 'Replace the example values with your real name and email',
    };
  }
  return { pass: true, label: `${U}/config/profile.md found` };
}

function checkHardcodedMetrics() {
  const filesToCheck = [
    join(projectRoot, 'modes', '_eval.md'),
  ];
  // Matches things like "170+ hours", "90% self-service", "20 evals" — patterns that suggest a
  // metric got baked into a prompt template instead of being read from cv.md or story-bank.md.
  const metricPattern = /\b\d{2,4}\+?\s*(hours?|%|evals?|layers?|tests?|fields?|bases?)\b/i;
  const hits = [];
  for (const path of filesToCheck) {
    if (!existsSync(path)) continue;
    const rel = path.replace(projectRoot + '/', '');
    const lines = readFileSync(path, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (
        line.includes('NEVER hardcode') ||
        line.includes('hardcoded') ||
        line.startsWith('#') ||
        line.startsWith('<!--')
      ) return;
      const m = line.match(metricPattern);
      if (m) hits.push(`${rel}:${i + 1} → "${m[0]}"`);
    });
  }
  if (hits.length === 0) {
    return { pass: true, label: 'No hardcoded metrics in mode prompts' };
  }
  return {
    warn: true,
    label: `${hits.length} possible hardcoded metric${hits.length === 1 ? '' : 's'} in mode prompts`,
    fix: hits.concat(`Move metrics to ${U}/config/cv.md or ${U}/config/story-bank.md and reference them from there`),
  };
}

function checkPortals() {
  if (existsSync(join(CONFIG_DIR, 'portals.yml'))) {
    return { pass: true, label: `${U}/config/portals.yml found` };
  }
  return {
    pass: false,
    label: `${U}/config/portals.yml not found`,
    fix: [
      `Run: cp user-template/config/portals.yml ${U}/config/portals.yml`,
      'Then customize with your target companies',
    ],
  };
}

function checkFonts() {
  const fontsDir = join(projectRoot, 'style/fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      label: 'style/fonts/ directory not found',
      fix: 'The style/fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        label: 'style/fonts/ directory is empty',
        fix: 'The style/fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      label: 'style/fonts/ directory not readable',
      fix: 'Check permissions on the style/fonts/ directory',
    };
  }
  return { pass: true, label: 'Fonts directory ready' };
}

function checkAutoDir(name) {
  const dirPath = join(USER_DIR, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${U}/${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, label: `${U}/${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${U}/${name}/ directory could not be created`,
      fix: `Run: mkdir -p ${U}/${name}`,
    };
  }
}

async function main() {
  console.log('\ncareer-ops doctor');
  console.log('================\n');

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    await checkPlaywright(),
    checkUserDir(),
    checkCv(),
    checkProfile(),
    checkPortals(),
    checkFonts(),
    checkAutoDir('data'),
    checkAutoDir('data/jds'),
    checkAutoDir('data/reports'),
    checkAutoDir('output'),
    checkHardcodedMetrics(),
  ];

  let failures = 0;
  let warnings = 0;

  for (const result of checks) {
    if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
    } else if (result.warn) {
      warnings++;
      console.log(`${yellow('⚠')} ${result.label}`);
      const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    } else {
      failures++;
      console.log(`${red('✗')} ${result.label}`);
      const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found${warnings > 0 ? ` (+${warnings} warning${warnings === 1 ? '' : 's'})` : ''}. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`Result: All required checks passed, ${warnings} warning${warnings === 1 ? '' : 's'} to review.`);
    process.exit(0);
  } else {
    console.log('Result: All checks passed. You\'re ready to go! Run `claude` to start.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('doctor.mjs failed:', err.message);
  process.exit(1);
});
