/* ════════════════════════════════════════════════════════════════════
   db.js  —  NuMind MAPS  |  SQLite database layer
   Node.js 18+, CommonJS, better-sqlite3 (synchronous)

   ── Scale target ─────────────────────────────────────────────────
   20 000 users/day  →  ~14 req/min sustained, ~100/min peak burst.
   PM2 cluster: each worker keeps its own connection; WAL mode allows
   N concurrent readers + 1 writer without SQLITE_BUSY.

   ── Bug history ───────────────────────────────────────────────────
   BUG 1  registered_at always overwritten on restart/re-registration.
     FIX: registered_at excluded from DO UPDATE SET — written once on
          first INSERT, never touched again.

   BUG 2  Child report tables used DELETE-then-INSERT — a crash between
          them left the session permanently empty.
     FIX: INSERT OR REPLACE (atomic per-row). No DELETE step.
          Crash leaves old or new data — never empty.

   BUG 3  saveReport overwrote good AI prose with a fallback report.
     FIX: upsertReportSummary CASE logic: AI prose fields only updated
          when incoming is_fallback = 0. Computed fields always updated.

   BUG 4  saveRegistration generated a fresh timestamp on every call.
     FIX: Pass student.registeredAt (if present) so re-runs are idempotent.

   ── Schema ───────────────────────────────────────────────────────
     students           — registration + profile
     assessments        — raw answers, scores, durations per module
     section_progress   — incremental audit log of submissions
     report_summary     — AI prose + computed snapshot fields
     report_personality — 9 NMAP dims per session
     report_aptitude    — 8 DAAB sub-tests per session
     report_interests   — up to 8 CPI ranked interests per session
     report_seaa        — 3 SEA domains per session
     report_careers     — Integrated Career Fit Matrix rows (variable)
════════════════════════════════════════════════════════════════════ */

'use strict';

const path = require('path');

/* ── Singleton DB connection ────────────────────────────────────── */
let _db    = null;
let _stmts = null;

/* ══════════════════════════════════════════════════════════════════
   MODULE LIST — single source of truth. Mirrors state.js / server.js.
══════════════════════════════════════════════════════════════════ */
const MODULES = [
  'cpi', 'sea', 'nmap',
  'daab_va', 'daab_pa', 'daab_na', 'daab_lsa',
  'daab_hma', 'daab_ar', 'daab_ma', 'daab_sa',
];

/* ══════════════════════════════════════════════════════════════════
   INIT — call once at startup (idempotent)
══════════════════════════════════════════════════════════════════ */
function _initDb() {
  if (_db) return _db;

  const Database = require('better-sqlite3');
  const dbPath   = process.env.SQLITE_PATH || path.join(__dirname, 'numind.db');
  _db = new Database(dbPath);

  /* ── Performance pragmas for 20 000 users/day ───────────────────
     All safe for production. WAL provides crash recovery so
     synchronous=NORMAL cannot cause data loss.
  ─────────────────────────────────────────────────────────────── */
  _db.pragma('journal_mode = WAL');       // concurrent readers + 1 writer, no SQLITE_BUSY
  _db.pragma('busy_timeout = 5000');      // wait 5 s on lock before throwing
  _db.pragma('synchronous = NORMAL');     // fsync on WAL checkpoints only (~3x faster than FULL)
  _db.pragma('cache_size = -16000');      // 16 MB page cache — reduces disk reads for hot data
  _db.pragma('temp_store = MEMORY');      // temp tables/indexes in RAM, not on disk
  _db.pragma('foreign_keys = ON');        // enforce referential integrity
  _db.pragma('mmap_size = 67108864');     // 64 MB memory-mapped I/O for read-heavy dashboard queries

  /* ── Schema ─────────────────────────────────────────────────── */
  _db.exec(`
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
      email               TEXT,
      registered_at       TEXT NOT NULL,
      completed_at        TEXT,
      report_generated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS assessments (
      session_id            TEXT PRIMARY KEY,
      saved_at              TEXT NOT NULL,
      cpi_raw_answers       TEXT, cpi_scores_json       TEXT, cpi_duration_seconds       INTEGER, cpi_completed_at       TEXT,
      sea_raw_answers       TEXT, sea_scores_json       TEXT, sea_duration_seconds       INTEGER, sea_completed_at       TEXT,
      nmap_raw_answers      TEXT, nmap_scores_json      TEXT, nmap_duration_seconds      INTEGER, nmap_completed_at      TEXT,
      daab_va_raw_answers   TEXT, daab_va_scores_json   TEXT, daab_va_duration_seconds   INTEGER, daab_va_completed_at   TEXT,
      daab_pa_raw_answers   TEXT, daab_pa_scores_json   TEXT, daab_pa_duration_seconds   INTEGER, daab_pa_completed_at   TEXT,
      daab_na_raw_answers   TEXT, daab_na_scores_json   TEXT, daab_na_duration_seconds   INTEGER, daab_na_completed_at   TEXT,
      daab_lsa_raw_answers  TEXT, daab_lsa_scores_json  TEXT, daab_lsa_duration_seconds  INTEGER, daab_lsa_completed_at  TEXT,
      daab_hma_raw_answers  TEXT, daab_hma_scores_json  TEXT, daab_hma_duration_seconds  INTEGER, daab_hma_completed_at  TEXT,
      daab_ar_raw_answers   TEXT, daab_ar_scores_json   TEXT, daab_ar_duration_seconds   INTEGER, daab_ar_completed_at   TEXT,
      daab_ma_raw_answers   TEXT, daab_ma_scores_json   TEXT, daab_ma_duration_seconds   INTEGER, daab_ma_completed_at   TEXT,
      daab_sa_raw_answers   TEXT, daab_sa_scores_json   TEXT, daab_sa_duration_seconds   INTEGER, daab_sa_completed_at   TEXT,
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS section_progress (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL,
      module_key       TEXT NOT NULL,
      submitted_at     TEXT NOT NULL,
      duration_seconds INTEGER,
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_summary (
      session_id               TEXT PRIMARY KEY,
      generated_at             TEXT NOT NULL,
      is_fallback              INTEGER NOT NULL DEFAULT 0,
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
      strong_aptitudes_json        TEXT,
      emerging_aptitudes_json      TEXT,
      top3_interests_json          TEXT,
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_personality (
      session_id  TEXT    NOT NULL,
      position    INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      stanine     INTEGER NOT NULL,
      band        TEXT    NOT NULL,
      PRIMARY KEY (session_id, position),
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_aptitude (
      session_id  TEXT    NOT NULL,
      position    INTEGER NOT NULL,
      key         TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      stanine     INTEGER NOT NULL,
      band        TEXT    NOT NULL,
      raw_score   INTEGER,
      max_score   INTEGER,
      PRIMARY KEY (session_id, key),
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_interests (
      session_id  TEXT    NOT NULL,
      rank        INTEGER NOT NULL,
      label       TEXT    NOT NULL,
      score       INTEGER NOT NULL,
      level       TEXT    NOT NULL,
      PRIMARY KEY (session_id, rank),
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_seaa (
      session_id  TEXT NOT NULL,
      key         TEXT NOT NULL,
      title       TEXT NOT NULL,
      score       INTEGER NOT NULL,
      category    TEXT,
      cat_label   TEXT,
      PRIMARY KEY (session_id, key),
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_careers (
      session_id       TEXT    NOT NULL,
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
      PRIMARY KEY (session_id, position),
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );

    -- Core read indexes
    CREATE INDEX IF NOT EXISTS idx_students_school      ON students(school);
    CREATE INDEX IF NOT EXISTS idx_students_school_ci   ON students(LOWER(school));
    CREATE INDEX IF NOT EXISTS idx_students_class       ON students(class);
    CREATE INDEX IF NOT EXISTS idx_students_registered  ON students(registered_at);
    CREATE INDEX IF NOT EXISTS idx_students_email       ON students(email);
    CREATE INDEX IF NOT EXISTS idx_students_email_ci    ON students(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_students_completed   ON students(completed_at);
    CREATE INDEX IF NOT EXISTS idx_section_prog_session ON section_progress(session_id);
    CREATE INDEX IF NOT EXISTS idx_section_prog_module  ON section_progress(module_key);
    CREATE INDEX IF NOT EXISTS idx_careers_cluster      ON report_careers(cluster);
    CREATE INDEX IF NOT EXISTS idx_interests_label      ON report_interests(label);
    CREATE INDEX IF NOT EXISTS idx_summary_fit_tier     ON report_summary(fit_tier);
    CREATE INDEX IF NOT EXISTS idx_summary_generated    ON report_summary(generated_at);
    CREATE INDEX IF NOT EXISTS idx_summary_seaa         ON report_summary(seaa_status);
    CREATE INDEX IF NOT EXISTS idx_summary_school       ON report_summary(session_id);
  `);

  /* ── Lightweight migration: add columns missing from legacy DBs ─ */
  for (const m of MODULES) {
    try {
      const cols = _db.prepare(`PRAGMA table_info(assessments)`).all().map(c => c.name);
      if (!cols.includes(m + '_completed_at')) {
        _db.exec(`ALTER TABLE assessments ADD COLUMN ${m}_completed_at TEXT`);
      }
    } catch (_) {}
  }

  /* ── Legacy schema integrity: ensure session_id PK exists ────────
     CREATE TABLE IF NOT EXISTS is a no-op on legacy DBs that may lack
     the PRIMARY KEY needed by ON CONFLICT(session_id) upserts.
     Detect and rebuild, preserving all existing rows.
  ─────────────────────────────────────────────────────────────── */
  const _hasPK = (table) => {
    try {
      const info = _db.prepare(`PRAGMA table_info(${table})`).all();
      if (info.find(c => c.name === 'session_id' && c.pk === 1)) return true;
      const idxList = _db.prepare(`PRAGMA index_list(${table})`).all();
      for (const idx of idxList) {
        if (!idx.unique) continue;
        const cols = _db.prepare(`PRAGMA index_info(${idx.name})`).all();
        if (cols.length === 1 && cols[0].name === 'session_id') return true;
      }
    } catch (_) {}
    return false;
  };

  const _rebuildPreservingData = (table, createSql, extraIndexSql) => {
    process.stderr.write('[WARN]  [DB] Rebuilding "' + table + '" — legacy schema. Preserving existing rows.\n');
    _db.pragma('foreign_keys = OFF');
    const tx = _db.transaction(() => {
      const oldCols = _db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      _db.exec(`ALTER TABLE ${table} RENAME TO ${table}__legacy`);
      _db.exec(createSql);
      const newCols = _db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      const shared  = oldCols.filter(c => newCols.includes(c));
      if (shared.length) {
        const cols = shared.join(', ');
        _db.exec(`INSERT OR IGNORE INTO ${table} (${cols}) SELECT ${cols} FROM ${table}__legacy`);
      }
      _db.exec(`DROP TABLE ${table}__legacy`);
      if (extraIndexSql) _db.exec(extraIndexSql);
    });
    try { tx(); } finally { _db.pragma('foreign_keys = ON'); }
  };

  if (!_hasPK('students')) {
    _rebuildPreservingData('students', `
      CREATE TABLE students (
        session_id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, full_name TEXT,
        class TEXT, section TEXT, school TEXT, school_state TEXT, school_city TEXT,
        age TEXT, gender TEXT, email TEXT,
        registered_at TEXT NOT NULL, completed_at TEXT, report_generated_at TEXT
      )
    `, `
      CREATE INDEX IF NOT EXISTS idx_students_school     ON students(school);
      CREATE INDEX IF NOT EXISTS idx_students_class      ON students(class);
      CREATE INDEX IF NOT EXISTS idx_students_registered ON students(registered_at);
      CREATE INDEX IF NOT EXISTS idx_students_email      ON students(email);
      CREATE INDEX IF NOT EXISTS idx_students_completed  ON students(completed_at);
    `);
  }

  if (!_hasPK('assessments')) {
    const moduleCols = MODULES
      .map(m => `${m}_raw_answers TEXT, ${m}_scores_json TEXT, ${m}_duration_seconds INTEGER, ${m}_completed_at TEXT`)
      .join(',\n        ');
    _rebuildPreservingData('assessments', `
      CREATE TABLE assessments (
        session_id TEXT PRIMARY KEY, saved_at TEXT NOT NULL,
        ${moduleCols},
        FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
      )
    `);
  }

  if (!_hasPK('report_summary')) {
    _rebuildPreservingData('report_summary', `
      CREATE TABLE report_summary (
        session_id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, is_fallback INTEGER NOT NULL DEFAULT 0,
        holistic_summary TEXT, aptitude_profile TEXT, interest_profile TEXT,
        internal_motivators TEXT, personality_profile TEXT, wellbeing_guidance TEXT, stream_advice TEXT,
        avg_personality_stanine REAL, avg_aptitude_stanine REAL, top_interest_score INTEGER,
        fit_score INTEGER, fit_tier TEXT,
        personality_status TEXT, aptitude_status TEXT, interest_status TEXT, seaa_status TEXT,
        strong_fit_pathways TEXT, emerging_fit_pathways TEXT, exploratory_pathways TEXT,
        recommended_primary TEXT, recommended_alternate TEXT, recommended_exploratory TEXT,
        top_personality_traits_json TEXT, strong_aptitudes_json TEXT,
        emerging_aptitudes_json TEXT, top3_interests_json TEXT,
        FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
      )
    `, `
      CREATE INDEX IF NOT EXISTS idx_summary_fit_tier  ON report_summary(fit_tier);
      CREATE INDEX IF NOT EXISTS idx_summary_generated ON report_summary(generated_at);
      CREATE INDEX IF NOT EXISTS idx_summary_seaa      ON report_summary(seaa_status);
    `);
  }

  /* ── Email-identity migration ────────────────────────────────────
     Email is now the student identity. Enforce one row per email with a
     UNIQUE index. Before adding it, collapse any duplicate-email rows left
     by the old session_id-only model (admin row + login row for the same
     student). Keep the row that has a report (rule: "test taken" = report
     exists); if none has a report, keep the oldest by registered_at. Loser
     rows are deleted; their child tables cascade via FK.
  ─────────────────────────────────────────────────────────────────── */
  try {
    const dupEmails = _db.prepare(`
      SELECT LOWER(TRIM(email)) AS em, COUNT(*) AS n
      FROM students
      WHERE email IS NOT NULL AND TRIM(email) <> ''
      GROUP BY LOWER(TRIM(email))
      HAVING n > 1
    `).all();

    if (dupEmails.length) {
      process.stderr.write('[WARN]  [DB] Email migration: collapsing ' + dupEmails.length + ' duplicate-email group(s).\n');
      _db.pragma('foreign_keys = ON'); // ensure child rows cascade on delete
      const dedupeTx = _db.transaction(() => {
        for (const { em } of dupEmails) {
          const rows = _db.prepare(`
            SELECT s.session_id,
                   s.registered_at,
                   CASE WHEN rs.session_id IS NOT NULL THEN 1 ELSE 0 END AS has_report
            FROM students s
            LEFT JOIN report_summary rs ON rs.session_id = s.session_id
            WHERE LOWER(TRIM(s.email)) = ?
          `).all(em);

          // Winner: report first, then oldest registered_at.
          rows.sort((a, b) => {
            if (a.has_report !== b.has_report) return b.has_report - a.has_report;
            return String(a.registered_at || '').localeCompare(String(b.registered_at || ''));
          });
          const keep = rows[0];
          for (const r of rows) {
            if (r.session_id === keep.session_id) continue;
            _db.prepare(`DELETE FROM students WHERE session_id = ?`).run(r.session_id);
          }
          process.stderr.write('[INFO]  [DB] email "' + em + '": kept ' + keep.session_id +
            ' (report=' + keep.has_report + '), removed ' + (rows.length - 1) + ' duplicate(s).\n');
        }
      });
      dedupeTx();
    }

    // Normalise emails to a canonical lowercase/trim form so the UNIQUE
    // index treats "A@x.com" and "a@x.com " as the same identity.
    _db.exec(`UPDATE students SET email = LOWER(TRIM(email)) WHERE email IS NOT NULL AND email <> LOWER(TRIM(email))`);

    // Enforce uniqueness. Partial index so legacy rows with blank email
    // (should not exist, but be safe) don't all collide on ''.
    _db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_students_email
              ON students(email) WHERE email IS NOT NULL AND email <> ''`);
  } catch (e) {
    process.stderr.write('[ERROR] [DB] Email-identity migration failed: ' + e.message + '\n');
  }

  /* ── Drop superseded "reports" table from very old deployments ─ */
  try {
    const legacyExists = _db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='reports'`
    ).get();
    if (legacyExists) {
      process.stderr.write('[WARN]  [DB] Dropping legacy "reports" table — superseded by report_summary + FK tables.\n');
      _db.exec('DROP TABLE reports');
    }
  } catch (_) {}

  process.stdout.write('✅  SQLite initialised at ' + dbPath + '\n');
  return _db;
}

/* ══════════════════════════════════════════════════════════════════
   PREPARED STATEMENTS — built lazily after _initDb()
   Prepared once, reused for every request.
══════════════════════════════════════════════════════════════════ */
function _prep() {
  if (_stmts) return _stmts;
  const db = _initDb();

  _stmts = {

    /* FIX Bug 1 + 4: registered_at absent from DO UPDATE — written once, never overwritten */
    upsertStudent: db.prepare(`
      INSERT INTO students (
        session_id, first_name, last_name, full_name, class, section,
        school, school_state, school_city, age, gender, email, registered_at
      ) VALUES (
        @session_id, @first_name, @last_name, @full_name, @class, @section,
        @school, @school_state, @school_city, @age, @gender, @email, @registered_at
      )
      ON CONFLICT(session_id) DO UPDATE SET
        first_name   = excluded.first_name,
        last_name    = excluded.last_name,
        full_name    = excluded.full_name,
        class        = excluded.class,
        section      = excluded.section,
        school       = excluded.school,
        school_state = excluded.school_state,
        school_city  = excluded.school_city,
        age          = excluded.age,
        gender       = excluded.gender,
        email        = excluded.email
        -- registered_at intentionally omitted: preserved forever after first INSERT
    `),

    ensureAssessmentRow: db.prepare(`
      INSERT INTO assessments (session_id, saved_at)
      VALUES (@session_id, @saved_at)
      ON CONFLICT(session_id) DO NOTHING
    `),

    markCompleted: db.prepare(`
      UPDATE students SET completed_at = @ts WHERE session_id = @session_id
    `),

    markReportTimestamp: db.prepare(`
      UPDATE students SET report_generated_at = @ts WHERE session_id = @session_id
    `),

    insertSectionProgress: db.prepare(`
      INSERT INTO section_progress (session_id, module_key, submitted_at, duration_seconds)
      VALUES (@session_id, @module_key, @submitted_at, @duration_seconds)
    `),

    /* FIX Bug 3: AI prose only overwritten when is_fallback = 0 */
    upsertReportSummary: db.prepare(`
      INSERT OR REPLACE INTO report_summary (
        session_id, generated_at, is_fallback,
        holistic_summary, aptitude_profile, interest_profile,
        internal_motivators, personality_profile, wellbeing_guidance, stream_advice,
        avg_personality_stanine, avg_aptitude_stanine, top_interest_score,
        fit_score, fit_tier,
        personality_status, aptitude_status, interest_status, seaa_status,
        strong_fit_pathways, emerging_fit_pathways, exploratory_pathways,
        recommended_primary, recommended_alternate, recommended_exploratory,
        top_personality_traits_json, strong_aptitudes_json, emerging_aptitudes_json,
        top3_interests_json
      ) VALUES (
        @session_id, @generated_at, @is_fallback,
        @holistic_summary, @aptitude_profile, @interest_profile,
        @internal_motivators, @personality_profile, @wellbeing_guidance, @stream_advice,
        @avg_personality_stanine, @avg_aptitude_stanine, @top_interest_score,
        @fit_score, @fit_tier,
        @personality_status, @aptitude_status, @interest_status, @seaa_status,
        @strong_fit_pathways, @emerging_fit_pathways, @exploratory_pathways,
        @recommended_primary, @recommended_alternate, @recommended_exploratory,
        @top_personality_traits_json, @strong_aptitudes_json, @emerging_aptitudes_json,
        @top3_interests_json
      )
      ON CONFLICT(session_id) DO UPDATE SET
        generated_at = excluded.generated_at,
        is_fallback  = excluded.is_fallback,
        holistic_summary    = CASE WHEN excluded.is_fallback = 0 THEN excluded.holistic_summary    ELSE holistic_summary    END,
        aptitude_profile    = CASE WHEN excluded.is_fallback = 0 THEN excluded.aptitude_profile    ELSE aptitude_profile    END,
        interest_profile    = CASE WHEN excluded.is_fallback = 0 THEN excluded.interest_profile    ELSE interest_profile    END,
        internal_motivators = CASE WHEN excluded.is_fallback = 0 THEN excluded.internal_motivators ELSE internal_motivators END,
        personality_profile = CASE WHEN excluded.is_fallback = 0 THEN excluded.personality_profile ELSE personality_profile END,
        wellbeing_guidance  = CASE WHEN excluded.is_fallback = 0 THEN excluded.wellbeing_guidance  ELSE wellbeing_guidance  END,
        stream_advice       = CASE WHEN excluded.is_fallback = 0 THEN excluded.stream_advice       ELSE stream_advice       END,
        avg_personality_stanine     = excluded.avg_personality_stanine,
        avg_aptitude_stanine        = excluded.avg_aptitude_stanine,
        top_interest_score          = excluded.top_interest_score,
        fit_score                   = excluded.fit_score,
        fit_tier                    = excluded.fit_tier,
        personality_status          = excluded.personality_status,
        aptitude_status             = excluded.aptitude_status,
        interest_status             = excluded.interest_status,
        seaa_status                 = excluded.seaa_status,
        strong_fit_pathways         = excluded.strong_fit_pathways,
        emerging_fit_pathways       = excluded.emerging_fit_pathways,
        exploratory_pathways        = excluded.exploratory_pathways,
        recommended_primary         = excluded.recommended_primary,
        recommended_alternate       = excluded.recommended_alternate,
        recommended_exploratory     = excluded.recommended_exploratory,
        top_personality_traits_json = excluded.top_personality_traits_json,
        strong_aptitudes_json       = excluded.strong_aptitudes_json,
        emerging_aptitudes_json     = excluded.emerging_aptitudes_json,
        top3_interests_json         = excluded.top3_interests_json
    `),

    /* FIX Bug 2: INSERT OR REPLACE — atomic per-row, no DELETE step */
    upsertPersonality: db.prepare(`
      INSERT OR REPLACE INTO report_personality (session_id, position, name, stanine, band)
      VALUES (@session_id, @position, @name, @stanine, @band)
    `),
    upsertAptitude: db.prepare(`
      INSERT OR REPLACE INTO report_aptitude (session_id, position, key, name, stanine, band, raw_score, max_score)
      VALUES (@session_id, @position, @key, @name, @stanine, @band, @raw_score, @max_score)
    `),
    upsertInterest: db.prepare(`
      INSERT OR REPLACE INTO report_interests (session_id, rank, label, score, level)
      VALUES (@session_id, @rank, @label, @score, @level)
    `),
    upsertSeaa: db.prepare(`
      INSERT OR REPLACE INTO report_seaa (session_id, key, title, score, category, cat_label)
      VALUES (@session_id, @key, @title, @score, @category, @cat_label)
    `),
    upsertCareer: db.prepare(`
      INSERT OR REPLACE INTO report_careers (
        session_id, position, career, cluster,
        interest_fit, aptitude_fit, personality_fit, seaa_fit,
        suitability_pct, alignment, rationale
      ) VALUES (
        @session_id, @position, @career, @cluster,
        @interest_fit, @aptitude_fit, @personality_fit, @seaa_fit,
        @suitability_pct, @alignment, @rationale
      )
    `),

    /* Read helpers — used by getFullReport (prepared once, fast on repeat calls) */
    getStudent:     db.prepare(`SELECT * FROM students          WHERE session_id = ?`),
    getAssessment:  db.prepare(`SELECT * FROM assessments       WHERE session_id = ?`),
    getSummary:     db.prepare(`SELECT * FROM report_summary    WHERE session_id = ?`),
    getPersonality: db.prepare(`SELECT * FROM report_personality WHERE session_id = ? ORDER BY position`),
    getAptitude:    db.prepare(`SELECT * FROM report_aptitude    WHERE session_id = ? ORDER BY position`),
    getInterests:   db.prepare(`SELECT * FROM report_interests   WHERE session_id = ? ORDER BY rank`),
    getSeaa:        db.prepare(`SELECT * FROM report_seaa        WHERE session_id = ?`),
    getCareers:     db.prepare(`SELECT * FROM report_careers     WHERE session_id = ? ORDER BY position`),

    /* NEW: lookup by email — used by returning-student flow and counsellor unlock */
    getStudentByEmail: db.prepare(`
      SELECT s.*, rs.fit_tier, rs.fit_score, rs.recommended_primary, rs.seaa_status
      FROM students s
      LEFT JOIN report_summary rs ON rs.session_id = s.session_id
      WHERE lower(s.email) = lower(?)
      ORDER BY s.registered_at DESC
      LIMIT 1
    `),

    deleteCareersBySession: db.prepare(`DELETE FROM report_careers WHERE session_id = ?`),
  };

  /* Per-module UPDATE statements — each touches only its 4 columns */
  _stmts.updateModule = {};
  for (const m of MODULES) {
    _stmts.updateModule[m] = db.prepare(`
      UPDATE assessments SET
        ${m}_raw_answers      = @raw_answers,
        ${m}_scores_json      = @scores_json,
        ${m}_duration_seconds = @duration_seconds,
        ${m}_completed_at     = @completed_at,
        saved_at              = @saved_at
      WHERE session_id = @session_id
    `);
  }

  return _stmts;
}

/* ══════════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════════ */

function saveRegistration(student, sessionId) {
  const db = _initDb();
  const s  = _prep();
  const norm = String(student.email || '').toLowerCase().trim();

  // Atomic find-or-create keyed on email. Running the lookup and the insert
  // inside ONE transaction (plus the UNIQUE(email) backstop) removes the
  // check-then-write race: under 500 concurrent users, two first-time
  // registrations for the same email can't both insert. The loser reuses
  // the winner's row instead of throwing a 500.
  const result = db.transaction(() => {
    if (norm) {
      const existing = s.getStudentByEmail.get(norm);
      if (existing) {
        // Identity already exists — reuse it. Never overwrite, never dupe.
        return { session_id: existing.session_id, existing: true, testTaken: existing.fit_tier != null };
      }
    }
    s.upsertStudent.run({
      session_id:    sessionId,
      first_name:    student.firstName    || '',
      last_name:     student.lastName     || '',
      full_name:     student.fullName     || `${student.firstName || ''} ${student.lastName || ''}`.trim(),
      class:         student.class        || '',
      section:       student.section      || '',
      school:        student.school       || '',
      school_state:  student.schoolState  || '',
      school_city:   student.schoolCity   || '',
      age:           String(student.age   || ''),
      gender:        student.gender       || '',
      email:         norm,
      registered_at: student.registeredAt || new Date().toISOString(),
    });

    // Auto-register a new school in schools_registry if this student's school
    // isn't already there. schools_registry was previously admin-curated only
    // (added exclusively via the dashboard's manual "add school" screen), so a
    // student typing a brand-new school name (the "Other" free-text option at
    // registration) was silently invisible to School Management's per-school
    // access and filtering — it existed only as a free-text value on this row.
    // Defensive: a failure here is a missing side-effect, not a registration
    // failure, so it must never throw past this point.
    const schoolName = String(student.school || '').trim();
    if (schoolName) {
      try {
        const already = db.prepare(
          `SELECT id FROM schools_registry WHERE LOWER(name) = LOWER(?)`
        ).get(schoolName);
        if (!already) {
          db.prepare(`
            INSERT INTO schools_registry (name, city, state, added_at, active)
            VALUES (?, ?, ?, ?, 1)
          `).run(schoolName, student.schoolCity || null, student.schoolState || null, new Date().toISOString());
          try {
            db.prepare(`
              INSERT INTO audit_log (user_id, user_email, action, target, detail, ip, ts)
              VALUES (NULL, ?, 'school_auto_registered', ?, ?, NULL, ?)
            `).run(
              norm || 'unknown',
              schoolName,
              JSON.stringify({ city: student.schoolCity || null, state: student.schoolState || null, via: 'student_registration' }),
              new Date().toISOString()
            );
          } catch (_) { /* audit_log missing/unavailable — non-fatal */ }
        }
      } catch (_) { /* schools_registry not yet initialised — non-fatal */ }
    }

    return { session_id: sessionId, existing: false, testTaken: false };
  });

  try {
    return result();
  } catch (e) {
    // UNIQUE(email) collision from a simultaneous insert that committed first.
    // Resolve to the row that won and reuse it — this is success, not error.
    if (norm && /UNIQUE constraint failed: students.email/i.test(String(e.message))) {
      const row = s.getStudentByEmail.get(norm);
      if (row) return { session_id: row.session_id, existing: true, testTaken: row.fit_tier != null };
    }
    throw e;
  }
}

function saveSection(sessionId, moduleKey, payload) {
  if (!sessionId)                   throw new Error('saveSection: sessionId is required');
  if (!MODULES.includes(moduleKey)) throw new Error('saveSection: unknown module ' + moduleKey);

  const db  = _initDb();
  const s   = _prep();
  const now = new Date().toISOString();
  const p   = payload || {};

  db.transaction(() => {
    s.ensureAssessmentRow.run({ session_id: sessionId, saved_at: now });
    s.updateModule[moduleKey].run({
      session_id:       sessionId,
      saved_at:         now,
      completed_at:     now,
      raw_answers:      JSON.stringify(p.raw_answers ?? null),
      scores_json:      JSON.stringify(p.scores      ?? null),
      duration_seconds: Math.floor(p.duration || 0),
    });
    s.insertSectionProgress.run({
      session_id:       sessionId,
      module_key:       moduleKey,
      submitted_at:     now,
      duration_seconds: Math.floor(p.duration || 0),
    });
  })();
}

function saveReport({ sessionId, student, assessments, report }) {
  if (!sessionId) throw new Error('saveReport: sessionId is required');

  const db  = _initDb();
  const s   = _prep();
  const now = new Date().toISOString();

  db.transaction(() => {
    /* 1) Student */
    if (student) {
      s.upsertStudent.run({
        session_id:    sessionId,
        first_name:    student.firstName    || '',
        last_name:     student.lastName     || '',
        full_name:     student.fullName     || '',
        class:         student.class        || '',
        section:       student.section      || '',
        school:        student.school       || '',
        school_state:  student.schoolState  || '',
        school_city:   student.schoolCity   || '',
        age:           String(student.age   || ''),
        gender:        student.gender       || '',
        email:         student.email        || '',
        registered_at: student.registeredAt || now,
      });
    }

    /* 2) Assessments */
    if (assessments && typeof assessments === 'object') {
      s.ensureAssessmentRow.run({ session_id: sessionId, saved_at: now });
      for (const m of MODULES) {
        let p = assessments[m];
        if (!p && m.startsWith('daab_') && assessments.daab) p = assessments.daab[m.slice(5)];
        if (!p) continue;
        s.updateModule[m].run({
          session_id:       sessionId,
          saved_at:         now,
          completed_at:     p.completed_at || now,
          raw_answers:      JSON.stringify(p.raw_answers ?? null),
          scores_json:      JSON.stringify(p.scores      ?? null),
          duration_seconds: Math.floor(p.duration || 0),
        });
      }
    }

    /* 3) Derive display rows */
    const personality = _derivePersonality(assessments || {});
    const aptitude    = _deriveAptitude(assessments    || {});
    const interests   = _deriveInterests(assessments   || {});
    const seaa        = _deriveSeaa(assessments        || {});
    const careers     = _deriveCareers(report         || {}, interests);

    /* 4) Child-table upserts (Bug 2 fix) */
    for (const row of personality) s.upsertPersonality.run({ session_id: sessionId, ...row });
    for (const row of aptitude)    s.upsertAptitude.run({ session_id: sessionId, ...row });
    for (const row of interests)   s.upsertInterest.run({ session_id: sessionId, ...row });
    for (const row of seaa)        s.upsertSeaa.run({ session_id: sessionId, ...row });
    s.deleteCareersBySession.run(sessionId);   // careers are position-keyed, safe inside transaction
    for (const row of careers)     s.upsertCareer.run({ session_id: sessionId, ...row });

    /* 5) Report summary (Bug 3 fix) */
    if (report && typeof report === 'object') {
      const PROSE_FIELDS = [
        'holistic_summary','aptitude_profile','interest_profile',
        'internal_motivators','personality_profile','wellbeing_guidance','stream_advice',
      ];
      const missing = PROSE_FIELDS.filter(f => !report[f]);
      if (missing.length) process.stderr.write('[WARN]  [DB] saveReport: missing AI fields for ' + sessionId + ' — ' + missing.join(', ') + '\n');

      const summary = _deriveSummary(personality, aptitude, interests, seaa, careers, report);
      s.upsertReportSummary.run({
        session_id:          sessionId,
        generated_at:        now,
        is_fallback:         report._fallback ? 1 : 0,
        holistic_summary:    report.holistic_summary    || '',
        aptitude_profile:    report.aptitude_profile    || '',
        interest_profile:    report.interest_profile    || '',
        internal_motivators: report.internal_motivators || '',
        personality_profile: report.personality_profile || '',
        wellbeing_guidance:  report.wellbeing_guidance  || '',
        stream_advice:       report.stream_advice       || '',
        ...summary,
      });
      s.markReportTimestamp.run({ session_id: sessionId, ts: now });
    } else {
      process.stderr.write('[WARN]  [DB] saveReport: no report object for session ' + sessionId + '\n');
    }

    /* 6) Mark completed */
    s.markCompleted.run({ session_id: sessionId, ts: now });
  })();
}

function getFullReport(sessionId) {
  const s = _prep();
  return {
    student:     s.getStudent.get(sessionId),
    assessments: s.getAssessment.get(sessionId),
    summary:     s.getSummary.get(sessionId),
    personality: s.getPersonality.all(sessionId),
    aptitude:    s.getAptitude.all(sessionId),
    interests:   s.getInterests.all(sessionId),
    seaa:        s.getSeaa.all(sessionId),
    careers:     s.getCareers.all(sessionId),
  };
}

function getSectionProgress(sessionId) {
  return _initDb().prepare(`
    SELECT module_key, submitted_at, duration_seconds
    FROM section_progress WHERE session_id = ? ORDER BY id ASC
  `).all(sessionId);
}

/* NEW: Lookup most recent session for an email + summary snapshot */
function getStudentByEmail(email) {
  if (!email) return null;
  return _prep().getStudentByEmail.get(String(email).toLowerCase().trim()) || null;
}

/* ── Email-identity resolver ──────────────────────────────────────
   The single source of truth for "what session_id owns this email".
   Used by /api/save-registration (student login/registration) so that:
     • email already in DB  → reuse that row's session_id (no new row)
     • email not in DB      → caller creates one row with the given sid
   Returns { session_id, exists, testTaken }.
     testTaken === true  ⇢ a report exists in the backend for this email
                          (this is the ONLY definition of "test taken").
   Because students.email is UNIQUE, there is at most one row per email,
   so this is unambiguous and race-safe (the UNIQUE index is the backstop
   if two requests try to insert the same email simultaneously).
─────────────────────────────────────────────────────────────────── */
function resolveStudentByEmail(email) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return { session_id: null, exists: false, testTaken: false };
  const row = _prep().getStudentByEmail.get(norm);
  if (!row) return { session_id: null, exists: false, testTaken: false };
  // getStudentByEmail LEFT JOINs report_summary; fit_tier is non-null only
  // when a report row exists. That is our "report exists in backend" test.
  const testTaken = row.fit_tier != null;
  return { session_id: row.session_id, exists: true, testTaken };
}

function close() {
  if (_db) {
    try { _db.close(); } catch (_) {}
    _db    = null;
    _stmts = null;
  }
}

/* ══════════════════════════════════════════════════════════════════
   DERIVATION HELPERS
   Mirror download.js so the DB always stores the same values the
   PDF renders. Keep these in sync if download.js changes.
══════════════════════════════════════════════════════════════════ */

const NMAP_TITLES = [
  'Leadership & Motivation','Assertiveness','Cautiousness',
  'Adaptability & Flexibility','Ethical Awareness','Creativity & Innovation',
  'Curiosity & Learning','Discipline & Sincerity','Patience & Resilience',
];
const DAAB_DISPLAY_ORDER = ['va','pa','na','sa','ma','ar','lsa','hma'];
const DAAB_LABELS = {
  va:'Verbal Ability', pa:'Perceptual Speed', na:'Numerical Ability',
  lsa:'Legal Studies Ability', hma:'Health & Medical Apt.',
  ar:'Abstract Reasoning', ma:'Mechanical Ability', sa:'Spatial Ability',
};
const _stanineBand = (s) => s >= 7 ? 'Strength' : s >= 4 ? 'Developing' : 'Needs Attention';
const _cpiLevel    = (sc) => sc >= 15 ? 'Strong' : sc >= 8 ? 'Moderate' : 'Low';
const _seaCatLabel = (cat) => {
  if (cat === 'A' || cat === 'B') return 'Strong Readiness';
  if (cat === 'C')                return 'Developing Readiness';
  return                              'Support Needed';
};
const SCORE_WORDS = new Set(['High','Moderate','Low','Strength','Developing','Needs Attention']);

function _derivePersonality(assessments) {
  const nmap = assessments && assessments.nmap && assessments.nmap.scores;
  const dims = (nmap && Array.isArray(nmap.dims) && nmap.dims.length) ? nmap.dims : [];
  const out  = [];
  for (let i = 0; i < 9; i++) {
    const d   = dims[i] || {};
    const stn = (typeof d.stanine === 'number' && d.stanine > 0) ? d.stanine : 5;
    const name = d.name || (d.label && !SCORE_WORDS.has(d.label) ? d.label : NMAP_TITLES[i]);
    out.push({ position: i, name: name || NMAP_TITLES[i], stanine: stn, band: _stanineBand(stn) });
  }
  return out;
}

function _deriveAptitude(assessments) {
  const daab = (assessments && assessments.daab) || {};
  return DAAB_DISPLAY_ORDER.map((key, i) => {
    const sub = daab[key] || (assessments && assessments['daab_' + key]) || {};
    const sc  = sub.scores || {};
    const stn = (typeof sc.stanine === 'number' && sc.stanine > 0) ? sc.stanine : 5;
    return {
      position: i, key, name: DAAB_LABELS[key], stanine: stn,
      band: sc.label || _stanineBand(stn),
      raw_score: (typeof sc.raw === 'number') ? sc.raw : null,
      max_score: (typeof sc.max === 'number') ? sc.max : null,
    };
  });
}

function _deriveInterests(assessments) {
  const cpi    = assessments && assessments.cpi && assessments.cpi.scores;
  const ranked = (cpi && Array.isArray(cpi.ranked)) ? cpi.ranked : [];
  return ranked.slice(0, 8).map((r, i) => ({
    rank:  i + 1,
    label: r.label || r.name || '—',
    score: typeof r.score === 'number' ? r.score : 0,
    level: r.level || _cpiLevel(typeof r.score === 'number' ? r.score : 0),
  }));
}

function _deriveSeaa(assessments) {
  const sea = (assessments && assessments.sea && assessments.sea.scores) || {};
  const dom = sea.domScores || { S: 0, E: 0, A: 0 };
  const cls = sea.cls       || {};
  return [
    { key:'S', title:'Social Adjustment',    score: dom.S || 0, category: (cls.S||{}).cat || null, cat_label: _seaCatLabel((cls.S||{}).cat) },
    { key:'E', title:'Emotional Adjustment', score: dom.E || 0, category: (cls.E||{}).cat || null, cat_label: _seaCatLabel((cls.E||{}).cat) },
    { key:'A', title:'Academic Adjustment',  score: dom.A || 0, category: (cls.A||{}).cat || null, cat_label: _seaCatLabel((cls.A||{}).cat) },
  ];
}

function _deriveCareers(report, derivedInterests) {
  const tbl = report && (report.career_table || report.career_table_json);
  let parsed = [];
  if (Array.isArray(tbl)) parsed = tbl;
  else if (typeof tbl === 'string') { try { parsed = JSON.parse(tbl); } catch (_) {} }

  const _normFit = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'high' || s === 'h') return 'High';
    if (s === 'low'  || s === 'l') return 'Low';
    return 'Moderate';
  };

  if (Array.isArray(parsed) && parsed.length) {
    return parsed.map((r, i) => {
      const pct = Math.round(parseFloat(r.suitability_pct) || 0);
      return {
        position: i, career: r.career || r.cluster || '—', cluster: r.cluster || null,
        interest_fit: _normFit(r.interest_fit), aptitude_fit: _normFit(r.aptitude_fit),
        personality_fit: _normFit(r.personality_fit), seaa_fit: _normFit(r.seaa_fit),
        suitability_pct: pct,
        alignment: r.alignment || (pct >= 80 ? 'Strong Fit' : pct >= 65 ? 'Emerging Fit' : 'Exploratory'),
        rationale: r.rationale || null,
      };
    });
  }

  // Fallback: derive from top interests when no career table exists
  return (derivedInterests || []).slice(0, 6).map((it, i) => ({
    position: i, career: it.label, cluster: it.label,
    interest_fit: it.level === 'Strong' ? 'High' : it.level === 'Moderate' ? 'Moderate' : 'Low',
    aptitude_fit: 'Moderate', personality_fit: 'Moderate', seaa_fit: 'Moderate',
    suitability_pct: Math.round((it.score / 20) * 100),
    alignment: it.score >= 15 ? 'Strong Fit' : it.score >= 8 ? 'Emerging Fit' : 'Exploratory',
    rationale: null,
  }));
}

function _deriveSummary(personality, aptitude, interests, seaa, careers, report) {
  const avgPers = personality.length ? personality.reduce((s,d) => s + d.stanine, 0) / personality.length : 5;
  const avgApt  = aptitude.length    ? aptitude.reduce((s,d) => s + d.stanine, 0)    / aptitude.length    : 5;
  const topInterestScore = (interests[0] && interests[0].score) || 0;

  const _pct = (s) => ((s - 1) / 8) * 100;
  let fitRaw  = (_pct(avgPers) * 0.30) + (_pct(avgApt) * 0.30) + ((topInterestScore / 20) * 100 * 0.40);
  for (const c of seaa) {
    if (c.cat_label === 'Support Needed')          fitRaw -= 7;
    else if (c.cat_label === 'Developing Readiness') fitRaw -= 3;
  }
  const fitScore = Math.max(0, Math.min(100, Math.round(fitRaw)));
  const fitTier  = fitScore >= 75 ? 'Strong Fit' : fitScore >= 55 ? 'Emerging Fit' : 'Exploratory Fit';

  const persStatus = avgPers >= 6.5 ? 'Strength' : avgPers >= 4 ? 'Developing' : 'Support Needed';
  const aptStatus  = avgApt  >= 6.5 ? 'Strength' : avgApt  >= 4 ? 'Developing' : 'Support Needed';
  const cpiStatus  = topInterestScore >= 15 ? 'Strength' : topInterestScore >= 8 ? 'Developing' : 'Support Needed';

  const seaWorst = seaa.reduce((w, c) => {
    if (c.cat_label === 'Support Needed') return 'Support Needed';
    if (c.cat_label === 'Developing Readiness' && w !== 'Support Needed') return 'Developing';
    return w;
  }, 'Strength');

  const strongFits   = careers.filter(c => (c.alignment||'').includes('Strong')).map(c => c.career);
  const emergingFits = careers.filter(c => (c.alignment||'').includes('Emerging')).map(c => c.career);
  const exploratory  = careers.filter(c => (c.alignment||'').includes('Exploratory')).map(c => c.career);
  const top3         = interests.slice(0, 3);

  return {
    avg_personality_stanine:     Number(avgPers.toFixed(2)),
    avg_aptitude_stanine:        Number(avgApt.toFixed(2)),
    top_interest_score:          topInterestScore,
    fit_score:                   fitScore,
    fit_tier:                    fitTier,
    personality_status:          persStatus,
    aptitude_status:             aptStatus,
    interest_status:             cpiStatus,
    seaa_status:                 seaWorst,
    strong_fit_pathways:         JSON.stringify(strongFits),
    emerging_fit_pathways:       JSON.stringify(emergingFits),
    exploratory_pathways:        JSON.stringify(exploratory),
    recommended_primary:         strongFits[0]  || emergingFits[0] || (top3[0] && top3[0].label) || 'Multidisciplinary',
    recommended_alternate:       strongFits[1]  || emergingFits[1] || emergingFits[0] || (top3[1] && top3[1].label) || 'Multidisciplinary',
    recommended_exploratory:     exploratory[0] || (top3[2] && top3[2].label) || 'Multidisciplinary',
    top_personality_traits_json: JSON.stringify(
      personality.slice().sort((a,b) => b.stanine - a.stanine).slice(0,3)
        .map(t => ({ name: t.name, stanine: t.stanine, label: t.band }))
    ),
    strong_aptitudes_json:   JSON.stringify(aptitude.filter(a => a.stanine >= 7).map(a => a.name)),
    emerging_aptitudes_json: JSON.stringify(aptitude.filter(a => a.stanine >= 4 && a.stanine <= 6).map(a => a.name)),
    top3_interests_json:     JSON.stringify(top3),
  };
}

/* ══════════════════════════════════════════════════════════════════
   EXPORTS
══════════════════════════════════════════════════════════════════ */
function getStudentBySessionId(sessionId) {
  if (!sessionId) return null;
  return _prep().getStudent.get(String(sessionId)) || null;
}

module.exports = {
  _initDb,
  saveRegistration,
  saveSection,
  saveReport,
  getFullReport,
  getSectionProgress,
  getStudentByEmail,
  resolveStudentByEmail,
  getStudentBySessionId,
  close,
  MODULES,
};
