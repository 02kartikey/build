#!/usr/bin/env node
/**
 * check-syntax.js — run before every deploy (npm test).
 *
 * 1. Parses every server and dashboard script (`node --check`).
 * 2. Loads every server module (`require`) in a child process, which also
 *    catches what parsing cannot: a missing require, or a name used before it
 *    is defined at load time. server.js is parsed only, since loading it
 *    starts the server.
 *
 * A listed file that does not exist is a failure, not a skip.
 * Usage: node check-syntax.js
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Works from the project root or from a scripts/ folder inside it.
const ROOT = fs.existsSync(path.join(__dirname, 'server.js')) ? __dirname : path.join(__dirname, '..');

const SERVER_MODULES = [
  'db.js',
  'dashboard-api.js',
  'dashboard-db.js',
  'dashboard-assistant.js',
  'counsellor-db.js',
  'counsellor-rag.js',
  'pg-core.js',
  'match-utils.js',
];
const PARSE_ONLY = [
  'server.js',
  // Browser scripts loaded as classic <script> tags by the dashboards
  'js/dashboard-common.js',
  'js/dashboard-flow.js',
  'js/dashboard-insights.js',
  'js/school-registry.js',
];
// Browser scripts loaded with <script type="module">. They are parsed as ES
// modules through an .mjs copy, so the result does not depend on whether the
// installed Node version detects module syntax on its own.
const ES_MODULES = [
  'js/dashboard-report-pdf.js',
];

let passed = 0;
const failures = [];
const run = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe', env: { ...process.env, LOG_LEVEL: 'error' } });
function checkModule(full) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-check-'));
  const copy = path.join(dir, path.basename(full, '.js') + '.mjs');
  try { fs.copyFileSync(full, copy); run(['--check', copy]); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const firstLine = (e) => (e.stderr || e.stdout || e.message || '').toString().trim().split('\n').find(Boolean) || 'failed';

console.log('\nSyntax and load check\n');
for (const file of [...SERVER_MODULES, ...PARSE_ONLY, ...ES_MODULES]) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { failures.push({ file, error: 'file not found' }); console.log(`  FAIL  ${file}: file not found`); continue; }
  try {
    if (ES_MODULES.includes(file)) checkModule(full);
    else run(['--check', full]);
    if (SERVER_MODULES.includes(file)) run(['-e', `require(${JSON.stringify(full)})`]);
    console.log(`  ok    ${file}`);
    passed++;
  } catch (e) {
    const error = firstLine(e);
    failures.push({ file, error });
    console.log(`  FAIL  ${file}: ${error}`);
  }
}

console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.error('Fix the files above before deploying.\n');
  process.exit(1);
}
console.log('All files clean.\n');
