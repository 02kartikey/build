#!/usr/bin/env node
'use strict';
/* ============================================================================
   set-credentials.js — create/reset NuMind MAPS dashboard logins
   ----------------------------------------------------------------------------
   Why: the first-boot passwords are random and printed to the deploy log ONCE.
   If you missed the banner they are unrecoverable (scrypt-hashed). This script
   sets known passwords directly, so you don't need Render's Shell (paid-only).

   It writes the SAME hash format the app verifies against:
       salt(16 random bytes, hex) + ':' + scryptSync(password, salt, 32).hex
   (matches dashboard-db.js _hashPassword / _verifyPassword)

   Run it from your laptop against the EXTERNAL database URL.

   Usage
     node set-credentials.js --url "postgresql://user:pass@dpg-xxxx.ohio-postgres.render.com/numind"
     node set-credentials.js --url "..." --check          # only list tables + users, change nothing
     node set-credentials.js --url "..." --password "MyPass123"   # set a custom password
     node set-credentials.js --url "..." --school "Demo School"   # scope for mgmt/counsellor

   Needs the `pg` module — run it from your project folder (it's already there).
   ========================================================================== */

const crypto = require('crypto');
const { Client } = require('pg');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.findIndex(a => a === '--' + n || a.startsWith('--' + n + '='));
  if (i === -1) return d;
  const a = argv[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const nx = argv[i + 1];
  return (nx && !nx.startsWith('--')) ? nx : true;
};

const URL_    = arg('url', process.env.DATABASE_URL || '');
const CHECK   = !!arg('check', false);
const SCHOOL  = String(arg('school', 'Demo School'));
const PASS    = arg('password', null);

const C = { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' };

/* Identical to dashboard-db.js _hashPassword */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return salt + ':' + hash;
}
const genPw = () => crypto.randomBytes(9).toString('base64url');

const ACCOUNTS = [
  { name: 'Super Admin',       email: 'admin@numind.co.in',      role: 'admin',      school: null },
  { name: 'School Management', email: 'management@numind.co.in', role: 'management', school: SCHOOL },
  { name: 'School Counsellor', email: 'counsellor@numind.co.in', role: 'counsellor', school: SCHOOL },
];

(async () => {
  if (!URL_ || URL_ === true) {
    console.log(`\n${C.r}Missing --url${C.x}`);
    console.log(`  node set-credentials.js --url "postgresql://...ohio-postgres.render.com/numind"\n`);
    console.log(`  ${C.d}Use the EXTERNAL Database URL (Render → numind-db → Info → Connections).`);
    console.log(`  The internal dpg-xxxx-a host only resolves inside Render's network.${C.x}\n`);
    process.exit(1);
  }
  if (/127\.0\.0\.1|localhost/.test(URL_)) {
    console.log(`\n${C.y}⚠  That URL points at localhost — this is your LOCAL database, not Render.${C.x}\n`);
  }

  const client = new Client({ connectionString: URL_, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log(`\n${C.g}✓ Connected${C.x}`);
  } catch (e) {
    console.log(`\n${C.r}✗ Could not connect:${C.x} ${e.message}`);
    console.log(`  ${C.d}If this times out, check you used the EXTERNAL url, and that the`);
    console.log(`  database's ipAllowList isn't restricted.${C.x}\n`);
    process.exit(1);
  }

  try {
    // ---- 1. Did initSchema ever run? ----
    const t = await client.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public'`
    );
    const tableCount = t.rows[0].c;
    console.log(`  Tables in public schema: ${C.b}${tableCount}${C.x}`);
    if (tableCount === 0) {
      console.log(`\n${C.r}The schema is empty — your app has NEVER connected to this database.${C.x}`);
      console.log(`  Fix DATABASE_URL on the web service first; initSchema() builds the`);
      console.log(`  27 tables on first successful boot. Nothing to seed until then.\n`);
      process.exit(1);
    }

    const hasUsers = await client.query(
      `SELECT to_regclass('public.dashboard_users') IS NOT NULL AS ok`
    );
    if (!hasUsers.rows[0].ok) {
      console.log(`\n${C.r}dashboard_users table missing — schema is incomplete.${C.x}\n`);
      process.exit(1);
    }

    // ---- 2. Show existing users ----
    const cur = await client.query(
      `SELECT u.email, u.role, u.active,
              COALESCE(string_agg(s.school, ', '), '(all)') AS schools
       FROM dashboard_users u
       LEFT JOIN dashboard_user_schools s ON s.user_id = u.id
       GROUP BY u.id, u.email, u.role, u.active ORDER BY u.role`
    );
    console.log(`  Existing staff accounts: ${C.b}${cur.rows.length}${C.x}`);
    for (const r of cur.rows) {
      console.log(`    ${C.d}· ${String(r.email).padEnd(30)} ${String(r.role).padEnd(11)} ${r.active ? '' : '[INACTIVE] '}${r.schools}${C.x}`);
    }

    if (CHECK) {
      console.log(`\n${C.d}--check: nothing was modified.${C.x}\n`);
      await client.end();
      process.exit(0);
    }

    // ---- 3. Upsert the three accounts with known passwords ----
    console.log(`\n${C.b}Setting credentials…${C.x}`);
    const now = new Date().toISOString();
    const out = [];

    for (const a of ACCOUNTS) {
      const pw = PASS && PASS !== true ? String(PASS) : genPw();
      const hash = hashPassword(pw);

      const row = await client.query(
        `INSERT INTO dashboard_users (name, email, password_hash, role, active, created_at)
         VALUES ($1,$2,$3,$4,TRUE,$5)
         ON CONFLICT (email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               role          = EXCLUDED.role,
               active        = TRUE
         RETURNING id`,
        [a.name, a.email, hash, a.role, now]
      );
      const id = row.rows[0].id;

      if (a.school) {
        await client.query(
          `INSERT INTO dashboard_user_schools (user_id, school) VALUES ($1,$2)
           ON CONFLICT (user_id, school) DO NOTHING`,
          [id, a.school]
        );
      }
      out.push([a.role, a.email, pw, a.school || '(all schools)']);
    }

    // Old sessions used the old passwords — clear them so logins are clean.
    await client.query('DELETE FROM dashboard_sessions').catch(() => {});

    console.log(`\n${C.g}${'═'.repeat(72)}${C.x}`);
    console.log(`${C.b}  NUMIND MAPS — DASHBOARD CREDENTIALS${C.x}`);
    console.log(`${C.g}${'═'.repeat(72)}${C.x}`);
    for (const [role, email, pw, school] of out) {
      console.log(`  ${C.b}${role.padEnd(11)}${C.x} ${email.padEnd(30)} ${C.y}${pw}${C.x}`);
      console.log(`  ${C.d}${''.padEnd(11)} scope: ${school}${C.x}`);
    }
    console.log(`${C.g}${'═'.repeat(72)}${C.x}`);
    console.log(`${C.d}  Save these now. Passwords are scrypt-hashed and cannot be read back.`);
    console.log(`  Existing dashboard sessions were cleared — log in fresh.${C.x}\n`);

  } catch (e) {
    console.log(`\n${C.r}Error:${C.x} ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
