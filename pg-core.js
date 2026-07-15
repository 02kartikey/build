/* ════════════════════════════════════════════════════════════════════
   pg-core.js — NuMind MAPS  |  PostgreSQL foundation layer
   --------------------------------------------------------------------
   Replaces the better-sqlite3 core. Provides:
     • a single shared connection Pool (safe across PM2 cluster workers)
     • the full schema (all 27 tables) in PostgreSQL dialect
     • async query helpers: q / one / many / exec / tx

   Design notes vs the old SQLite layer:
     • pg is ASYNC. Every helper returns a Promise. All callers await.
     • No prepared-statement cache: pg parameterises server-side per query.
       Placeholders are $1,$2,… (not ?).
     • No pragmas (WAL, synchronous, mmap): Postgres handles durability and
       concurrency natively. The old single-writer write queue is obsolete —
       the Pool gives real concurrent writers.
     • TEXT ISO-8601 timestamps → TIMESTAMPTZ. INTEGER 0/1 flags → BOOLEAN.
       JSON-as-TEXT columns → JSONB. AUTOINCREMENT → GENERATED … AS IDENTITY.
     • SQLite "COLLATE NOCASE" uniqueness → CITEXT (case-insensitive text)
       so email/school/tag uniqueness stays case-insensitive without extra
       functional indexes.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const { Pool, types } = require('pg');

/* Type parity with the old better-sqlite3 layer:
   • int8/BIGINT (OID 20) — pg returns these as STRINGS by default; SQLite
     returned numbers. Every IDENTITY id (users, notes, schools…) is int8, and
     the dashboards do strict `x.id === userId` compares, so parse as Number.
     (Safe: ids here never approach Number.MAX_SAFE_INTEGER.)
   • NUMERIC (OID 1700) — returned as string by default; parse as float so
     ROUND(...) aggregates behave like SQLite's numeric results. */
types.setTypeParser(20,   (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

let _pool = null;

/* ── Connection ─────────────────────────────────────────────────────── */
function _makePool() {
  // Prefer a single DATABASE_URL (Render/EC2 style); fall back to discrete vars.
  const cfg = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
      }
    : {
        host:     process.env.PGHOST     || '127.0.0.1',
        port:     parseInt(process.env.PGPORT || '5432', 10),
        user:     process.env.PGUSER     || 'numind',
        password: process.env.PGPASSWORD || '',
        database: process.env.PGDATABASE || 'numind',
        ssl: process.env.PGSSL === 'require'
          ? { rejectUnauthorized: false }
          : false,
      };

  // Pool sizing: default modest so a single node stays under Postgres'
  // max_connections when running PM2 cluster mode (each worker owns a pool).
  cfg.max                     = parseInt(process.env.PG_POOL_MAX || '10', 10);
  cfg.idleTimeoutMillis       = parseInt(process.env.PG_IDLE_MS   || '30000', 10);
  cfg.connectionTimeoutMillis = parseInt(process.env.PG_CONN_MS   || '5000', 10);

  const pool = new Pool(cfg);
  // A pool 'error' on an idle client would otherwise crash the process.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pg-core] idle client error:', err.message);
  });
  return pool;
}

function pool() {
  if (!_pool) _pool = _makePool();
  return _pool;
}

/* ── Query helpers ──────────────────────────────────────────────────── */

/** Raw query → full pg result object ({ rows, rowCount, ... }). */
async function q(text, params = []) {
  return pool().query(text, params);
}

/** First row, or null. Mirrors better-sqlite3 stmt.get(). */
async function one(text, params = []) {
  const r = await pool().query(text, params);
  return r.rows[0] || null;
}

/** All rows. Mirrors stmt.all(). */
async function many(text, params = []) {
  const r = await pool().query(text, params);
  return r.rows;
}

/** Fire-and-return rowCount. Mirrors stmt.run() when you only need `changes`. */
async function exec(text, params = []) {
  const r = await pool().query(text, params);
  return { rowCount: r.rowCount, rows: r.rows };
}

/**
 * Transaction helper. Replaces better-sqlite3's synchronous db.transaction().
 * Usage:
 *   await tx(async (c) => {
 *     await c.query('INSERT ...', [...]);
 *     const row = (await c.query('SELECT ...', [...])).rows[0];
 *     return row;
 *   });
 * Automatically BEGIN / COMMIT, or ROLLBACK on any throw. Always releases.
 */
async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/* ── Schema ─────────────────────────────────────────────────────────── */
/*  All 27 tables, PostgreSQL dialect. Idempotent (IF NOT EXISTS).
    citext requires the extension; we create it first. Timestamps are
    TIMESTAMPTZ; the app currently passes ISO-8601 strings which Postgres
    parses natively, so no call-site changes are required for inserts.  */

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS citext;

/* ══ Core student / assessment / report tables (from db.js) ══ */
CREATE TABLE IF NOT EXISTS students (
  session_id          TEXT PRIMARY KEY,
  first_name          TEXT,
  last_name           TEXT,
  full_name           TEXT,
  class               TEXT,
  section             TEXT,
  school              TEXT,
  school_state        TEXT,
  school_city         TEXT,
  age                 TEXT,
  gender              TEXT,
  email               CITEXT,
  registered_at       TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  report_generated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS assessments (
  session_id            TEXT PRIMARY KEY REFERENCES students(session_id) ON DELETE CASCADE,
  saved_at              TIMESTAMPTZ NOT NULL,
  cpi_raw_answers       TEXT, cpi_scores_json       TEXT, cpi_duration_seconds       INTEGER, cpi_completed_at       TIMESTAMPTZ,
  sea_raw_answers       TEXT, sea_scores_json       TEXT, sea_duration_seconds       INTEGER, sea_completed_at       TIMESTAMPTZ,
  nmap_raw_answers      TEXT, nmap_scores_json      TEXT, nmap_duration_seconds      INTEGER, nmap_completed_at      TIMESTAMPTZ,
  daab_va_raw_answers   TEXT, daab_va_scores_json   TEXT, daab_va_duration_seconds   INTEGER, daab_va_completed_at   TIMESTAMPTZ,
  daab_pa_raw_answers   TEXT, daab_pa_scores_json   TEXT, daab_pa_duration_seconds   INTEGER, daab_pa_completed_at   TIMESTAMPTZ,
  daab_na_raw_answers   TEXT, daab_na_scores_json   TEXT, daab_na_duration_seconds   INTEGER, daab_na_completed_at   TIMESTAMPTZ,
  daab_lsa_raw_answers  TEXT, daab_lsa_scores_json  TEXT, daab_lsa_duration_seconds  INTEGER, daab_lsa_completed_at  TIMESTAMPTZ,
  daab_hma_raw_answers  TEXT, daab_hma_scores_json  TEXT, daab_hma_duration_seconds  INTEGER, daab_hma_completed_at  TIMESTAMPTZ,
  daab_ar_raw_answers   TEXT, daab_ar_scores_json   TEXT, daab_ar_duration_seconds   INTEGER, daab_ar_completed_at   TIMESTAMPTZ,
  daab_ma_raw_answers   TEXT, daab_ma_scores_json   TEXT, daab_ma_duration_seconds   INTEGER, daab_ma_completed_at   TIMESTAMPTZ,
  daab_sa_raw_answers   TEXT, daab_sa_scores_json   TEXT, daab_sa_duration_seconds   INTEGER, daab_sa_completed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS section_progress (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  module_key       TEXT NOT NULL,
  submitted_at     TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS report_summary (
  session_id               TEXT PRIMARY KEY REFERENCES students(session_id) ON DELETE CASCADE,
  generated_at             TIMESTAMPTZ NOT NULL,
  is_fallback              BOOLEAN NOT NULL DEFAULT FALSE,
  holistic_summary         TEXT,
  aptitude_profile         TEXT,
  interest_profile         TEXT,
  internal_motivators      TEXT,
  personality_profile      TEXT,
  wellbeing_guidance       TEXT,
  stream_advice            TEXT,
  avg_personality_stanine  REAL,
  avg_aptitude_stanine     REAL,
  top_interest_score       INTEGER,
  fit_score                INTEGER,
  fit_tier                 TEXT,
  personality_status       TEXT,
  aptitude_status          TEXT,
  interest_status          TEXT,
  seaa_status              TEXT,
  strong_fit_pathways      TEXT,
  emerging_fit_pathways    TEXT,
  exploratory_pathways     TEXT,
  recommended_primary      TEXT,
  recommended_alternate    TEXT,
  recommended_exploratory  TEXT,
  top_personality_traits_json TEXT,
  strong_aptitudes_json       TEXT,
  emerging_aptitudes_json     TEXT,
  top3_interests_json         TEXT
);

CREATE TABLE IF NOT EXISTS report_personality (
  session_id  TEXT    NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  stanine     INTEGER NOT NULL,
  band        TEXT    NOT NULL,
  PRIMARY KEY (session_id, position)
);

CREATE TABLE IF NOT EXISTS report_aptitude (
  session_id  TEXT    NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  key         TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  stanine     INTEGER NOT NULL,
  band        TEXT    NOT NULL,
  raw_score   INTEGER,
  max_score   INTEGER,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS report_interests (
  session_id  TEXT    NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  rank        INTEGER NOT NULL,
  label       TEXT    NOT NULL,
  score       INTEGER NOT NULL,
  level       TEXT    NOT NULL,
  PRIMARY KEY (session_id, rank)
);

CREATE TABLE IF NOT EXISTS report_seaa (
  session_id  TEXT NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  title       TEXT NOT NULL,
  score       INTEGER NOT NULL,
  category    TEXT,
  cat_label   TEXT,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS report_careers (
  session_id       TEXT    NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  career           TEXT    NOT NULL,
  cluster          TEXT,
  interest_fit     TEXT,
  aptitude_fit     TEXT,
  personality_fit  TEXT,
  seaa_fit         TEXT,
  suitability_pct  INTEGER,
  alignment        TEXT,
  rationale        TEXT,
  PRIMARY KEY (session_id, position)
);

CREATE INDEX IF NOT EXISTS idx_students_school      ON students(school);
CREATE INDEX IF NOT EXISTS idx_students_school_ci   ON students(LOWER(school));
CREATE INDEX IF NOT EXISTS idx_students_class       ON students(class);
CREATE INDEX IF NOT EXISTS idx_students_registered  ON students(registered_at);
CREATE INDEX IF NOT EXISTS idx_students_email       ON students(email);
CREATE INDEX IF NOT EXISTS idx_students_completed   ON students(completed_at);
CREATE INDEX IF NOT EXISTS idx_section_prog_session ON section_progress(session_id);
CREATE INDEX IF NOT EXISTS idx_section_prog_module  ON section_progress(module_key);
CREATE INDEX IF NOT EXISTS idx_careers_cluster      ON report_careers(cluster);
CREATE INDEX IF NOT EXISTS idx_interests_label      ON report_interests(label);
CREATE INDEX IF NOT EXISTS idx_summary_fit_tier     ON report_summary(fit_tier);
CREATE INDEX IF NOT EXISTS idx_summary_generated    ON report_summary(generated_at);
CREATE INDEX IF NOT EXISTS idx_summary_seaa         ON report_summary(seaa_status);

/* ══ Counsellor / chat / auth tables (from counsellor-db.js) ══ */
CREATE TABLE IF NOT EXISTS counsellor_queries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  message         TEXT NOT NULL,
  preferred_date  TEXT,
  preferred_time  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  submitted_at    TIMESTAMPTZ NOT NULL,
  admin_note      TEXT,
  updated_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cq_email     ON counsellor_queries(email);
CREATE INDEX IF NOT EXISTS idx_cq_status    ON counsellor_queries(status);
CREATE INDEX IF NOT EXISTS idx_cq_submitted ON counsellor_queries(submitted_at);

CREATE TABLE IF NOT EXISTS chat_history (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           TEXT NOT NULL,
  session_id      TEXT,
  conversation_id TEXT,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ch_email   ON chat_history(email);
CREATE INDEX IF NOT EXISTS idx_ch_session ON chat_history(session_id);
CREATE INDEX IF NOT EXISTS idx_ch_created ON chat_history(created_at);
CREATE INDEX IF NOT EXISTS idx_ch_conv    ON chat_history(conversation_id);

CREATE TABLE IF NOT EXISTS counsellor_sessions (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctok_email ON counsellor_sessions(email);
CREATE INDEX IF NOT EXISTS idx_ctok_exp   ON counsellor_sessions(expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_reset ON rate_limits(reset_at);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  summary         TEXT NOT NULL,
  message_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_convsum_uniq  ON conversation_summaries(email, conversation_id);
CREATE INDEX        IF NOT EXISTS idx_convsum_email ON conversation_summaries(email);

CREATE TABLE IF NOT EXISTS student_pins (
  email       CITEXT PRIMARY KEY,
  pin_hash    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS student_otps (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       TEXT NOT NULL,
  otp_hash    TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'register',
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON student_otps(email);
CREATE INDEX IF NOT EXISTS idx_otp_exp   ON student_otps(expires_at);

CREATE TABLE IF NOT EXISTS otp_stage_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ost_email ON otp_stage_tokens(email);
CREATE INDEX IF NOT EXISTS idx_ost_exp   ON otp_stage_tokens(expires_at);

/* ══ Dashboard / staff / audit tables (from dashboard-db.js) ══ */
CREATE TABLE IF NOT EXISTS dashboard_users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT    NOT NULL,
  email         CITEXT  NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'counsellor',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  permissions   JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL,
  last_login    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_du_email ON dashboard_users(email);
CREATE INDEX IF NOT EXISTS idx_du_role  ON dashboard_users(role);

CREATE TABLE IF NOT EXISTS dashboard_user_schools (
  user_id  BIGINT NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
  school   CITEXT NOT NULL,
  UNIQUE(user_id, school)
);
CREATE INDEX IF NOT EXISTS idx_dus_user   ON dashboard_user_schools(user_id);
CREATE INDEX IF NOT EXISTS idx_dus_school ON dashboard_user_schools(school);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token      TEXT   PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ds_user    ON dashboard_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ds_expires ON dashboard_sessions(expires_at);

CREATE TABLE IF NOT EXISTS reminder_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_email TEXT   NOT NULL,
  sent_by       BIGINT NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL,
  subject       TEXT,
  message       TEXT
);
CREATE INDEX IF NOT EXISTS idx_rl_email  ON reminder_log(student_email);
CREATE INDEX IF NOT EXISTS idx_rl_sentby ON reminder_log(sent_by);

CREATE TABLE IF NOT EXISTS student_notes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT   NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  author_id  BIGINT NOT NULL REFERENCES dashboard_users(id)  ON DELETE CASCADE,
  note       TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sn_session ON student_notes(session_id);

CREATE TABLE IF NOT EXISTS student_tags (
  session_id TEXT   NOT NULL REFERENCES students(session_id) ON DELETE CASCADE,
  tag        CITEXT NOT NULL,
  added_by   BIGINT NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_st_session ON student_tags(session_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT,
  user_email TEXT,
  action     TEXT   NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  ts         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_al_ts      ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_al_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_al_action  ON audit_log(action);

CREATE TABLE IF NOT EXISTS schools_registry (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name     CITEXT  NOT NULL UNIQUE,
  city     TEXT,
  state    TEXT,
  added_at TIMESTAMPTZ NOT NULL,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token      TEXT   PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS analytics_cache (
  cache_key     TEXT    PRIMARY KEY,
  cache_value   TEXT    NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL,
  cache_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_analytics_cache_ts ON analytics_cache(computed_at);
`;

/**
 * Create/verify the full schema. Idempotent — safe to run on every boot.
 * Runs inside a single transaction so a partial failure rolls back cleanly.
 */
async function initSchema() {
  await tx(async (c) => {
    // Run the whole DDL block. citext extension must exist before any
    // CITEXT column is created, which is why it's the first statement.
    await c.query(SCHEMA);
  });
}

/** Verify connectivity (used by /health and startup). */
async function ping() {
  const r = await pool().query('SELECT 1 AS ok');
  return r.rows[0] && r.rows[0].ok === 1;
}

/** Graceful shutdown for PM2 reloads / SIGTERM. */
async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = {
  pool,
  q,
  one,
  many,
  exec,
  tx,
  initSchema,
  ping,
  close,
  SCHEMA,
};
