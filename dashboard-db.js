/* ════════════════════════════════════════════════════════════════════
   dashboard-db.js  —  NuMind MAPS  |  Dashboard database layer
   Node.js 18+, CommonJS, better-sqlite3 (synchronous)

   Tables owned by this module (all share the main numind.db):
     dashboard_users        — counsellors, school-management, super-admins
     dashboard_sessions     — login session tokens (8-hour TTL)
     dashboard_user_schools — M:M: which schools a user can access
     reminder_log           — email reminders sent to students
     student_notes          — counsellor annotations per student
     student_tags           — counsellor labels per student
     audit_log              — all significant system actions
     schools_registry       — admin-managed official school list
     password_reset_tokens  — 1-hour reset tokens

   Aggregate analytics routes (new):
     getAggregateScores     — psychometric distribution across school
     getWellbeingAlerts     — students with SEA Support Needed
     getCareerDistribution  — recommended_primary career distribution
     getModuleTiming        — avg duration_seconds per assessment module
════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');

let _db = null;

/* ══════════════════════════════════════════════════════════════════
   INIT — idempotent, call once at startup
══════════════════════════════════════════════════════════════════ */
function init(db) {
  if (_db) return;
  _db = db;

  _db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'counsellor',
      active        INTEGER NOT NULL DEFAULT 1,
      permissions   TEXT    NOT NULL DEFAULT '{}',
      created_at    TEXT    NOT NULL,
      last_login    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_du_email ON dashboard_users(email);
    CREATE INDEX IF NOT EXISTS idx_du_role  ON dashboard_users(role);

    CREATE TABLE IF NOT EXISTS dashboard_user_schools (
      user_id  INTEGER NOT NULL,
      school   TEXT    NOT NULL COLLATE NOCASE,
      UNIQUE(user_id, school),
      FOREIGN KEY (user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dus_user   ON dashboard_user_schools(user_id);
    CREATE INDEX IF NOT EXISTS idx_dus_school ON dashboard_user_schools(school);

    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      FOREIGN KEY (user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ds_user    ON dashboard_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_ds_expires ON dashboard_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS reminder_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      student_email TEXT    NOT NULL,
      sent_by       INTEGER NOT NULL,
      sent_at       TEXT    NOT NULL,
      subject       TEXT,
      message       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rl_email  ON reminder_log(student_email);
    CREATE INDEX IF NOT EXISTS idx_rl_sentby ON reminder_log(sent_by);

    CREATE TABLE IF NOT EXISTS student_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      author_id  INTEGER NOT NULL,
      note       TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE,
      FOREIGN KEY (author_id)  REFERENCES dashboard_users(id)  ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sn_session ON student_notes(session_id);

    CREATE TABLE IF NOT EXISTS student_tags (
      session_id TEXT    NOT NULL,
      tag        TEXT    NOT NULL COLLATE NOCASE,
      added_by   INTEGER NOT NULL,
      added_at   TEXT    NOT NULL,
      PRIMARY KEY (session_id, tag),
      FOREIGN KEY (session_id) REFERENCES students(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_st_session ON student_tags(session_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      user_email TEXT,
      action     TEXT    NOT NULL,
      target     TEXT,
      detail     TEXT,
      ip         TEXT,
      ts         TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_al_ts      ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_al_user_id ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_al_action  ON audit_log(action);

    CREATE TABLE IF NOT EXISTS schools_registry (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      city     TEXT,
      state    TEXT,
      added_at TEXT    NOT NULL,
      active   INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES dashboard_users(id) ON DELETE CASCADE
    );
  `);

  /* ── ALTER TABLE guards — add columns missing from legacy DBs ── */
  const _addCol = (tbl, col, def) => {
    try { _db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); } catch (_) {}
  };
  _addCol('reminder_log',    'subject',     'TEXT');
  _addCol('reminder_log',    'message',     'TEXT');
  _addCol('dashboard_users', 'permissions', "TEXT DEFAULT '{}'");

  /* ── Seed default accounts on first boot ── */
  const count = _db.prepare('SELECT COUNT(*) AS c FROM dashboard_users').get();
  if (count.c === 0) {
    const now    = new Date().toISOString();
    // Generate a cryptographically random first-boot password
    // This is logged ONCE to stdout — capture it immediately and change it.
    const adminPw  = require('crypto').randomBytes(12).toString('base64url');
    const mgmtPw   = require('crypto').randomBytes(12).toString('base64url');
    const counsPw  = require('crypto').randomBytes(12).toString('base64url');

    const ins = _db.prepare(
      'INSERT INTO dashboard_users (name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    );
    const insSchool = _db.prepare(
      'INSERT OR IGNORE INTO dashboard_user_schools (user_id, school) VALUES (?, ?)'
    );
    ins.run('Super Admin',       'admin@numind.co.in',       _hashPassword(adminPw),  'admin',      now);
    const mgmt  = ins.run('School Management', 'management@numind.co.in', _hashPassword(mgmtPw),   'management', now);
    insSchool.run(mgmt.lastInsertRowid, 'Demo School');
    const couns = ins.run('School Counsellor','counsellor@numind.co.in', _hashPassword(counsPw),  'counsellor', now);
    insSchool.run(couns.lastInsertRowid, 'Demo School');

    // ⚠ Log once — capture from pm2 logs on first boot, then change immediately
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║        NUMIND MAPS — FIRST BOOT CREDENTIALS             ║');
    console.log('║  SAVE THESE NOW — they will never be shown again.       ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Admin:      admin@numind.co.in       / ${adminPw.padEnd(22)}║`);
    console.log(`║  Management: management@numind.co.in  / ${mgmtPw.padEnd(22)}║`);
    console.log(`║  Counsellor: counsellor@numind.co.in  / ${counsPw.padEnd(22)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Change all passwords immediately via the dashboard.    ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
  }
}

/* ══════════════════════════════════════════════════════════════════
   PASSWORD HASHING
══════════════════════════════════════════════════════════════════ */
// Salted password hashing using scrypt (memory-hard, GPU-resistant)
// Format: salt:hash (both hex) — stored in password_hash column
function _hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return salt + ':' + hash;
}

function _verifyPassword(plain, stored) {
  try {
    if (!stored || !stored.includes(':')) {
      // Legacy SHA-256 hash (pre-migration) — accept but log for upgrade
      const sha = crypto.createHash('sha256').update(String(plain)).digest('hex');
      return sha === stored;
    }
    const [salt, hash] = stored.split(':');
    const attempt = crypto.scryptSync(String(plain), salt, 32).toString('hex');
    return attempt === hash;
  } catch { return false; }
}

/* ══════════════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════════════ */
function login(email, password) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  const user = _db.prepare(`
    SELECT id, name, email, role, active, permissions, password_hash
    FROM dashboard_users
    WHERE LOWER(email) = ?
  `).get(norm);

  if (!user || !user.active) return null;
  if (!_verifyPassword(String(password || ''), user.password_hash)) return null;

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const now       = new Date().toISOString();

  // Wrap both writes in a transaction — atomic and reduces the lock window
  _db.transaction(() => {
    _db.prepare('INSERT INTO dashboard_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
       .run(token, user.id, now, expiresAt);
    _db.prepare('UPDATE dashboard_users SET last_login = ? WHERE id = ?')
       .run(now, user.id);
  })();

  const schools = _db.prepare('SELECT school FROM dashboard_user_schools WHERE user_id = ?')
                     .all(user.id).map(r => r.school);
  let permissions = {};
  try { permissions = JSON.parse(user.permissions || '{}'); } catch (_) {}
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, schools, permissions } };
}

function verifyToken(token) {
  if (!_db) throw new Error('dashboard-db not initialised');
  if (!token) return null;
  const now = new Date().toISOString();
  const session = _db.prepare(`
    SELECT s.user_id, u.name, u.email, u.role, u.active, u.permissions
    FROM dashboard_sessions s
    JOIN dashboard_users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);

  if (!session || !session.active) return null;
  const schools = _db.prepare('SELECT school FROM dashboard_user_schools WHERE user_id = ?')
                     .all(session.user_id).map(r => r.school);
  let permissions = {};
  try { permissions = JSON.parse(session.permissions || '{}'); } catch (_) {}
  return { id: session.user_id, name: session.name, email: session.email, role: session.role, schools, permissions };
}

function logout(token) {
  if (!_db) throw new Error('dashboard-db not initialised');
  _db.prepare('DELETE FROM dashboard_sessions WHERE token = ?').run(token);
}

function purgeExpiredSessions() {
  if (!_db) return;
  const now = new Date().toISOString();
  try {
    const info = _db.transaction(() => {
      const r = _db.prepare('DELETE FROM dashboard_sessions WHERE expires_at < ?').run(now);
      _db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?').run(now);
      return r;
    })();
    if (info && info.changes > 0) {
      process.stderr.write('[INFO]  [Dashboard] Purged ' + info.changes + ' expired session(s).\n');
    }
  } catch (e) {
    // SQLITE_BUSY during purge is non-fatal — skip this cycle, try next hour
    if (!e.message.includes('database is locked')) throw e;
  }
}

/* ══════════════════════════════════════════════════════════════════
   USER MANAGEMENT
══════════════════════════════════════════════════════════════════ */
function listUsers() {
  if (!_db) throw new Error('dashboard-db not initialised');
  const users = _db.prepare(
    'SELECT id, name, email, role, active, permissions, created_at, last_login FROM dashboard_users ORDER BY created_at DESC'
  ).all();
  return users.map(u => {
    const schools = _db.prepare('SELECT school FROM dashboard_user_schools WHERE user_id = ?')
                       .all(u.id).map(r => r.school);
    let permissions = {};
    try { permissions = JSON.parse(u.permissions || '{}'); } catch (_) {}
    return { ...u, permissions, schools };
  });
}

function createUser({ name, email, password, role, schools = [], permissions = {} }) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  const info = _db.prepare(
    'INSERT INTO dashboard_users (name, email, password_hash, role, active, permissions, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
  ).run(
    String(name).slice(0, 200), norm, _hashPassword(String(password || '')),
    role || 'counsellor', JSON.stringify(permissions || {}), new Date().toISOString()
  );
  const userId = info.lastInsertRowid;
  const ins = _db.prepare('INSERT OR IGNORE INTO dashboard_user_schools (user_id, school) VALUES (?, ?)');
  for (const s of schools) { if (s) ins.run(userId, String(s).trim()); }
  return userId;
}

function updateUser({ id, name, email, password, role, active, schools, permissions }) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const fields = [], vals = [];
  if (name        !== undefined) { fields.push('name = ?');          vals.push(String(name).slice(0, 200)); }
  if (email       !== undefined) { fields.push('email = ?');         vals.push(String(email).toLowerCase().trim()); }
  if (role        !== undefined) { fields.push('role = ?');          vals.push(role); }
  if (active      !== undefined) { fields.push('active = ?');        vals.push(active ? 1 : 0); }
  if (password    !== undefined) { fields.push('password_hash = ?'); vals.push(_hashPassword(String(password))); }
  if (permissions !== undefined) { fields.push('permissions = ?');   vals.push(JSON.stringify(permissions || {})); }
  if (fields.length) {
    vals.push(id);
    _db.prepare(`UPDATE dashboard_users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (Array.isArray(schools)) {
    _db.prepare('DELETE FROM dashboard_user_schools WHERE user_id = ?').run(id);
    const ins = _db.prepare('INSERT OR IGNORE INTO dashboard_user_schools (user_id, school) VALUES (?, ?)');
    for (const s of schools) { if (s) ins.run(id, String(s).trim()); }
  }
}

function deleteUser(id) {
  if (!_db) throw new Error('dashboard-db not initialised');
  _db.prepare('DELETE FROM dashboard_users WHERE id = ?').run(id);
}

function getUserByEmail(email) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  return _db.prepare('SELECT id, name, email, role FROM dashboard_users WHERE LOWER(email) = ? AND active = 1').get(norm);
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT DATA — scoped to school(s)
══════════════════════════════════════════════════════════════════ */

/* ── Helper: build school IN clause ── */
function _schoolClause(schools) {
  const list = (Array.isArray(schools) ? schools : [schools]).filter(Boolean);
  return {
    ph:     list.map(() => '?').join(','),
    params: list.map(x => x.toLowerCase()),
  };
}

function getStudentsBySchool(schools, { class: cls, section, search, limit = 200, offset = 0 } = {}) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const { ph, params } = _schoolClause(schools);
  if (!params.length) return [];

  let where = `WHERE LOWER(s.school) IN (${ph})`;
  const p   = [...params];
  if (cls)    { where += ' AND s.class = ?';    p.push(cls); }
  if (section){ where += ' AND s.section = ?';  p.push(section); }
  if (search) {
    where += ' AND (LOWER(s.full_name) LIKE ? OR LOWER(s.email) LIKE ?)';
    const q = `%${search.toLowerCase()}%`;
    p.push(q, q);
  }

  return _db.prepare(`
    SELECT
      s.session_id, s.first_name, s.last_name, s.full_name,
      s.class, s.section, s.school, s.email, s.gender, s.age,
      s.registered_at, s.completed_at, s.report_generated_at,
      CASE
        WHEN rs.session_id IS NOT NULL THEN 'completed'
        WHEN a.session_id  IS NOT NULL THEN 'in_progress'
        ELSE 'not_started'
      END AS status,
      (CASE WHEN a.cpi_completed_at      IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.sea_completed_at      IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.nmap_completed_at     IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_va_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_pa_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_na_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_lsa_completed_at IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_hma_completed_at IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_ar_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_ma_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_sa_completed_at  IS NOT NULL THEN 1 ELSE 0 END) AS modules_done
    FROM students s
    LEFT JOIN assessments    a  ON a.session_id  = s.session_id
    LEFT JOIN report_summary rs ON rs.session_id = s.session_id
    ${where}
    ORDER BY s.registered_at DESC
    LIMIT ? OFFSET ?
  `).all(...p, limit, offset);
}

function countStudentsBySchool(schools) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const { ph, params } = _schoolClause(schools);
  if (!params.length) return { total: 0, completed: 0, in_progress: 0, not_started: 0 };

  return _db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN rs.session_id IS NOT NULL                            THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN rs.session_id IS NULL AND a.session_id IS NOT NULL   THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN a.session_id  IS NULL                                THEN 1 ELSE 0 END) AS not_started
    FROM students s
    LEFT JOIN assessments    a  ON a.session_id  = s.session_id
    LEFT JOIN report_summary rs ON rs.session_id = s.session_id
    WHERE LOWER(s.school) IN (${ph})
  `).get(...params);
}

function getSchoolSummaries(schools) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const list = (Array.isArray(schools) ? schools : [schools]).filter(Boolean);
  return list.map(school => {
    const counts  = countStudentsBySchool([school]);
    const classes = _db.prepare(`
      SELECT s.class,
             COUNT(*) AS total,
             SUM(CASE WHEN rs.session_id IS NOT NULL THEN 1 ELSE 0 END)                          AS completed,
             SUM(CASE WHEN rs.session_id IS NULL AND a.session_id IS NOT NULL THEN 1 ELSE 0 END) AS in_progress
      FROM students s
      LEFT JOIN assessments    a  ON a.session_id  = s.session_id
      LEFT JOIN report_summary rs ON rs.session_id = s.session_id
      WHERE LOWER(s.school) = ?
      GROUP BY s.class ORDER BY s.class
    `).all(school.toLowerCase());
    return { school, ...counts, classes };
  });
}

function getAllSchools() {
  if (!_db) throw new Error('dashboard-db not initialised');
  return _db.prepare(`
    SELECT school, COUNT(*) AS total_students
    FROM students
    WHERE school IS NOT NULL AND school != ''
    GROUP BY LOWER(school)
    ORDER BY school
  `).all();
}

function getStudentBySessionId(sessionId) {
  if (!_db) throw new Error('dashboard-db not initialised');
  return _db.prepare(`
    SELECT s.*,
      CASE
        WHEN rs.session_id IS NOT NULL THEN 'completed'
        WHEN a.session_id  IS NOT NULL THEN 'in_progress'
        ELSE 'not_started'
      END AS status,
      (CASE WHEN a.cpi_completed_at      IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.sea_completed_at      IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.nmap_completed_at     IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_va_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_pa_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_na_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_lsa_completed_at IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_hma_completed_at IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_ar_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_ma_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN a.daab_sa_completed_at  IS NOT NULL THEN 1 ELSE 0 END) AS modules_done
    FROM students s
    LEFT JOIN assessments    a  ON a.session_id  = s.session_id
    LEFT JOIN report_summary rs ON rs.session_id = s.session_id
    WHERE s.session_id = ?
  `).get(sessionId) || null;
}

function getCompletionTrend(schools, days = 14) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const { ph, params } = _schoolClause(schools);
  if (!params.length) return [];
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return _db.prepare(`
    SELECT DATE(rs.generated_at) AS day, COUNT(*) AS completed
    FROM report_summary rs
    JOIN students s ON s.session_id = rs.session_id
    WHERE LOWER(s.school) IN (${ph}) AND DATE(rs.generated_at) >= ?
    GROUP BY day ORDER BY day
  `).all(...params, cutoff);
}

/* ══════════════════════════════════════════════════════════════════
   AGGREGATE ANALYTICS (power the dashboard overview panels)
══════════════════════════════════════════════════════════════════ */

/**
 * Psychometric aggregate across all completed students in schools.
 * Returns counts for personality/aptitude/interest/seaa status tiers,
 * average stanines, average fit score, and fit tier distribution.
 */
function getAggregateScores(schools) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const { ph, params } = _schoolClause(schools);
  if (!params.length) return {};

  return _db.prepare(`
    SELECT
      COUNT(*)                                                              AS total_completed,
      ROUND(AVG(rs.fit_score), 1)                                          AS avg_fit_score,
      ROUND(AVG(rs.avg_personality_stanine), 2)                            AS avg_personality_stanine,
      ROUND(AVG(rs.avg_aptitude_stanine), 2)                               AS avg_aptitude_stanine,
      SUM(CASE WHEN rs.fit_tier = 'Strong Fit'      THEN 1 ELSE 0 END)    AS fit_strong,
      SUM(CASE WHEN rs.fit_tier = 'Emerging Fit'    THEN 1 ELSE 0 END)    AS fit_emerging,
      SUM(CASE WHEN rs.fit_tier = 'Exploratory Fit' THEN 1 ELSE 0 END)    AS fit_exploratory,
      SUM(CASE WHEN rs.personality_status = 'Strength'       THEN 1 ELSE 0 END) AS pers_strength,
      SUM(CASE WHEN rs.personality_status = 'Developing'     THEN 1 ELSE 0 END) AS pers_developing,
      SUM(CASE WHEN rs.personality_status = 'Support Needed' THEN 1 ELSE 0 END) AS pers_support,
      SUM(CASE WHEN rs.aptitude_status    = 'Strength'       THEN 1 ELSE 0 END) AS apt_strength,
      SUM(CASE WHEN rs.aptitude_status    = 'Developing'     THEN 1 ELSE 0 END) AS apt_developing,
      SUM(CASE WHEN rs.aptitude_status    = 'Support Needed' THEN 1 ELSE 0 END) AS apt_support,
      SUM(CASE WHEN rs.interest_status    = 'Strength'       THEN 1 ELSE 0 END) AS int_strength,
      SUM(CASE WHEN rs.interest_status    = 'Developing'     THEN 1 ELSE 0 END) AS int_developing,
      SUM(CASE WHEN rs.interest_status    = 'Support Needed' THEN 1 ELSE 0 END) AS int_support,
      SUM(CASE WHEN rs.seaa_status = 'Strength'          THEN 1 ELSE 0 END) AS sea_strength,
      SUM(CASE WHEN rs.seaa_status = 'Developing'        THEN 1 ELSE 0 END) AS sea_developing,
      SUM(CASE WHEN rs.seaa_status = 'Support Needed'    THEN 1 ELSE 0 END) AS sea_support
    FROM report_summary rs
    JOIN students s ON s.session_id = rs.session_id
    WHERE LOWER(s.school) IN (${ph})
  `).get(...params) || {};
}

/**
 * Students whose seaa_status = 'Support Needed', with their domain scores.
 * Used to surface the wellbeing alert panel on every dashboard overview.
 */
function getWellbeingAlerts(schools) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const { ph, params } = _schoolClause(schools);
  if (!params.length) return [];

  const students = _db.prepare(`
    SELECT s.session_id, s.full_name, s.first_name, s.school, s.class, s.section,
           s.email, s.gender, rs.seaa_status, rs.fit_score, rs.fit_tier
    FROM report_summary rs
    JOIN students s ON s.session_id = rs.session_id
    WHERE LOWER(s.school) IN (${ph})
      AND rs.seaa_status = 'Support Needed'
    ORDER BY rs.fit_score ASC
    LIMIT 100
  `).all(...params);

  return students.map(stu => {
    const seaa = _db.prepare(
      'SELECT title, score, category, cat_label FROM report_seaa WHERE session_id = ?'
    ).all(stu.session_id);
    return { ...stu, seaa };
  });
}

/**
 * Distribution of recommended_primary career pathways (from AI-generated reports).
 * This is real career stream data, NOT a proxy.
 */
function getCareerDistribution(schools) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const { ph, params } = _schoolClause(schools);
  if (!params.length) return [];

  const rows = _db.prepare(`
    SELECT rs.recommended_primary AS career, COUNT(*) AS count
    FROM report_summary rs
    JOIN students s ON s.session_id = rs.session_id
    WHERE LOWER(s.school) IN (${ph})
      AND rs.recommended_primary IS NOT NULL
      AND rs.recommended_primary != ''
    GROUP BY rs.recommended_primary
    ORDER BY count DESC
    LIMIT 20
  `).all(...params);

  const total = rows.reduce((a, r) => a + r.count, 0);
  return rows.map(r => ({
    career: r.career,
    count:  r.count,
    pct:    total ? Math.round(r.count / total * 100) : 0,
  }));
}

/**
 * Average time (in minutes) students spend on each assessment module.
 * Uses duration_seconds stored in assessments at section completion.
 */
function getModuleTiming(schools) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const { ph, params } = _schoolClause(schools);
  if (!params.length) return [];

  const MODULES = [
    { key: 'cpi',     label: 'CPI · Career Interests' },
    { key: 'sea',     label: 'SEA · Social-Emotional' },
    { key: 'nmap',    label: 'NMAP · Personality' },
    { key: 'daab_va', label: 'DAAB · Aptitude (Verbal)' },
  ];

  return MODULES.map(m => {
    const row = _db.prepare(`
      SELECT
        COUNT(*) AS completion_count,
        ROUND(AVG(a.${m.key}_duration_seconds) / 60.0, 1) AS avg_minutes
      FROM assessments a
      JOIN students s ON s.session_id = a.session_id
      WHERE LOWER(s.school) IN (${ph})
        AND a.${m.key}_completed_at IS NOT NULL
        AND a.${m.key}_duration_seconds > 0
    `).get(...params);
    return {
      module:           m.label,
      key:              m.key,
      avg_minutes:      row ? (row.avg_minutes || 0) : 0,
      completion_count: row ? (row.completion_count || 0) : 0,
    };
  });
}

/* ══════════════════════════════════════════════════════════════════
   REMINDERS
══════════════════════════════════════════════════════════════════ */
function logReminder({ studentEmail, sentBy, subject, message }) {
  if (!_db) throw new Error('dashboard-db not initialised');
  _db.prepare(
    'INSERT INTO reminder_log (student_email, sent_by, sent_at, subject, message) VALUES (?, ?, ?, ?, ?)'
  ).run(
    String(studentEmail).toLowerCase().trim(), sentBy,
    new Date().toISOString(), subject || null, message || null
  );
}

function getReminderLog({ sentBy, studentEmail, limit = 100 } = {}) {
  if (!_db) throw new Error('dashboard-db not initialised');
  if (studentEmail) {
    return _db.prepare(`
      SELECT rl.*, du.name AS sent_by_name
      FROM reminder_log rl
      LEFT JOIN dashboard_users du ON du.id = rl.sent_by
      WHERE LOWER(rl.student_email) = ?
      ORDER BY rl.sent_at DESC LIMIT ?
    `).all(String(studentEmail).toLowerCase().trim(), limit);
  }
  if (sentBy) {
    return _db.prepare('SELECT * FROM reminder_log WHERE sent_by = ? ORDER BY sent_at DESC LIMIT ?')
              .all(sentBy, limit);
  }
  return _db.prepare(`
    SELECT rl.*, du.name AS sent_by_name
    FROM reminder_log rl
    LEFT JOIN dashboard_users du ON du.id = rl.sent_by
    ORDER BY rl.sent_at DESC LIMIT ?
  `).all(limit);
}

/* ══════════════════════════════════════════════════════════════════
   AUDIT LOG
══════════════════════════════════════════════════════════════════ */
function auditLog({ userId, userEmail, action, target, detail, ip } = {}) {
  if (!_db) return;
  try {
    _db.prepare(
      'INSERT INTO audit_log (user_id, user_email, action, target, detail, ip, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId || null, userEmail || null, action, target || null, detail || null, ip || null, new Date().toISOString());
  } catch (e) { console.error('[Audit]', e.message); }
}

function getAuditLog({ limit = 200, userId } = {}) {
  if (!_db) throw new Error('dashboard-db not initialised');
  if (userId) {
    return _db.prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY ts DESC LIMIT ?').all(userId, limit);
  }
  return _db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit);
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT CRUD (admin)
══════════════════════════════════════════════════════════════════ */
function upsertStudent({ session_id, first_name, last_name, full_name, email, class: cls, section, school, school_state, school_city, age, gender }) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const now = new Date().toISOString();
  const sid = session_id || crypto.randomBytes(16).toString('hex');
  _db.prepare(`
    INSERT INTO students (session_id, first_name, last_name, full_name, email, class, section, school, school_state, school_city, age, gender, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      first_name   = excluded.first_name,   last_name    = excluded.last_name,
      full_name    = excluded.full_name,     email        = excluded.email,
      class        = excluded.class,         section      = excluded.section,
      school       = excluded.school,        school_state = excluded.school_state,
      school_city  = excluded.school_city,   age          = excluded.age,
      gender       = excluded.gender
  `).run(sid, first_name||'', last_name||'', full_name||(first_name+' '+(last_name||'')).trim(),
         email||'', cls||'', section||'', school||'', school_state||'', school_city||'', age||'', gender||'', now);
  return sid;
}

function deleteStudent(sessionId) {
  if (!_db) throw new Error('dashboard-db not initialised');
  _db.prepare('DELETE FROM students WHERE session_id = ?').run(sessionId);
}

function resetStudentAssessment(sessionId) {
  if (!_db) throw new Error('dashboard-db not initialised');
  _db.transaction(() => {
    ['assessments','report_summary','report_personality','report_aptitude',
     'report_interests','report_seaa','report_careers','section_progress']
      .forEach(t => _db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sessionId));
    _db.prepare('UPDATE students SET completed_at = NULL, report_generated_at = NULL WHERE session_id = ?').run(sessionId);
  })();
}

function moveStudent(sessionId, fields) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const ALLOWED = ['class','section','school','first_name','last_name','full_name','email','age','gender','school_state','school_city'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.includes(k) && v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(sessionId);
  _db.prepare(`UPDATE students SET ${sets.join(', ')} WHERE session_id = ?`).run(...vals);
}

/* ══════════════════════════════════════════════════════════════════
   NOTES & TAGS
══════════════════════════════════════════════════════════════════ */
function addStudentNote({ sessionId, authorId, note }) {
  if (!_db) throw new Error('dashboard-db not initialised');
  return _db.prepare(
    'INSERT INTO student_notes (session_id, author_id, note, created_at) VALUES (?, ?, ?, ?)'
  ).run(sessionId, authorId, String(note).slice(0, 2000), new Date().toISOString()).lastInsertRowid;
}

function getStudentNotes(sessionId) {
  if (!_db) throw new Error('dashboard-db not initialised');
  return _db.prepare(`
    SELECT sn.*, du.name AS author_name
    FROM student_notes sn
    LEFT JOIN dashboard_users du ON du.id = sn.author_id
    WHERE sn.session_id = ? ORDER BY sn.created_at DESC
  `).all(sessionId);
}

function deleteStudentNote(noteId, authorId) {
  if (!_db) throw new Error('dashboard-db not initialised');
  _db.prepare('DELETE FROM student_notes WHERE id = ? AND author_id = ?').run(noteId, authorId);
}

function setStudentTags(sessionId, tags, addedBy) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const now = new Date().toISOString();
  _db.transaction(() => {
    _db.prepare('DELETE FROM student_tags WHERE session_id = ?').run(sessionId);
    const ins = _db.prepare('INSERT OR IGNORE INTO student_tags (session_id, tag, added_by, added_at) VALUES (?, ?, ?, ?)');
    for (const t of tags) { if (t) ins.run(sessionId, String(t).trim().slice(0, 64), addedBy, now); }
  })();
}

function getStudentTags(sessionId) {
  if (!_db) throw new Error('dashboard-db not initialised');
  return _db.prepare('SELECT tag FROM student_tags WHERE session_id = ? ORDER BY added_at')
            .all(sessionId).map(r => r.tag);
}

/* ══════════════════════════════════════════════════════════════════
   SCHOOLS REGISTRY
══════════════════════════════════════════════════════════════════ */
function listRegisteredSchools() {
  if (!_db) throw new Error('dashboard-db not initialised');
  return _db.prepare('SELECT * FROM schools_registry ORDER BY name').all();
}

function upsertRegisteredSchool({ id, name, city, state, active }) {
  if (!_db) throw new Error('dashboard-db not initialised');
  if (id) {
    const fields = [], vals = [];
    if (name   !== undefined) { fields.push('name = ?');   vals.push(name); }
    if (city   !== undefined) { fields.push('city = ?');   vals.push(city); }
    if (state  !== undefined) { fields.push('state = ?');  vals.push(state); }
    if (active !== undefined) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
    if (fields.length) { vals.push(id); _db.prepare(`UPDATE schools_registry SET ${fields.join(', ')} WHERE id = ?`).run(...vals); }
    return id;
  }
  return _db.prepare(
    'INSERT OR IGNORE INTO schools_registry (name, city, state, added_at, active) VALUES (?, ?, ?, ?, 1)'
  ).run(String(name).slice(0, 200), city||'', state||'', new Date().toISOString()).lastInsertRowid;
}

function deleteRegisteredSchool(id) {
  if (!_db) throw new Error('dashboard-db not initialised');
  _db.prepare('DELETE FROM schools_registry WHERE id = ?').run(id);
}

/* ══════════════════════════════════════════════════════════════════
   PASSWORD RESET
══════════════════════════════════════════════════════════════════ */
function createPasswordResetToken(userId) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const token = crypto.randomBytes(32).toString('hex');
  const exp   = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  _db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
  _db.prepare('INSERT INTO password_reset_tokens (token, user_id, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)')
     .run(token, userId, new Date().toISOString(), exp);
  return token;
}

function consumePasswordResetToken(token, newPassword) {
  if (!_db) throw new Error('dashboard-db not initialised');
  const now = new Date().toISOString();
  const row = _db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > ?').get(token, now);
  if (!row) return false;
  _db.transaction(() => {
    _db.prepare('UPDATE dashboard_users SET password_hash = ? WHERE id = ?').run(_hashPassword(String(newPassword)), row.user_id);
    _db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);
  })();
  return true;
}

/* ══════════════════════════════════════════════════════════════════
   EXPORTS
══════════════════════════════════════════════════════════════════ */
module.exports = {
  init,
  /* auth */
  login, verifyToken, logout, purgeExpiredSessions,
  /* users */
  listUsers, createUser, updateUser, deleteUser, getUserByEmail,
  /* students */
  getStudentsBySchool, getStudentBySessionId,
  countStudentsBySchool, getSchoolSummaries, getAllSchools, getCompletionTrend,
  /* student CRUD */
  upsertStudent, deleteStudent, resetStudentAssessment, moveStudent,
  /* notes & tags */
  addStudentNote, getStudentNotes, deleteStudentNote,
  setStudentTags, getStudentTags,
  /* reminders */
  logReminder, getReminderLog,
  /* audit */
  auditLog, getAuditLog,
  /* schools registry */
  listRegisteredSchools, upsertRegisteredSchool, deleteRegisteredSchool,
  /* password reset */
  createPasswordResetToken, consumePasswordResetToken,
  /* aggregate analytics (new) */
  getAggregateScores, getWellbeingAlerts, getCareerDistribution, getModuleTiming,
};
