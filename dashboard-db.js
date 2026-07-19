/* ════════════════════════════════════════════════════════════════════
   dashboard-db.js — NuMind MAPS  |  Dashboard database layer (PostgreSQL)
   --------------------------------------------------------------------
   Async rewrite on pg-core.js. Schema now owned by pg-core (initSchema).
   Every DB function is async. In-memory caches (token cache, school cache)
   are unchanged — they are per-worker and not DB-bound.

   Conversions from better-sqlite3:
     • ? → $1,$2,…; positional placeholders built dynamically for IN clauses.
     • .get/.all/.run → pg.one/pg.many/pg.exec; transactions → pg.tx.
     • lastInsertRowid → RETURNING id. .changes → rowCount.
     • 0/1 flags → BOOLEAN (active, used). LOWER(email/school) dropped where
       the column is CITEXT (email on dashboard_users/students-join, school on
       dashboard_user_schools/schools_registry). students.school is plain TEXT,
       so LOWER() is retained on its comparisons for case-insensitive matching.
     • DATE(x) → (x)::date  and  DATE(x) >= ? → x::date >= $n::date.
     • INSERT OR IGNORE → ON CONFLICT DO NOTHING.
     • COLLATE NOCASE ordering → CITEXT columns already sort case-insensitively.
     • permissions column is JSONB — pg returns it already parsed (object), so
       JSON.parse guards are made tolerant of receiving an object.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');
const pg     = require('./pg-core.js');

let _ready = false;

/* ══════════════════════════════════════════════════════════════════
   INIT — idempotent. Legacy signature init(db); arg ignored (schema owned
   by pg-core). Seeds default accounts on first boot.
══════════════════════════════════════════════════════════════════ */
async function init(_db) {
  if (_ready) return;
  await require('./db.js')._initDb();
  _ready = true;

  const count = await pg.one('SELECT COUNT(*)::int AS c FROM dashboard_users');
  if (count && count.c === 0) {
    const now     = new Date().toISOString();
    const adminPw = crypto.randomBytes(12).toString('base64url');
    const mgmtPw  = crypto.randomBytes(12).toString('base64url');
    const counsPw = crypto.randomBytes(12).toString('base64url');

    const insUser = async (name, email, pw, role) => {
      const row = await pg.one(
        `INSERT INTO dashboard_users (name, email, password_hash, role, active, created_at)
         VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id`,
        [name, email, _hashPassword(pw), role, now]
      );
      return row.id;
    };
    const insSchool = (uid, school) => pg.exec(
      `INSERT INTO dashboard_user_schools (user_id, school) VALUES ($1,$2)
       ON CONFLICT (user_id, school) DO NOTHING`,
      [uid, school]
    );

    await insUser('Super Admin', 'admin@numind.co.in', adminPw, 'admin');
    const mgmt  = await insUser('School Management', 'management@numind.co.in', mgmtPw, 'management');
    await insSchool(mgmt, 'Demo School');
    const couns = await insUser('School Counsellor', 'counsellor@numind.co.in', counsPw, 'counsellor');
    await insSchool(couns, 'Demo School');

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
function _hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return salt + ':' + hash;
}

function _verifyPassword(plain, stored) {
  try {
    if (!stored || !stored.includes(':')) {
      const sha = crypto.createHash('sha256').update(String(plain)).digest('hex');
      return sha.length === String(stored).length &&
             crypto.timingSafeEqual(Buffer.from(sha), Buffer.from(String(stored)));
    }
    const [salt, hash] = stored.split(':');
    const attempt = crypto.scryptSync(String(plain), salt, 32).toString('hex');
    return attempt.length === hash.length &&
           crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

/* permissions column is JSONB — pg may hand back an object already. Be tolerant. */
function _perms(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch { return {}; }
}

/* ══════════════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════════════ */
async function login(email, password) {
  const norm = String(email || '').toLowerCase().trim();
  const user = await pg.one(
    `SELECT id, name, email, role, active, permissions, password_hash
     FROM dashboard_users WHERE email = $1`,
    [norm]
  );
  if (!user || !user.active) return null;
  if (!_verifyPassword(String(password || ''), user.password_hash)) return null;

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const now       = new Date().toISOString();

  await pg.tx(async (c) => {
    await c.query('INSERT INTO dashboard_sessions (token, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)', [token, user.id, now, expiresAt]);
    await c.query('UPDATE dashboard_users SET last_login = $1 WHERE id = $2', [now, user.id]);
  });

  const schoolsRows = await pg.many('SELECT school FROM dashboard_user_schools WHERE user_id = $1', [user.id]);
  const schools = schoolsRows.map(r => r.school);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, schools, permissions: _perms(user.permissions) } };
}

/* Token verification cache: 30s in-memory LRU per worker. */
const _TOKEN_CACHE_TTL  = 30 * 1000;
const _TOKEN_CACHE_MAX  = 2000;
const _tokenCache       = new Map();

function _tokenCacheGet(token) {
  const entry = _tokenCache.get(token);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > _TOKEN_CACHE_TTL) { _tokenCache.delete(token); return undefined; }
  return entry.user;
}

function _tokenCacheSet(token, user) {
  if (_tokenCache.size >= _TOKEN_CACHE_MAX) {
    _tokenCache.delete(_tokenCache.keys().next().value);
  }
  _tokenCache.set(token, { user, cachedAt: Date.now() });
}

async function verifyToken(token) {
  if (!token) return null;
  const cached = _tokenCacheGet(token);
  if (cached !== undefined) return cached;

  const now = new Date().toISOString();
  const session = await pg.one(
    `SELECT s.user_id, u.name, u.email, u.role, u.active, u.permissions
     FROM dashboard_sessions s
     JOIN dashboard_users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > $2`,
    [token, now]
  );
  if (!session || !session.active) { _tokenCacheSet(token, null); return null; }
  const schoolsRows = await pg.many('SELECT school FROM dashboard_user_schools WHERE user_id = $1', [session.user_id]);
  const user = {
    id: session.user_id, name: session.name, email: session.email,
    role: session.role, schools: schoolsRows.map(r => r.school), permissions: _perms(session.permissions),
  };
  _tokenCacheSet(token, user);
  return user;
}

async function logout(token) {
  _tokenCache.delete(token);
  await pg.exec('DELETE FROM dashboard_sessions WHERE token = $1', [token]);
}

async function purgeExpiredSessions() {
  const now = new Date().toISOString();
  try {
    const info = await pg.tx(async (c) => {
      const r = await c.query('DELETE FROM dashboard_sessions WHERE expires_at < $1', [now]);
      await c.query('DELETE FROM password_reset_tokens WHERE expires_at < $1', [now]);
      return r;
    });
    if (info && info.rowCount > 0) {
      process.stderr.write('[INFO]  [Dashboard] Purged ' + info.rowCount + ' expired session(s).\n');
    }
  } catch (e) {
    throw e;
  }
}

/* ══════════════════════════════════════════════════════════════════
   USER MANAGEMENT
══════════════════════════════════════════════════════════════════ */
async function listUsers() {
  const users = await pg.many(
    'SELECT id, name, email, role, active, permissions, created_at, last_login FROM dashboard_users ORDER BY created_at DESC'
  );
  const out = [];
  for (const u of users) {
    const schoolsRows = await pg.many('SELECT school FROM dashboard_user_schools WHERE user_id = $1', [u.id]);
    out.push({ ...u, permissions: _perms(u.permissions), schools: schoolsRows.map(r => r.school) });
  }
  return out;
}

async function createUser({ name, email, password, role, schools = [], permissions = {} }) {
  const norm = String(email || '').toLowerCase().trim();
  const row = await pg.one(
    `INSERT INTO dashboard_users (name, email, password_hash, role, active, permissions, created_at)
     VALUES ($1,$2,$3,$4,TRUE,$5,$6) RETURNING id`,
    [String(name).slice(0, 200), norm, _hashPassword(String(password || '')),
     role || 'counsellor', JSON.stringify(permissions || {}), new Date().toISOString()]
  );
  const userId = row.id;
  for (const s of schools) {
    if (s) await pg.exec(
      'INSERT INTO dashboard_user_schools (user_id, school) VALUES ($1,$2) ON CONFLICT (user_id, school) DO NOTHING',
      [userId, String(s).trim()]
    );
  }
  return userId;
}

async function updateUser({ id, name, email, password, role, active, schools, permissions }) {
  const fields = [], vals = [];
  let n = 1;
  if (name        !== undefined) { fields.push(`name = $${n++}`);          vals.push(String(name).slice(0, 200)); }
  if (email       !== undefined) { fields.push(`email = $${n++}`);         vals.push(String(email).toLowerCase().trim()); }
  if (role        !== undefined) { fields.push(`role = $${n++}`);          vals.push(role); }
  if (active      !== undefined) { fields.push(`active = $${n++}`);        vals.push(!!active); }
  if (password    !== undefined) { fields.push(`password_hash = $${n++}`); vals.push(_hashPassword(String(password))); }
  if (permissions !== undefined) { fields.push(`permissions = $${n++}`);   vals.push(JSON.stringify(permissions || {})); }
  if (fields.length) {
    vals.push(id);
    await pg.exec(`UPDATE dashboard_users SET ${fields.join(', ')} WHERE id = $${n}`, vals);
  }
  if (Array.isArray(schools)) {
    await pg.exec('DELETE FROM dashboard_user_schools WHERE user_id = $1', [id]);
    for (const s of schools) {
      if (s) await pg.exec(
        'INSERT INTO dashboard_user_schools (user_id, school) VALUES ($1,$2) ON CONFLICT (user_id, school) DO NOTHING',
        [id, String(s).trim()]
      );
    }
  }
}

async function deleteUser(id) {
  await pg.exec('DELETE FROM dashboard_users WHERE id = $1', [id]);
}

async function getUserByEmail(email) {
  const norm = String(email || '').toLowerCase().trim();
  return pg.one('SELECT id, name, email, role FROM dashboard_users WHERE email = $1 AND active = TRUE', [norm]);
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT DATA — scoped to school(s)
══════════════════════════════════════════════════════════════════ */

/* Build a school IN clause with positional params starting at $start.
   students.school is plain TEXT → compare LOWER(s.school) IN (lowercased list). */
function _schoolClause(schools, start = 1) {
  const list = (Array.isArray(schools) ? schools : [schools]).filter(Boolean);
  return {
    list,
    ph:     list.map((_, i) => `$${start + i}`).join(','),
    params: list.map(x => x.toLowerCase()),
  };
}

const _STATUS_CLAUSE = {
  completed:   'rs.session_id IS NOT NULL',
  in_progress: 'rs.session_id IS NULL AND a.session_id IS NOT NULL',
  not_started: 'a.session_id IS NULL',
};

/* Returns { where, p } where placeholders are numbered from $1. */
function _studentWhere(schools, { class: cls, section, search, status } = {}) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return null;
  let where = `WHERE LOWER(s.school) IN (${ph})`;
  const p   = [...params];
  let n = params.length + 1;
  if (cls)     { where += ` AND s.class = $${n++}`;   p.push(cls); }
  if (section) { where += ` AND s.section = $${n++}`; p.push(section); }
  if (search)  {
    where += ` AND (LOWER(s.full_name) LIKE $${n} OR LOWER(s.email) LIKE $${n + 1})`;
    const q = `%${search.toLowerCase()}%`;
    p.push(q, q); n += 2;
  }
  if (status && _STATUS_CLAUSE[status]) where += ` AND ${_STATUS_CLAUSE[status]}`;
  return { where, p, nextIdx: n };
}

const _MODULES_DONE_EXPR = `
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
   CASE WHEN a.daab_sa_completed_at  IS NOT NULL THEN 1 ELSE 0 END)`;

async function getStudentsBySchool(schools, opts = {}) {
  const { limit = 200, offset = 0 } = opts;
  const w = _studentWhere(schools, opts);
  if (!w) return [];
  const { where, p, nextIdx } = w;
  const params = [...p, limit, offset];
  return pg.many(
    `SELECT
       s.session_id, s.first_name, s.last_name, s.full_name,
       s.class, s.section, s.school, s.email, s.gender, s.age,
       s.registered_at, s.completed_at, s.report_generated_at,
       CASE
         WHEN rs.session_id IS NOT NULL THEN 'completed'
         WHEN a.session_id  IS NOT NULL THEN 'in_progress'
         ELSE 'not_started'
       END AS status,
       ${_MODULES_DONE_EXPR} AS modules_done
     FROM students s
     LEFT JOIN assessments    a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     ${where}
     ORDER BY s.registered_at DESC
     LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
    params
  );
}

async function getAtRiskStudents(schools, { days = 3, limit = 1000 } = {}) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const n = params.length + 1;
  return pg.many(
    `SELECT
       s.session_id, s.first_name, s.last_name, s.full_name,
       s.class, s.section, s.school, s.email, s.gender, s.age, s.registered_at,
       CASE WHEN a.session_id IS NOT NULL THEN 'in_progress' ELSE 'not_started' END AS status,
       ${_MODULES_DONE_EXPR} AS modules_done
     FROM students s
     LEFT JOIN assessments    a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     WHERE LOWER(s.school) IN (${ph})
       AND rs.session_id IS NULL
       AND s.registered_at < $${n}
     ORDER BY s.registered_at ASC
     LIMIT $${n + 1}`,
    [...params, cutoff, limit]
  );
}

async function getGenderStats(schools) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  return pg.many(
    `SELECT
       COALESCE(NULLIF(TRIM(s.gender), ''), 'Other') AS gender,
       COUNT(*)::int AS total,
       SUM(CASE WHEN rs.session_id IS NOT NULL THEN 1 ELSE 0 END)::int AS completed
     FROM students s
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     WHERE LOWER(s.school) IN (${ph})
     GROUP BY COALESCE(NULLIF(TRIM(s.gender), ''), 'Other')`,
    params
  );
}

async function listCounsellorsForSchools(schools) {
  const list = (schools || []).map(s => String(s).toLowerCase());
  if (!list.length) return [];
  const ph = list.map((_, i) => `$${i + 1}`).join(',');
  const rows = await pg.many(
    `SELECT DISTINCT u.id, u.name, u.email, u.last_login, u.active
     FROM dashboard_users u
     JOIN dashboard_user_schools us ON us.user_id = u.id
     WHERE u.role = 'counsellor' AND u.active = TRUE
       AND LOWER(us.school) IN (${ph})
     ORDER BY u.name`,
    list
  );
  const out = [];
  for (const r of rows) {
    const srows = await pg.many('SELECT school FROM dashboard_user_schools WHERE user_id = $1 ORDER BY school', [r.id]);
    out.push({
      id: r.id, name: r.name, email: r.email, last_login: r.last_login,
      schools: srows.map(x => x.school).filter(s => list.includes(String(s).toLowerCase())),
    });
  }
  return out;
}

async function countStudentsFiltered(schools, opts = {}) {
  const w = _studentWhere(schools, opts);
  if (!w) return 0;
  const row = await pg.one(
    `SELECT COUNT(*)::int AS n
     FROM students s
     LEFT JOIN assessments    a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     ${w.where}`,
    w.p
  );
  return row ? row.n : 0;
}

async function countStudentsBySchool(schools) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return { total: 0, completed: 0, in_progress: 0, not_started: 0 };
  return pg.one(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN rs.session_id IS NOT NULL                          THEN 1 ELSE 0 END)::int AS completed,
       SUM(CASE WHEN rs.session_id IS NULL AND a.session_id IS NOT NULL THEN 1 ELSE 0 END)::int AS in_progress,
       SUM(CASE WHEN a.session_id  IS NULL                              THEN 1 ELSE 0 END)::int AS not_started
     FROM students s
     LEFT JOIN assessments    a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     WHERE LOWER(s.school) IN (${ph})`,
    params
  );
}

async function getSchoolSummaries(schools) {
  const list = (Array.isArray(schools) ? schools : [schools]).filter(Boolean);
  if (!list.length) return [];
  const ph     = list.map((_, i) => `$${i + 1}`).join(',');
  const params = list.map(x => x.toLowerCase());

  const rows = await pg.many(
    `SELECT
       s.school,
       s.class,
       COUNT(*)::int                                                                       AS total,
       SUM(CASE WHEN rs.session_id IS NOT NULL THEN 1 ELSE 0 END)::int                    AS completed,
       SUM(CASE WHEN rs.session_id IS NULL AND a.session_id IS NOT NULL THEN 1 ELSE 0 END)::int AS in_progress,
       SUM(CASE WHEN a.session_id IS NULL THEN 1 ELSE 0 END)::int                         AS not_started
     FROM students s
     LEFT JOIN assessments    a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     WHERE LOWER(s.school) IN (${ph})
     GROUP BY LOWER(s.school), s.school, s.class
     ORDER BY s.school, s.class`,
    params
  );

  const schoolMap = new Map();
  for (const row of rows) {
    const key = row.school.toLowerCase();
    if (!schoolMap.has(key)) {
      schoolMap.set(key, { school: row.school, total: 0, completed: 0, in_progress: 0, not_started: 0, classes: [] });
    }
    const s = schoolMap.get(key);
    s.total       += row.total;
    s.completed   += row.completed;
    s.in_progress += row.in_progress;
    s.not_started += row.not_started;
    s.classes.push({ class: row.class, total: row.total, completed: row.completed, in_progress: row.in_progress });
  }
  return [...schoolMap.values()];
}

/* getAllSchools cache — per-worker, 60s TTL. */
let _getAllSchoolsCache   = null;
let _getAllSchoolsCacheTs = 0;
const _SCHOOL_CACHE_TTL  = 60 * 1000;

async function getAllSchools() {
  const now = Date.now();
  if (_getAllSchoolsCache && (now - _getAllSchoolsCacheTs) < _SCHOOL_CACHE_TTL) {
    return _getAllSchoolsCache;
  }
  const result = await pg.many(
    `SELECT MIN(school) AS school, COUNT(*)::int AS total_students
     FROM students
     WHERE school IS NOT NULL AND school != ''
     GROUP BY LOWER(school)
     ORDER BY school`
  );
  _getAllSchoolsCache   = result;
  _getAllSchoolsCacheTs = now;
  return result;
}

function _invalidateSchoolCache() {
  _getAllSchoolsCache   = null;
  _getAllSchoolsCacheTs = 0;
}

async function getStudentBySessionId(sessionId) {
  return pg.one(
    `SELECT s.*,
       CASE
         WHEN rs.session_id IS NOT NULL THEN 'completed'
         WHEN a.session_id  IS NOT NULL THEN 'in_progress'
         ELSE 'not_started'
       END AS status,
       ${_MODULES_DONE_EXPR} AS modules_done
     FROM students s
     LEFT JOIN assessments    a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     WHERE s.session_id = $1`,
    [sessionId]
  );
}

async function getCompletionTrend(schools, days = 14) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const n = params.length + 1;
  return pg.many(
    `SELECT to_char((rs.generated_at)::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS completed
     FROM report_summary rs
     JOIN students s ON s.session_id = rs.session_id
     WHERE LOWER(s.school) IN (${ph}) AND (rs.generated_at)::date >= $${n}::date
     GROUP BY (rs.generated_at)::date ORDER BY (rs.generated_at)::date`,
    [...params, cutoff]
  );
}

/* ══════════════════════════════════════════════════════════════════
   AGGREGATE ANALYTICS
══════════════════════════════════════════════════════════════════ */
async function getAggregateScores(schools) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return {};
  return (await pg.one(
    `SELECT
       COUNT(*)::int                                                        AS total_completed,
       ROUND(AVG(rs.fit_score)::numeric, 1)::float8                        AS avg_fit_score,
       ROUND(AVG(rs.avg_personality_stanine)::numeric, 2)::float8          AS avg_personality_stanine,
       ROUND(AVG(rs.avg_aptitude_stanine)::numeric, 2)::float8             AS avg_aptitude_stanine,
       SUM(CASE WHEN rs.fit_tier = 'Strong Fit'      THEN 1 ELSE 0 END)::int AS fit_strong,
       SUM(CASE WHEN rs.fit_tier = 'Emerging Fit'    THEN 1 ELSE 0 END)::int AS fit_emerging,
       SUM(CASE WHEN rs.fit_tier = 'Exploratory Fit' THEN 1 ELSE 0 END)::int AS fit_exploratory,
       SUM(CASE WHEN rs.personality_status = 'Strength'       THEN 1 ELSE 0 END)::int AS pers_strength,
       SUM(CASE WHEN rs.personality_status = 'Developing'     THEN 1 ELSE 0 END)::int AS pers_developing,
       SUM(CASE WHEN rs.personality_status = 'Support Needed' THEN 1 ELSE 0 END)::int AS pers_support,
       SUM(CASE WHEN rs.aptitude_status    = 'Strength'       THEN 1 ELSE 0 END)::int AS apt_strength,
       SUM(CASE WHEN rs.aptitude_status    = 'Developing'     THEN 1 ELSE 0 END)::int AS apt_developing,
       SUM(CASE WHEN rs.aptitude_status    = 'Support Needed' THEN 1 ELSE 0 END)::int AS apt_support,
       SUM(CASE WHEN rs.interest_status    = 'Strength'       THEN 1 ELSE 0 END)::int AS int_strength,
       SUM(CASE WHEN rs.interest_status    = 'Developing'     THEN 1 ELSE 0 END)::int AS int_developing,
       SUM(CASE WHEN rs.interest_status    = 'Support Needed' THEN 1 ELSE 0 END)::int AS int_support,
       SUM(CASE WHEN rs.seaa_status = 'Strength'          THEN 1 ELSE 0 END)::int AS sea_strength,
       SUM(CASE WHEN rs.seaa_status = 'Developing'        THEN 1 ELSE 0 END)::int AS sea_developing,
       SUM(CASE WHEN rs.seaa_status = 'Support Needed'    THEN 1 ELSE 0 END)::int AS sea_support
     FROM report_summary rs
     JOIN students s ON s.session_id = rs.session_id
     WHERE LOWER(s.school) IN (${ph})`,
    params
  )) || {};
}

async function getWellbeingAlerts(schools) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const rows = await pg.many(
    `SELECT s.session_id, s.full_name, s.first_name, s.school, s.class, s.section,
            s.email, s.gender, rs.seaa_status, rs.fit_score, rs.fit_tier,
            se.title AS se_title, se.score AS se_score,
            se.category AS se_category, se.cat_label AS se_cat_label
     FROM report_summary rs
     JOIN students s      ON s.session_id  = rs.session_id
     LEFT JOIN report_seaa se ON se.session_id = rs.session_id
     WHERE LOWER(s.school) IN (${ph})
       AND rs.seaa_status = 'Support Needed'
     ORDER BY rs.fit_score ASC, s.session_id, se.key
     LIMIT 300`,
    params
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.session_id)) {
      map.set(row.session_id, {
        session_id: row.session_id, full_name: row.full_name, first_name: row.first_name,
        school: row.school, class: row.class, section: row.section,
        email: row.email, gender: row.gender, seaa_status: row.seaa_status,
        fit_score: row.fit_score, fit_tier: row.fit_tier, seaa: [],
      });
    }
    if (row.se_title !== null) {
      map.get(row.session_id).seaa.push({
        title: row.se_title, score: row.se_score, category: row.se_category, cat_label: row.se_cat_label,
      });
    }
  }
  return [...map.values()].slice(0, 100);
}

async function getCareerDistribution(schools) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const rows = await pg.many(
    `SELECT rs.recommended_primary AS career, COUNT(*)::int AS count
     FROM report_summary rs
     JOIN students s ON s.session_id = rs.session_id
     WHERE LOWER(s.school) IN (${ph})
       AND rs.recommended_primary IS NOT NULL
       AND rs.recommended_primary != ''
     GROUP BY rs.recommended_primary
     ORDER BY count DESC
     LIMIT 20`,
    params
  );
  const total = rows.reduce((a, r) => a + r.count, 0);
  return rows.map(r => ({ career: r.career, count: r.count, pct: total ? Math.round(r.count / total * 100) : 0 }));
}

async function getModuleTiming(schools) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const MODULES = [
    { key: 'cpi',     label: 'CPI · Career Interests' },
    { key: 'sea',     label: 'SEA · Social-Emotional' },
    { key: 'nmap',    label: 'NMAP · Personality' },
    { key: 'daab_va', label: 'DAAB · Aptitude (Verbal)' },
  ];
  const out = [];
  for (const m of MODULES) {
    const row = await pg.one(
      `SELECT
         COUNT(*)::int AS completion_count,
         ROUND((AVG(a.${m.key}_duration_seconds) / 60.0)::numeric, 1)::float8 AS avg_minutes
       FROM assessments a
       JOIN students s ON s.session_id = a.session_id
       WHERE LOWER(s.school) IN (${ph})
         AND a.${m.key}_completed_at IS NOT NULL
         AND a.${m.key}_duration_seconds > 0`,
      params
    );
    out.push({
      module: m.label, key: m.key,
      avg_minutes: row ? (Number(row.avg_minutes) || 0) : 0,
      completion_count: row ? (row.completion_count || 0) : 0,
    });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   ANALYTICS CACHE
══════════════════════════════════════════════════════════════════ */
const _CACHE_VERSION = 1;
const _CACHE_TTL_MS  = 5 * 60 * 1000;

function _cacheKey(scope, schools) {
  const sorted = (Array.isArray(schools) ? schools : [schools])
    .filter(Boolean).map(s => s.toLowerCase()).sort().join('|');
  return `${scope}:${sorted}`;
}

async function _cacheRead(key) {
  const row = await pg.one(
    'SELECT cache_value, computed_at, cache_version FROM analytics_cache WHERE cache_key = $1', [key]
  );
  if (!row) return null;
  if (row.cache_version !== _CACHE_VERSION) return null;
  if (Date.now() - new Date(row.computed_at).getTime() > _CACHE_TTL_MS) return null;
  try { return JSON.parse(row.cache_value); } catch { return null; }
}

async function _cacheWrite(key, value) {
  await pg.exec(
    `INSERT INTO analytics_cache (cache_key, cache_value, computed_at, cache_version)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (cache_key) DO UPDATE SET
       cache_value   = EXCLUDED.cache_value,
       computed_at   = EXCLUDED.computed_at,
       cache_version = EXCLUDED.cache_version`,
    [key, JSON.stringify(value), new Date().toISOString(), _CACHE_VERSION]
  );
}

async function getAggregateScoresCached(schools) {
  const key = _cacheKey('agg', schools);
  const cached = await _cacheRead(key);
  if (cached !== null) return cached;
  const fresh = await getAggregateScores(schools);
  await _cacheWrite(key, fresh);
  return fresh;
}

async function getSchoolSummariesCached(schools) {
  const key = _cacheKey('schools', schools);
  const cached = await _cacheRead(key);
  if (cached !== null) return cached;
  const fresh = await getSchoolSummaries(schools);
  await _cacheWrite(key, fresh);
  return fresh;
}

async function getCareerDistributionCached(schools) {
  const key = _cacheKey('careers', schools);
  const cached = await _cacheRead(key);
  if (cached !== null) return cached;
  const fresh = await getCareerDistribution(schools);
  await _cacheWrite(key, fresh);
  return fresh;
}

async function getModuleTimingCached(schools) {
  const key = _cacheKey('timing', schools);
  const cached = await _cacheRead(key);
  if (cached !== null) return cached;
  const fresh = await getModuleTiming(schools);
  await _cacheWrite(key, fresh);
  return fresh;
}

async function getCompletionTrendCached(schools, days = 14) {
  const key = _cacheKey(`trend_${days}`, schools);
  const cached = await _cacheRead(key);
  if (cached !== null) return cached;
  const fresh = await getCompletionTrend(schools, days);
  await _cacheWrite(key, fresh);
  return fresh;
}

async function refreshAnalyticsCache() {
  const schoolsAll = (await getAllSchools()).map(s => s.school);
  if (!schoolsAll.length) return;

  await _cacheWrite(_cacheKey('agg',       schoolsAll), await getAggregateScores(schoolsAll));
  await _cacheWrite(_cacheKey('schools',   schoolsAll), await getSchoolSummaries(schoolsAll));
  await _cacheWrite(_cacheKey('careers',   schoolsAll), await getCareerDistribution(schoolsAll));
  await _cacheWrite(_cacheKey('timing',    schoolsAll), await getModuleTiming(schoolsAll));
  await _cacheWrite(_cacheKey('trend_14',  schoolsAll), await getCompletionTrend(schoolsAll, 14));
  await _cacheWrite(_cacheKey('wellbeing', schoolsAll), await getWellbeingAlerts(schoolsAll));

  for (const school of schoolsAll) {
    await _cacheWrite(_cacheKey('agg',       [school]), await getAggregateScores([school]));
    await _cacheWrite(_cacheKey('schools',   [school]), await getSchoolSummaries([school]));
    await _cacheWrite(_cacheKey('careers',   [school]), await getCareerDistribution([school]));
    await _cacheWrite(_cacheKey('timing',    [school]), await getModuleTiming([school]));
    await _cacheWrite(_cacheKey('wellbeing', [school]), await getWellbeingAlerts([school]));
  }

  await pg.exec(
    'DELETE FROM analytics_cache WHERE computed_at < $1',
    [new Date(Date.now() - 2 * _CACHE_TTL_MS).toISOString()]
  );
}

async function getWellbeingAlertsCached(schools) {
  const key = _cacheKey('wellbeing', schools);
  const cached = await _cacheRead(key);
  if (cached !== null) return cached;
  const fresh = await getWellbeingAlerts(schools);
  await _cacheWrite(key, fresh);
  return fresh;
}

/* ══════════════════════════════════════════════════════════════════
   REMINDERS
══════════════════════════════════════════════════════════════════ */
async function logReminder({ studentEmail, sentBy, subject, message }) {
  await pg.exec(
    'INSERT INTO reminder_log (student_email, sent_by, sent_at, subject, message) VALUES ($1,$2,$3,$4,$5)',
    [String(studentEmail).toLowerCase().trim(), sentBy, new Date().toISOString(), subject || null, message || null]
  );
}

async function getReminderLog({ sentBy, studentEmail, schools, limit = 100 } = {}) {
  if (studentEmail) {
    return pg.many(
      `SELECT rl.*, du.name AS sent_by_name
       FROM reminder_log rl
       LEFT JOIN dashboard_users du ON du.id = rl.sent_by
       WHERE LOWER(rl.student_email) = $1
       ORDER BY rl.sent_at DESC LIMIT $2`,
      [String(studentEmail).toLowerCase().trim(), limit]
    );
  }
  if (sentBy) {
    return pg.many('SELECT * FROM reminder_log WHERE sent_by = $1 ORDER BY sent_at DESC LIMIT $2', [sentBy, limit]);
  }
  if (Array.isArray(schools) && schools.length) {
    const ph = schools.map((_, i) => `$${i + 1}`).join(',');
    const params = schools.map(s => s.toLowerCase());
    return pg.many(
      `SELECT rl.*, du.name AS sent_by_name
       FROM reminder_log rl
       LEFT JOIN dashboard_users du ON du.id = rl.sent_by
       JOIN students st ON LOWER(st.email) = LOWER(rl.student_email)
       WHERE LOWER(st.school) IN (${ph})
       ORDER BY rl.sent_at DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    );
  }
  return pg.many(
    `SELECT rl.*, du.name AS sent_by_name
     FROM reminder_log rl
     LEFT JOIN dashboard_users du ON du.id = rl.sent_by
     ORDER BY rl.sent_at DESC LIMIT $1`,
    [limit]
  );
}

/* ══════════════════════════════════════════════════════════════════
   AUDIT LOG
══════════════════════════════════════════════════════════════════ */
async function auditLog({ userId, userEmail, action, target, detail, ip } = {}) {
  try {
    await pg.exec(
      'INSERT INTO audit_log (user_id, user_email, action, target, detail, ip, ts) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId || null, userEmail || null, action, target || null, detail || null, ip || null, new Date().toISOString()]
    );
  } catch (e) { console.error('[Audit]', e.message); }
}

async function getAuditLog({ limit = 200, userId } = {}) {
  if (userId) {
    return pg.many('SELECT * FROM audit_log WHERE user_id = $1 ORDER BY ts DESC LIMIT $2', [userId, limit]);
  }
  return pg.many('SELECT * FROM audit_log ORDER BY ts DESC LIMIT $1', [limit]);
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT CRUD (admin)
══════════════════════════════════════════════════════════════════ */
async function upsertStudent({ session_id, first_name, last_name, full_name, email, class: cls, section, school, school_state, school_city, age, gender }) {
  const now  = new Date().toISOString();
  const norm = String(email || '').toLowerCase().trim();

  const doUpsert = (c, sid) => c.query(
    `INSERT INTO students (session_id, first_name, last_name, full_name, email, class, section, school, school_state, school_city, age, gender, registered_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (session_id) DO UPDATE SET
       first_name   = EXCLUDED.first_name,   last_name    = EXCLUDED.last_name,
       full_name    = EXCLUDED.full_name,    email        = EXCLUDED.email,
       class        = EXCLUDED.class,        section      = EXCLUDED.section,
       school       = EXCLUDED.school,       school_state = EXCLUDED.school_state,
       school_city  = EXCLUDED.school_city,  age          = EXCLUDED.age,
       gender       = EXCLUDED.gender`,
    [sid, first_name || '', last_name || '', full_name || (first_name + ' ' + (last_name || '')).trim(),
     norm, cls || '', section || '', school || '', school_state || '', school_city || '', age || '', gender || '', now]
  );

  let resultSid;
  try {
    resultSid = await pg.tx(async (c) => {
      let sid = session_id;
      if (norm) {
        const existing = await c.query('SELECT session_id FROM students WHERE email = $1', [norm]);
        if (existing.rows[0]) sid = existing.rows[0].session_id;
      }
      if (!sid) sid = crypto.randomBytes(16).toString('hex');
      await doUpsert(c, sid);
      return sid;
    });
  } catch (e) {
    if (norm && e.code === '23505') {
      const row = await pg.one('SELECT session_id FROM students WHERE email = $1', [norm]);
      if (row) { _invalidateSchoolCache(); return row.session_id; }
    }
    throw e;
  }
  _invalidateSchoolCache();
  return resultSid;
}

async function getStudentByEmail(email) {
  if (!email) return null;
  return pg.one(
    'SELECT session_id, full_name, email, school FROM students WHERE email = $1 LIMIT 1',
    [String(email).toLowerCase().trim()]
  );
}

/* Bulk import: all rows in one transaction. Returns { imported, skipped }. */
async function runImportTransaction(rows) {
  let imported = 0, skipped = 0;
  await pg.tx(async (c) => {
    for (const r of rows) {
      if (!r.first_name && !r.full_name && !r.name) { skipped++; continue; }
      try {
        const fullName = r.full_name || r.name || '';
        const fn = r.first_name || fullName.split(' ')[0];
        const ln = r.last_name  || fullName.split(' ').slice(1).join(' ');
        const norm = String(r.email || '').toLowerCase().trim();
        const now  = new Date().toISOString();

        let sid = null;
        if (norm) {
          const existing = await c.query('SELECT session_id FROM students WHERE email = $1', [norm]);
          if (existing.rows[0]) sid = existing.rows[0].session_id;
        }
        if (!sid) sid = crypto.randomBytes(16).toString('hex');

        await c.query(
          `INSERT INTO students (session_id, first_name, last_name, full_name, email, class, section, school, school_state, school_city, age, gender, registered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (session_id) DO UPDATE SET
             first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
             full_name = EXCLUDED.full_name,   email = EXCLUDED.email,
             class = EXCLUDED.class,           section = EXCLUDED.section,
             school = EXCLUDED.school,         school_state = EXCLUDED.school_state,
             school_city = EXCLUDED.school_city, age = EXCLUDED.age, gender = EXCLUDED.gender`,
          [sid, fn || '', ln || '', fullName || (fn + ' ' + (ln || '')).trim(), norm,
           r.class || r.Class || '', r.section || r.Section || '', r.school || r.School || '',
           r.school_state || '', r.school_city || '', r.age || '', r.gender || '', now]
        );
        imported++;
      } catch (_) { skipped++; }
    }
  });
  _invalidateSchoolCache();
  return { imported, skipped };
}

async function deleteStudent(sessionId) {
  await pg.exec('DELETE FROM students WHERE session_id = $1', [sessionId]);
  _invalidateSchoolCache();
}

async function resetStudentAssessment(sessionId) {
  await pg.tx(async (c) => {
    for (const t of ['assessments','report_summary','report_personality','report_aptitude',
                     'report_interests','report_seaa','report_careers','section_progress']) {
      await c.query(`DELETE FROM ${t} WHERE session_id = $1`, [sessionId]);
    }
    await c.query('UPDATE students SET completed_at = NULL, report_generated_at = NULL WHERE session_id = $1', [sessionId]);
  });
}

async function moveStudent(sessionId, fields) {
  const ALLOWED = ['class','section','school','first_name','last_name','full_name','email','age','gender','school_state','school_city'];
  const sets = [], vals = [];
  let n = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.includes(k) && v !== undefined) { sets.push(`${k} = $${n++}`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(sessionId);
  await pg.exec(`UPDATE students SET ${sets.join(', ')} WHERE session_id = $${n}`, vals);
}

/* ══════════════════════════════════════════════════════════════════
   NOTES & TAGS
══════════════════════════════════════════════════════════════════ */
async function addStudentNote({ sessionId, authorId, note }) {
  const row = await pg.one(
    'INSERT INTO student_notes (session_id, author_id, note, created_at) VALUES ($1,$2,$3,$4) RETURNING id',
    [sessionId, authorId, String(note).slice(0, 2000), new Date().toISOString()]
  );
  return row ? row.id : null;
}

async function getStudentNotes(sessionId) {
  return pg.many(
    `SELECT sn.*, du.name AS author_name
     FROM student_notes sn
     LEFT JOIN dashboard_users du ON du.id = sn.author_id
     WHERE sn.session_id = $1 ORDER BY sn.created_at DESC`,
    [sessionId]
  );
}

async function deleteStudentNote(noteId, authorId) {
  await pg.exec('DELETE FROM student_notes WHERE id = $1 AND author_id = $2', [noteId, authorId]);
}

async function setStudentTags(sessionId, tags, addedBy) {
  const now = new Date().toISOString();
  await pg.tx(async (c) => {
    await c.query('DELETE FROM student_tags WHERE session_id = $1', [sessionId]);
    for (const t of tags) {
      if (t) await c.query(
        'INSERT INTO student_tags (session_id, tag, added_by, added_at) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id, tag) DO NOTHING',
        [sessionId, String(t).trim().slice(0, 64), addedBy, now]
      );
    }
  });
}

async function getStudentTags(sessionId) {
  const rows = await pg.many('SELECT tag FROM student_tags WHERE session_id = $1 ORDER BY added_at', [sessionId]);
  return rows.map(r => r.tag);
}

/* ══════════════════════════════════════════════════════════════════
   SCHOOLS REGISTRY
══════════════════════════════════════════════════════════════════ */
async function listRegisteredSchools() {
  try {
    const liveSchools = await getAllSchools();
    const existingRows = await pg.many('SELECT LOWER(name) AS n FROM schools_registry');
    const existing = new Set(existingRows.map(r => r.n));
    const now = new Date().toISOString();
    for (const s of liveSchools) {
      const name = (s.school || '').trim();
      if (name && !existing.has(name.toLowerCase())) {
        await pg.exec(
          `INSERT INTO schools_registry (name, city, state, added_at, active)
           VALUES ($1, NULL, NULL, $2, TRUE) ON CONFLICT (name) DO NOTHING`,
          [name, now]
        );
        existing.add(name.toLowerCase());
      }
    }
  } catch (_) { /* best-effort backfill */ }
  return pg.many('SELECT * FROM schools_registry ORDER BY name');
}

async function upsertRegisteredSchool({ id, name, city, state, active }) {
  if (id) {
    const fields = [], vals = [];
    let n = 1;
    if (name   !== undefined) { fields.push(`name = $${n++}`);   vals.push(name); }
    if (city   !== undefined) { fields.push(`city = $${n++}`);   vals.push(city); }
    if (state  !== undefined) { fields.push(`state = $${n++}`);  vals.push(state); }
    if (active !== undefined) { fields.push(`active = $${n++}`); vals.push(!!active); }
    if (fields.length) { vals.push(id); await pg.exec(`UPDATE schools_registry SET ${fields.join(', ')} WHERE id = $${n}`, vals); }
    return id;
  }
  const nm = String(name || '').slice(0, 200).trim();
  if (!nm) throw new Error('school name required');
  const row = await pg.one(
    `INSERT INTO schools_registry (name, city, state, added_at, active)
     VALUES ($1,$2,$3,$4,TRUE)
     ON CONFLICT (name) DO UPDATE SET
       city   = EXCLUDED.city,
       state  = EXCLUDED.state,
       active = TRUE
     RETURNING id`,
    [nm, city || '', state || '', new Date().toISOString()]
  );
  return row ? row.id : null;
}

async function deleteRegisteredSchool(id) {
  await pg.exec('DELETE FROM schools_registry WHERE id = $1', [id]);
}

/* ══════════════════════════════════════════════════════════════════
   PASSWORD RESET
══════════════════════════════════════════════════════════════════ */
async function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp   = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await pg.exec('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
  await pg.exec(
    'INSERT INTO password_reset_tokens (token, user_id, created_at, expires_at, used) VALUES ($1,$2,$3,$4,FALSE)',
    [token, userId, new Date().toISOString(), exp]
  );
  return token;
}

async function consumePasswordResetToken(token, newPassword) {
  const now = new Date().toISOString();
  const row = await pg.one('SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > $2', [token, now]);
  if (!row) return false;
  await pg.tx(async (c) => {
    await c.query('UPDATE dashboard_users SET password_hash = $1 WHERE id = $2', [_hashPassword(String(newPassword)), row.user_id]);
    await c.query('UPDATE password_reset_tokens SET used = TRUE WHERE token = $1', [token]);
  });
  return true;
}

/* ══════════════════════════════════════════════════════════════════
   EXPORTS
══════════════════════════════════════════════════════════════════ */
/* Assemble everything download.js needs to render a student's report PDF,
   in the exact shapes it consumes (scorer JSON from `assessments`, AI report
   from `report_summary` + `report_careers`). Returns null if the student or
   their assessment scores don't exist. */
async function getReportPdfData(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;

  const student = await pg.one(
    `SELECT session_id, first_name, last_name, full_name, class, section, school
       FROM students WHERE session_id = $1`, [sid]);
  if (!student) return null;

  const a = await pg.one(
    `SELECT cpi_scores_json, nmap_scores_json, sea_scores_json,
            daab_va_scores_json, daab_pa_scores_json, daab_na_scores_json,
            daab_lsa_scores_json, daab_hma_scores_json, daab_ar_scores_json,
            daab_ma_scores_json, daab_sa_scores_json
       FROM assessments WHERE session_id = $1`, [sid]);
  if (!a) return null; // no scores saved yet → nothing to render

  const rs = await pg.one(
    `SELECT holistic_summary, aptitude_profile, interest_profile, internal_motivators,
            personality_profile, wellbeing_guidance, stream_advice
       FROM report_summary WHERE session_id = $1`, [sid]);

  const careers = await pg.many(
    `SELECT position, career, cluster, interest_fit, aptitude_fit, personality_fit,
            seaa_fit, suitability_pct, alignment, rationale
       FROM report_careers WHERE session_id = $1 ORDER BY position`, [sid]);

  const _parse = (j) => { try { return j ? JSON.parse(j) : null; } catch (_) { return null; } };

  const daab = {};
  ['va', 'pa', 'na', 'lsa', 'hma', 'ar', 'ma', 'sa'].forEach((k) => {
    const sc = _parse(a['daab_' + k + '_scores_json']);
    if (sc) daab[k] = { scores: sc };
  });

  const ai = {};
  if (rs) {
    ['holistic_summary', 'aptitude_profile', 'interest_profile', 'internal_motivators',
     'personality_profile', 'wellbeing_guidance', 'stream_advice'].forEach((k) => {
      if (rs[k]) ai[k] = rs[k];
    });
  }
  if (careers && careers.length) {
    ai.career_table = careers.map((c, i) => ({
      rank: i + 1,
      career: c.career || '',
      cluster: c.cluster || '',
      interest_fit: c.interest_fit || '',
      aptitude_fit: c.aptitude_fit || '',
      personality_fit: c.personality_fit || '',
      seaa_fit: c.seaa_fit || '',
      suitability_pct: c.suitability_pct != null ? Number(c.suitability_pct) : 0,
      alignment: c.alignment || '',
      rationale: c.rationale || '',
    }));
  }

  return {
    student: {
      firstName: student.first_name || (student.full_name || '').split(' ')[0] || '',
      fullName:  student.full_name || '',
      class:     student.class || '',
      section:   student.section || '',
      school:    student.school || '',
    },
    cpi:  _parse(a.cpi_scores_json)  || { ranked: [], top3: [] },
    nmap: _parse(a.nmap_scores_json) || { dims: [], sorted: [] },
    sea:  _parse(a.sea_scores_json)  || { domScores: { E: 0, S: 0, A: 0 }, cls: {} },
    daab: Object.keys(daab).length ? daab : null,
    ai,
  };
}

module.exports = {
  init,
  /* auth */
  login, verifyToken, logout, purgeExpiredSessions,
  /* users */
  listUsers, createUser, updateUser, deleteUser, getUserByEmail,
  /* students */
  getStudentsBySchool,
  countStudentsFiltered,
  getAtRiskStudents,
  getGenderStats,
  listCounsellorsForSchools, getStudentBySessionId, getReportPdfData,
  countStudentsBySchool, getAllSchools,
  /* student CRUD */
  upsertStudent, deleteStudent, resetStudentAssessment, moveStudent, runImportTransaction, getStudentByEmail,
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
  /* analytics — cached wrappers */
  getAggregateScores:    getAggregateScoresCached,
  getWellbeingAlerts:    getWellbeingAlertsCached,
  getCareerDistribution: getCareerDistributionCached,
  getModuleTiming:       getModuleTimingCached,
  getSchoolSummaries:    getSchoolSummariesCached,
  getCompletionTrend:    getCompletionTrendCached,
  refreshAnalyticsCache,
};
