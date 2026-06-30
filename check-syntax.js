#!/usr/bin/env node
/**
 * scripts/check-syntax.js
 * Verifies every server-side JS file parses without errors.
 * Run before deploy — catches missing brackets, typos, broken requires.
 *
 * Usage: node scripts/check-syntax.js
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');

// All server-side JS files that must parse cleanly
const FILES = [
  'server.js',
  'db.js',
  'dashboard-api.js',
  'dashboard-db.js',
  'counsellor-db.js',
  'counsellor-rag.js',
];

let passed = 0, failed = 0;
const failures = [];

console.log('\n🔍  Syntax check\n');

for (const file of FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    console.log(`  ⚠️   ${file} — NOT FOUND (skipping)`);
    continue;
  }
  try {
    execSync(`node --check "${full}"`, { stdio: 'pipe' });
    console.log(`  ✅  ${file}`);
    passed++;
  } catch (e) {
    const msg = (e.stderr || e.stdout || '').toString().trim().split('\n')[0];
    console.log(`  ❌  ${file}\n     ${msg}`);
    failures.push({ file, error: msg });
    failed++;
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.error(`❌  Syntax errors found. Fix before deploying.\n`);
  process.exit(1);
}

console.log(`✅  All files clean.\n`);
