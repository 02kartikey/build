#!/usr/bin/env node
'use strict';
/* ============================================================================
   check-db.js — read-only check of the Render Postgres for NuMind MAPS
   ----------------------------------------------------------------------------
   Answers one question: has the app ever connected and built its schema?
   Changes NOTHING. Safe to run any time.

   Usage (run from the project folder, so the `pg` module resolves):
     node check-db.js "postgresql://user:pass@dpg-xxxx.ohio-postgres.render.com/numind"

   Use the EXTERNAL database URL (Render → numind-db → Info → Connections).
   The internal "dpg-xxxx-a" host only resolves inside Render's own network.
   ========================================================================== */

const { Client } = require('pg');

const url = process.argv[2];
if (!url) {
  console.log('\nUsage:\n  node check-db.js "<external-database-url>"\n');
  console.log('Get it from: Render -> numind-db -> Info -> Connections -> External Database URL');
  console.log('It ends with ".ohio-postgres.render.com/numind"\n');
  process.exit(1);
}
if (/@dpg-[^.]+\/|@dpg-[^.]+$/.test(url)) {
  console.log('\n[!] That looks like the INTERNAL url (no ".ohio-postgres.render.com" in the host).');
  console.log('    It only resolves inside Render. Use the External Database URL from your laptop.\n');
}
if (/127\.0\.0\.1|localhost/.test(url)) {
  console.log('\n[!] That url points at localhost — that is your LOCAL database, not Render.\n');
}

const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    await c.connect();
    console.log('\nConnected OK.');
  } catch (e) {
    console.log('\nCONNECT FAILED: ' + e.message);
    console.log('  - "getaddrinfo ENOTFOUND"  -> you used the internal url; use the External one.');
    console.log('  - "password authentication failed" -> you left PASS as a placeholder.');
    console.log('  - timeout -> the database ipAllowList may be restricted.\n');
    process.exit(1);
  }

  try {
    const t = await c.query(
      'SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()'
    );
    const n = t.rows[0].n;
    console.log('TABLES: ' + n);

    if (n === 0) {
      console.log('\n>> Schema is EMPTY.');
      console.log('   Your app has NEVER successfully connected to this database.');
      console.log('   initSchema() builds the 27 tables on the first good boot.');
      console.log('   Fix DATABASE_URL on the "build" web service first.');
      console.log('   No dashboard credentials exist yet, and none can until this works.\n');
      await c.end();
      process.exit(0);
    }

    console.log('\n>> Schema exists. Bootstrap has run at least once.');

    const has = await c.query("SELECT to_regclass('public.dashboard_users') IS NOT NULL AS ok");
    if (!has.rows[0].ok) {
      console.log('   But dashboard_users is missing — schema is incomplete.\n');
      await c.end();
      process.exit(0);
    }

    const u = await c.query(
      `SELECT u.email, u.role, u.active,
              COALESCE(string_agg(s.school, ', '), '(all schools)') AS schools
       FROM dashboard_users u
       LEFT JOIN dashboard_user_schools s ON s.user_id = u.id
       GROUP BY u.id, u.email, u.role, u.active
       ORDER BY u.role`
    );
    console.log('\nSTAFF ACCOUNTS: ' + u.rows.length);
    for (const r of u.rows) {
      console.log('   - ' + String(r.email).padEnd(30) + String(r.role).padEnd(12) +
                  (r.active ? '' : '[INACTIVE] ') + r.schools);
    }

    const s = await c.query('SELECT COUNT(*)::int AS n FROM students').catch(() => ({ rows: [{ n: 'n/a' }] }));
    const rep = await c.query('SELECT COUNT(*)::int AS n FROM report_summary').catch(() => ({ rows: [{ n: 'n/a' }] }));
    console.log('\nSTUDENTS: ' + s.rows[0].n + '   REPORTS: ' + rep.rows[0].n);
    if (s.rows[0].n === 0) {
      console.log('   (Aria has nothing to unlock until a student completes an assessment.)');
    }

    console.log('\nNext: run set-credentials.js with the same url to set known passwords.\n');
    await c.end();
  } catch (e) {
    console.log('\nQUERY ERROR: ' + e.message + '\n');
    await c.end().catch(() => {});
    process.exit(1);
  }
})();
