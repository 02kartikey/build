#!/usr/bin/env node
/**
 * check-syntax.js — run before every deploy (npm test).
 *
 * Finds every script itself, so a new file is checked without editing a list:
 *   • root *.js        parsed with `node --check`; every one that is a module
 *                      (no shebang, not server.js) is also require()d in a
 *                      child process, which catches a missing require or a
 *                      name used before it is defined at load time.
 *                      server.js and the CLI scripts (shebang) are parse-only,
 *                      since loading them starts the server or runs the tool.
 *   • js/**\/*.js       browser scripts. Files using import/export are parsed
 *                      as ES modules through an .mjs copy (independent of the
 *                      installed Node's module detection); the rest as
 *                      classic scripts.
 *   • cross-module     every `mod.fn` used on a local require() is exported
 *                      by that module (a missing one only fails at runtime).
 *   • *.html           every <script type="module" src> and <script src> that
 *                      points at a local file must exist.
 *
 * Usage: node check-syntax.js
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Works from the project root or from a scripts/ folder inside it.
const ROOT = fs.existsSync(path.join(__dirname, 'server.js')) ? __dirname : path.join(__dirname, '..');

const run = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe', env: { ...process.env, LOG_LEVEL: 'error' } });
const firstLine = (e) => (e.stderr || e.stdout || e.message || '').toString().trim().split('\n').find(Boolean) || 'failed';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(rel));
    else if (ent.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function checkModule(full) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-check-'));
  const copy = path.join(dir, path.basename(full, '.js') + '.mjs');
  try { fs.copyFileSync(full, copy); run(['--check', copy]); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const checks = [];
for (const f of fs.readdirSync(ROOT).filter(n => n.endsWith('.js')).sort()) {
  const cli = read(f).startsWith('#!') || f === 'server.js';
  checks.push({ file: f, fn: () => { run(['--check', f]); if (!cli) run(['-e', `require(${JSON.stringify(path.join(ROOT, f))})`]); } });
}
for (const f of walk('js').sort()) {
  const esm = /^\s*(import\s|export\s)/m.test(read(f));
  checks.push({ file: f, fn: () => (esm ? checkModule(path.join(ROOT, f)) : run(['--check', f])) });
}
/* Cross-module calls: every `mod.name` used on a local require() must be
   something that module exports. A call to a function another module lacks
   parses fine and only fails at runtime, on the request that reaches it. */
const serverFiles = fs.readdirSync(ROOT).filter(n => n.endsWith('.js'));
const exportsOf = (mod) => JSON.parse(run(['-e', `process.stdout.write(JSON.stringify(Object.keys(require(${JSON.stringify(path.join(ROOT, mod))}))))`]).toString());
for (const f of serverFiles.sort()) {
  // Comments removed, and file names ("counsellor-rag.js") are not member uses.
  const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  const uses = new Map();   // module file → Set of member names
  const note = (mod, name) => { if (/^(js|mjs|json|html|css)$/.test(name)) return; if (!uses.has(mod)) uses.set(mod, new Set()); uses.get(mod).add(name); };
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*'\.\/([\w.-]+?)(?:\.js)?'\s*\)\s*;/g)) {
    const [, v, mod] = m;
    for (const u of src.matchAll(new RegExp('(?<![\\w$.])' + v + '\\.(\\w+)', 'g'))) note(mod + '.js', u[1]);
  }
  for (const m of src.matchAll(/require\(\s*'\.\/([\w.-]+?)(?:\.js)?'\s*\)\.(\w+)/g)) note(m[1] + '.js', m[2]);
  for (const [mod, names] of uses) {
    if (!serverFiles.includes(mod) || read(mod).startsWith('#!') || mod === 'server.js') continue;
    checks.push({ file: `${f} → ${mod} (exports used)`, fn: () => {
      const have = new Set(exportsOf(mod));
      const missing = [...names].filter(n => !have.has(n));
      if (missing.length) throw new Error('not exported: ' + missing.join(', '));
    } });
  }
}

for (const h of fs.readdirSync(ROOT).filter(n => n.endsWith('.html')).sort()) {
  const srcs = [...read(h).matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\.?\/?[^":?#]+\.(?:js|css))(?:\?[^"]*)?"/g)].map(m => m[1]);
  checks.push({ file: h + ' (local script/style links)', fn: () => {
    const missing = srcs.filter(s => !/^https?:/.test(s) && !fs.existsSync(path.join(ROOT, s.replace(/^\.?\//, ''))));
    if (missing.length) throw new Error('missing: ' + missing.join(', '));
  } });
}

console.log('\nSyntax and load check\n');
let passed = 0;
const failures = [];
for (const { file, fn } of checks) {
  try { fn(); console.log(`  ok    ${file}`); passed++; }
  catch (e) { const error = firstLine(e); failures.push({ file, error }); console.log(`  FAIL  ${file}: ${error}`); }
}

console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.error('Fix the files above before deploying.\n');
  process.exit(1);
}
console.log('All files clean.\n');
