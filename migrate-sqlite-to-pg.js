/* ════════════════════════════════════════════════════════════════════
   migrate-sqlite-to-pg.js — NuMind MAPS  |  One-time data migration
   --------------------------------------------------------------------
   Copies every row from the legacy better-sqlite3 database into PostgreSQL.

   Usage:
     SQLITE_PATH=/data/numind.db \
     DATABASE_URL=postgres://user:pass@host:5432/numind \
     node migrate-sqlite-to-pg.js [--truncate] [--dry-run]

   Flags:
     --truncate   Empty the PG tables first (fresh re-run). Off by default so
                  an accidental second run won't wipe data.
     --dry-run    Read + count from SQLite, create the PG schema, but insert
                  nothing. Useful to validate connectivity and row counts.

   Notes:
     • Schema is created via pg-core.initSchema() before any insert.
     • Insert order respects foreign keys (students → assessments → reports …).
     • BOOLEAN conversion: SQLite 0/1 integers → PG true/false for the columns
       that changed type (is_fallback, active, used, dashboard permissions JSON).
     • Timestamps are ISO-8601 strings in SQLite; PG parses them natively into
       TIMESTAMPTZ, so they pass straight through.
     • IDENTITY columns: we insert explicit id values using OVERRIDING SYSTEM
       VALUE so PK relationships are preserved, then bump each sequence past
       MAX(id) so future inserts don't collide.
     • Idempotency: every insert uses ON CONFLICT DO NOTHING on the primary key,
       so a re-run without --truncate tops up missing rows rather than erroring.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const path = require('path');
const pg   = require('./pg-core.js');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'numind.db');
const TRUNCATE    = process.argv.includes('--truncate');
const DRY_RUN     = process.argv.includes('--dry-run');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 is required to read the legacy DB. Install it (temporarily) to run this migration.');
  process.exit(1);
}

/* Boolean columns that changed type SQLite(int) → PG(boolean). */
const BOOL_COLS = {
  report_summary:        ['is_fallback'],
  dashboard_users:       ['active'],
  student_otps:          ['used'],
  password_reset_tokens: ['used'],
  schools_registry:      ['active'],
};

/* JSON/JSONB columns (stored as TEXT in SQLite, JSONB in PG). */
const JSON_COLS = {
  dashboard_users: ['permissions'],
};

/* Tables that have an IDENTITY id we must preserve + resequence afterwards. */
const IDENTITY_TABLES = [
  'section_progress', 'counsellor_queries', 'chat_history',
  'conversation_summaries', 'student_otps', 'dashboard_users',
  'reminder_log', 'student_notes', 'audit_log', 'schools_registry',
];

/* Full insert order — parents before children (FK-safe). */
const TABLE_ORDER = [
  // core
  'students',
  'assessments',
  'section_progress',
  'report_summary',
  'report_personality',
  'report_aptitude',
  'report_interests',
  'report_seaa',
  'report_careers',
  // counsellor
  'counsellor_queries',
  'chat_history',
  'counsellor_sessions',
  'rate_limits',
  'conversation_summaries',
  'student_pins',
  'student_otps',
  'otp_stage_tokens',
  // dashboard
  'dashboard_users',
  'dashboard_user_schools',
  'dashboard_sessions',
  'reminder_log',
  'student_notes',
  'student_tags',
  'audit_log',
  'schools_registry',
  'password_reset_tokens',
  'analytics_cache',
];

function _coerceRow(table, row) {
  const bools = BOOL_COLS[table] || [];
  const jsons = JSON_COLS[table] || [];
  const out = { ...row };
  for (const c of bools) {
    if (c in out && out[c] !== null && out[c] !== undefined) out[c] = !!out[c];
  }
  for (const c of jsons) {
    // pg accepts a JS string as JSONB input as long as it's valid JSON text.
    if (c in out && (out[c] === '' || out[c] === null || out[c] === undefined)) out[c] = '{}';
  }
  return out;
}

async function _tableExistsSqlite(sdb, table) {
  const r = sdb.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(table);
  return !!r;
}

async function _migrateTable(sdb, table) {
  if (!(await _tableExistsSqlite(sdb, table))) {
    console.log(`  · ${table}: (absent in SQLite — skipped)`);
    return { table, count: 0 };
  }

  const rows = sdb.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) { console.log(`  · ${table}: 0 rows`); return { table, count: 0 }; }
  if (DRY_RUN)      { console.log(`  · ${table}: ${rows.length} rows (dry-run, not inserted)`); return { table, count: rows.length }; }

  const cols = Object.keys(rows[0]);
  const collist = cols.map(c => `"${c}"`).join(', ');
  const hasIdentity = IDENTITY_TABLES.includes(table) && cols.includes('id');
  const overriding  = hasIdentity ? 'OVERRIDING SYSTEM VALUE ' : '';

  // Insert in batched multi-row statements for speed.
  const BATCH = 200;
  let inserted = 0;

  await pg.tx(async (c) => {
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH).map(r => _coerceRow(table, r));
      const params = [];
      const tuples = slice.map((r) => {
        const ph = cols.map((col) => {
          params.push(r[col] === undefined ? null : r[col]);
          return `$${params.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      const sql =
        `INSERT INTO ${table} (${collist}) ${overriding}` +
        `VALUES ${tuples.join(', ')} ` +
        `ON CONFLICT DO NOTHING`;
      const res = await c.query(sql, params);
      inserted += res.rowCount;
    }
  });

  console.log(`  · ${table}: ${inserted}/${rows.length} inserted` +
              (inserted !== rows.length ? ' (rest already present)' : ''));
  return { table, count: inserted };
}

async function _resequenceIdentities() {
  for (const table of IDENTITY_TABLES) {
    try {
      // setval to MAX(id); if table empty, reset to 1 with is_called=false.
      await pg.q(
        `SELECT setval(
           pg_get_serial_sequence($1, 'id'),
           COALESCE((SELECT MAX(id) FROM ${table}), 1),
           (SELECT COUNT(*) FROM ${table}) > 0
         )`,
        [table]
      );
    } catch (e) {
      console.warn(`  ! resequence ${table}: ${e.message}`);
    }
  }
  console.log('  · identity sequences resynced');
}

async function _truncateAll() {
  // Reverse FK order, CASCADE to be safe. RESTART IDENTITY resets sequences.
  const rev = [...TABLE_ORDER].reverse();
  await pg.q(`TRUNCATE ${rev.join(', ')} RESTART IDENTITY CASCADE`);
  console.log('  · all PG tables truncated');
}

async function main() {
  console.log('NuMind MAPS — SQLite → PostgreSQL migration');
  console.log('  SQLite source :', SQLITE_PATH);
  console.log('  PG target     :', process.env.DATABASE_URL ? '(DATABASE_URL)' :
    `${process.env.PGHOST || '127.0.0.1'}/${process.env.PGDATABASE || 'numind'}`);
  console.log('  Mode          :', DRY_RUN ? 'DRY RUN' : (TRUNCATE ? 'TRUNCATE + LOAD' : 'TOP-UP (ON CONFLICT DO NOTHING)'));
  console.log('');

  const sdb = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });

  console.log('Ensuring PG schema…');
  await pg.initSchema();

  if (TRUNCATE && !DRY_RUN) {
    console.log('Truncating target tables…');
    await _truncateAll();
  }

  console.log('Copying tables…');
  let total = 0;
  for (const table of TABLE_ORDER) {
    const { count } = await _migrateTable(sdb, table);
    total += count;
  }

  if (!DRY_RUN) {
    console.log('Resyncing identity sequences…');
    await _resequenceIdentities();
  }

  sdb.close();
  await pg.close();

  console.log('');
  console.log(`Done. ${total} row(s) ${DRY_RUN ? 'counted' : 'migrated'}.`);
  if (DRY_RUN) console.log('Dry run only — no data was written. Re-run without --dry-run to migrate.');
}

main().catch((e) => {
  console.error('\nMIGRATION FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
