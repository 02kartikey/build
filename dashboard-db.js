/* ════════════════════════════════════════════════════════════════════
   dashboard-db.js — NuMind MAPS  |  Dashboard database layer (PostgreSQL)
   --------------------------------------------------------------------
   Staff accounts and sessions, settings, reminders and schedules, follow-ups,
   branch mapping, and every analytic the dashboards show. The schema is
   owned by pg-core (initSchema); every function here is async.

   Conventions:
     • Placeholders are positional ($1, $2 …), built dynamically for IN lists.
     • School names compare by match.normSchool (case, spaces and punctuation
       ignored) in JS and its twin match.sqlNormSchool in SQL — the one rule
       for scoping, grouping and permission checks. Email columns are CITEXT.
     • permissions is JSONB and arrives already parsed.
     • Per-worker in-memory caches (session tokens, school list, branch map)
       expire on their own and are cleared on writes.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');
const pg     = require('./pg-core.js');
const match  = require('./match-utils.js');
// A whole number from an environment setting, or the default.
const _int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

/* ── Unique School ID ────────────────────────────────────────────────
   SQL forms of match-utils uidSchoolKey()/normUid(); identical to the
   uq_students_school_uid_v2 index expression in pg-core.js, so lookups use
   the index and agree with the uniqueness rule. */
const _SQL_UID_SCHOOL = match.sqlUidSchoolKey;
const _SQL_NORM_UID   = match.sqlUid;
const _isUidConflict  = (e) => e && e.code === '23505' && /uq_students_school_uid/.test(String(e.constraint || e.message || ''));

// The student holding `uid` at `school`, or null. `client` lets callers run it
// inside their transaction (pass FOR UPDATE via `lock` to hold the row).
async function findStudentByUid(school, uid, client) {
  // Looked up at the school the name now belongs to (see mergedSchoolOf).
  const u = match.normUid(uid), sc = match.uidSchoolKey(await mergedSchoolOf(school, client));
  if (!u || !sc) return null;
  const sql = `SELECT session_id, full_name, school, class, student_uid FROM students
                WHERE ${match.sqlHasUid('student_uid')}
                  AND ${_SQL_UID_SCHOOL('school')} = $1 AND ${_SQL_NORM_UID('student_uid')} = $2 LIMIT 1`;
  if (client) return (await client.query(sql, [sc, u])).rows[0] || null;
  return pg.one(sql, [sc, u]);
}

let _ready = false;

/* ══════════════════════════════════════════════════════════════════
   INIT — idempotent. Ensures the schema, then seeds default accounts on
   first boot.
══════════════════════════════════════════════════════════════════ */
async function init() {
  if (_ready) return;
  await require('./db.js')._initDb();
  _ready = true;

  // Link earlier reports of email-less (bulk-imported) students into journeys.
  // Idempotent and non-blocking; only worker 0 does it under PM2.
  if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
    setImmediate(() => require('./db.js').backfillJourneyHistory({ commit: true, quiet: true })
      .catch(e => console.warn('[journey] backfill skipped:', e.message)));
  }

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

  // Transparent hash upgrade. Accounts created before the scrypt migration still
  // hold an unsalted SHA-256 digest (no ':' separator), which is cheap to
  // brute-force if the table ever leaks. A successful login is the one moment we
  // hold the plaintext, so re-hash with scrypt + a fresh salt and write it back.
  // Best-effort: a failure must never block a valid login — the next successful
  // login retries.
  if (user.password_hash && !String(user.password_hash).includes(':')) {
    try {
      await pg.exec(
        'UPDATE dashboard_users SET password_hash = $1 WHERE id = $2',
        [_hashPassword(String(password || '')), user.id]
      );
    } catch (e) {
      console.warn('[auth] legacy password hash upgrade failed for user', user.id, e && e.message);
    }
  }

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

/* Every request reads the session from the database (one indexed lookup), so
   a sign-out, a deactivated account or changed schools/permissions take
   effect on every PM2 worker at once. */
async function verifyToken(token) {
  if (!token) return null;
  const now = new Date().toISOString();
  const session = await pg.one(
    `SELECT s.user_id, u.name, u.email, u.role, u.active, u.permissions
     FROM dashboard_sessions s
     JOIN dashboard_users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > $2`,
    [token, now]
  );
  if (!session || !session.active) return null;
  const schoolsRows = await pg.many('SELECT school FROM dashboard_user_schools WHERE user_id = $1', [session.user_id]);
  const user = {
    id: session.user_id, name: session.name, email: session.email,
    role: session.role, schools: schoolsRows.map(r => r.school), permissions: _perms(session.permissions),
  };
  return user;
}

async function logout(token) {
  await pg.exec('DELETE FROM dashboard_sessions WHERE token = $1', [token]);
}

async function purgeExpiredSessions() {
  const now = new Date().toISOString();
  const info = await pg.tx(async (c) => {
    const r = await c.query('DELETE FROM dashboard_sessions WHERE expires_at < $1', [now]);
    await c.query('DELETE FROM password_reset_tokens WHERE expires_at < $1', [now]);
    return r;
  });
  if (info && info.rowCount > 0) {
    process.stderr.write('[INFO]  [Dashboard] Purged ' + info.rowCount + ' expired session(s).\n');
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

/* Build a school IN clause with positional params starting at $start; use it
   as `${match.sqlNormSchool('s.school')} IN (${ph})`. */
function _schoolClause(schools, start = 1) {
  const list = (Array.isArray(schools) ? schools : [schools]).filter(Boolean);
  return {
    list,
    ph:     list.map((_, i) => `$${start + i}`).join(','),
    // One school-equality rule everywhere: match.normSchool (case, spaces and
    // punctuation ignored) here, its SQL twin match.sqlNormSchool in queries.
    params: list.map(x => match.normSchool(x)),
  };
}
const _STATUS_CLAUSE = {
  completed:   'rs.session_id IS NOT NULL',
  in_progress: 'rs.session_id IS NULL AND a.session_id IS NOT NULL',
  not_started: 'a.session_id IS NULL',
};

/* Returns { where, p } where placeholders are numbered from $1.
   Class is free text ("10", "Class 10", "X-B"), so a class filter matches every
   label on record that belongs to the same grade (match-utils), not just the
   exact string: "10" also finds "Class 10" and "X". */
async function _studentWhere(schools, { class: cls, section, search, status } = {}) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return null;
  let where = `WHERE ${match.sqlNormSchool('s.school')} IN (${ph})`;
  const p   = [...params];
  let n = params.length + 1;
  if (cls) {
    const labels = await _classLabelsMatching(schools, cls);
    where += ` AND s.class = ANY($${n++})`; p.push(labels);
  }
  if (section) { where += ` AND LOWER(BTRIM(s.section)) = LOWER(BTRIM($${n++}))`; p.push(section); }
  if (search)  {
    where += ` AND (LOWER(s.full_name) LIKE $${n} OR LOWER(s.email) LIKE $${n + 1} OR ${_SQL_NORM_UID('s.student_uid')} = $${n + 2})`;
    const q = `%${search.toLowerCase()}%`;
    p.push(q, q, match.normUid(search)); n += 3;
  }
  if (status && _STATUS_CLAUSE[status]) where += ` AND ${_STATUS_CLAUSE[status]}`;
  return { where, p, nextIdx: n };
}

/* Progress across the FOUR assessment modules: NMAP, DAAB, CPI, SEAA.

   The dashboards show four dots and the profile prints "n/4", so this counts
   modules, not columns. DAAB counts as one module and only when all eight
   subtests are recorded, so a partly finished aptitude battery is not done.
   Keep this in step with MODULES in db.js if a module is ever added. */
// All 8 aptitude sub-tests finished = the aptitude part is done.
const _DAAB_ALL_DONE_EXPR = `(a.daab_va_completed_at  IS NOT NULL
         AND a.daab_pa_completed_at  IS NOT NULL
         AND a.daab_na_completed_at  IS NOT NULL
         AND a.daab_lsa_completed_at IS NOT NULL
         AND a.daab_hma_completed_at IS NOT NULL
         AND a.daab_ar_completed_at  IS NOT NULL
         AND a.daab_ma_completed_at  IS NOT NULL
         AND a.daab_sa_completed_at  IS NOT NULL)`;
const _MODULES_DONE_EXPR = `
  (CASE WHEN a.nmap_completed_at IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN a.cpi_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN a.sea_completed_at  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN ${_DAAB_ALL_DONE_EXPR} THEN 1 ELSE 0 END)`;

async function getStudentsBySchool(schools, opts = {}) {
  const { limit = 200, offset = 0 } = opts;
  const w = await _studentWhere(schools, opts);
  if (!w) return [];
  const { where, p, nextIdx } = w;
  const params = [...p, limit, offset];
  return pg.many(
    `SELECT
       s.session_id, s.first_name, s.last_name, s.full_name,
       s.class, s.section, s.school, s.email, s.gender, s.age,
       s.access_code, s.student_uid,
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

async function listCounsellorsForSchools(schools) {
  const list = (schools || []).map(s => match.normSchool(s));
  if (!list.length) return [];
  const ph = list.map((_, i) => `$${i + 1}`).join(',');
  const rows = await pg.many(
    `SELECT DISTINCT u.id, u.name, u.email, u.last_login, u.active
     FROM dashboard_users u
     JOIN dashboard_user_schools us ON us.user_id = u.id
     WHERE u.role = 'counsellor' AND u.active = TRUE
       AND ${match.sqlNormSchool('us.school')} IN (${ph})
     ORDER BY u.name`,
    list
  );
  const out = [];
  for (const r of rows) {
    const srows = await pg.many('SELECT school FROM dashboard_user_schools WHERE user_id = $1 ORDER BY school', [r.id]);
    out.push({
      id: r.id, name: r.name, email: r.email, last_login: r.last_login,
      schools: srows.map(x => x.school).filter(s => list.includes(match.normSchool(s))),
    });
  }
  return out;
}

async function countStudentsFiltered(schools, opts = {}) {
  const w = await _studentWhere(schools, opts);
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

/* Every school name students have registered under, with student counts.
   Read fresh each time (one grouped scan, a few milliseconds): a per-worker
   cache would keep showing a merged or renamed school on the other workers. */
async function getAllSchools() {
  return pg.many(
    `SELECT MIN(school) AS school, COUNT(*)::int AS total_students
     FROM students
     WHERE school IS NOT NULL AND school != ''
     GROUP BY ${match.sqlNormSchool('school')}
     ORDER BY school`
  );
}

/* Contact details for a list of students, limited to the given schools
   (admins pass null = all), so a reminder can go to any drill-down list
   without the browser looking up each student. */
async function getStudentContacts(sessionIds, schools) {
  const ids = [...new Set((sessionIds || []).map(String))];
  if (!ids.length) return [];
  if (schools === null) {
    return pg.many('SELECT session_id, email, full_name, first_name, school, class, section FROM students WHERE session_id = ANY($1)', [ids]);
  }
  const { ph, params } = _schoolClause(schools, 2);
  if (!params.length) return [];
  return pg.many(
    `SELECT session_id, email, full_name, first_name, school, class, section FROM students
      WHERE session_id = ANY($1) AND ${match.sqlNormSchool('school')} IN (${ph})`, [ids, ...params]);
}

async function getStudentBySessionId(sessionId) {
  return pg.one(
    `SELECT s.*,
       CASE
         WHEN rs.session_id IS NOT NULL THEN 'completed'
         WHEN a.session_id  IS NOT NULL THEN 'in_progress'
         ELSE 'not_started'
       END AS status,
       ${_MODULES_DONE_EXPR} AS modules_done,
       a.saved_at AS last_activity,
       -- Which of the 4 parts are finished (for the profile's progress view).
       json_build_object(
         'nmap', a.nmap_completed_at IS NOT NULL,
         'daab', ${_DAAB_ALL_DONE_EXPR},
         'cpi',  a.cpi_completed_at  IS NOT NULL,
         'sea',  a.sea_completed_at  IS NOT NULL) AS parts_done
     FROM students s
     LEFT JOIN assessments    a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs ON rs.session_id = s.session_id
     WHERE s.session_id = $1`,
    [sessionId]
  );
}

/* ══════════════════════════════════════════════════════════════════
   AGGREGATE ANALYTICS
══════════════════════════════════════════════════════════════════ */
/* SQL filter for a counsellor limited to certain classes or sections: the
   same predicate the facts-based views use, turned into an id list so
   SQL-based figures (trend, timing, wellbeing list) agree with them.
   Returns '' when there is no predicate. `params` is extended in place. */
async function _predicateFilter(schools, predicate, params, col = 's.session_id') {
  if (!predicate) return '';
  const ids = (await getStudentFacts(schools, { predicate })).map(f => f.session_id);
  params.push(ids);
  return ` AND ${col} = ANY($${params.length})`;
}

/* ── The three wellbeing areas ──────────────────────────────────────
   Wellbeing support is always shown split into these, never as one number.
   Reports from an earlier version of the wellbeing test used other area
   names; they are kept apart as "Earlier version" rather than guessed into
   one of the three. */
// Each area has 20 questions (js/engine/sea.js SEA_DOMAINS), one point each.
const WELLBEING_AREA_MAX_SCORE = 20;
const WELLBEING_AREAS = Object.freeze([
  { key: 'S', label: 'Social', title: 'Social adjustment', description: 'Getting on with classmates, friends and teachers.', max_score: WELLBEING_AREA_MAX_SCORE },
  { key: 'E', label: 'Emotional', title: 'Emotional adjustment', description: 'Handling feelings, stress and setbacks.', max_score: WELLBEING_AREA_MAX_SCORE },
  { key: 'A', label: 'Academic', title: 'Academic adjustment', description: 'Coping with schoolwork, study habits and exams.', max_score: WELLBEING_AREA_MAX_SCORE },
]);
const WELLBEING_OTHER = Object.freeze({ key: 'other', label: 'Earlier version', title: 'Earlier version of the wellbeing test', description: 'Reports from an earlier version of the wellbeing test, which used different areas.' });
// The four assessment parts, as the dashboards name them. `views` are the
// analytics dimensions the drill-down dashboard offers for each part.
const PARAMETERS = Object.freeze([
  { key: 'personality', label: 'Personality', module: 'NMAP', description: 'Personality assessment (9 traits).', views: ['personality_top', 'personality_level'] },
  { key: 'aptitude', label: 'Aptitude', module: 'DAAB', description: 'Aptitude tests (all 8 abilities finished).', views: ['aptitude_top', 'aptitude_level'] },
  { key: 'career', label: 'Career interest', module: 'CPI', description: 'Career interest inventory.', views: ['career_area', 'stream'] },
  { key: 'seaa', label: 'SEAA', module: 'SEAA', description: 'Social, emotional and academic adjustment (wellbeing).', views: ['seaa_concern', 'wellbeing_need'] },
]);
/* SEAA concern groups. A student's areas in the needs-support band give one
   combination; one or two areas is "Need intervention", all three is
   "Critical". Group keys list the areas in S, E, A order. */
const SEAA_CONCERNS = Object.freeze([
  { key: 'S', label: 'Social only', level: 'intervention', description: 'Needs support in social adjustment only.' },
  { key: 'E', label: 'Emotional only', level: 'intervention', description: 'Needs support in emotional adjustment only.' },
  { key: 'A', label: 'Academic only', level: 'intervention', description: 'Needs support in academic adjustment only.' },
  { key: 'SE', label: 'Social + Emotional', level: 'intervention', description: 'Needs support in social and emotional adjustment.' },
  { key: 'EA', label: 'Emotional + Academic', level: 'intervention', description: 'Needs support in emotional and academic adjustment.' },
  { key: 'SA', label: 'Academic + Social', level: 'intervention', description: 'Needs support in academic and social adjustment.' },
  { key: 'SEA', label: 'All three', level: 'critical', description: 'Needs support in all three areas: social, emotional and academic.' },
  { key: 'none', label: 'No significant concern', level: 'none', description: 'No area is in the needs-support band.' },
  { key: 'other', label: 'Earlier test version', level: 'none', description: 'Took an earlier version of the wellbeing test with different areas; not classified.' },
]);
const SEAA_LEVELS = Object.freeze({
  intervention: { label: 'Need intervention', description: 'Adjustment concern in one or two areas.' },
  critical: { label: 'Critical', description: 'Adjustment concern in all three areas: social, emotional and academic.' },
});
function seaaConcernOf(f) {
  // Only students whose report has SEAA areas are classified.
  if (f.status !== 'completed' || !f.seaa_scores || !Object.keys(f.seaa_scores).length) return null;
  const keys = new Set((f.seaa_support || []).map(a => a.key));
  const core = ['S', 'E', 'A'].filter(k => keys.has(k)).join('');
  // 'S','E','A','SE','EA','SA' or 'SEA' (letters always in S, E, A order).
  if (core) return core;
  return keys.has('other') ? 'other' : 'none';
}

/* Academic year a date falls in, by its start year (2026 = 2026–27). The
   year starts on the first of ACADEMIC_YEAR_START_MONTH (default April) in
   APP_TIMEZONE. */
const ACADEMIC_YEAR_START_MONTH = Math.min(12, Math.max(1, _int(process.env.ACADEMIC_YEAR_START_MONTH, 4)));
let _ymFormat = null;   // built on first use (APP_TIMEZONE is defined further down)
function academicYearOf(d) {
  if (!d) return null;
  const t = new Date(d);
  if (isNaN(t)) return null;
  _ymFormat = _ymFormat || new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIMEZONE, year: 'numeric', month: 'numeric' });
  const parts = Object.fromEntries(_ymFormat.formatToParts(t).map(x => [x.type, x.value]));
  const y = +parts.year, m = +parts.month;
  return m >= ACADEMIC_YEAR_START_MONTH ? y : y - 1;
}
const academicYearLabel = (y) => `${y}–${String((y + 1) % 100).padStart(2, '0')}`;

/* ── Merged schools and school groups ──────────────────────────────
   Merge rewrites student records to one school name (permanent) and keeps
   the merged-away spellings in school_merges, which a trigger applies to every
   later write. A group shows several schools as branches of one school. Both
   tables are read on every request: they are tiny and indexed, and reading
   them fresh means every worker sees a change at once. */
const SCHOOL_NAME_MAX = 120;
const _cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, SCHOOL_NAME_MAX);
const _badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

async function getSchoolGroups() {
  const rows = await pg.many('SELECT school_key, group_name FROM school_groups');
  return new Map(rows.map(r => [r.school_key, r.group_name]));
}
// The group (shown as the school) and branch a school name belongs to.
function groupOf(name, groups) {
  const clean = _cleanName(name);
  const g = groups.get(match.normSchool(name));
  return { org: g || clean, branch: clean, grouped: !!g };
}
/* normalised school key → {org, branch, grouped} for a list of raw names.
   Names that normalise alike share the first one's entry, so one school
   typed with different case or spacing never splits in two. */
function _groupIndex(schools, groups) {
  const idx = new Map();
  for (const sc of schools || []) {
    const k = match.normSchool(sc);
    if (!idx.has(k)) idx.set(k, groupOf(sc, groups));
  }
  return idx;
}

/* The School registry page (admin), in one read: every school name on
   record (students' spellings and registered schools; names that normalise
   alike are one row) with its students, registry entry and group; the group
   names in use; and groups of names that look like one school, to review. */
async function listSchoolNames() {
  const [groups, rows, reg] = await Promise.all([
    getSchoolGroups(),
    pg.many(`SELECT BTRIM(school) AS name, COUNT(*)::int AS students FROM students
              WHERE COALESCE(BTRIM(school), '') <> '' GROUP BY 1 ORDER BY 2 DESC, 1`),
    pg.many('SELECT id, name::text AS name, city, state, active FROM schools_registry ORDER BY name'),
  ]);
  const byKey = new Map();
  const entry = (name) => {
    const key = match.normSchool(name);
    if (!key) return null;
    if (!byKey.has(key)) byKey.set(key, { key, name, names: [], students: 0, registry: null, group: groups.get(key) || null });
    const e = byKey.get(key);
    if (!e.names.includes(name)) e.names.push(name);
    return e;
  };
  for (const r of rows) { const e = entry(r.name); if (e) e.students += r.students; }
  for (const r of reg) {
    const e = entry(r.name);
    if (!e) continue;
    e.name = r.name;                     // the registered spelling is the one shown
    e.registry = { id: r.id, city: r.city, state: r.state, active: r.active };
  }
  const names = [...byKey.values()].sort((a, b) => b.students - a.students || a.name.localeCompare(b.name));
  const keyOf = new Map(names.map(n => [n.name, n.key]));
  const suggestions = match.likelyDuplicateGroups(names.map(n => n.name))
    .map(g => g.map(n => keyOf.get(n)))
    .sort((a, b) => b.length - a.length);
  return { names, groups: [...new Set(groups.values())].sort((a, b) => a.localeCompare(b)), suggestions };
}

/* Merge school names into one school. Rewrites, in one transaction:
     students.school, dashboard users' school access, the school registry,
     scheduled reminders and per-school settings,
   then records the merged-away spellings for later registrations and
   sign-ins, and sets or clears the school's group. Refuses (409) when two
   students would end up sharing a Unique School ID at the merged school. */
async function mergeSchools({ names, school, group, userId }) {
  const target = _cleanName(school), grp = _cleanName(group);
  const tKey = match.normSchool(target);
  if (!tKey) throw _badRequest('Enter the school name to merge into.');
  if (grp && match.normSchool(grp) === tKey) throw _badRequest('A school cannot be part of itself. Leave "Part of" empty, or name the larger school.');
  const keys = new Set((names || []).map(n => match.normSchool(n)).filter(Boolean));
  if (!keys.size) throw _badRequest('Tick at least one school name.');
  keys.add(tKey);
  const otherKeys = [...keys].filter(k => k !== tKey);
  const mine = (rows) => rows.map(r => r.v).filter(v => keys.has(match.normSchool(v)));

  const result = await pg.tx(async (c) => {
    const q = (sql, p) => c.query(sql, p);
    // The kept name is a real school from now on: if it was merged away
    // earlier, forget that first, or the trigger would redirect the rewrite.
    await q('DELETE FROM school_merges WHERE name_key = $1', [tKey]);
    // 1. Students. Unique School IDs must stay one per school.
    const stu = mine((await q(`SELECT DISTINCT school AS v FROM students WHERE school IS NOT NULL`)).rows);
    const clash = (await q(
      `SELECT ${match.sqlUid('student_uid')} AS uid,
              array_agg(COALESCE(NULLIF(full_name, ''), first_name) || ' (' || school || ')' ORDER BY school) AS who
         FROM students WHERE school = ANY($1) AND ${match.sqlHasUid('student_uid')}
        GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 1 LIMIT 5`, [stu])).rows;
    if (clash.length) {
      throw Object.assign(new Error('After this merge, these students would share a Unique School ID: '
        + clash.map(r => `${r.uid}: ${r.who.join(' and ')}`).join('; ')
        + '. Change one ID in each pair (open the student and edit the ID), then merge again.'), { status: 409 });
    }
    const moved = stu.length ? (await q('UPDATE students SET school = $1 WHERE school = ANY($2) AND school <> $1', [target, stu])).rowCount : 0;

    // 2. Dashboard users' school access moves to the merged name.
    const dus = mine((await q('SELECT DISTINCT school::text AS v FROM dashboard_user_schools')).rows);
    if (dus.length) {
      await q(`INSERT INTO dashboard_user_schools (user_id, school)
               SELECT DISTINCT user_id, $1 FROM dashboard_user_schools WHERE school = ANY($2::citext[])
               ON CONFLICT (user_id, school) DO NOTHING`, [target, dus]);
      await q('DELETE FROM dashboard_user_schools WHERE school = ANY($1::citext[]) AND school <> $2::citext', [dus, target]);
      await q('UPDATE dashboard_user_schools SET school = $1 WHERE school = $1::citext AND school::text <> $1', [target]);
    }

    // 3. School registry: one entry, under the merged name.
    const reg = (await q('SELECT id, name::text AS name, city, state FROM schools_registry')).rows.filter(r => keys.has(match.normSchool(r.name)));
    const same = reg.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (same) await q('UPDATE schools_registry SET name = $1, active = TRUE WHERE id = $2', [target, same.id]);
    else {
      const from = reg.find(r => r.city || r.state) || {};
      await q('INSERT INTO schools_registry (name, city, state, added_at, active) VALUES ($1, $2, $3, $4, TRUE)',
        [target, from.city || null, from.state || null, new Date().toISOString()]);
    }
    const dropReg = reg.filter(r => r !== same).map(r => r.id);
    if (dropReg.length) await q('DELETE FROM schools_registry WHERE id = ANY($1)', [dropReg]);

    // 4. Scheduled reminders for one school.
    const sch = mine((await q('SELECT DISTINCT school AS v FROM reminder_schedules WHERE school IS NOT NULL')).rows);
    if (sch.length) await q('UPDATE reminder_schedules SET school = $1 WHERE school = ANY($2)', [target, sch]);

    // 5. Per-school settings: the merged school keeps its own, or else takes
    //    over one merged spelling's settings.
    const tScope = _scopeKeyFor(target), oScopes = otherKeys.map(k => 'school:' + k);
    const hasOwn = (await q('SELECT 1 FROM dashboard_settings WHERE scope = $1', [tScope])).rowCount > 0;
    if (!hasOwn && oScopes.length) {
      await q(`UPDATE dashboard_settings SET scope = $1 WHERE scope = (
                 SELECT scope FROM dashboard_settings WHERE scope = ANY($2) ORDER BY updated_at DESC LIMIT 1)`, [tScope, oScopes]);
    }
    if (oScopes.length) await q('DELETE FROM dashboard_settings WHERE scope = ANY($1)', [oScopes]);

    // 6. Remember the merged-away spellings; earlier merges into any of
    //    these names now point at the merged school.
    if (otherKeys.length) {
      await q(`INSERT INTO school_merges (name_key, school, merged_by) SELECT k, $2, $3 FROM unnest($1::text[]) AS k
               ON CONFLICT (name_key) DO UPDATE SET school = EXCLUDED.school, merged_at = now(), merged_by = EXCLUDED.merged_by`,
        [otherKeys, target, userId || null]);
    }
    const repoint = (await q('SELECT name_key, school FROM school_merges')).rows.filter(r => keys.has(match.normSchool(r.school))).map(r => r.name_key);
    if (repoint.length) await q('UPDATE school_merges SET school = $1 WHERE name_key = ANY($2)', [target, repoint]);

    // 7. Group: set it, or clear it when "Part of" is empty.
    if (otherKeys.length) await q('DELETE FROM school_groups WHERE school_key = ANY($1)', [otherKeys]);
    if (grp) {
      await q(`INSERT INTO school_groups (school_key, group_name, updated_by) VALUES ($1, $2, $3)
               ON CONFLICT (school_key) DO UPDATE SET group_name = EXCLUDED.group_name, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tKey, grp, userId || null]);
    } else {
      await q('DELETE FROM school_groups WHERE school_key = $1', [tKey]);
    }
    return { school: target, group: grp || null, names_merged: otherKeys.length, students_moved: moved };
  });
  return result;
}

/* Schools (or groups) and their branches the user can see, with progress
   for each, for the drill-down dashboard. */
async function getFlowStructure(schools, { predicate = null, year = null } = {}) {
  const groups = await getSchoolGroups();
  const all = await getStudentFacts(schools, { predicate });
  const years = [...new Set(all.map(f => f.academic_year).filter(y => y != null))].sort((a, b) => b - a);
  const facts = year == null ? all : all.filter(f => f.academic_year === year);
  const settings = await getSettingsMap(schools);
  const orgs = new Map();
  const blank = () => ({ registered: 0, completed: 0, in_progress: 0, not_started: 0, target_sum: 0 });
  const add = (o, f) => { o.registered++; o[f.status]++; o.target_sum += settings.forSchool(f.school).completion_target_pct; };
  // Every school the user has, even before any student registers.
  const byKey = _groupIndex(schools, groups);
  for (const sc of schools) {
    const b = byKey.get(match.normSchool(sc));
    if (!orgs.has(b.org)) orgs.set(b.org, Object.assign(blank(), { org: b.org, branches: new Map() }));
    const o = orgs.get(b.org);
    if (!o.branches.has(b.branch)) o.branches.set(b.branch, Object.assign(blank(), { branch: b.branch, schools: [], target: settings.forSchool(sc).completion_target_pct }));
    o.branches.get(b.branch).schools.push(sc);
  }
  // Facts match schools case- and spacing-insensitively, so look them up by key
  // (every fact's school is one of `schools`, which getStudentFacts filtered on).
  for (const f of facts) {
    const b = byKey.get(match.normSchool(f.school));
    const o = orgs.get(b.org), br = o.branches.get(b.branch);
    add(o, f); add(br, f);
  }
  const pct = (n, d) => (d ? Math.round(n / d * 1000) / 10 : 0);
  // A group's target is its schools' targets weighted by registered students.
  const fin = (x) => ({
    registered: x.registered, completed: x.completed, in_progress: x.in_progress, not_started: x.not_started,
    pending: x.registered - x.completed, completion_pct: pct(x.completed, x.registered),
    target_pct: x.registered ? Math.round(x.target_sum / x.registered) : (x.target || settings.global.completion_target_pct),
  });
  return {
    years: years.map(y => ({ year: y, label: academicYearLabel(y) })),
    current_year: academicYearOf(new Date()),
    orgs: [...orgs.values()].map(o => Object.assign({ org: o.org }, fin(o), {
      branches: [...o.branches.values()].map(b => Object.assign({ branch: b.branch, schools: b.schools }, fin(b)))
        .sort((a, b) => b.registered - a.registered || a.branch.localeCompare(b.branch)),
    })).sort((a, b) => b.registered - a.registered || a.org.localeCompare(b.org)),
  };
}
// The raw school names of one school or group (org), or one of its branches, within `schools`.
async function schoolsOfBranch(schools, org, branch) {
  const idx = _groupIndex(schools, await getSchoolGroups());
  return schools.filter(sc => { const b = idx.get(match.normSchool(sc)); return b.org === org && (!branch || b.branch === branch); });
}

function wellbeingAreaOf(key, title) {
  const k = String(key || '').trim().toUpperCase(), t = String(title || '').trim().toLowerCase();
  const hit = WELLBEING_AREAS.find(a => a.key === k) || WELLBEING_AREAS.find(a => t.startsWith(a.label.toLowerCase() + ' adjust') || t === a.label.toLowerCase());
  return hit || WELLBEING_OTHER;
}
// Counts per area for a list of facts (a student can be in more than one area).
function wellbeingAreaCounts(list) {
  const c = { S: 0, E: 0, A: 0, other: 0 };
  for (const f of list) for (const a of (f.seaa_support || [])) c[a.key] = (c[a.key] || 0) + 1;
  return c;
}

/* Career distribution for the overview chart. by = 'career_area' | 'stream'.
   Built from getBreakdown, so every completed student is counted exactly once
   (including a "Not available yet" bar when a report lacks interest data) and
   the bars always add up to the Completed KPI. The previous version grouped
   by the AI's free-text career name and kept only the top 20, which is why
   large schools showed far fewer students than had completed. */
async function getCareerDistribution(schools, by = 'career_area', { predicate } = {}) {
  const dim = by === 'stream' ? 'stream' : 'career_area';
  const b = await getBreakdown(schools, dim, { predicate });
  const total = b.totals.population;
  return {
    by: dim, label: b.dimension.label, question: b.dimension.question, total,
    distribution: b.groups.map(g => ({
      key: g.key, career: g.label, description: g.description, count: g.total,
      pct: total ? Math.round(g.total / total * 100) : 0,
    })).sort((a, b2) => b2.count - a.count),
  };
}

/* Average time per assessment part. Aptitude is one part made of eight timed
   subtests, so it is the sum of all eight for students who finished all eight. */
async function getModuleTiming(schools, { predicate = null } = {}) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const only = await _predicateFilter(schools, predicate, params);
  const MODULES = [
    { key: 'nmap', label: 'Personality (NMAP)',            done: 'a.nmap_completed_at IS NOT NULL', secs: 'a.nmap_duration_seconds' },
    { key: 'daab', label: 'Aptitude — all 8 tests (DAAB)', done: 'a.daab_va_completed_at IS NOT NULL AND a.daab_pa_completed_at IS NOT NULL AND a.daab_na_completed_at IS NOT NULL AND a.daab_lsa_completed_at IS NOT NULL AND a.daab_hma_completed_at IS NOT NULL AND a.daab_ar_completed_at IS NOT NULL AND a.daab_ma_completed_at IS NOT NULL AND a.daab_sa_completed_at IS NOT NULL', secs: '(COALESCE(a.daab_va_duration_seconds,0) + COALESCE(a.daab_pa_duration_seconds,0) + COALESCE(a.daab_na_duration_seconds,0) + COALESCE(a.daab_lsa_duration_seconds,0) + COALESCE(a.daab_hma_duration_seconds,0) + COALESCE(a.daab_ar_duration_seconds,0) + COALESCE(a.daab_ma_duration_seconds,0) + COALESCE(a.daab_sa_duration_seconds,0))' },
    { key: 'cpi',  label: 'Career interests (CPI)',        done: 'a.cpi_completed_at IS NOT NULL',  secs: 'a.cpi_duration_seconds' },
    { key: 'sea',  label: 'Wellbeing (SEAA)',              done: 'a.sea_completed_at IS NOT NULL',  secs: 'a.sea_duration_seconds' },
  ];
  const out = [];
  for (const m of MODULES) {
    const row = await pg.one(
      `SELECT COUNT(*)::int AS completion_count,
              ROUND((AVG(${m.secs}) / 60.0)::numeric, 1)::float8 AS avg_minutes,
              ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${m.secs}) / 60.0)::numeric, 1)::float8 AS median_minutes
         FROM assessments a
         JOIN students s ON s.session_id = a.session_id
        WHERE ${match.sqlNormSchool('s.school')} IN (${ph})${only} AND ${m.done} AND ${m.secs} > 0`,
      params
    );
    out.push({
      module: m.label, key: m.key,
      avg_minutes: row ? (Number(row.avg_minutes) || 0) : 0,
      median_minutes: row ? (Number(row.median_minutes) || 0) : 0,
      completion_count: row ? (row.completion_count || 0) : 0,
    });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   HOUSEKEEPING
   Every dashboard number is computed live from the same student facts, so
   no aggregate is cached. analytics_cache (left by earlier builds) is
   emptied, and AI analyses older than 30 days are dropped.
══════════════════════════════════════════════════════════════════ */
async function pruneCaches() {
  await pg.exec('DELETE FROM analytics_cache');
  await pg.exec("DELETE FROM ai_insights_cache WHERE created_at < now() - interval '30 days'");
}


/* ══════════════════════════════════════════════════════════════════
   REMINDERS
══════════════════════════════════════════════════════════════════ */
/* ── Follow-up tasks ──────────────────────────────────────────────
   Each staff member's own task list. A task may point at a student record
   (session_id) or just carry the name as typed. */
const FOLLOWUP_OPEN_MAX = 1000;   // open tasks per user, a guard against runaway scripts
const FOLLOWUP_TYPES = { call: 'Call parent', checkin: 'Student check-in', email: 'Send email', report: 'Share report', meeting: 'Meeting', other: 'Other' };
async function listFollowups(userId) {
  return pg.many(
    `SELECT f.id, f.session_id, COALESCE(NULLIF(s.full_name, ''), f.student_label) AS student, s.school, s.class, s.section,
            f.task_type, f.notes, to_char(f.due_date, 'YYYY-MM-DD') AS due, f.done, f.created_at, f.done_at
       FROM followup_tasks f LEFT JOIN students s ON s.session_id = f.session_id
      WHERE f.user_id = $1 ORDER BY f.done, f.due_date NULLS LAST, f.id DESC LIMIT 500`, [userId]);
}
async function createFollowup({ userId, sessionId, studentLabel, type, notes, due }) {
  if (!FOLLOWUP_TYPES[type]) throw Object.assign(new Error('Unknown task type.'), { status: 400 });
  const d = due ? String(due).slice(0, 10) : null;
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw Object.assign(new Error('Due date must be YYYY-MM-DD.'), { status: 400 });
  const label = String(studentLabel || '').trim().slice(0, 160) || null;
  if (!sessionId && !label) throw Object.assign(new Error('Say which student the task is about.'), { status: 400 });
  const mine = await pg.one('SELECT COUNT(*)::int AS n FROM followup_tasks WHERE user_id = $1 AND NOT done', [userId]);
  if (mine && mine.n >= FOLLOWUP_OPEN_MAX) throw Object.assign(new Error(`You have ${FOLLOWUP_OPEN_MAX.toLocaleString('en-IN')} open tasks. Complete some first.`), { status: 400 });
  const r = await pg.one(
    `INSERT INTO followup_tasks (user_id, session_id, student_label, task_type, notes, due_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, sessionId || null, label, type, String(notes || '').trim().slice(0, 2000) || null, d]);
  return r.id;
}
async function setFollowupDone(userId, id, done) {
  return (await pg.exec(`UPDATE followup_tasks SET done = $3, done_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $2 AND user_id = $1`, [userId, id, !!done])).rowCount;
}
async function deleteFollowup(userId, id) {
  return (await pg.exec(`DELETE FROM followup_tasks WHERE id = $2 AND user_id = $1`, [userId, id])).rowCount;
}

/* ── Scheduled reminder campaigns ──────────────────────────────────
   A schedule names a group of students (by progress), optionally one
   school, and how often to write to them. The server runs due schedules
   (dashboard-api runReminderSchedules); this file only stores them. */
const SCHEDULE_GROUPS = {
  not_started: { label: 'Not started', dimension: 'completion', groups: ['not_started'] },
  in_progress: { label: 'In progress', dimension: 'completion', groups: ['in_progress'] },
  all_pending: { label: 'Not yet completed', dimension: 'completion', groups: ['not_started', 'in_progress'] },
  stalled:     { label: 'Stalled', dimension: 'attention', groups: ['stalled'] },
};
const SCHEDULE_FREQUENCIES = [1, 2, 7];
// Schools with fewer registered students than this are folded into one line
// on overview tables (often a school name typed differently at registration).
const SMALL_SCHOOL_MAX_STUDENTS = _int(process.env.SMALL_SCHOOL_MAX_STUDENTS, 5);
const SCHEDULES_PER_USER_MAX = parseInt(process.env.SCHEDULES_PER_USER_MAX || '20', 10);
const APP_TZ = () => APP_TIMEZONE;
// Today at `send_hour` in the app's time zone, or tomorrow if that has passed.
const _NEXT_RUN_SQL = (hourParam, tzParam) =>
  `CASE WHEN ((date_trunc('day', now() AT TIME ZONE ${tzParam}) + make_interval(hours => ${hourParam})) AT TIME ZONE ${tzParam}) > now()
        THEN ((date_trunc('day', now() AT TIME ZONE ${tzParam}) + make_interval(hours => ${hourParam})) AT TIME ZONE ${tzParam})
        ELSE ((date_trunc('day', now() AT TIME ZONE ${tzParam}) + make_interval(days => 1, hours => ${hourParam})) AT TIME ZONE ${tzParam}) END`;

async function createSchedule({ createdBy, targetGroup, school, frequencyDays, sendHour, subject, message }) {
  if (!SCHEDULE_GROUPS[targetGroup]) throw Object.assign(new Error('Choose who the reminder goes to.'), { status: 400 });
  const freq = parseInt(frequencyDays, 10);
  if (!SCHEDULE_FREQUENCIES.includes(freq)) throw Object.assign(new Error('Frequency must be daily, every 2 days or weekly.'), { status: 400 });
  const hour = parseInt(sendHour, 10);
  if (!(hour >= 0 && hour <= 23)) throw Object.assign(new Error('Send hour must be between 0 and 23.'), { status: 400 });
  const subj = String(subject || '').trim().slice(0, 160), msg = String(message || '').trim().slice(0, 4000);
  if (!subj || !msg) throw Object.assign(new Error('Subject and message are required.'), { status: 400 });
  const mine = await pg.one('SELECT COUNT(*)::int AS n FROM reminder_schedules WHERE created_by = $1', [createdBy]);
  if (mine && mine.n >= SCHEDULES_PER_USER_MAX) throw Object.assign(new Error(`You already have ${SCHEDULES_PER_USER_MAX} schedules. Delete one first.`), { status: 400 });
  const row = await pg.one(
    `INSERT INTO reminder_schedules (created_by, target_group, school, frequency_days, send_hour, subject, message, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, ${_NEXT_RUN_SQL('$5', '$8')}) RETURNING id`,
    [createdBy, targetGroup, String(school || '').trim() || null, freq, hour, subj, msg, APP_TZ()]);
  return row.id;
}
async function listSchedules({ createdBy } = {}) {
  const rows = await pg.many(
    `SELECT s.*, u.name AS created_by_name FROM reminder_schedules s JOIN dashboard_users u ON u.id = s.created_by
      ${createdBy ? 'WHERE s.created_by = $1' : ''} ORDER BY s.active DESC, s.next_run_at ASC`, createdBy ? [createdBy] : []);
  return rows.map(r => Object.assign(r, { target_label: (SCHEDULE_GROUPS[r.target_group] || {}).label || r.target_group }));
}
async function setScheduleActive(id, active, { createdBy } = {}) {
  const r = await pg.exec(
    `UPDATE reminder_schedules SET active = $2, last_error = NULL,
            next_run_at = CASE WHEN $2 THEN ${_NEXT_RUN_SQL('send_hour', '$3')} ELSE next_run_at END
      WHERE id = $1 ${createdBy ? 'AND created_by = $4' : ''}`, createdBy ? [id, !!active, APP_TZ(), createdBy] : [id, !!active, APP_TZ()]);
  return r.rowCount;
}
async function deleteSchedule(id, { createdBy } = {}) {
  const r = await pg.exec(`DELETE FROM reminder_schedules WHERE id = $1 ${createdBy ? 'AND created_by = $2' : ''}`, createdBy ? [id, createdBy] : [id]);
  return r.rowCount;
}
/* Claims every due schedule (so two workers never run the same one) and
   returns them with their creator's scope. `run(schedule, creator)` sends and
   returns { sent, skipped }; the outcome and the next run are recorded here. */
async function runDueSchedules(run) {
  const due = await pg.tx(async (c) => {
    const r = await c.query(
      `SELECT id FROM reminder_schedules WHERE active AND next_run_at <= now() FOR UPDATE SKIP LOCKED`);
    if (!r.rows.length) return [];
    const ids = r.rows.map(x => x.id);
    // Pushing next_run_at forward first means a crash mid-run never causes a
    // storm of retries every few minutes; the error is kept for the page.
    await c.query(
      `UPDATE reminder_schedules SET next_run_at = next_run_at + make_interval(days => frequency_days)
        WHERE id = ANY($1)`, [ids]);
    // A schedule that was paused for longer than its frequency catches up to the future.
    await c.query(
      `UPDATE reminder_schedules SET next_run_at = ${_NEXT_RUN_SQL('send_hour', '$2')} WHERE id = ANY($1) AND next_run_at <= now()`, [ids, APP_TZ()]);
    return (await c.query(`SELECT * FROM reminder_schedules WHERE id = ANY($1)`, [ids])).rows;
  });
  for (const sch of due) {
    try {
      const creator = await _userById(sch.created_by);
      if (!creator || !creator.active) throw new Error('The user who created this schedule no longer has access.');
      const out = await run(sch, creator);
      await pg.exec(`UPDATE reminder_schedules SET last_run_at = now(), last_run_sent = $2, last_run_skipped = $3, last_error = NULL WHERE id = $1`, [sch.id, out.sent, out.skipped]);
    } catch (e) {
      await pg.exec(`UPDATE reminder_schedules SET last_run_at = now(), last_error = $2 WHERE id = $1`, [sch.id, String(e.message || e).slice(0, 300)]).catch(() => {});
    }
  }
  return due.length;
}
async function _userById(id) {
  const u = await pg.one('SELECT id, name, email, role, active, permissions FROM dashboard_users WHERE id = $1', [id]);
  if (!u) return null;
  const schools = await pg.many('SELECT school FROM dashboard_user_schools WHERE user_id = $1', [id]);
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, schools: schools.map(r => r.school), permissions: _perms(u.permissions) };
}
// Emails that already received a reminder in the last `days` days.
async function recentlyReminded(emails, days) {
  if (!emails.length) return new Set();
  const rows = await pg.many(
    `SELECT DISTINCT LOWER(student_email) AS e FROM reminder_log WHERE LOWER(student_email) = ANY($1) AND sent_at > now() - make_interval(days => $2)`,
    [emails.map(e => e.toLowerCase()), days]);
  return new Set(rows.map(r => r.e));
}

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
  // An array scopes the log to those schools; an empty one (staff with no
  // schools assigned) sees nothing rather than everything.
  if (Array.isArray(schools)) {
    if (!schools.length) return [];
    const ph = schools.map((_, i) => `$${i + 1}`).join(',');
    const params = schools.map(s => match.normSchool(s));
    // EXISTS, not JOIN: a student with several attempts must not repeat a row.
    return pg.many(
      `SELECT rl.*, du.name AS sent_by_name
       FROM reminder_log rl
       LEFT JOIN dashboard_users du ON du.id = rl.sent_by
       WHERE EXISTS (SELECT 1 FROM students st
                     WHERE st.email = rl.student_email::citext
                       AND ${match.sqlNormSchool('st.school')} IN (${ph}))
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
async function upsertStudent({ session_id, first_name, last_name, full_name, email, class: cls, section, school, school_state, school_city, age, gender, student_uid }) {
  const now  = new Date().toISOString();
  const norm = String(email || '').toLowerCase().trim();
  const uid  = match.cleanUid(student_uid) || null;
  const schoolName = String(school || '').trim().replace(/\s+/g, ' ');

  // Staff-created students get an access code on creation, exactly like imported
  // ones, so "Add Student" and "Import CSV" behave identically. COALESCE keeps
  // any existing code intact when this is an update rather than an insert.
  const doUpsert = (c, sid) => c.query(
    `INSERT INTO students (session_id, first_name, last_name, full_name, email, class, section, school, school_state, school_city, age, gender, registered_at, access_code, access_code_set_at, student_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (session_id) DO UPDATE SET
       first_name   = EXCLUDED.first_name,   last_name    = EXCLUDED.last_name,
       full_name    = EXCLUDED.full_name,    email        = EXCLUDED.email,
       class        = EXCLUDED.class,        section      = EXCLUDED.section,
       school       = EXCLUDED.school,       school_state = EXCLUDED.school_state,
       school_city  = EXCLUDED.school_city,  age          = EXCLUDED.age,
       gender       = EXCLUDED.gender,
       student_uid  = COALESCE(EXCLUDED.student_uid, students.student_uid),
       access_code        = COALESCE(students.access_code, EXCLUDED.access_code),
       access_code_set_at = COALESCE(students.access_code_set_at, EXCLUDED.access_code_set_at)`,
    [sid, first_name || '', last_name || '', full_name || (first_name + ' ' + (last_name || '')).trim(),
     norm, String(cls || '').trim().replace(/\s+/g, ' '), section || '', schoolName, school_state || '', school_city || '', age || '', gender || '', now,
     generateAccessCode(), now, uid]
  );

  let resultSid;
  try {
    resultSid = await pg.tx(async (c) => {
      let sid = session_id;
      // The Unique School ID identifies the student within their school; it
      // wins over email when both are given.
      // An ID already held by a different student is a conflict, never an
      // update: a typo would otherwise rename someone else's record.
      const byUid = uid ? await findStudentByUid(schoolName, uid, c) : null;
      if (byUid && byUid.session_id !== session_id) {
        throw Object.assign(new Error(`Unique School ID ${uid} is already used by another student at this school.`), { status: 409, code: 'UID_TAKEN' });
      }
      if (!sid && norm) {
        const existing = await c.query('SELECT session_id, school FROM students WHERE email = $1', [norm]);
        const hit = existing.rows[0];
        // Same email at another school: refuse rather than move that school's student here.
        if (hit && !match.schoolMatches(schoolName, hit.school)) {
          throw Object.assign(new Error('This email is already used by a student at another school.'), { status: 409 });
        }
        if (hit) sid = hit.session_id;
      }
      if (!sid) sid = crypto.randomBytes(16).toString('hex');
      await doUpsert(c, sid);
      return sid;
    });
  } catch (e) {
    // Two saves at once can both pass the checks above; the database index is
    // the final word, reported as the same 409.
    if (_isUidConflict(e)) throw Object.assign(new Error(`Unique School ID ${uid} is already used by another student at this school.`), { status: 409, code: 'UID_TAKEN' });
    if (norm && e.code === '23505') {
      const row = await pg.one('SELECT session_id, school FROM students WHERE email = $1', [norm]);
      if (row && match.schoolMatches(schoolName, row.school)) return row.session_id;
      throw Object.assign(new Error('This email is already used by another student.'), { status: 409 });
    }
    throw e;
  }
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

/* ══════════════════════════════════════════════════════════════════
   STUDENT ACCESS CODES
   Staff-issued credential letting a bulk-imported student start the
   assessment without re-registering. Codes are short and human-typable,
   so they are deliberately scoped: a code is only ever looked up together
   with the student's school + class + name, never on its own.
══════════════════════════════════════════════════════════════════ */

// Unambiguous alphabet — no O/0, I/1, S/5 to avoid transcription errors
// when a code is read off a dashboard and typed by a student.
const _CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

function generateAccessCode(len = 8) {
  // rejection sampling keeps the distribution uniform (256 % 30 != 0)
  const limit = 256 - (256 % _CODE_ALPHABET.length);
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len)) {
      if (b < limit) { out += _CODE_ALPHABET[b % _CODE_ALPHABET.length]; if (out.length === len) break; }
    }
  }
  return out;
}

// Constant-time compare so a redeem endpoint can't be timing-probed.
function _codesEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Issue (or re-issue) a code for one student. Returns the new plaintext code.
async function setStudentAccessCode(sessionId, code) {
  const c = code || generateAccessCode();
  await pg.exec(
    `UPDATE students SET access_code = $1, access_code_set_at = $2 WHERE session_id = $3`,
    [c, new Date().toISOString(), sessionId]
  );
  return c;
}

// Redeem: school + class + name + code must ALL match one student.
// Returns the student row on success, null otherwise. The candidate set is
// narrowed in SQL by school/class/name; the code itself is compared in JS
// in constant time so we never leak which field was wrong.
// The school a typed name belongs to now: a merged-away spelling gives the
// school it was merged into, anything else is returned as typed.
async function mergedSchoolOf(name, client) {
  const sc = String(name || '').trim();
  if (!sc) return sc;
  const run = client ? (t, p) => client.query(t, p).then(r => r.rows[0] || null) : pg.one;
  const row = await run(`SELECT school FROM school_merges WHERE name_key = ${match.sqlNormSchool('$1')}`, [sc]);
  return row ? row.school : sc;
}

async function redeemAccessCode({ school, klass, name, uid, code }) {
  // A student may still type a spelling that has since been merged.
  const sc = await mergedSchoolOf(school);
  const kl = String(klass  || '').trim();
  const nm = String(name   || '').trim();
  const cd = String(code   || '').trim().toUpperCase();
  // Second way in: school + Unique School ID + code (the ID replaces class + name).
  if (uid != null && String(uid).trim()) {
    if (!sc || !cd) return null;
    // Found by ID, then the school is matched the same forgiving way as the
    // class-and-name path ("ABPS" finds "ABPS,BAGA"). If the typed school fits
    // more than one school holding this ID, only an exact school match counts.
    const cands = (await pg.many(
      `SELECT session_id, first_name, last_name, full_name, class, section, school, school_state,
              school_city, email, age, gender, access_code, student_uid
         FROM students
        WHERE access_code IS NOT NULL AND ${match.sqlHasUid('student_uid')} AND ${_SQL_NORM_UID('student_uid')} = $1`,
      [match.normUid(uid)])).filter(r => match.schoolMatches(sc, r.school));
    const row = cands.length === 1 ? cands[0]
      : cands.find(r => match.uidSchoolKey(r.school) === match.uidSchoolKey(sc)) || null;
    // Compare even when no row was found, so timing does not reveal which part was wrong.
    const ok = _codesEqual(row ? row.access_code : 'X'.repeat(cd.length || 8), cd);
    if (!row || !ok) return null;
    delete row.access_code;
    return row;
  }
  if (!sc || !kl || !nm || !cd) return null;

  // Narrow in SQL only by "has a code" — school/class/name are compared with
  // match-utils below so "ABPS" finds "ABPS,BAGA" and "9" finds "IX". Widening
  // the candidate set does not weaken the credential: the access code is still
  // compared byte-for-byte in constant time, and a wrong code matches nothing.
  const rows = await pg.many(
    `SELECT session_id, first_name, last_name, full_name, class, section,
            school, school_state, school_city, email, age, gender, access_code, student_uid
       FROM students
      WHERE access_code IS NOT NULL`
  );
  for (const r of rows) {
    if (!match.schoolMatches(sc, r.school))  continue;
    if (!match.classMatches(kl, r.class))    continue;
    if (!match.nameMatches(nm, r.full_name)) continue;
    if (_codesEqual(r.access_code, cd)) { delete r.access_code; return r; }
  }
  return null;
}

/* ── Access-code entry lookups ───────────────────────────────────────
   Exact matching would fail real students: a row saying "ABPS,BAGA" must be
   found from "ABPS", and "IX" from the "9" they pick. So the candidate set is
   fetched with a cheap SQL prefilter and narrowed in JS by match-utils, which
   understands punctuation, partial school names, and roman-numeral /
   "Class 9" / "9th" grade labels.
   Row counts per school are small (hundreds at most), so the JS pass costs
   little next to the database round-trip. */

/* Every school that has at least one code-holding student. This is the source
   for the entry form's school suggestions, so it always reflects the schools
   staff have actually imported (the only ones whose students can use it). */
async function listAccessSchools(query) {
  const rows = await pg.many(
    `SELECT DISTINCT btrim(school) AS school
       FROM students
      WHERE access_code IS NOT NULL
        AND school IS NOT NULL AND btrim(school) <> ''
      ORDER BY school`
  );
  const all = rows.map(r => r.school).filter(Boolean);
  const q = String(query || '').trim();
  if (!q) return all;
  return all.filter(s => match.schoolMatches(q, s));
}

// Names available for the school+class picker on the student entry screen.
// Only students who actually have a code are listed.
async function listAccessNames(school, klass) {
  const rows = await pg.many(
    `SELECT full_name, school, class FROM students
      WHERE access_code IS NOT NULL
        AND full_name IS NOT NULL AND btrim(full_name) <> ''
      ORDER BY full_name`
  );
  const seen = new Set();
  const out  = [];
  for (const r of rows) {
    if (!match.schoolMatches(school, r.school)) continue;
    if (!match.classMatches(klass, r.class))    continue;
    const key = match.normName(r.full_name);
    if (seen.has(key)) continue;      // same student listed once
    seen.add(key);
    out.push({ full_name: r.full_name });
  }
  return out;
}

/* Distinct classes for a school that have at least one code-holding student.
   Bulk import stores class as free text ("10-B", "Class 10 DS"), so the entry
   form cannot use a fixed Grade 9-12 list — it must offer these values.
   Rows whose labels differ only in notation ("IX" and "9") are collapsed to a
   single option so the student is not asked to guess which spelling is theirs. */
async function listAccessClasses(school) {
  const rows = await pg.many(
    `SELECT DISTINCT btrim(class) AS class, school FROM students
      WHERE access_code IS NOT NULL
        AND class IS NOT NULL AND btrim(class) <> ''
      ORDER BY class`
  );
  const labelsByGrade = new Map();  // grade number → Set of distinct raw labels
  const other         = [];
  for (const r of rows) {
    if (!match.schoolMatches(school, r.school)) continue;
    const label = String(r.class || '').trim();
    const g = match.classGradeNumber(label);
    if (g == null) { if (!other.includes(label)) other.push(label); continue; }
    if (!labelsByGrade.has(g)) labelsByGrade.set(g, new Set());
    labelsByGrade.get(g).add(label);
  }

  /* One option per grade. Which label to show:
       - exactly one raw label for this grade  → show it verbatim ("IX", "10-B")
       - several labels ("IX-A" and "IX-B", or "IX" and "9") → show the plain
         grade number.
     Showing an arbitrary section here would be actively misleading: a student
     in IX-B would be offered only "IX-A" and reasonably conclude their class
     is missing. Grade-level matching means one option per grade is correct;
     the label just has to be honest about that. */
  const graded = [...labelsByGrade.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([grade, labels]) => ({
      class: labels.size === 1 ? [...labels][0] : String(grade),
    }));
  return graded.concat(other.sort().map(c => ({ class: c })));
}

/* Bulk roster import.

   Three things this has to get right that the previous version did not:

   1. IDENTITY. Rows were de-duplicated by email only. Bulk rosters usually
      carry no email at all, so every row fell through to a fresh random
      session_id and re-importing the same file created a complete second copy
      of the roster. Rows without an email are now matched on the natural key
      a school actually uses — school + class + name — which is the same tuple
      the access-code login already treats as identifying a student.

   2. ACCESS CODES. The importer ignored any access_code column and always
      generated a new one. Since the CSV export includes access codes, the
      obvious round-trip (export a roster, edit it, import it back) silently
      re-issued every code and invalidated the slips already handed out. A code
      supplied in the file is now honoured, and an existing code is never
      overwritten.

   3. VISIBLE FAILURES. Every error was swallowed by `catch (_) { skipped++ }`,
      so a rejected row was indistinguishable from a blank one and nobody could
      tell why an import "worked" but came up short. Each skip now records a row
      number and a reason, returned to the caller for display. */
/* Bulk roster import.

   Four things this has to get right that the previous version did not:

   1. IDENTITY. Rows were de-duplicated by email only. Bulk rosters usually
      carry no email at all, so every row fell through to a fresh random
      session_id and re-importing the same file created a complete second copy
      of the roster. Rows without an email are now matched on the natural key
      a school actually uses — school + class + name — which is the same tuple
      the access-code login already treats as identifying a student. Rows are
      matched against students already in the database AND against students
      created earlier in this same file, so a roster that lists someone twice
      produces one record rather than two.

   2. ACCESS CODES. The importer ignored any access_code column and always
      generated a new one. Since the CSV export includes access codes, the
      obvious round-trip (export a roster, edit it, import it back) silently
      re-issued every code and invalidated the slips already handed out. A code
      supplied in the file is now honoured — unless it already belongs to a
      different student, in which case the row keeps its own code rather than
      creating two students who can log in with the same string. Nothing
      enforces uniqueness at the schema level (idx_students_access is a plain
      index), so this check is the only thing standing behind that invariant.

   3. VISIBLE FAILURES. Every error was swallowed by `catch (_) { skipped++ }`,
      so a rejected row was indistinguishable from a blank one and nobody could
      tell why an import "worked" but came up short. Each skip now records a row
      number and a reason, returned to the caller for display.

   4. COST. Matching on the natural key needs the existing email-less students,
      and querying for them per row would mean one full scan per row — 683 rows
      against a 683-student school is 683 queries and ~466k comparisons, all
      holding a transaction open. They are fetched once, up front, and indexed
      in memory by normalised (school, grade, name). */
/* Column names schools use for the Unique School ID. Headers arrive lower-
   cased with spaces as underscores ("Admission No" → admission_no). */
const UID_COLUMNS = ['student_uid', 'unique_school_id', 'unique_id', 'uid', 'student_id', 'school_id',
  'school_student_id', 'admission_no', 'admission_number', 'enrolment_no', 'enrollment_no', 'enrolment_number', 'enrollment_number'];
function _importUid(row) {
  for (const k of UID_COLUMNS) if (row[k] != null && String(row[k]).trim()) return String(row[k]).trim();
  return '';
}

async function runImportTransaction(rows) {
  let imported = 0, updated = 0, skipped = 0;
  /* Two distinct lists. `errors` means the row did NOT go in; `warnings` means
     it did, with something the user should know. Collapsing them (an earlier
     version did) put successfully imported rows under a heading that said they
     had not been imported — worse than saying nothing. */
  const errors   = [];   // { row, name, reason } — row rejected
  const warnings = [];   // { row, name, reason } — row imported with a caveat

  /* Natural key for an email-less student. Normalised through match-utils so
     "ABPS"/"ABPS,BAGA", "IX"/"9" and "MAMTA  SHARMA"/"Mamta Sharma" collapse
     to the same key. Grade is used rather than the raw class label because a
     roster re-exported from elsewhere often changes notation. */
  const natKey = (school, klass, name) => {
    const g = match.classGradeNumber(klass);
    return match.normSchool(school) + '|' + (g == null
      ? String(klass || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
      : 'g' + g) + '|' + match.normName(name);
  };

  await pg.tx(async (c) => {
    // One read, up front, instead of one per row.
    const existing = await c.query(
      `SELECT session_id, school, class, full_name, email, access_code, student_uid FROM students`
    );
    // Unique School ID is the strongest key a school gives us: school|ID.
    const uidKey = (school, uid) => match.uidSchoolKey(school) + '|' + match.normUid(uid);
    const byUid   = new Map();   // school|unique id      → session_id
    const byEmail = new Map();   // normalised email      → session_id
    const byNat   = new Map();   // school|grade|name     → session_id (exact)
    const codeOwner = new Map(); // access_code           → session_id
    /* Email-less students kept as a list as well as a map. The map gives an
       O(1) hit for the common case, but a hashed key cannot express a partial
       school name: "ABPS" and "ABPS,BAGA" normalise to different strings even
       though schoolMatches() treats them as the same school. Rows that miss the
       map fall back to a scan of this list, which is already in memory — so the
       fuzzy case costs JS comparisons, never another database round-trip. */
    const emailless = [];
    const uidOf   = new Map();   // session_id            → its Unique School ID
    const rowOf   = new Map();   // session_id            → { school, full_name }
    for (const r of existing.rows) {
      rowOf.set(r.session_id, { school: r.school, full_name: r.full_name });
      if (r.student_uid && String(r.student_uid).trim()) { byUid.set(uidKey(r.school, r.student_uid), r.session_id); uidOf.set(r.session_id, r.student_uid); }
      const em = String(r.email || '').toLowerCase().trim();
      if (em) byEmail.set(em, r.session_id);
      else if (r.full_name && r.school) {
        const k = natKey(r.school, r.class, r.full_name);
        if (!byNat.has(k)) byNat.set(k, r.session_id);
        emailless.push({ session_id: r.session_id, school: r.school, class: r.class, full_name: r.full_name });
      }
      if (r.access_code) codeOwner.set(String(r.access_code).toUpperCase(), r.session_id);
    }

    const fuzzyFind = (school, klass, name) => {
      for (const row of emailless) {
        if (!match.schoolMatches(school, row.school)) continue;
        if (klass && !match.classMatches(klass, row.class)) continue;
        if (!match.nameMatches(name, row.full_name)) continue;
        return row.session_id;
      }
      return null;
    };

    // Unique School IDs already used by an earlier row of THIS file, so two
    // different students given the same ID are caught instead of the later
    // row silently overwriting the earlier one.
    const fileUids = new Map();   // school|unique id → { rowNo, name }
    // A merged-away spelling in the file means the school it was merged into
    // (the insert trigger stores it that way, so matching must agree).
    const mergedTo = new Map((await c.query('SELECT name_key, school FROM school_merges')).rows.map(m => [m.name_key, m.school]));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNo = i + 2;   // +2: 1-based, and row 1 is the header
      const fullName = String(r.full_name || r.name || '').trim();
      const fn = String(r.first_name || fullName.split(' ')[0] || '').trim();
      const ln = String(r.last_name  || fullName.split(' ').slice(1).join(' ') || '').trim();
      const display = fullName || (fn + ' ' + ln).trim();

      if (!fn && !fullName) {
        skipped++; errors.push({ row: rowNo, name: '', reason: 'No name in this row' });
        continue;
      }

      // A savepoint per row: one failed insert must not abort the whole
      // transaction (PostgreSQL rejects every later statement until rollback).
      await c.query('SAVEPOINT import_row');
      try {
        const norm   = String(r.email  || '').toLowerCase().trim();
        const typed  = String(r.school || r.School || '').trim().replace(/\s+/g, ' ');
        const school = mergedTo.get(match.normSchool(typed)) || typed;
        const klass  = String(r.class  || r.Class  || '').trim().replace(/\s+/g, ' ');
        const now    = new Date().toISOString();

        const uid    = match.cleanUid(_importUid(r)) || null;
        if (uid && school) {
          const prev = fileUids.get(uidKey(school, uid));
          if (prev && !match.nameMatches(display, prev.name)) {
            skipped++;
            errors.push({ row: rowNo, name: display, reason: `Unique School ID ${uid} is also given to ${prev.name} in row ${prev.rowNo}. Each student needs their own ID.` });
            await c.query('RELEASE SAVEPOINT import_row'); continue;
          }
          if (!prev) fileUids.set(uidKey(school, uid), { rowNo, name: display });
        }
        // Locate an existing student: Unique School ID first, then email, then
        // school + class + name.
        let sid = null, natk = null;
        if (uid && school) {
          sid = byUid.get(uidKey(school, uid)) || null;
          // Matched by ID: the name must agree. A different name means a typo
          // in the ID, or an ID someone else already registered with; updating
          // would overwrite another child's record, so the row is refused.
          const held = sid && rowOf.get(sid);
          if (held && held.full_name && !match.nameMatches(held.full_name, display)) {
            skipped++;
            errors.push({ row: rowNo, name: display, reason: `Unique School ID ${uid} already belongs to a student with a different name at this school. Check the ID, or edit that student if the name has changed.` });
            await c.query('RELEASE SAVEPOINT import_row'); continue;
          }
        }
        if (!sid && norm) {
          sid = byEmail.get(norm) || null;
          // An email already used at ANOTHER school is never matched: that would
          // move another school's student (and their reports) into this one.
          const held = sid && rowOf.get(sid);
          if (held && !match.schoolMatches(school, held.school)) {
            skipped++;
            errors.push({ row: rowNo, name: display, reason: 'This email is already used by a student at another school.' });
            await c.query('RELEASE SAVEPOINT import_row'); continue;
          }
        }
        if (!sid && display && school) {
          natk = natKey(school, klass, display);
          sid  = byNat.get(natk) || fuzzyFind(school, klass, display);
          // Same name and class but a different Unique School ID = a different
          // student (two "Rahul Kumar" in 10-A), not the same one.
          if (sid && uid && uidOf.get(sid) && match.normUid(uidOf.get(sid)) !== match.normUid(uid)) { sid = null; natk = null; }
        }
        // A student matched by email/name who already holds a DIFFERENT ID
        // at this school would end up with two IDs; keep the stored one.
        // Matched by ID: keep the ID as already stored (same ID, maybe spelt differently).
        let uidToSet = uid && sid && byUid.get(uidKey(school, uid)) === sid ? null : uid;
        if (uid && sid && !byUid.has(uidKey(school, uid))) {
          const had = uidOf.get(sid);
          if (had && match.normUid(had) !== match.normUid(uid)) {
            warnings.push({ row: rowNo, name: display, reason: `Already has Unique School ID ${had}; kept it and ignored ${uid}` });
            uidToSet = null;
          }
        }
        const isUpdate = !!sid;
        if (!sid) sid = crypto.randomBytes(16).toString('hex');

        /* Honour a code from the file only if it is free or already this
           student's. Handing the same code to two students would let one of
           them log in as the other. */
        let code = String(r.access_code || '').trim().toUpperCase() || null;
        if (code) {
          const owner = codeOwner.get(code);
          if (owner && owner !== sid) {
            warnings.push({ row: rowNo, name: display,
              reason: 'Access code ' + code + ' already belongs to another student — this row kept its own code' });
            code = null;
          }
        }
        /* Always offer a code. The ON CONFLICT below COALESCEs against the
           stored value, so an existing code is never overwritten — which means
           this only ever fills a gap. Gating it on `!isUpdate` (an earlier
           version of this function) meant re-importing a roster to backfill
           codes left already-known students without one, silently. */
        if (!code) code = generateAccessCode();

        await c.query(
          `INSERT INTO students (session_id, first_name, last_name, full_name, email, class, section, school, school_state, school_city, age, gender, registered_at, access_code, access_code_set_at, student_uid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (session_id) DO UPDATE SET
             student_uid = COALESCE(EXCLUDED.student_uid, students.student_uid),
             first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
             full_name = EXCLUDED.full_name,   email = EXCLUDED.email,
             class = EXCLUDED.class,           section = EXCLUDED.section,
             school = EXCLUDED.school,         school_state = EXCLUDED.school_state,
             school_city = EXCLUDED.school_city, age = EXCLUDED.age, gender = EXCLUDED.gender,
             -- keep any code already issued so re-importing a roster never
             -- invalidates codes already handed out to students
             access_code = COALESCE(students.access_code, EXCLUDED.access_code),
             access_code_set_at = COALESCE(students.access_code_set_at, EXCLUDED.access_code_set_at)`,
          [sid, fn || '', ln || '', display, norm,
           klass, r.section || r.Section || '',
           school, r.school_state || '', r.school_city || '',
           r.age || '', r.gender || '', now,
           code, now, uidToSet]
        );

        // Register this student so later rows in the SAME file match them
        // instead of creating a second record.
        if (norm) byEmail.set(norm, sid);
        if (uidToSet && school) { byUid.set(uidKey(school, uidToSet), sid); uidOf.set(sid, uidToSet); }
        if (natk && !byNat.has(natk)) byNat.set(natk, sid);
        if (!norm && !isUpdate && display && school) {
          emailless.push({ session_id: sid, school, class: klass, full_name: display });
        }
        if (code) codeOwner.set(code, sid);
        rowOf.set(sid, { school, full_name: display });

        if (isUpdate) updated++; else imported++;
        await c.query('RELEASE SAVEPOINT import_row');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT import_row');
        skipped++;
        errors.push({ row: rowNo, name: display, reason: _isUidConflict(e) ? 'This Unique School ID is already used by another student at this school.' : e.message.slice(0, 160) });
      }
    }
  });
  return { imported, updated, skipped,
           errors:   errors.slice(0, 50),
           warnings: warnings.slice(0, 50) };
}

async function deleteStudent(sessionId) {
  await pg.exec('DELETE FROM students WHERE session_id = $1', [sessionId]);
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
  const ALLOWED = ['class','section','school','first_name','last_name','full_name','email','age','gender','school_state','school_city','student_uid'];
  if (fields.student_uid !== undefined) fields = Object.assign({}, fields, { student_uid: match.cleanUid(fields.student_uid) || null });
  // Changing the ID or the school: the (school, ID) pair must stay free.
  if (fields.student_uid || fields.school) {
    const cur = await pg.one('SELECT school, student_uid FROM students WHERE session_id = $1', [sessionId]);
    const uid = fields.student_uid !== undefined ? fields.student_uid : (cur && cur.student_uid);
    const owner = uid ? await findStudentByUid(fields.school || (cur && cur.school), uid) : null;
    if (owner && owner.session_id !== sessionId) {
      throw Object.assign(new Error(`Unique School ID ${uid} is already used by another student at ${fields.school ? 'that' : 'this'} school.`), { status: 409, code: 'UID_TAKEN' });
    }
  }
  const sets = [], vals = [];
  let n = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.includes(k) && v !== undefined) { sets.push(`${k} = $${n++}`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(sessionId);
  try {
    await pg.exec(`UPDATE students SET ${sets.join(', ')} WHERE session_id = $${n}`, vals);
  } catch (e) {
    if (_isUidConflict(e)) throw Object.assign(new Error('That Unique School ID is already used by another student at this school.'), { status: 409, code: 'UID_TAKEN' });
    throw e;
  }
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
/* The registered schools, as admins entered them. Reading the list never
   adds to it: names students type are shown separately (listSchoolNames)
   until an admin registers or merges them. */
async function listRegisteredSchools() {
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
   PROGRAMME ANALYTICS — one source of truth for every dashboard number
   ------------------------------------------------------------------
   Every chart, KPI, alert and drill-down list is computed from the same
   per-student "facts" (getStudentFacts). A chart's counts and the student
   list behind a bar are produced by the same dimension definition, so the
   number on a bar always equals the length of the list it opens.

   Nothing here is a hand-maintained list of categories:
     • career areas and subject streams come from the assessment's own
       definition (js/engine/cpi.js, loaded below);
     • status words and thresholds come from db.js (the code that writes them);
     • class groups come from the class labels actually on record, collapsed
       by grade with match-utils (so "10", "Class 10", "X-B" are one class);
     • strongest-trait / strongest-aptitude groups are whatever the reports
       contain.
══════════════════════════════════════════════════════════════════ */
const _fs   = require('fs');
const _path = require('path');
const _core = require('./db.js');

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

/* ── Career areas, straight from the assessment definition ──────────
   cpi.js is a browser ES module with no imports, so it can be loaded here
   unchanged. Both the repo layout (js/engine/cpi.js) and a flat deploy
   (cpi.js next to server.js) are supported. */
let _careerAreasPromise = null;
function getCareerAreas() {
  if (!_careerAreasPromise) {
    const candidates = [
      _path.join(__dirname, 'js', 'engine', 'cpi.js'),
      _path.join(__dirname, 'engine', 'cpi.js'),
      _path.join(__dirname, 'cpi.js'),
    ];
    const file = candidates.find(f => _fs.existsSync(f));
    _careerAreasPromise = (file
      ? import('data:text/javascript,' + encodeURIComponent(_fs.readFileSync(file, 'utf8')))
      : Promise.reject(new Error('cpi.js not found next to the server')))
      .then(m => (m.CPI_AREAS || []).map(a => ({
        id: a.id, label: a.label, stream: a.stream || null, subjects: a.subjects || null,
        careers: Array.isArray(a.careers) ? a.careers.slice() : [], color: a.color || null,
      })))
      .catch(e => { _careerAreasPromise = null; throw e; });
  }
  return _careerAreasPromise;
}

/* ── Programme settings ─────────────────────────────────────────────
   Editable from the dashboards; stored per school or network-wide. The
   defaults below apply only until someone saves a value, and can be set per
   deployment through the environment. */
const SETTINGS_SCHEMA = Object.freeze({
  completion_target_pct: {
    label: 'Completion target (%)',
    description: 'The share of registered students the school aims to have fully completed (all 4 parts done and the report generated). Schools and classes below this are flagged.',
    min: 1, max: 100, default: _int(process.env.DEFAULT_COMPLETION_TARGET_PCT, 80),
  },
  follow_up_after_days: {
    label: 'Follow up after (days)',
    description: 'A student who started but has saved no progress for this many days is "stalled"; a student who registered this many days ago and has not started is "overdue to start".',
    min: 1, max: 60, default: _int(process.env.DEFAULT_FOLLOW_UP_DAYS, 3),
  },
});
const _scopeKeyFor = (school) => school ? 'school:' + match.normSchool(school) : 'global';

function _cleanSettings(obj) {
  const out = {};
  for (const [k, def] of Object.entries(SETTINGS_SCHEMA)) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) out[k] = Math.min(def.max, Math.max(def.min, Math.round(n)));
    }
  }
  return out;
}

/* Effective settings for a set of schools: defaults ← global ← per school. */
async function getSettingsMap(schools) {
  const keys = ['global', ...(schools || []).map(_scopeKeyFor)];
  const rows = await pg.many('SELECT scope, settings FROM dashboard_settings WHERE scope = ANY($1)', [keys]);
  const byScope = new Map(rows.map(r => [r.scope, _cleanSettings(r.settings)]));
  const defaults = Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([k, d]) => [k, d.default]));
  const global = Object.assign({}, defaults, byScope.get('global') || {});
  const bySchool = new Map();
  for (const s of (schools || [])) {
    bySchool.set(match.normSchool(s), Object.assign({}, global, byScope.get(_scopeKeyFor(s)) || {}));
  }
  return {
    global,
    forSchool: (school) => bySchool.get(match.normSchool(school)) || global,
    overrides: Object.fromEntries([...byScope.entries()]),
  };
}

async function saveSettings({ school, values, userId }) {
  const clean = _cleanSettings(values);
  if (!Object.keys(clean).length) throw new Error('No valid settings supplied');
  const scope = _scopeKeyFor(school);
  await pg.exec(
    `INSERT INTO dashboard_settings (scope, settings, updated_at, updated_by)
     VALUES ($1, $2::jsonb, now(), $3)
     ON CONFLICT (scope) DO UPDATE SET
       settings   = dashboard_settings.settings || EXCLUDED.settings,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [scope, JSON.stringify(clean), userId || null]
  );
  return clean;
}

/* ── Class groups ────────────────────────────────────────────────── */
function classGroupOf(raw) {
  const g = match.classGradeNumber(raw);
  if (g != null) return { key: 'g' + g, label: 'Class ' + g, order: g };
  const lbl = String(raw || '').trim();
  return lbl
    ? { key: 'x:' + lbl.toLowerCase().replace(/\s+/g, ' '), label: lbl, order: 1000 }
    : { key: 'none', label: 'Class not recorded', order: 1001 };
}

/* Raw class labels in scope that belong to a requested class (grade-tolerant). */
async function _classLabelsMatching(schools, cls) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length || !cls) return [];
  const rows = await pg.many(
    `SELECT DISTINCT class FROM students WHERE ${match.sqlNormSchool('school')} IN (${ph}) AND class IS NOT NULL`, params);
  const want = String(cls).trim();
  const wantGroup = want.startsWith('g') || want.startsWith('x:') || want === 'none' ? want : null;
  return rows.map(r => r.class).filter(c =>
    wantGroup ? classGroupOf(c).key === wantGroup : match.classMatches(want, c));
}

async function listClasses(schools) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const rows = await pg.many(
    `SELECT class, COUNT(*)::int AS n FROM students
      WHERE ${match.sqlNormSchool('school')} IN (${ph}) GROUP BY class`, params);
  const map = new Map();
  for (const r of rows) {
    const g = classGroupOf(r.class);
    if (!map.has(g.key)) map.set(g.key, Object.assign({}, g, { students: 0, labels: [] }));
    const e = map.get(g.key); e.students += r.n; if (r.class) e.labels.push(r.class);
  }
  return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/* ── Per-student facts ─────────────────────────────────────────────── */
async function getStudentFacts(schools, { predicate } = {}) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return [];
  const rows = await pg.many(
    `SELECT
       s.session_id, s.full_name, s.first_name, s.class, s.section, s.school, s.email, s.student_uid,
       s.gender, s.registered_at, s.completed_at, s.access_code IS NOT NULL AS has_access_code,
       CASE WHEN rs.session_id IS NOT NULL THEN 'completed'
            WHEN a.session_id  IS NOT NULL THEN 'in_progress'
            ELSE 'not_started' END AS status,
       ${_MODULES_DONE_EXPR} AS modules_done,
       (a.nmap_completed_at IS NOT NULL) AS personality_done, (${_DAAB_ALL_DONE_EXPR}) AS aptitude_done,
       (a.cpi_completed_at IS NOT NULL) AS career_done, (a.sea_completed_at IS NOT NULL) AS seaa_done,
       a.saved_at AS last_activity,
       rs.generated_at, rs.fit_score, rs.fit_tier,
       rs.personality_status, rs.aptitude_status, rs.interest_status, rs.seaa_status,
       rs.recommended_primary,
       ri.label AS top_interest, ri.score AS top_interest_score,
       (SELECT p.name FROM report_personality p
         WHERE p.session_id = s.session_id ORDER BY p.stanine DESC, p.position LIMIT 1) AS top_trait,
       (SELECT ap.name FROM report_aptitude ap
         WHERE ap.session_id = s.session_id AND ap.stanine > 0
         ORDER BY ap.stanine DESC, ap.position LIMIT 1) AS top_aptitude,
       (SELECT json_agg(json_build_object('key', se.key, 'title', se.title) ORDER BY se.key)
          FROM report_seaa se
         WHERE se.session_id = s.session_id AND se.cat_label = $${params.length + 1}) AS seaa_support,
       (SELECT json_object_agg(se.key, se.score) FROM report_seaa se WHERE se.session_id = s.session_id) AS seaa_scores
     FROM students s
     LEFT JOIN assessments      a  ON a.session_id  = s.session_id
     LEFT JOIN report_summary   rs ON rs.session_id = s.session_id
     LEFT JOIN report_interests ri ON ri.session_id = s.session_id AND ri.rank = 1
     WHERE ${match.sqlNormSchool('s.school')} IN (${ph})`,
    // The wellbeing scorer's "needs support" label (same word as the summary status).
    [...params, _core.SUMMARY_STATUS.SUPPORT]
  );
  for (const f of rows) {
    const g = classGroupOf(f.class);
    f.class_key = g.key; f.class_label = g.label; f.class_order = g.order;
    // Each area that needs support, as one of the three wellbeing areas.
    const seen = new Set();
    f.seaa_support = (Array.isArray(f.seaa_support) ? f.seaa_support : [])
      .map(x => wellbeingAreaOf(x.key, x.title)).filter(a => !seen.has(a.key) && seen.add(a.key));
    f.seaa_concern = seaaConcernOf(f);
    f.academic_year = academicYearOf(f.registered_at);
  }
  await _attachJourneyFacts(rows);
  // predicate: extra per-user restriction (e.g. a counsellor limited to
  // certain classes) applied after scoping by school.
  return typeof predicate === 'function' ? rows.filter(predicate) : rows;
}

/* Year-on-year facts. A journey belongs to an identity (db.journeyIdentity);
   the facts are attached to the identity's most recent attempt so each
   student is counted once. */
async function _attachJourneyFacts(facts) {
  if (!facts.length) return;
  const ids = facts.map(f => f.session_id);
  const mine = await pg.many(
    `SELECT DISTINCT email FROM report_history WHERE session_id = ANY($1)`, [ids]);
  if (!mine.length) return;
  const hist = await pg.many(
    `SELECT email, session_id, class, attempt_no, generated_at, fit_score, fit_tier, metrics_json
       FROM report_history WHERE email = ANY($1)
      ORDER BY email, generated_at ASC`,
    [mine.map(r => r.email)]
  );
  const byId = new Map();
  for (const h of hist) {
    const k = String(h.email).toLowerCase();
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(h);
  }
  const bySession = new Map(facts.map(f => [f.session_id, f]));
  const topInterest = (h) => {
    const m = h && h.metrics_json && typeof h.metrics_json === 'object' ? h.metrics_json : {};
    return Array.isArray(m.interests) && m.interests[0] ? m.interests[0].label : null;
  };
  for (const attempts of byId.values()) {
    const last = attempts[attempts.length - 1];
    const f = bySession.get(last.session_id);
    if (!f) continue;
    const first = attempts[0];
    const delta = (typeof last.fit_score === 'number' && typeof first.fit_score === 'number')
      ? last.fit_score - first.fit_score : null;
    f.journey = {
      attempts: attempts.length,
      from_class: first.class, to_class: last.class,
      fit_from: first.fit_score, fit_to: last.fit_score, fit_delta: delta,
      direction: attempts.length < 2 ? null
        : delta == null ? 'steady' : delta >= JOURNEY_CHANGE_POINTS ? 'improved'
        : delta <= -JOURNEY_CHANGE_POINTS ? 'declined' : 'steady',
      interest_from: topInterest(first), interest_to: topInterest(last),
    };
    f.journey.interest_changed = attempts.length >= 2 && !!f.journey.interest_from
      && !!f.journey.interest_to && f.journey.interest_from !== f.journey.interest_to;
  }
}
// Fit-score change (points out of 100) that counts as a real improvement or decline.
const JOURNEY_CHANGE_POINTS = _int(process.env.JOURNEY_CHANGE_POINTS, 5);

/* ── Dimensions: how students are grouped on every chart ─────────────
   population — who the chart is about ('all' registered, or 'completed').
   multi      — a student can sit in more than one group (counts can exceed
                the population; the UI says so).
   valueOf    — the group key(s) for one student, or null if the student is
                outside the population. */
const S = _core.SUMMARY_STATUS;
const NOT_AVAILABLE = { key: 'not_available', label: 'Not available yet',
  description: 'Completed, but this part of the report has no data (for example an older report saved before this field existed). Open the student to check.' };

const _levelGroups = (what) => [
  { key: S.STRONG,     label: 'Strong',        description: `Average ${what} level is in the upper band (${_core.STATUS_THRESHOLDS.strong}+ on the 1–9 scale). A clear strength.` },
  { key: S.DEVELOPING, label: 'Developing',    description: `Average ${what} level is in the middle band (${_core.STATUS_THRESHOLDS.developing} to under ${_core.STATUS_THRESHOLDS.strong}). Typical; can grow with practice.` },
  { key: S.SUPPORT,    label: 'Needs support', description: `Average ${what} level is in the lower band (under ${_core.STATUS_THRESHOLDS.developing}). Worth a conversation and targeted help.` },
];

function _dataDrivenGroups(facts, field, describe) {
  const counts = new Map();
  for (const f of facts) if (f.status === 'completed' && f[field]) counts.set(f[field], (counts.get(f[field]) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => ({ key: k, label: k, description: describe(k) }));
}

async function getDimensions() {
  const areas = await getCareerAreas();
  const streams = [];
  for (const a of areas) if (a.stream && !streams.includes(a.stream)) streams.push(a.stream);
  const streamOf = new Map(areas.map(a => [a.label, a.stream]));
  const completedOnly = (fn) => (f, ctx) => f.status !== 'completed' ? null : fn(f, ctx);

  return {
    completion: {
      label: 'Assessment progress', population: 'all',
      question: 'How far has each registered student got through the four assessment parts?',
      groups: () => [
        { key: 'completed',   label: 'Completed',   description: 'Finished all 4 parts (personality, aptitude, career interests, wellbeing) and the report has been generated.' },
        { key: 'in_progress', label: 'In progress', description: 'Started at least one part but the report is not generated yet.' },
        { key: 'not_started', label: 'Not started', description: 'Registered (or imported by the school) but has not answered anything yet.' },
      ],
      valueOf: (f) => f.status,
    },
    gender: {
      label: 'Gender', population: 'all',
      question: 'How many students of each gender registered, and how many of them completed?',
      groups: () => [
        { key: 'female', label: 'Female', description: 'Registered as female.' },
        { key: 'male',   label: 'Male',   description: 'Registered as male.' },
        { key: 'other',  label: 'Other',  description: 'Registered as another gender.' },
        { key: 'not_given', label: 'Not given', description: 'No gender recorded at registration.' },
      ],
      valueOf: (f) => {
        const g = String(f.gender || '').trim().toLowerCase();
        return g === 'female' || g === 'male' ? g : g ? 'other' : 'not_given';
      },
    },
    attention: {
      label: 'Needs follow-up', population: 'all',
      question: 'Which students need someone to act, and why?',
      groups: (facts, ctx) => [
        { key: 'report_pending', label: 'Report not generated', description: 'Answered all 4 parts, but the report was never saved. Usually a connection drop at the very end; the student should reopen the results page.' },
        { key: 'stalled',        label: 'Stalled',              description: `Started but has saved no progress for ${ctx.daysText}.` },
        { key: 'overdue_start',  label: 'Overdue to start',     description: `Registered ${ctx.daysText} or more ago and has not started.` },
        { key: 'support',        label: 'Wellbeing support',    description: 'Completed, and at least one wellbeing area (social, emotional or academic adjustment) is in the "needs support" band.' },
        { key: 'on_track',       label: 'No action needed',     description: 'Recently active, recently registered, or completed with no wellbeing concern.' },
      ],
      valueOf: (f, ctx) => {
        const days = ctx.settings.forSchool(f.school).follow_up_after_days;
        const cutoff = ctx.now - days * 86400000;
        if (f.status !== 'completed' && f.modules_done >= 4) return 'report_pending';
        if (f.status === 'in_progress' && f.last_activity && new Date(f.last_activity).getTime() < cutoff) return 'stalled';
        if (f.status === 'not_started' && new Date(f.registered_at).getTime() < cutoff) return 'overdue_start';
        if (f.status === 'completed' && f.seaa_status === S.SUPPORT) return 'support';
        return 'on_track';
      },
    },
    career_area: {
      label: 'Career interest area', population: 'completed',
      question: "Which career area did each completed student show the strongest interest in? (The student's top area from the career-interest questions.)",
      groups: () => [...areas.map(a => ({ key: a.label, label: a.label,
        description: `Strongest interest is ${a.label}. Typical careers: ${a.careers.join(', ')}. Usual subject stream: ${a.stream || 'varies'}.` })), NOT_AVAILABLE],
      valueOf: completedOnly(f => f.top_interest || NOT_AVAILABLE.key),
    },
    stream: {
      label: 'Subject stream', population: 'completed',
      question: "Which subject stream does each completed student's strongest career interest usually lead to?",
      groups: () => [...streams.map(st => ({ key: st, label: st,
        description: `Career areas that usually lead to ${st}: ${areas.filter(a => a.stream === st).map(a => a.label).join(', ')}.` })), NOT_AVAILABLE],
      valueOf: completedOnly(f => (f.top_interest && streamOf.get(f.top_interest)) || NOT_AVAILABLE.key),
    },
    personality_level: {
      label: 'Personality — overall level', population: 'completed',
      question: 'Across the 9 personality traits, where does each completed student sit overall?',
      groups: () => [..._levelGroups('personality'), NOT_AVAILABLE],
      valueOf: completedOnly(f => f.personality_status || NOT_AVAILABLE.key),
    },
    personality_top: {
      label: 'Personality — strongest trait', population: 'completed',
      question: "What is each completed student's strongest personality trait?",
      groups: (facts) => [..._dataDrivenGroups(facts, 'top_trait', k => `Students whose highest-scoring personality trait is ${k}.`), NOT_AVAILABLE],
      valueOf: completedOnly(f => f.top_trait || NOT_AVAILABLE.key),
    },
    aptitude_level: {
      label: 'Aptitude — overall level', population: 'completed',
      question: 'Across the aptitude tests each student took, where do they sit overall?',
      groups: () => [..._levelGroups('aptitude'), NOT_AVAILABLE],
      valueOf: completedOnly(f => f.aptitude_status || NOT_AVAILABLE.key),
    },
    aptitude_top: {
      label: 'Aptitude — strongest ability', population: 'completed',
      question: "What is each completed student's strongest ability?",
      groups: (facts) => [..._dataDrivenGroups(facts, 'top_aptitude', k => `Students whose highest aptitude result is ${k}.`), NOT_AVAILABLE],
      valueOf: completedOnly(f => f.top_aptitude || NOT_AVAILABLE.key),
    },
    wellbeing_level: {
      label: 'Wellbeing — overall', population: 'completed',
      question: 'How settled is each completed student socially, emotionally and academically? (Their weakest of the three areas decides the group.)',
      groups: () => [
        { key: S.STRONG,     label: 'Well-established', description: 'All three areas (social, emotional, academic adjustment) are in a healthy range.' },
        { key: S.DEVELOPING, label: 'Developing',       description: 'At least one area is developing; none needs support.' },
        { key: S.SUPPORT,    label: 'Needs support',    description: 'At least one area is in the "needs support" band. A counsellor should check in.' },
        NOT_AVAILABLE,
      ],
      valueOf: completedOnly(f => f.seaa_status || NOT_AVAILABLE.key),
    },
    wellbeing_need: {
      label: 'Wellbeing — area needing support', population: 'completed', multi: true,
      question: 'Which wellbeing area needs support? A student who needs support in two areas appears in both.',
      groups: (facts) => {
        const hasOther = facts.some(f => (f.seaa_support || []).some(a => a.key === 'other'));
        return [...WELLBEING_AREAS, ...(hasOther ? [WELLBEING_OTHER] : [])]
          .map(a => ({ key: a.key, label: a.label, description: `${a.title} is in the needs-support band. ${a.description}` }))
          .concat([{ key: 'none', label: 'No area needs support', description: 'None of the three areas is in the needs-support band.' }]);
      },
      valueOf: completedOnly(f => f.seaa_support.length ? f.seaa_support.map(x => x.key) : ['none']),
    },
    parameters: {
      label: 'Assessment parts completed', population: 'all', multi: true,
      question: 'Which of the four assessment parts has each registered student finished? A student appears under every part they have finished.',
      groups: () => PARAMETERS.map(p => ({ key: p.key, label: p.label, description: p.description })),
      valueOf: (f) => PARAMETERS.filter(p => f[p.key + '_done']).map(p => p.key),
    },
    seaa_concern: {
      label: 'SEAA concern', population: 'completed',
      question: 'In how many of the three adjustment areas (social, emotional, academic) does each completed student need support?',
      groups: (facts) => SEAA_CONCERNS.filter(c => c.key !== 'other' || facts.some(f => f.seaa_concern === 'other'))
        .map(c => ({ key: c.key, label: c.label, description: c.description })),
      valueOf: completedOnly(f => f.seaa_concern),
    },
    fit_tier: {
      label: 'Overall career-fit', population: 'completed',
      question: 'How well do each completed student’s personality, aptitude and interests line up behind a career direction? (Integrated Fit Score.)',
      groups: () => [..._core.FIT_TIERS.map((t, i, all) => ({ key: t.key, label: t.key,
        description: `Integrated Fit Score ${t.min}${i ? `–${all[i - 1].min - 1}` : '–100'}. ` + (i === 0
          ? 'Strengths, abilities and interests point clearly in the same direction.'
          : i === all.length - 1 ? 'Interests and strengths are still spread out — exploration and exposure will help.'
          : 'A direction is forming; some areas still need building.') })), NOT_AVAILABLE],
      valueOf: completedOnly(f => f.fit_tier || NOT_AVAILABLE.key),
    },
    journey_direction: {
      label: 'Year-on-year change', population: 'journey',
      question: 'For students assessed in more than one class (for example Class 9 and then Class 10), did their overall career-fit improve?',
      groups: () => [
        { key: 'improved', label: 'Improved', description: `Integrated Fit Score rose by ${JOURNEY_CHANGE_POINTS} points or more between their first and latest assessment.` },
        { key: 'steady',   label: 'Steady',   description: `Changed by less than ${JOURNEY_CHANGE_POINTS} points.` },
        { key: 'declined', label: 'Declined', description: `Fell by ${JOURNEY_CHANGE_POINTS} points or more. Worth a conversation.` },
      ],
      valueOf: (f) => (f.journey && f.journey.attempts >= 2) ? f.journey.direction : null,
    },
    journey_interest: {
      label: 'Year-on-year interest change', population: 'journey',
      question: 'For students assessed more than once, has their strongest career interest changed?',
      groups: () => [
        { key: 'changed', label: 'Interest changed', description: 'Their strongest career-interest area is different from their first assessment.' },
        { key: 'same',    label: 'Same interest',    description: 'Their strongest career-interest area is the same as before.' },
      ],
      valueOf: (f) => (f.journey && f.journey.attempts >= 2) ? (f.journey.interest_changed ? 'changed' : 'same') : null,
    },
  };
}

const POPULATION_LABEL = {
  all: 'registered students',
  completed: 'students who completed the assessment',
  journey: 'students assessed in more than one class',
};

async function _analyticsContext(schools) {
  const settings = await getSettingsMap(schools);
  // Each school is bucketed with its own follow-up setting; describe it that
  // way, quoting the number only when every school in view uses the same one.
  const all = [...new Set((schools || []).map(s => settings.forSchool(s).follow_up_after_days))];
  const days = all.length === 1 ? all[0] : null;
  const daysText = days != null ? days + ' day' + (days === 1 ? '' : 's') : 'the number of days set for each school';
  return { settings, now: Date.now(), days, daysText };
}

function _asKeys(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

/* Class × group counts for one dimension. */
async function getBreakdown(schools, dimensionId, { facts: preFacts, predicate } = {}) {
  const dims = await getDimensions();
  const dim = dims[dimensionId];
  if (!dim) throw Object.assign(new Error('Unknown dimension'), { status: 400 });
  const facts = preFacts || await getStudentFacts(schools, { predicate });
  const ctx = await _analyticsContext(schools);
  const groups = dim.groups(facts, ctx);
  const classes = new Map();
  // `completed`: how many in each group have finished the assessment.
  const total = { population: 0, counts: {}, completed: {} };
  for (const g of groups) total.counts[g.key] = 0;
  for (const f of facts) {
    const keys = _asKeys(dim.valueOf(f, ctx));
    if (!keys.length) continue;
    if (!classes.has(f.class_key)) classes.set(f.class_key, { key: f.class_key, label: f.class_label, order: f.class_order, population: 0, counts: {} });
    const c = classes.get(f.class_key);
    c.population++; total.population++;
    for (const k of keys) {
      c.counts[k] = (c.counts[k] || 0) + 1;
      total.counts[k] = (total.counts[k] || 0) + 1;
      if (f.status === 'completed') total.completed[k] = (total.completed[k] || 0) + 1;
    }
  }
  // Groups with no definition yet (e.g. a career label renamed in cpi.js but
  // still on old reports) are surfaced rather than silently dropped.
  for (const k of Object.keys(total.counts)) {
    if (!groups.some(g => g.key === k)) groups.push({ key: k, label: k, description: 'Value found in saved reports.' });
  }
  // Counts in group order, so the same numbers always serialise the same way
  // (the AI analysis fingerprints them) whatever order the rows arrived in.
  const order = groups.map(g => g.key);
  const ordered = (counts) => Object.fromEntries(order.filter(k => k in counts).map(k => [k, counts[k]]));
  total.counts = ordered(total.counts);
  total.completed = ordered(total.completed);
  for (const c of classes.values()) c.counts = ordered(c.counts);
  return {
    dimension: { id: dimensionId, label: dim.label, question: dim.question, multi: !!dim.multi,
                 population: dim.population, population_label: POPULATION_LABEL[dim.population] },
    groups: groups.filter(g => g.key !== NOT_AVAILABLE.key || total.counts[g.key])
                  .map(g => Object.assign({}, g, { total: total.counts[g.key] || 0 })),
    classes: [...classes.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
    totals: total,
  };
}

/* The students behind any count: same dimension logic as getBreakdown. */
async function getDrillStudents(schools, { dimension, groups, classKey, status, search, limit = 100, offset = 0, idsOnly = false, predicate } = {}) {
  const dims = await getDimensions();
  const dim = dimension ? dims[dimension] : null;
  if (dimension && !dim) throw Object.assign(new Error('Unknown dimension'), { status: 400 });
  const facts = await getStudentFacts(schools, { predicate });
  const ctx = await _analyticsContext(schools);
  const want = (groups || []).filter(Boolean);
  const q = String(search || '').toLowerCase().trim();
  const qUid = match.normUid(search);
  let rows = facts.filter(f => {
    if (status && f.status !== status) return false;
    if (q && !(String(f.full_name || '').toLowerCase().includes(q) || String(f.email || '').toLowerCase().includes(q)
               || (f.student_uid && match.normUid(f.student_uid) === qUid))) return false;
    if (dim) {
      const keys = _asKeys(dim.valueOf(f, ctx));
      if (!keys.length) return false;
      if (want.length && !keys.some(k => want.includes(k))) return false;
    }
    return true;
  });
  // How many of the matching students are in each class (before the class
  // filter), so a grade-wise table always equals the list behind it.
  const byClass = new Map();
  for (const f of rows) {
    if (!byClass.has(f.class_key)) byClass.set(f.class_key, { key: f.class_key, label: f.class_label, order: f.class_order, n: 0 });
    byClass.get(f.class_key).n++;
  }
  const by_class = [...byClass.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  if (classKey) rows = rows.filter(f => f.class_key === classKey);
  // Session id breaks ties, so pages of a long list never repeat or skip a student.
  rows.sort((a, b) => a.class_order - b.class_order || String(a.section || '').localeCompare(String(b.section || ''))
    || String(a.full_name || '').localeCompare(String(b.full_name || '')) || (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));
  const total = rows.length;
  if (idsOnly) return { total, by_class, ids: rows.map(f => f.session_id) };
  const lim = Math.min(Math.max(_int(limit, 100), 1), 500);
  const off = Math.max(_int(offset, 0), 0);
  return {
    total, limit: lim, offset: off, by_class,
    students: rows.slice(off, off + lim).map(f => ({
      session_id: f.session_id, full_name: f.full_name, first_name: f.first_name,
      class: f.class, class_label: f.class_label, section: f.section, school: f.school,
      email: f.email, student_uid: f.student_uid || null, gender: f.gender, status: f.status, modules_done: f.modules_done,
      registered_at: f.registered_at, completed_at: f.completed_at, last_activity: f.last_activity,
      fit_score: f.fit_score, fit_tier: f.fit_tier, top_interest: f.top_interest,
      seaa_status: f.seaa_status, journey: f.journey || null,
      seaa_concern: f.seaa_concern || null, seaa_scores: f.seaa_scores || null,
      parameters_done: PARAMETERS.filter(p => f[p.key + '_done']).map(p => p.key),
      matched: dim ? _asKeys(dim.valueOf(f, ctx)) : [],
    })),
  };
}

/* ── Programme trend, anchored to when the programme started ───────── */
async function getProgrammeTrend(schools, { granularity = 'week', from = null, to = null, predicate = null } = {}) {
  const { ph, params } = _schoolClause(schools, 1);
  if (!params.length) return { granularity, programme_start: null, buckets: [] };
  const unit = granularity === 'day' ? 'day' : 'week';
  const tzIdx = params.length + 1, unitIdx = params.length + 2;
  const bucketSql = (col) => `to_char(date_trunc($${unitIdx}, (${col}) AT TIME ZONE $${tzIdx}), 'YYYY-MM-DD')`;
  const p = [...params, APP_TIMEZONE, unit];
  const scope = `${match.sqlNormSchool('s.school')} IN (${ph})` + await _predicateFilter(schools, predicate, p);
  // "Started" uses the same rule as the In-progress/Completed status: the
  // student has an assessment record. Its date is the earliest evidence of
  // activity (first saved part, any completed part, or the last save).
  const firstActivity = `LEAST(sp.first_at, a.nmap_completed_at, a.cpi_completed_at, a.sea_completed_at,
    a.daab_va_completed_at, a.daab_pa_completed_at, a.daab_na_completed_at, a.daab_lsa_completed_at,
    a.daab_hma_completed_at, a.daab_ar_completed_at, a.daab_ma_completed_at, a.daab_sa_completed_at, a.saved_at)`;
  const [reg, started, done] = await Promise.all([
    pg.many(`SELECT ${bucketSql('s.registered_at')} AS b, COUNT(*)::int AS n
               FROM students s WHERE ${scope} GROUP BY 1`, p),
    pg.many(`SELECT ${bucketSql('fs.first_at')} AS b, COUNT(*)::int AS n FROM (
               SELECT a.session_id, ${firstActivity} AS first_at
                 FROM assessments a
                 JOIN students s ON s.session_id = a.session_id
                 LEFT JOIN (SELECT session_id, MIN(submitted_at) AS first_at FROM section_progress GROUP BY session_id) sp
                        ON sp.session_id = a.session_id
                WHERE ${scope}
             ) fs WHERE fs.first_at IS NOT NULL GROUP BY 1`, p),
    pg.many(`SELECT ${bucketSql('rs.generated_at')} AS b, COUNT(*)::int AS n
               FROM report_summary rs JOIN students s ON s.session_id = rs.session_id
              WHERE ${scope} GROUP BY 1`, p),
  ]);
  const all = [...reg, ...started, ...done].map(r => r.b).filter(Boolean).sort();
  if (!all.length) return { granularity: unit, programme_start: null, buckets: [] };
  const toMap = (rows) => new Map(rows.map(r => [r.b, r.n]));
  const R = toMap(reg), St = toMap(started), D = toMap(done);
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: APP_TIMEZONE }));
  const stepDays = unit === 'week' ? 7 : 1;
  const start = new Date(all[0] + 'T00:00:00Z');
  const lastData = new Date(all[all.length - 1] + 'T00:00:00Z');
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const end = todayUtc > lastData ? todayUtc : lastData;
  const buckets = [];
  let cumReg = 0, cumDone = 0, cumStarted = 0, i = 0;
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + stepDays * 86400000)) {
    i++;
    const key = d.toISOString().slice(0, 10);
    const endDay = new Date(d.getTime() + (stepDays - 1) * 86400000).toISOString().slice(0, 10);
    const r = R.get(key) || 0, s2 = St.get(key) || 0, c = D.get(key) || 0;
    cumReg += r; cumDone += c; cumStarted += s2;
    buckets.push({
      index: i, label: (unit === 'week' ? 'Week ' : 'Day ') + i, start: key, end: endDay,
      registered: r, started: s2, completed: c,
      cumulative_registered: cumReg, cumulative_started: cumStarted, cumulative_completed: cumDone,
      completion_rate_pct: cumReg ? Math.round(cumDone / cumReg * 100) : 0,
    });
  }
  const inRange = buckets.filter(b => (!from || b.end >= from) && (!to || b.start <= to));
  return { granularity: unit, timezone: APP_TIMEZONE, programme_start: buckets[0].start, buckets: inRange, total_buckets: buckets.length };
}

/* ── Alerts (deterministic, explainable, clickable) ──────────────────── */
/* Per-school and per-class summary for the "Schools & classes" view. Built
   from the same facts and dimension rules as every other number, so a cell
   here always matches the list it opens. */
async function getSchoolSummary(schools, { predicate } = {}) {
  const facts = await getStudentFacts(schools, { predicate });
  const ctx = await _analyticsContext(schools);
  const dims = await getDimensions();
  const attn = dims.attention;
  const blank = () => ({ total: 0, completed: 0, in_progress: 0, not_started: 0, follow_up: 0, support: 0, completed_recent: 0, careers: {}, areas: { S: 0, E: 0, A: 0, other: 0 } });
  const recentFrom = ctx.now - PULSE_WINDOW_DAYS * _DAY_MS;
  const add = (o, f) => {
    o.total++; o[f.status]++;
    if (f.generated_at && new Date(f.generated_at).getTime() >= recentFrom) o.completed_recent++;   // dated by the report, as in the trend
    const a = attn.valueOf(f, ctx);
    if (a !== 'on_track') o.follow_up++;
    if (a === 'support') { o.support++; for (const ar of (f.seaa_support || [])) o.areas[ar.key] = (o.areas[ar.key] || 0) + 1; }
    if (f.status === 'completed' && f.top_interest) o.careers[f.top_interest] = (o.careers[f.top_interest] || 0) + 1;
  };
  const top = (c) => { const e = Object.entries(c).sort((x, y) => y[1] - x[1])[0]; return e ? { area: e[0], students: e[1] } : null; };
  const bySchool = new Map();
  // Named as the user's own school list spells it, so filters built from the
  // name (drill-downs, AI summaries) always resolve to that school.
  const spelling = new Map((schools || []).map(n => [match.normSchool(n), n]));
  for (const f of facts) {
    const k = match.normSchool(f.school);
    if (!bySchool.has(k)) bySchool.set(k, Object.assign(blank(), { school: spelling.get(k) || f.school, classes: new Map() }));
    const sc = bySchool.get(k); add(sc, f);
    if (!sc.classes.has(f.class_key)) sc.classes.set(f.class_key, Object.assign(blank(), { key: f.class_key, label: f.class_label, order: f.class_order }));
    add(sc.classes.get(f.class_key), f);
  }
  // Assigned schools with nobody registered yet still appear (as empty).
  for (const name of schools || []) {
    const k = match.normSchool(name);
    if (!bySchool.has(k)) bySchool.set(k, Object.assign(blank(), { school: name, classes: new Map() }));
  }
  const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
  return [...bySchool.values()].map(sc => {
    const set = ctx.settings.forSchool(sc.school);
    const classes = [...sc.classes.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map(c => ({ key: c.key, label: c.label, total: c.total, completed: c.completed, in_progress: c.in_progress, not_started: c.not_started,
                   follow_up: c.follow_up, support: c.support, support_areas: c.areas, completion_pct: pct(c.completed, c.total), top_career: top(c.careers) }));
    return { school: sc.school, total: sc.total, completed: sc.completed, in_progress: sc.in_progress, not_started: sc.not_started,
             follow_up: sc.follow_up, support: sc.support, support_areas: sc.areas, completion_pct: pct(sc.completed, sc.total),
             standing: targetStanding(pct(sc.completed, sc.total), set.completion_target_pct),
             completed_recent: sc.completed_recent, recent_days: PULSE_WINDOW_DAYS,
             target_pct: set.completion_target_pct, follow_up_after_days: set.follow_up_after_days,
             top_career: top(sc.careers), classes };
  }).sort((a, b) => a.school.localeCompare(b.school));
}
/* Where a completion rate stands against its target. Below this share of
   the target a school is "far behind" (a critical alert, shown red). */
const TARGET_FAR_BEHIND_SHARE = 0.75;
function targetStanding(pct, target) {
  if (target == null) return null;
  return pct >= target ? 'met' : pct < target * TARGET_FAR_BEHIND_SHARE ? 'far_behind' : 'behind';
}

/* ── Pace and momentum (Insights) ───────────────────────────────────
   Rolling windows ending now: "this week" is the last 7 days. */
const PULSE_WINDOW_DAYS   = 7;    // one "week" for this-week vs last-week
const PULSE_SPARK_WEEKS   = 12;   // weekly completions shown as a sparkline
const PULSE_PACE_WEEKS    = 4;    // recent weeks averaged for the forecast
const PULSE_REMINDER_DAYS = 30;   // reminders counted over this many days
const _DAY_MS = 86400000;

/* How the programme is moving, from the same facts as every other count:
   this week against last (registrations, completions, activity), weekly
   completions, the pace needed to reach each school's target and when it
   will be reached at the recent pace, how far students get through the four
   parts, the wellbeing picture (SEAA), and reminders sent to these students.
   A completion is dated by its report (report_summary.generated_at), as in
   the trend chart and the "completed" status itself. */
async function getPulse(schools, { facts: preFacts, predicate } = {}) {
  const facts = preFacts || await getStudentFacts(schools, { predicate });
  const ctx = await _analyticsContext(schools);
  const now = ctx.now, week = PULSE_WINDOW_DAYS * _DAY_MS;
  const ts = (d) => (d ? new Date(d).getTime() : NaN);
  const inWeek = (d, k) => { const t = ts(d); return t >= now - (k + 1) * week && t < now - k * week; };
  const count = (pred) => facts.reduce((n, f) => n + (pred(f) ? 1 : 0), 0);

  // Weekly completions, oldest first, ending with the current week.
  const spark = Array.from({ length: PULSE_SPARK_WEEKS }, (_, i) => {
    const k = PULSE_SPARK_WEEKS - 1 - i;
    return { from: new Date(now - (k + 1) * week).toISOString(), completed: count(f => inWeek(f.generated_at, k)) };
  });
  const recent = spark.slice(-PULSE_PACE_WEEKS).reduce((n, w) => n + w.completed, 0);
  const pacePerWeek = Math.round(recent / PULSE_PACE_WEEKS * 10) / 10;

  // Each school is held to its own target; the gap is the sum of the gaps.
  const bySchool = new Map();
  for (const f of facts) {
    const k = match.normSchool(f.school);
    if (!bySchool.has(k)) bySchool.set(k, { school: f.school, total: 0, completed: 0 });
    const x = bySchool.get(k); x.total++; if (f.status === 'completed') x.completed++;
  }
  let gap = 0, weighted = 0;
  for (const x of bySchool.values()) {
    const t = ctx.settings.forSchool(x.school).completion_target_pct;
    gap += Math.max(0, Math.ceil(x.total * t / 100) - x.completed);
    weighted += t * x.total;
  }
  const registered = facts.length;
  const targets = [...new Set([...bySchool.values()].map(x => ctx.settings.forSchool(x.school).completion_target_pct))];
  const weeksToTarget = gap === 0 ? 0 : pacePerWeek > 0 ? Math.ceil(gap / pacePerWeek) : null;

  // How far students get: each part, then the full report.
  const started = count(f => f.status !== 'not_started');
  const funnel = [
    { key: 'registered', label: 'Registered', students: registered },
    { key: 'started', label: 'Started', students: started },
    ...(PARAMETERS.map(p => ({ key: p.key, label: p.label + ' done', students: count(f => !!f[p.key + '_done']) }))),
    { key: 'completed', label: 'All parts done, report ready', students: count(f => f.status === 'completed') },
  ];

  // Wellbeing (SEAA) results: concern in one or two areas ("intervention"),
  // or in all three ("critical"), as the SEAA_LEVELS describe them.
  const levelOf = new Map(SEAA_CONCERNS.map(c => [c.key, c.level]));
  const seaa = { assessed: count(f => !!f.seaa_scores), levels: {}, by_area: {} };
  for (const k of Object.keys(SEAA_LEVELS)) seaa.levels[k] = 0;
  for (const f of facts) {
    const lvl = levelOf.get(f.seaa_concern);
    if (lvl && lvl in seaa.levels) seaa.levels[lvl]++;
    for (const a of (f.seaa_support || [])) seaa.by_area[a.key] = (seaa.by_area[a.key] || 0) + 1;
  }

  const emails = [...new Set(facts.map(f => String(f.email || '').trim().toLowerCase()).filter(Boolean))];
  const rem = emails.length ? await pg.one(
    `SELECT COUNT(*)::int AS sent, COUNT(DISTINCT LOWER(student_email))::int AS students FROM reminder_log
      WHERE sent_at >= now() - ($2 || ' days')::interval AND LOWER(student_email) = ANY($1)`,
    [emails, String(PULSE_REMINDER_DAYS)]) : { sent: 0, students: 0 };

  return {
    window_days: PULSE_WINDOW_DAYS,
    registrations: { this_week: count(f => inWeek(f.registered_at, 0)), last_week: count(f => inWeek(f.registered_at, 1)) },
    completions:   { this_week: count(f => inWeek(f.generated_at, 0)),  last_week: count(f => inWeek(f.generated_at, 1)) },
    active_this_week: count(f => inWeek(f.last_activity, 0)),
    weekly_completions: spark,
    target: {
      registered, completed: count(f => f.status === 'completed'),
      target_pct: registered ? Math.round(weighted / registered) : (targets[0] != null ? targets[0] : null),
      per_school: targets.length > 1, completions_needed: gap,
      pace_weeks: PULSE_PACE_WEEKS, pace_per_week: pacePerWeek, weeks_to_target: weeksToTarget,
      expected_by: weeksToTarget ? new Date(now + weeksToTarget * week).toISOString() : null,
    },
    funnel, seaa,
    reminders: { days: PULSE_REMINDER_DAYS, sent: rem.sent, students: rem.students },
  };
}

// The attention groups behind the "Follow-up" and "Wellbeing" columns, so the
// page opens exactly the students it counted.
async function getFollowUpGroups() {
  const dims = await getDimensions();
  const keys = dims.attention.groups([], await _analyticsContext([])).map(g => g.key);
  return { follow_up: keys.filter(k => k !== 'on_track'), support: keys.filter(k => k === 'support') };
}

async function getAlerts(schools, { facts: preFacts, predicate } = {}) {
  const facts = preFacts || await getStudentFacts(schools, { predicate });
  const ctx = await _analyticsContext(schools);
  const dims = await getDimensions();
  const alerts = [];
  const byClass = (list) => {
    const m = new Map();
    for (const f of list) {
      if (!m.has(f.class_key)) m.set(f.class_key, { key: f.class_key, label: f.class_label, order: f.class_order, count: 0 });
      m.get(f.class_key).count++;
    }
    return [...m.values()].sort((a, b) => a.order - b.order);
  };
  const classText = (list) => list.map(c => `${c.label}: ${c.count}`).join(' · ');

  // 1) Schools (and their classes) below the completion target.
  const schoolGroups = new Map();
  for (const f of facts) {
    const k = match.normSchool(f.school);
    if (!schoolGroups.has(k)) schoolGroups.set(k, { name: f.school, rows: [] });
    schoolGroups.get(k).rows.push(f);
  }
  for (const { name, rows } of schoolGroups.values()) {
    const target = ctx.settings.forSchool(name).completion_target_pct;
    const done = rows.filter(f => f.status === 'completed').length;
    const pct = rows.length ? Math.round(done / rows.length * 100) : 0;
    if (pct >= target) continue;
    const needed = Math.max(0, Math.ceil(rows.length * target / 100) - done);
    const classes = new Map();
    for (const f of rows) {
      if (!classes.has(f.class_key)) classes.set(f.class_key, { key: f.class_key, label: f.class_label, order: f.class_order, n: 0, done: 0 });
      const c = classes.get(f.class_key); c.n++; if (f.status === 'completed') c.done++;
    }
    const lagging = [...classes.values()].filter(c => c.n && c.done / c.n * 100 < target)
      .sort((a, b) => a.done / a.n - b.done / b.n);
    alerts.push({
      id: 'below_target:' + match.normSchool(name), type: 'below_target',
      severity: targetStanding(pct, target) === 'far_behind' ? 'critical' : 'warning',
      title: `${name}: ${pct}% completed — target is ${target}%`,
      detail: `${done} of ${rows.length} registered students have completed. ${needed} more completion${needed === 1 ? '' : 's'} needed to reach the target.`
        + (lagging.length ? ` Furthest behind: ${lagging.slice(0, 4).map(c => `${c.label} ${Math.round(c.done / c.n * 100)}% (${c.done}/${c.n})`).join(', ')}.` : ''),
      why: 'Students without a completed assessment have no report, so they and their parents get no career guidance from the programme.',
      action: 'Open the list of students who have not finished and arrange a supervised lab session or send a reminder.',
      count: rows.length - done, school: name,
      pct, target, done, total: rows.length, needed,
      by_class: lagging.map(c => ({ label: c.label, count: c.n - c.done, class_key: c.key })),
      drill: { dimension: 'completion', groups: ['in_progress', 'not_started'], school: name },
    });
  }

  // 2) Attention groups, each broken down by class.
  const attn = dims.attention;
  const buckets = { report_pending: [], stalled: [], overdue_start: [], support: [] };
  for (const f of facts) { const k = attn.valueOf(f, ctx); if (buckets[k]) buckets[k].push(f); }
  const daysPlus = ctx.days != null ? `${ctx.days}+ day${ctx.days === 1 ? '' : 's'}` : 'longer than each school’s follow-up setting';
  const defs = {
    report_pending: { severity: 'critical', title: n => `${n} student${n === 1 ? '' : 's'} finished every part but have no report`,
      why: 'They have done all the work but cannot see their report, and they do not count as completed.',
      action: 'Ask each student to reopen the assessment on the same device; the report is generated from their saved answers. If it fails again, contact support.' },
    stalled: { severity: 'warning', title: n => `${n} student${n === 1 ? '' : 's'} stalled part-way through`,
      why: `They started but have saved nothing for ${daysPlus}. Students who stop half-way rarely finish without a nudge.`,
      action: 'Send a reminder or give them time in the next lab period. Their progress is saved, so they continue where they stopped.' },
    overdue_start: { severity: 'info', title: n => `${n} student${n === 1 ? '' : 's'} registered ${daysPlus} ago but have not started`,
      why: 'They are on the roster but have not opened the assessment.',
      action: 'Check they have their access code and send a reminder or schedule a session.' },
    support: { severity: 'warning', title: n => `${n} student${n === 1 ? '' : 's'} need wellbeing support`,
      why: 'At least one of their social, emotional or academic adjustment results is in the needs-support band.',
      action: 'A counsellor should check in with each of them. The list shows which area needs support.' },
  };
  for (const [k, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    const d = defs[k], cls = byClass(list);
    const alert = {
      id: 'attention:' + k, type: k, severity: d.severity, title: d.title(list.length),
      detail: 'By class — ' + classText(cls) + '.', why: d.why, action: d.action,
      count: list.length, by_class: cls.map(c => ({ label: c.label, count: c.count, class_key: c.key })),
      drill: { dimension: 'attention', groups: [k] },
    };
    if (k === 'support') {
      // Never one number: each area, and each area by class.
      const areas = [...WELLBEING_AREAS, WELLBEING_OTHER];
      const total = wellbeingAreaCounts(list);
      alert.by_area = areas.filter(a => total[a.key]).map(a => ({ key: a.key, label: a.label, count: total[a.key] }));
      alert.area_by_class = cls.map(c => ({ label: c.label, class_key: c.key, counts: wellbeingAreaCounts(list.filter(f => f.class_key === c.key)) }));
      alert.detail = alert.by_area.map(a => `${a.label} ${a.count}`).join(' · ') + '. A student who needs support in two areas is counted in both.';
    }
    alerts.push(alert);
  }
  const order = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  if (!alerts.length && facts.length) {
    alerts.push({ id: 'all_clear', type: 'all_clear', severity: 'good', title: 'Everything is on track',
      detail: 'Every school is at or above its completion target and no student needs follow-up right now.',
      why: '', action: '', count: 0, by_class: [], drill: null });
  }
  const one = (schools || []).length === 1;
  return { alerts, settings: one ? ctx.settings.forSchool(schools[0]) : ctx.settings.global,
           settings_scope: one ? 'school' : 'default', as_of: new Date().toISOString() };
}

/* ── Aria (student AI counsellor) themes, aggregated — never quotes ──── */
async function getAriaThemes(schools, { classKey, predicate } = {}) {
  const facts = (await getStudentFacts(schools, { predicate })).filter(f => !classKey || f.class_key === classKey);
  if (!facts.length) return { students_using_aria: 0, themes: [] };
  const cdb = require('./counsellor-db.js');
  const idToStudent = new Map();
  for (const f of facts) {
    if (f.email) idToStudent.set(String(f.email).toLowerCase(), f);
    idToStudent.set(String(cdb.accessIdentityFor(f.session_id)).toLowerCase(), f);
  }
  const rows = await pg.many(
    `SELECT LOWER(email) AS id, content FROM chat_history
      WHERE role = 'user' AND LOWER(email) = ANY($1)`,
    [[...idToStudent.keys()]]
  );
  const perStudent = new Map();
  for (const r of rows) {
    const f = idToStudent.get(r.id); if (!f) continue;
    if (!perStudent.has(f.session_id)) perStudent.set(f.session_id, { f, texts: [] });
    perStudent.get(f.session_id).texts.push(r.content);
  }
  const themeStudents = new Map();
  for (const { f, texts } of perStudent.values()) {
    for (const t of cdb.classifyThemes(texts)) {
      if (!themeStudents.has(t.key)) themeStudents.set(t.key, { key: t.key, label: t.label, students: 0, by_class: {} });
      const e = themeStudents.get(t.key); e.students++;
      e.by_class[f.class_label] = (e.by_class[f.class_label] || 0) + 1;
    }
  }
  return {
    students_using_aria: perStudent.size,
    students_in_scope: facts.length,
    themes: [...themeStudents.values()].sort((a, b) => b.students - a.students),
    note: 'Counts of students whose questions to Aria touched each theme. Individual messages are never shown here.',
  };
}

/* ── Plain-English glossary, built from the same constants the code uses ── */
async function getGlossary() {
  const areas = await getCareerAreas();
  const t = _core.STATUS_THRESHOLDS, it = _core.INTEREST_THRESHOLDS;
  return [
    { term: 'NMAP (Personality)', aliases: ['nmap', 'personality'], meaning: 'The personality part of the assessment. It looks at 9 traits such as leadership, creativity and resilience.', why: 'Shows how a student tends to think and behave, which shapes the kind of work and study they enjoy.' },
    { term: 'DAAB / NAAB (Aptitude)', aliases: ['daab', 'naab', 'aptitude'], meaning: 'The aptitude part: 8 short timed tests (verbal, numerical, abstract reasoning, spatial, mechanical, perceptual speed, legal reasoning, health & medical).', why: 'Shows which kinds of thinking come most easily, which helps match subjects and careers.' },
    { term: 'CPI / NCPI (Career interests)', aliases: ['cpi', 'ncpi', 'career interest', 'interest'], meaning: `The career-interest part: 20 questions that score the student across ${areas.length} career areas (${areas.map(a => a.label).join(', ')}). Each area is scored out of ${it.max}.`, why: 'Shows what the student enjoys. The strongest area is their "career interest area" on the dashboards.' },
    { term: 'SEAA / NSEAA (Wellbeing)', aliases: ['seaa', 'nseaa', 'sea', 'wellbeing', 'social emotional'], meaning: 'The social, emotional and academic adjustment part. It checks how settled the student is with peers, with their feelings, and with schoolwork.', why: 'A student who is struggling here may need support before career decisions make sense.' },
    { term: 'Level (1–9 scale, "stanine")', aliases: ['stanine', 'level', 'band'], meaning: `Personality and aptitude results are placed on a 1–9 scale, where 5 is typical. Dashboards show bands instead of numbers: Strong (${t.strong}+), Developing (${t.developing} to under ${t.strong}) and Needs support (under ${t.developing}).`, why: 'Bands are easier to act on than raw numbers and are never shown to students as scores.' },
    { term: 'Career interest area', aliases: ['career area', 'cluster'], meaning: 'The career area where the student showed the strongest interest. Comes from the career-interest part.', why: 'Used to group students on the career charts.' },
    { term: 'Subject stream', aliases: ['stream', 'pcm', 'pcb', 'commerce', 'humanities'], meaning: 'The subject stream that a student’s strongest career-interest area usually leads to: ' + areas.map(a => `${a.label} → ${a.stream}`).join('; ') + '.', why: 'Helps plan Class 11–12 subject choices. It is a guide, not a decision.' },
    { term: 'Integrated Fit Score', aliases: ['fit', 'fit score', 'fit tier', 'career fit'], meaning: 'A 0–100 score combining personality (30%), aptitude (30%) and the strongest career interest (40%), reduced when wellbeing needs support. Tiers: ' + _core.FIT_TIERS.map(f => `${f.key} (${f.min}+)`).join(', ') + '.', why: 'Shows how clearly a student’s strengths and interests point in one direction.' },
    { term: 'Completed', aliases: ['completed', 'complete'], meaning: 'All 4 parts answered and the report generated and saved.', why: 'Only completed students have a report and appear in the personality, aptitude, interest and wellbeing charts.' },
    { term: 'In progress', aliases: ['in progress', 'started'], meaning: 'Started at least one part but the report is not generated yet.', why: 'These students can resume where they stopped.' },
    { term: 'Not started', aliases: ['not started'], meaning: 'Registered or imported, but has not answered anything yet.', why: 'Usually needs an access code, a reminder or lab time.' },
    { term: 'Stalled', aliases: ['stalled', 'at risk', 'at-risk'], meaning: 'Started, but no progress saved for the number of days set in the school’s "follow up after" setting.', why: 'Students who stop half-way rarely finish without a nudge.' },
    { term: 'Report not generated', aliases: ['report pending'], meaning: 'The student answered all 4 parts but no report was saved — usually a connection drop at the very end.', why: 'They have done the work but cannot see the result.' },
    { term: 'Completion target', aliases: ['target'], meaning: 'The share of registered students a school aims to have completed. Set on the dashboard; schools and classes below it are flagged.', why: 'Lets each school decide what "on track" means.' },
    { term: 'Journey / year-on-year', aliases: ['journey', 'year on year', 'attempt'], meaning: 'When a student is assessed again in a higher class, the attempts are linked so you can see what changed. Attempts are linked when the email and the student name both match; otherwise by school and Unique School ID. Attempts with neither are never linked by name alone.', why: 'Shows growth over time and whether interests are settling.' },
    { term: 'Aria', aliases: ['aria', 'ai counsellor'], meaning: 'The AI study-and-career guide students can chat with after completing their report.', why: 'Staff see the themes students raise with Aria (for example exam stress), never the messages themselves in aggregate views.' },
    { term: 'Access code', aliases: ['access code', 'code'], meaning: 'An 8-character code the school gives each imported student so they can start without an email.', why: 'Most bulk-imported students sign in this way.' },
  ];
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

/* Report data for several students at once (bulk ZIP download). Only
   students with a generated report are rendered — the same rule the
   "Completed" status uses — so a ZIP never contains half-empty reports. */
async function getReportPdfDataBatch(sessionIds) {
  const ids = (sessionIds || []).map(String);
  const withReport = new Set((await pg.many(
    'SELECT session_id FROM report_summary WHERE session_id = ANY($1)', [ids])).map(r => r.session_id));
  const out = [];
  for (const sid of ids) {
    if (!withReport.has(sid)) { out.push({ session_id: sid, data: null, error: 'No report yet' }); continue; }
    try {
      const data = await getReportPdfData(sid);
      out.push(data ? { session_id: sid, data } : { session_id: sid, data: null, error: 'Assessment scores missing' });
    } catch (e) { out.push({ session_id: sid, data: null, error: e.message }); }
  }
  return out;
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
  listCounsellorsForSchools, getStudentBySessionId, getStudentContacts, getReportPdfData,
  getAllSchools,
  /* student CRUD */
  upsertStudent, deleteStudent, resetStudentAssessment, moveStudent, runImportTransaction, getStudentByEmail,
  /* access codes */
  generateAccessCode, setStudentAccessCode, redeemAccessCode, listAccessNames, listAccessClasses,
  findStudentByUid, UID_COLUMNS,
  listAccessSchools,
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
  /* analytics */
  getModuleTiming,
  getCareerDistribution,
  pruneCaches,
  /* programme analytics (live; one source for charts, lists, alerts, AI) */
  getCareerAreas, getDimensions, getStudentFacts, getBreakdown, getDrillStudents, getPulse,
  getProgrammeTrend, getAlerts, getAriaThemes, getGlossary, listClasses, getSchoolSummary, getFollowUpGroups,
  SCHEDULE_GROUPS, createSchedule, listSchedules, setScheduleActive, deleteSchedule, runDueSchedules, recentlyReminded,
  FOLLOWUP_TYPES, listFollowups, createFollowup, setFollowupDone, deleteFollowup,
  WELLBEING_AREAS, WELLBEING_OTHER, wellbeingAreaOf, APP_TIMEZONE, SMALL_SCHOOL_MAX_STUDENTS,
  PARAMETERS, SEAA_CONCERNS, SEAA_LEVELS, academicYearOf, academicYearLabel, ACADEMIC_YEAR_START_MONTH,
  getSchoolGroups, groupIndex: _groupIndex, mergedSchoolOf, listSchoolNames, mergeSchools, getFlowStructure, schoolsOfBranch,
  getSettingsMap, saveSettings, SETTINGS_SCHEMA, classGroupOf,
  getReportPdfDataBatch,
};
