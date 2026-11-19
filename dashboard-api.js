/* ════════════════════════════════════════════════════════════════════
   dashboard-api.js  —  NuMind MAPS  |  All /api/dashboard/* routes
   Node.js 18+, CommonJS

   Role hierarchy:
     admin       — full access: all routes, all schools, user management
     management  — read: schools they oversee + reminder log; no user CRUD
     counsellor  — scoped: their school only; notes/tags/reminders; no /schools

   Email:
     _sendEmail is wired up in server.js via init(db, sendEmailFn).
     _sendReminder guards with if (!_sendEmail) → 503
     so a missing config returns a clean error, not a crash.

   Aggregate analytics routes (power dashboard overview panels):
     GET /api/dashboard/aggregate-scores    — psychometric distribution
     GET /api/dashboard/wellbeing-alerts    — students needing SEA support
     GET /api/dashboard/career-distribution — recommended_primary distribution
     GET /api/dashboard/module-timing       — avg duration per assessment module
════════════════════════════════════════════════════════════════════ */

'use strict';

const _ddb = require('./dashboard-db.js');
const _cdb = require('./counsellor-db.js');
const _core = require('./db.js'); // shared class-matching helper (single source of truth)

/* School names are free text and can carry stray whitespace (bulk imports,
   hand-typed entries). Every SQL comparison uses LOWER(BTRIM(school)), so JS
   comparisons must normalise identically — otherwise a padded name silently
   fails a permission check and a legitimate user is denied. One helper so the
   two sides can never drift apart. */
/* Access-control key for a school name. Normalises case, punctuation and
   whitespace so "ABPS,BAGA", "ABPS, BAGA" and "abps baga" are one school —
   these are formatting differences in the same name, and treating them as
   distinct hid students from the counsellor assigned to them.

   Deliberately NOT fuzzy beyond that: no prefix or partial matching here.
   "Delhi Public School" and "Delhi Public School Noida" are different schools
   in the same chain, and a looser key would let a counsellor for one reach
   students at the other. Divergent spellings are prevented at the source
   instead, by db.js _canonicalSchoolName() at registration time. */
const _schoolKey = (v) => require('./match-utils.js').normSchool(v);
const _match = require('./match-utils.js');
const _assistant = require('./dashboard-assistant.js');
let _sendEmail = null;

/* Hourly request limits (per user for staff features, per network for the
   public access-code endpoints). Each can be raised in the environment. */
const _envInt = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = Object.freeze({
  insights:       _envInt('INSIGHTS_MAX_PER_HOUR', 60),
  insightsRegen:  _envInt('INSIGHTS_REGEN_MAX', 30),
  assistant:      _envInt('ASSISTANT_MAX_PER_HOUR', 120),
  accessSchools:  _envInt('ACCESS_SCHOOLS_MAX', 600),
  accessNames:    _envInt('ACCESS_NAMES_MAX', 1200),
  redeemStudent:  _envInt('ACCESS_REDEEM_MAX', 8),
  redeemNetwork:  _envInt('ACCESS_REDEEM_IP_MAX', 600),
});
const SESSION_PURGE_MS = 60 * 60 * 1000;

// Rate limiter injected by server.js (shares the DB-backed limiter used by the
// public counsellor endpoints). Left null in tests -> limiter simply not applied.
let _rl = null;

/* Called once by server.js after the schema is ready.
   sendEmail  the SMTP sender, or null when email is not configured
   rateLimit  (scope, key, limit) => Promise<boolean>, the shared DB limiter
   ai, models, log  passed to the AI analysis and assistant; without `ai`
              both answer 503 and everything else still works. */
function init({ sendEmail = null, rateLimit = null, ai = null, models = {}, log } = {}) {
  _assistant.init({ ai, models, log });
  _sendEmail = typeof sendEmail === 'function' ? sendEmail : null;
  _rl = typeof rateLimit === 'function' ? rateLimit : null;
  _startScheduleRunner();
  // Expired sessions and reset tokens are purged hourly; a failure is logged, never fatal.
  setInterval(() => {
    _ddb.purgeExpiredSessions().catch(e => process.stderr.write('[WARN]  [Dashboard] purgeExpiredSessions: ' + (e && e.message) + '\n'));
  }, SESSION_PURGE_MS).unref();
}

/* ══════════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════════ */
function _readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let tooLarge = false;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) {
        // Keep draining (don't destroy the socket) so a clean 413 can be sent.
        if (!tooLarge) { tooLarge = true; reject(new Error('body_too_large')); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return; // already rejected
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function _json(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function _auth(req) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? await _ddb.verifyToken(token) : null;
}

async function _requireRole(req, res, ...roles) {
  const user = await _auth(req);
  if (!user) { _json(res, 401, { error: 'Unauthorized' }); return null; }
  if (roles.length && !roles.includes(user.role)) { _json(res, 403, { error: 'Forbidden' }); return null; }
  return user;
}

/* Derive scoped school list for the requesting user */
async function _userSchools(user, overrideSchool = '') {
  if (user.role === 'admin') {
    return overrideSchool ? [overrideSchool] : (await _ddb.getAllSchools()).map(r => r.school);
  }
  if (overrideSchool) {
    // Non-admins may narrow to one school, but only within their own scope.
    // Same school-name normalisation as everywhere else, so a spelling that
    // differs only in case, spaces or punctuation still resolves.
    const want = _match.normSchool(overrideSchool);
    const hit = (user.schools || []).find(s => _match.normSchool(s) === want);
    return hit ? [hit] : [];
  }
  return user.schools;
}

/* Extra per-user restriction inside their schools (fine-grained permissions),
   as a predicate over student facts. Mirrors the studentScope handling in
   _students so the analytics views cannot show more than the student list. */
function _predicateFor(user) {
  const p = (user && user.permissions) || {};
  if (!user || user.role === 'admin') return null;
  if (p.studentScope === 'class' && Array.isArray(p.allowedClasses) && p.allowedClasses.length) {
    return (f) => p.allowedClasses.some(ac => _match.classMatches(ac, f.class));
  }
  if (p.studentScope === 'section' && Array.isArray(p.allowedSections) && p.allowedSections.length) {
    return (f) => p.allowedSections.some(as => _core.classKey(as) === _core.classKey(f.section));
  }
  return null;
}

/* The student row if `sessionId` is inside the user's scope, else null. */
async function _studentInScope(user, sessionId) {
  const stu = await _ddb.getStudentBySessionId(sessionId);
  if (!stu) return null;
  if (user.role === 'admin') return stu;
  const schools = (await _userSchools(user)).map(_schoolKey);
  if (!schools.includes(_schoolKey(stu.school))) return null;
  const pred = _predicateFor(user);
  return (!pred || pred(stu)) ? stu : null;
}

// The numeric id at the end of the URL, or null when it is not a positive integer.
function _idParam(req) { const n = Number(_seg(req.url, -1)); return Number.isInteger(n) && n > 0 ? n : null; }

function _qs(req) { return new URLSearchParams(req.url.split('?')[1] || ''); }

/* Resolve the `school` query/body value to the user's scoped school list.
   Returns null (and has answered 403) when a non-admin names a school
   outside their scope. */
async function _scopedSchools(user, res, school) {
  const list = await _userSchools(user, school || '');
  if (school && !list.length) { _json(res, 403, { error: 'That school is not assigned to you.' }); return null; }
  return list;
}

/* `year` from the query string: null when absent, undefined when malformed. */
function _yearParam(qs) {
  const v = (qs.get('year') || '').trim();
  if (!v) return null;
  return /^\d{4}$/.test(v) ? Number(v) : undefined;
}

/* Full analytics scope from the query string: `school` (one raw school
   name), or `org` (a school or group) with optional `branch`, plus
   `year` (academic year by start year, e.g. 2026 = 2026–27). Returns
   {schools, predicate}, or null when it has already answered 403. */
async function _scopeQ(user, res, qs) {
  let schools = await _scopedSchools(user, res, qs.get('school'));
  if (!schools) return null;
  const org = (qs.get('org') || '').trim();
  if (org) schools = await _ddb.schoolsOfBranch(schools, org, (qs.get('branch') || '').trim() || null);
  const base = _predicateFor(user);
  const year = _yearParam(qs);
  if (year === undefined) { _json(res, 400, { error: 'year must be a four-digit academic start year, e.g. 2026.' }); return null; }
  const predicate = year == null ? base : (f) => f.academic_year === year && (!base || base(f));
  return { schools, predicate, year };
}

/* ══════════════════════════════════════════════════════════════════
   ROUTE DISPATCHER
══════════════════════════════════════════════════════════════════ */
async function handle(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;

  try {
    // ── Auth ────────────────────────────────────────────────────
    if (method === 'POST' && url === '/api/dashboard/login')           return await _login(req, res);
    if (method === 'POST' && url === '/api/dashboard/logout')          return await _logout(req, res);
    if (method === 'GET'  && url === '/api/dashboard/me')              return _me(req, res);
    if (method === 'POST' && url === '/api/dashboard/forgot-password') return await _forgotPassword(req, res);
    if (method === 'POST' && url === '/api/dashboard/reset-password')  return await _resetPassword(req, res);
    if (method === 'POST' && url === '/api/dashboard/change-password') return await _changePassword(req, res);

    // ── Aggregate analytics (any authenticated role, scoped) ────
    if (method === 'GET' && url === '/api/dashboard/aggregate-scores')    return _aggregateScores(req, res);
    if (method === 'GET' && url === '/api/dashboard/wellbeing-alerts')    return _wellbeingAlerts(req, res);
    if (method === 'GET' && url === '/api/dashboard/career-distribution') return _careerDistribution(req, res);
    if (method === 'GET' && url === '/api/dashboard/module-timing')       return _moduleTiming(req, res);

    // ── Programme analytics (one source for charts, lists, alerts) ─
    if (method === 'GET'  && url === '/api/dashboard/catalogue')       return await _catalogue(req, res);
    if (method === 'GET'  && url === '/api/dashboard/classes')         return await _classes(req, res);
    if (method === 'GET'  && url === '/api/dashboard/breakdown')       return await _breakdown(req, res);
    if (method === 'GET'  && url === '/api/dashboard/drill')           return await _drill(req, res);
    if (method === 'GET'  && url === '/api/dashboard/alerts')          return await _alerts(req, res);
    if (method === 'GET'  && url === '/api/dashboard/school-summary')  return await _schoolSummary(req, res);
    if (method === 'GET'  && url === '/api/dashboard/pulse')           return await _pulse(req, res);
    if (method === 'GET'  && url === '/api/dashboard/flow')            return await _flow(req, res);
    if (method === 'GET'  && url === '/api/dashboard/school-names')    return await _schoolNamesGet(req, res);
    if (method === 'POST' && url === '/api/dashboard/schools/merge')   return await _schoolsMerge(req, res);
    if (method === 'GET'  && url === '/api/dashboard/aria-themes')     return await _ariaThemes(req, res);
    if (method === 'GET'  && url === '/api/dashboard/settings')        return await _getSettings(req, res);
    if (method === 'PUT'  && url === '/api/dashboard/settings')        return await _putSettings(req, res);

    // ── AI: Programme Intelligence + dashboard assistant ─────────
    if (method === 'POST'   && url === '/api/dashboard/insights')                 return await _insights(req, res);
    if (method === 'POST'   && url === '/api/dashboard/assistant')                return await _assistantChat(req, res);
    if (method === 'GET'    && url === '/api/dashboard/assistant/conversations')  return await _assistantList(req, res);
    if (method === 'GET'    && url === '/api/dashboard/assistant/history')        return await _assistantHistory(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/assistant\/conversations\/[a-f0-9]{16,40}$/)) return await _assistantDelete(req, res);

    // ── Bulk report download + journey linking ───────────────────
    if (method === 'POST' && url === '/api/dashboard/students/report-pdf-batch') return await _reportPdfBatch(req, res);
    if (method === 'POST' && url.match(/^\/api\/dashboard\/students\/[^/]+\/journey\/unlink$/)) return await _journeyUnlink(req, res);

    // ── Student data ─────────────────────────────────────────────
    if (method === 'GET'  && url === '/api/dashboard/students')        return _students(req, res);
    if (method === 'GET'  && url === '/api/dashboard/stats')           return _stats(req, res);
    if (method === 'GET'  && url === '/api/dashboard/trend')           return _trend(req, res);
    if (method === 'GET'  && url === '/api/dashboard/students/export') return _exportStudentsCsv(req, res);
    if (method === 'POST' && url === '/api/dashboard/send-reminder')   return await _sendReminder(req, res);

    // ── Student CRUD ─────────────────────────────────────────────
    if (method === 'POST'   && url === '/api/dashboard/students')                        return await _createStudent(req, res);
    if (method === 'POST'   && url === '/api/dashboard/students/import')                 return await _importStudents(req, res);
    if (method === 'PUT'    && url.match(/^\/api\/dashboard\/students\/[^/]+$/))         return await _updateStudent(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/students\/[^/]+$/))         return _delStudent(req, res);
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/reset$/))  return _resetAssessment(req, res);
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/reset-pin$/)) return await _resetStudentPin(req, res);
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/access-code$/)) return await _regenAccessCode(req, res);

    // ── Per-student detail ───────────────────────────────────────
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+$/))            return await _studentBasic(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/reminders$/)) return _studentReminders(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes$/))     return _getNotes(req, res);
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes$/))     return await _addNote(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes\/[^/]+$/)) return _delNote(req, res);
    if (method === 'PUT'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/tags$/))      return await _setTags(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/report$/))    return _studentReport(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/report-pdf$/)) return _studentReportPdfData(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/insights$/))  return _studentInsights(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/journey$/))   return _studentJourney(req, res);

    // ── At-risk (all roles, school-scoped) ───────────────────────
    if (method === 'GET' && url === '/api/dashboard/at-risk')      return _atRisk(req, res);

    // ── Counsellor directory (management | admin) ────────────────
    if (method === 'GET' && url === '/api/dashboard/counsellors')  return _counsellors(req, res);

    // ── Schools + reminder log (management | admin) ──────────────
    if (method === 'GET' && url === '/api/dashboard/schools')      return _schools(req, res);
    if (method === 'GET' && url === '/api/dashboard/reminder-log') return _reminderLog(req, res);
    if (method === 'GET'    && url === '/api/dashboard/followups')                    return await _followupsList(req, res);
    if (method === 'POST'   && url === '/api/dashboard/followups')                    return await _followupsCreate(req, res);
    if (method === 'PUT'    && url.match(/^\/api\/dashboard\/followups\/\d+$/))        return await _followupsUpdate(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/followups\/\d+$/))        return await _followupsDelete(req, res);
    if (method === 'POST'   && url === '/api/dashboard/assistant/note')               return await _assistantNote(req, res);
    if (method === 'GET'    && url === '/api/dashboard/schedules')                    return await _schedulesList(req, res);
    if (method === 'POST'   && url === '/api/dashboard/schedules')                    return await _schedulesCreate(req, res);
    if (method === 'PUT'    && url.match(/^\/api\/dashboard\/schedules\/\d+$/))        return await _schedulesUpdate(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/schedules\/\d+$/))        return await _schedulesDelete(req, res);

    // ── Student Counsellor Queries ──────────────────────────────
    if (method === 'GET'   && url.startsWith('/api/dashboard/queries')) return _listQueries(req, res);
    if (method === 'PATCH' && url.startsWith('/api/dashboard/queries/')) return await _updateQuery(req, res);

    // ── Schools registry (admin only) ────────────────────────────
    if (method === 'GET'    && url === '/api/dashboard/schools-registry')              return _listSchoolsReg(req, res);
    if (method === 'POST'   && url === '/api/dashboard/schools-registry')              return await _upsertSchoolReg(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/schools-registry\/\d+$/)) return _delSchoolReg(req, res);

    // ── User management (admin only) ─────────────────────────────
    if (method === 'GET'    && url === '/api/dashboard/users')           return _listUsers(req, res);
    if (method === 'POST'   && url === '/api/dashboard/users')           return await _createUser(req, res);
    if (method === 'PUT'    && url.startsWith('/api/dashboard/users/'))  return await _updateUser(req, res);
    if (method === 'DELETE' && url.startsWith('/api/dashboard/users/'))  return _deleteUser(req, res);

    // ── Audit log (admin only) ───────────────────────────────────
    if (method === 'GET' && url === '/api/dashboard/audit-log') return _auditLog(req, res);

    _json(res, 404, { error: 'Not found' });

  } catch (err) {
    // Known client errors — respond correctly, do NOT log as server error
    if (err.message === 'body_too_large') return _json(res, 413, { error: 'Payload too large. Maximum upload size exceeded.' });
    if (err.message === 'invalid_json')   return _json(res, 400, { error: 'Invalid JSON in request body' });
    // Unexpected server errors only
    process.stderr.write('[ERROR] [Dashboard API] ' + err.message + '\n' + (err.stack || '') + '\n');
    _json(res, 500, { error: 'Server error' });
  }
}

/* ══════════════════════════════════════════════════════════════════
   AUTH ROUTES
══════════════════════════════════════════════════════════════════ */
async function _login(req, res) {
  const body = await _readBody(req, 4 * 1024);
  const { email, password } = body || {};
  if (!email || !password) return _json(res, 400, { error: 'Email and password required' });
  const result = await _ddb.login(email, password);
  if (!result) return _json(res, 401, { error: 'Invalid email or password' });
  _json(res, 200, result);
}

async function _logout(req, res) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) await _ddb.logout(token);
  _json(res, 200, { ok: true });
}

async function _me(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  _json(res, 200, { user });
}

async function _forgotPassword(req, res) {
  const body = await _readBody(req, 4 * 1024);
  const { email } = body || {};
  if (!email) return _json(res, 400, { error: 'email required' });
  const u = await _ddb.getUserByEmail(email);
  // Always return 200 — anti-enumeration (don't reveal whether email exists)
  if (!u) return _json(res, 200, { ok: true });
  const token = await _ddb.createPasswordResetToken(u.id);
  if (_sendEmail) {
    try {
      await _sendEmail({
        to: u.email,
        subject: '[NuMind MAPS] Password Reset',
        text: [
          `Hi ${u.name},`,
          '',
          'A password reset was requested for your NuMind MAPS dashboard account.',
          '',
          'Reset token (valid 1 hour):',
          token,
          '',
          'If you did not request this, please ignore this email.',
          '',
          '— NuMind MAPS System',
        ].join('\n'),
      });
    } catch (e) { process.stderr.write('[ERROR] [Dashboard] forgot-password email error: ' + e.message + '\n'); }
    // When SMTP is configured, token travels via email only — never in the response.
    return _json(res, 200, { ok: true });
  }
  // SMTP not configured: the token goes to the server log for an operator to
  // relay. It is never returned in the response, which would let anyone reset
  // any staff password knowing only the email.
  process.stderr.write('[WARN]  [Dashboard] SMTP not configured — password reset token for user ' + u.id + ': ' + token + '\n');
  return _json(res, 200, { ok: true });
}

async function _resetPassword(req, res) {
  const body = await _readBody(req, 4 * 1024);
  const { token, password } = body || {};
  if (!token || !password) return _json(res, 400, { error: 'token and password required' });
  if (String(password).length < 8) return _json(res, 400, { error: 'Password must be at least 8 characters' });
  const ok = await _ddb.consumePasswordResetToken(token, password);
  if (!ok) return _json(res, 400, { error: 'Token invalid or expired' });
  _json(res, 200, { ok: true });
}

async function _changePassword(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const body = await _readBody(req, 4 * 1024);
  // Accept both 'current_password' and 'old_password' for compatibility with all dashboard UIs
  const current_password = (body || {}).current_password || (body || {}).old_password;
  const new_password     = (body || {}).new_password;
  if (!current_password || !new_password) return _json(res, 400, { error: 'current_password and new_password required' });
  if (String(new_password).length < 8) return _json(res, 400, { error: 'Password must be at least 8 characters' });
  const check = await _ddb.login(user.email, current_password);
  if (!check) return _json(res, 401, { error: 'Current password is incorrect' });
  await _ddb.updateUser({ id: user.id, password: new_password });
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'change_password' });
  _json(res, 200, { ok: true });
}

/* ══════════════════════════════════════════════════════════════════
   AGGREGATE ANALYTICS
══════════════════════════════════════════════════════════════════ */
async function _aggregateScores(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const agg = await _ddb.getAggregateScores(await _userSchools(user));
    _json(res, 200, { aggregates: agg });
  } catch (e) { process.stderr.write('[ERROR] [aggregate-scores] ' + e.message + '\n'); _json(res, 500, { error: 'Server error' }); }
}

async function _wellbeingAlerts(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const qs = _qs(req);
    const schools = await _scopedSchools(user, res, qs.get('school'));
    if (!schools) return;
    const { alerts, total } = await _ddb.getWellbeingAlerts(schools, { limit: qs.get('limit') || 20, predicate: _predicateFor(user) });
    _json(res, 200, { alerts, total });
  } catch (e) { process.stderr.write('[ERROR] [wellbeing-alerts] ' + e.message + '\n'); _json(res, 500, { error: 'Server error' }); }
}

async function _careerDistribution(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const qs = _qs(req);
    const schools = await _scopedSchools(user, res, qs.get('school'));
    if (!schools) return;
    _json(res, 200, await _ddb.getCareerDistribution(schools, qs.get('by') === 'stream' ? 'stream' : 'career_area', { predicate: _predicateFor(user) }));
  } catch (e) { process.stderr.write('[ERROR] [career-distribution] ' + e.message + '\n'); _json(res, 500, { error: 'Server error' }); }
}

async function _moduleTiming(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const schools = await _scopedSchools(user, res, _qs(req).get('school'));
    if (!schools) return;
    _json(res, 200, { timing: await _ddb.getModuleTiming(schools, { predicate: _predicateFor(user) }) });
  } catch (e) { process.stderr.write('[ERROR] [module-timing] ' + e.message + '\n'); _json(res, 500, { error: 'Server error' }); }
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT DATA
══════════════════════════════════════════════════════════════════ */
async function _students(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const qs      = new URLSearchParams(req.url.split('?')[1] || '');
  const cls     = qs.get('class')   || '';
  const section = qs.get('section') || '';
  const search  = qs.get('search')  || '';
  const school  = qs.get('school')  || '';
  const status  = qs.get('status')  || '';
  const offset  = Math.max(parseInt(qs.get('offset') || '0', 10), 0);
  const limit   = Math.min(parseInt(qs.get('limit') || '100', 10), 2000);

  let schools = await _userSchools(user, school);

  // Fine-grained permission scoping
  const p = user.permissions || {};
  if (user.role !== 'admin') {
    if (p.studentScope === 'class' && Array.isArray(p.allowedClasses) && p.allowedClasses.length) {
      if (cls && !p.allowedClasses.some(ac => _core.classMatches(ac, cls))) return _json(res, 200, { students: [], count: 0 });
      if (!cls) {
        const rows = [];
        for (const ac of p.allowedClasses)
          rows.push(...await _ddb.getStudentsBySchool(schools, { class: ac, section, search, limit, offset }));
        return _json(res, 200, { students: rows, count: rows.length });
      }
    }
    if (p.studentScope === 'section' && Array.isArray(p.allowedSections) && p.allowedSections.length) {
      if (section && !p.allowedSections.some(as => _core.classKey(as) === _core.classKey(section))) return _json(res, 200, { students: [], count: 0 });
      if (!section) {
        const rows = [];
        for (const as of p.allowedSections)
          rows.push(...await _ddb.getStudentsBySchool(schools, { class: cls, section: as, search, limit, offset }));
        return _json(res, 200, { students: rows, count: rows.length });
      }
    }
  }

  const filters  = { class: cls, section, search, status };
  const students = await _ddb.getStudentsBySchool(schools, { ...filters, limit, offset });
  const total    = await _ddb.countStudentsFiltered(schools, filters);
  _json(res, 200, { students, count: students.length, total, limit, offset });
}

async function _stats(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const qs     = new URLSearchParams(req.url.split('?')[1] || '');
  const school = qs.get('school') || '';
  const schools = await _userSchools(user, school);
  const stats   = await _ddb.countStudentsBySchool(schools);
  const gender  = await _ddb.getGenderStats(schools);
  _json(res, 200, { stats, gender });
}

/* Programme trend anchored to the first registration in scope: Week 1, Week 2,
   … up to today, with empty weeks shown as zero. `from`/`to` (YYYY-MM-DD)
   narrow the visible range without renumbering the weeks. */
async function _trend(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const qs = _qs(req);
  const schools = await _scopedSchools(user, res, qs.get('school'));
  if (!schools) return;
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const trend = await _ddb.getProgrammeTrend(schools, {
    granularity: qs.get('granularity') === 'day' ? 'day' : 'week', from: iso(qs.get('from')), to: iso(qs.get('to')),
    predicate: _predicateFor(user),
  });
  _json(res, 200, { trend });
}

async function _atRisk(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const qs   = new URLSearchParams(req.url.split('?')[1] || '');
  const schools = await _scopedSchools(user, res, qs.get('school'));
  if (!schools) return;
  // Same definition as the "Needs follow-up" list (each school's own
  // follow-up setting, the user's class/section limits), so the numbers agree.
  const out = await _ddb.getDrillStudents(schools, {
    dimension: 'attention', groups: ['stalled', 'report_pending'],
    limit: qs.get('limit') || 500, offset: qs.get('offset') || 0, predicate: _predicateFor(user),
  });
  _json(res, 200, { students: out.students, total: out.total });
}

async function _counsellors(req, res) {
  const user = await _requireRole(req, res, 'management', 'admin');
  if (!user) return;
  const counsellors = await _ddb.listCounsellorsForSchools(await _userSchools(user));
  _json(res, 200, { counsellors });
}

async function _schools(req, res) {
  const user = await _requireRole(req, res, 'management', 'admin');
  if (!user) return;
  const summaries = await _ddb.getSchoolSummaries(await _userSchools(user));
  _json(res, 200, { schools: summaries });
}

async function _exportStudentsCsv(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const qs     = new URLSearchParams(req.url.split('?')[1] || '');
  const school = qs.get('school') || '';
  const cls    = qs.get('class')  || '';
  const status = qs.get('status') || '';
  const pred = _predicateFor(user);
  const filtered = (await _ddb.getStudentsBySchool(await _userSchools(user, school), { class: cls, status, limit: 50000 }))
    .filter(s => !pred || pred(s));
  // Quote every cell; text starting with = + - @ is prefixed so Excel does not run it as a formula.
  const esc = v => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g,'""')}"`; };
  // TIMESTAMPTZ arrives as a Date; exports show the calendar date only.
  const day = v => v ? new Date(v).toISOString().slice(0,10) : '';
  // Access Code included so staff can print/hand out codes straight from the export.
  // "Unique School ID" re-imports as-is (the importer accepts that header).
  const header = ['Name','Unique School ID','Email','School','Class','Section','Gender','Age','Access Code','Status','Modules Done','Registered At','Completed At'];
  const rows = filtered.map(s => [
    esc(s.full_name), esc(s.student_uid), esc(s.email), esc(s.school), esc(s.class), esc(s.section),
    esc(s.gender), esc(s.age), esc(s.access_code), esc(s.status), s.modules_done,
    esc(day(s.registered_at)),
    esc(day(s.completed_at)),
  ]);
  const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="students-${new Date().toISOString().slice(0,10)}.csv"`,
  });
  res.end('\uFEFF' + csv);
}

/* ══════════════════════════════════════════════════════════════════
   EMAIL — both routes guard against null _sendEmail
══════════════════════════════════════════════════════════════════ */
/* ── Follow-up tasks: each staff member's own list ───────────────── */
async function _followupsList(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  _json(res, 200, { tasks: await _ddb.listFollowups(user.id), types: _ddb.FOLLOWUP_TYPES });
}
async function _followupsCreate(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const b = (await _readBody(req, 8 * 1024)) || {};
    // A task about a student record must be about one the user can see.
    if (b.session_id && !(await _studentInScope(user, String(b.session_id)))) return _json(res, 403, { error: 'That student is not in your schools.' });
    const id = await _ddb.createFollowup({ userId: user.id, sessionId: b.session_id ? String(b.session_id) : null, studentLabel: b.student, type: b.type, notes: b.notes, due: b.due });
    _json(res, 201, { ok: true, id });
  } catch (e) { _err(res, e, 'followups'); }
}
async function _followupsUpdate(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const id = _idParam(req);
  if (!id) return _json(res, 400, { error: 'Invalid task id.' });
  const b = (await _readBody(req, 2 * 1024)) || {};
  const n = await _ddb.setFollowupDone(user.id, id, !!b.done);
  if (!n) return _json(res, 404, { error: 'Task not found.' });
  _json(res, 200, { ok: true });
}
async function _followupsDelete(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const id = _idParam(req);
  if (!id) return _json(res, 400, { error: 'Invalid task id.' });
  const n = await _ddb.deleteFollowup(user.id, id);
  if (!n) return _json(res, 404, { error: 'Task not found.' });
  _json(res, 200, { ok: true });
}

/* ── Scheduled reminder campaigns ──────────────────────────────────
   Stored in reminder_schedules and run here, on one worker, every few
   minutes: each due schedule resolves its students with the creator's own
   scope (schools, class and section limits), skips anyone reminded within the
   schedule's frequency, sends through the same email path as a manual
   reminder, and logs every email to the reminder log. */
const SCHEDULE_CHECK_MS = 5 * 60 * 1000;
const _canSchedule = (user) => user.role === 'admin' || (user.role === 'management' && !(user.permissions && user.permissions.can_send_reminders === false));

async function _runSchedule(sch, creator) {
  if (!_sendEmail) throw new Error('Email is not configured on this server (SMTP settings are missing), so nothing was sent.');
  const def = _ddb.SCHEDULE_GROUPS[sch.target_group];
  if (!def) throw new Error('Unknown target group.');
  const schools = await _userSchools(creator, sch.school || '');
  if (sch.school && !schools.length) throw new Error(`"${sch.school}" is no longer one of the creator's schools.`);
  const ids = (await _ddb.getDrillStudents(schools, { dimension: def.dimension, groups: def.groups, idsOnly: true, predicate: _predicateFor(creator) })).ids;
  const rows = await _ddb.getStudentContacts(ids, null);
  const withEmail = rows.filter(r => r.email);
  const recent = await _ddb.recentlyReminded(withEmail.map(r => r.email), sch.frequency_days);
  let sent = 0, skipped = rows.length - withEmail.length;
  for (const st of withEmail) {
    if (recent.has(String(st.email).toLowerCase())) { skipped++; continue; }
    try {
      await _sendEmail({ to: st.email, subject: sch.subject,
        text: [`Dear ${st.full_name || st.first_name || 'Student'},`, '', sch.message, '', 'If you have any questions, please contact your school counsellor.', '', '— NuMind MAPS Team'].join('\n') });
      await _ddb.logReminder({ studentEmail: st.email, sentBy: creator.id, subject: sch.subject, message: sch.message });
      sent++;
    } catch (e) {
      skipped++;
      process.stderr.write('[WARN]  [Dashboard] scheduled reminder to ' + st.email + ' failed: ' + e.message + '\n');
    }
  }
  return { sent, skipped };
}
function _startScheduleRunner() {
  // One worker runs schedules under PM2; the SKIP LOCKED claim keeps it safe
  // even if more than one does.
  if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') return;
  const tick = () => _ddb.runDueSchedules(_runSchedule).catch(e => process.stderr.write('[WARN]  [Dashboard] schedule runner: ' + e.message + '\n'));
  setTimeout(tick, 20 * 1000).unref();
  setInterval(tick, SCHEDULE_CHECK_MS).unref();
}
async function _schedulesList(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const list = await _ddb.listSchedules({ createdBy: user.role === 'admin' ? null : user.id });
  _json(res, 200, { schedules: list, email_enabled: !!_sendEmail, can_create: _canSchedule(user),
    groups: Object.entries(_ddb.SCHEDULE_GROUPS).map(([id, g]) => ({ id, label: g.label })), timezone: _ddb.APP_TIMEZONE });
}
async function _schedulesCreate(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  if (!_canSchedule(user)) return _json(res, 403, { error: 'You do not have permission to send reminders.' });
  try {
    const b = (await _readBody(req, 16 * 1024)) || {};
    const school = String(b.school || '').trim();
    if (school && !(await _userSchools(user, school)).length) return _json(res, 403, { error: 'That school is not assigned to you.' });
    const id = await _ddb.createSchedule({ createdBy: user.id, targetGroup: b.target_group, school, frequencyDays: b.frequency_days, sendHour: b.send_hour == null ? 9 : b.send_hour, subject: b.subject, message: b.message });
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'create_schedule', target: String(id), detail: `${b.target_group} · every ${b.frequency_days} day(s)${school ? ' · ' + school : ''}` });
    _json(res, 201, { ok: true, id, email_enabled: !!_sendEmail });
  } catch (e) { _err(res, e, 'schedules'); }
}
async function _schedulesUpdate(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const id = _idParam(req);
  if (!id) return _json(res, 400, { error: 'Invalid schedule id.' });
  const b = (await _readBody(req, 4 * 1024)) || {};
  const n = await _ddb.setScheduleActive(id, !!b.active, { createdBy: user.role === 'admin' ? null : user.id });
  if (!n) return _json(res, 404, { error: 'Schedule not found.' });
  _json(res, 200, { ok: true });
}
async function _schedulesDelete(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const id = _idParam(req);
  if (!id) return _json(res, 400, { error: 'Invalid schedule id.' });
  const n = await _ddb.deleteSchedule(id, { createdBy: user.role === 'admin' ? null : user.id });
  if (!n) return _json(res, 404, { error: 'Schedule not found.' });
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_schedule', target: String(id) });
  _json(res, 200, { ok: true });
}

const REMINDER_BATCH_MAX = 500;
// Largest roster upload (the JSON body of an import, and its rows), shared with the page.
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const IMPORT_MAX_ROWS = 2000;
async function _sendReminder(req, res) {
  const user = await _requireRole(req, res, 'counsellor', 'management', 'admin');
  if (!user) return;
  if (user.role !== 'admin' && user.permissions && user.permissions.can_send_reminders === false) {
    return _json(res, 403, { error: 'You do not have permission to send reminders.' });
  }

  // ── Critical null-check — server.js passes null until SMTP is configured ──
  if (!_sendEmail) {
    return _json(res, 503, {
      error: 'Email is not configured on this server. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your .env file, then restart.',
    });
  }

  const body = await _readBody(req, 64 * 1024);
  const { subject, message } = body || {};
  let { students } = body || {};
  if (!message) return _json(res, 400, { error: 'message required' });

  // A list of session ids (any drill-down list, the assistant) is resolved
  // here in one scoped query; students without an email are reported back.
  let noEmail = 0, preScoped = false;
  if (Array.isArray(body && body.session_ids)) {
    preScoped = true; // rows are already limited to the caller's schools and class/section limits
    if (body.session_ids.length > REMINDER_BATCH_MAX) return _json(res, 400, { error: 'At most ' + REMINDER_BATCH_MAX + ' students per request.' });
    const pred = _predicateFor(user);
    const rows = (await _ddb.getStudentContacts(body.session_ids, user.role === 'admin' ? null : await _userSchools(user)))
      .filter(r => !pred || pred(r));
    noEmail = rows.filter(r => !r.email).length;
    students = rows.filter(r => r.email);
    if (!students.length) return _json(res, 200, { ok: true, sent: 0, failed: 0, no_email: noEmail, scopeRejected: body.session_ids.length - rows.length });
  }
  if (!Array.isArray(students) || !students.length) return _json(res, 400, { error: 'students or session_ids required' });

  // Scope guard: verify each target email belongs to a real student within
  // the caller's assigned school(s) — prevents using this endpoint to email
  // arbitrary addresses (including ones with no corresponding student at all).
  let inScope = students;
  if (user.role !== 'admin' && !preScoped) {
    const schools = (await _userSchools(user)).map(_schoolKey);
    const pred = _predicateFor(user);
    // Resolve each student's school first (async), then filter synchronously.
    const checked = await Promise.all(students.map(async (st) => {
      if (!st.email) return null;
      const stu = _ddb.getStudentByEmail ? await _ddb.getStudentByEmail(st.email) : null;
      return (stu && schools.includes(_schoolKey(stu.school)) && (!pred || pred(stu))) ? st : null;
    }));
    inScope = checked.filter(Boolean);
    if (!inScope.length) {
      return _json(res, 403, { error: 'None of the selected students are in your assigned school(s).' });
    }
  }

  const emailSubject = subject || 'Reminder: Complete your NuMind MAPS Assessment';
  let sent = 0, failed = 0;

  for (const st of inScope) {
    if (!st.email) { failed++; continue; }
    try {
      await _sendEmail({
        to:      st.email,
        subject: emailSubject,
        text: [
          `Dear ${st.full_name || st.first_name || st.firstName || 'Student'},`,
          '',
          message,
          '',
          'If you have any questions, please contact your school counsellor.',
          '',
          '— NuMind MAPS Team',
        ].join('\n'),
      });
      await _ddb.logReminder({ studentEmail: st.email, sentBy: user.id, subject: emailSubject, message });
      sent++;
    } catch (e) {
      process.stderr.write('[ERROR] [Dashboard] reminder error for ' + st.email + ': ' + e.message + '\n');
      failed++;
    }
  }

  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'send_reminder',
                  detail: `sent=${sent} failed=${failed} no_email=${noEmail} scopeRejected=${students.length - inScope.length}` });
  _json(res, 200, { ok: true, sent, failed, no_email: noEmail, scopeRejected: students.length - inScope.length });
}

/* ══════════════════════════════════════════════════════════════════
   REMINDER LOG
══════════════════════════════════════════════════════════════════ */
async function _reminderLog(req, res) {
  const user = await _requireRole(req, res, 'management', 'admin');
  if (!user) return;
  const opts = { limit: 200 };
  if (user.role !== 'admin') opts.schools = await _userSchools(user);
  _json(res, 200, { log: await _ddb.getReminderLog(opts) });
}

/* ══════════════════════════════════════════════════════════════════
   COUNSELLOR QUERIES — student contact/schedule form submissions
   Accessible by: admin, management, counsellor (own school scoped)
══════════════════════════════════════════════════════════════════ */
async function _listQueries(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management', 'counsellor');
  if (!user) return;
  const qs     = Object.fromEntries(new URL('http://x' + req.url).searchParams);
  const status = qs.status || '';     // 'pending' | 'in-progress' | 'resolved' | ''
  const limit  = Math.min(parseInt(qs.limit || '200', 10), 500);
  const offset = parseInt(qs.offset || '0', 10);
  const scopeOpts = user.role !== 'admin' ? { schools: await _userSchools(user) } : {};
  const rows   = await _cdb.listQueries({ status: status || undefined, limit, offset, ...scopeOpts });
  // Count pending for badge — same scoping applied
  const pending = (await _cdb.listQueries({ status: 'pending', limit: 500, ...scopeOpts })).length;
  _json(res, 200, { queries: rows, pending });
}

async function _updateQuery(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management', 'counsellor');
  if (!user) return;
  const id   = parseInt(req.url.split('/').pop(), 10);
  if (!id) return _json(res, 400, { error: 'Invalid query id' });
  const body = await _readBody(req).catch(() => ({}));
  const { status, adminNote } = body || {};
  const allowed = ['pending', 'in-progress', 'resolved'];
  if (status && !allowed.includes(status)) {
    return _json(res, 400, { error: 'status must be pending | in-progress | resolved' });
  }
  await _cdb.updateQuery(id, { status, adminNote });
  await _ddb.auditLog({
    userId: user.id, userEmail: user.email,
    action: 'update_query', target: String(id),
    detail: status ? `status=${status}` : 'note updated',
  });
  _json(res, 200, { ok: true });
}

/* ══════════════════════════════════════════════════════════════════
   USER MANAGEMENT (admin only)
══════════════════════════════════════════════════════════════════ */
async function _listUsers(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  _json(res, 200, { users: await _ddb.listUsers() });
}

async function _createUser(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const body = await _readBody(req);
  const { name, email, password, role, schools, permissions } = body || {};
  if (!name || !email || !password) return _json(res, 400, { error: 'name, email, password required' });
  if (!['counsellor','management','admin'].includes(role)) {
    return _json(res, 400, { error: 'role must be counsellor | management | admin' });
  }
  try {
    const id = await _ddb.createUser({ name, email, password, role, schools: schools || [], permissions: permissions || {} });
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'create_user', target: email, detail: `role=${role}` });
    _json(res, 201, { ok: true, id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return _json(res, 409, { error: 'Email already exists' });
    throw e;
  }
}

async function _updateUser(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  if (!id) return _json(res, 400, { error: 'Invalid user id' });
  const body = await _readBody(req);
  if (body.permissions === null || body.permissions === undefined) delete body.permissions;
  await _ddb.updateUser({ id, ...body });
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'update_user', target: String(id) });
  _json(res, 200, { ok: true });
}

async function _deleteUser(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  if (!id) return _json(res, 400, { error: 'Invalid user id' });
  await _ddb.deleteUser(id);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_user', target: String(id) });
  _json(res, 200, { ok: true });
}

/* ══════════════════════════════════════════════════════════════════
   AUDIT LOG (admin only)
══════════════════════════════════════════════════════════════════ */
async function _auditLog(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  _json(res, 200, { log: await _ddb.getAuditLog({ limit: 500 }) });
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT CRUD
══════════════════════════════════════════════════════════════════ */
async function _createStudent(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const body = await _readBody(req, 16 * 1024);
  const { first_name, last_name, email, class: cls, section, school, age, gender, school_state, school_city, student_uid } = body || {};
  if (!first_name || !school) return _json(res, 400, { error: 'first_name and school required' });
  // Scope guard: management may only create students under their assigned school(s)
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(_schoolKey);
    if (!schools.includes(_schoolKey(school))) {
      return _json(res, 403, { error: 'You can only add students to your assigned school(s).' });
    }
    const pred = _predicateFor(user);
    if (pred && !pred({ class: cls || '', section: section || '' })) {
      return _json(res, 403, { error: 'You can only add students to the classes or sections you are assigned.' });
    }
  }
  // Upsert: an existing Unique School ID or email updates that row in place; otherwise create.
  try {
    const sid = await _ddb.upsertStudent({ first_name, last_name, email, class: cls, section, school, age, gender, school_state, school_city, student_uid });
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'create_student', target: sid,
                    detail: `${first_name} ${last_name || ''} @ ${school}` });
    _json(res, 201, { ok: true, session_id: sid });
  } catch (e) { _err(res, e, 'create-student'); }
}

async function _updateStudent(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const sessionId = _seg(req.url, -1);
  // IDOR guard: management may only edit students in their assigned schools
  let stu = null;
  if (user.role !== 'admin') {
    // School AND class/section limits, before and after the change.
    stu = await _studentInScope(user, sessionId);
    if (!stu) return _json(res, (await _ddb.getStudentBySessionId(sessionId)) ? 403 : 404, { error: 'Student not found in your schools.' });
  }
  const body = await _readBody(req, 16 * 1024);
  if (stu) {
    const pred = _predicateFor(user);
    const after = { class: body && body.class != null ? body.class : stu.class, section: body && body.section != null ? body.section : stu.section };
    if (pred && !pred(after)) return _json(res, 403, { error: 'You can only move students within the classes or sections you are assigned.' });
  }
  // Moving a student to another school must stay inside the editor's own schools.
  if (user.role !== 'admin' && body && body.school != null && !(await _userSchools(user)).map(_schoolKey).includes(_schoolKey(body.school))) {
    return _json(res, 403, { error: 'You can only move students between your assigned schools.' });
  }
  try {
    await _ddb.moveStudent(sessionId, body || {});
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'update_student', target: sessionId });
    _json(res, 200, { ok: true });
  } catch (e) { _err(res, e, 'update-student'); }
}

async function _delStudent(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const sessionId = _seg(req.url, -1);
  await _ddb.deleteStudent(sessionId);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_student', target: sessionId });
  _json(res, 200, { ok: true });
}

async function _resetAssessment(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  await _ddb.resetStudentAssessment(sessionId);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'reset_assessment', target: sessionId });
  _json(res, 200, { ok: true });
}

async function _importStudents(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const body = await _readBody(req, IMPORT_MAX_BYTES);
  let rows = (body && Array.isArray(body.rows)) ? body.rows : [];
  if (!rows.length) return _json(res, 400, { error: 'rows array required' });
  if (rows.length > IMPORT_MAX_ROWS) return _json(res, 400, { error: `A roster can have at most ${IMPORT_MAX_ROWS} students. Split the file and upload each part.` });

  // Scope guard: management may only import rows for their assigned school(s).
  // Filtered here (not per-row inside the transaction) so the rejection count
  // is visible to the caller via the existing skipped counter.
  let scopeRejected = 0;
  if (user.role !== 'admin') {
    const assigned = await _userSchools(user);
    const before = rows.length;
    const kept = [];
    for (const r of rows) {
      // Match tolerantly, then rewrite the row's school to the assigned
      // spelling: "ABPS" in a roster for a user assigned "ABPS,BAGA" is
      // accepted and stored as "ABPS,BAGA", so the students land under the
      // name the user (and their counsellors) are scoped to.
      const hit = assigned.find(a => _schoolKey(a) === _schoolKey(r.school))
               || assigned.find(a => require('./match-utils.js').schoolMatches(r.school, a));
      if (hit) kept.push(Object.assign({}, r, { school: hit }));
    }
    rows = kept;
    scopeRejected = before - rows.length;
    if (!rows.length) {
      return _json(res, 403, { error: 'None of the rows match your assigned school(s).' });
    }
  }

  let imported = 0, updated = 0, skipped = 0, errors = [], warnings = [];
  try {
    const doImport = await _ddb.runImportTransaction(rows.slice(0, IMPORT_MAX_ROWS));
    imported = doImport.imported;
    updated  = doImport.updated || 0;
    skipped  = doImport.skipped;
    errors   = doImport.errors   || [];
    warnings = doImport.warnings || [];
  } catch (e) {
    process.stderr.write('[ERROR] [import_students] ' + e.message + '\n');
    return _json(res, 500, { error: 'Import failed: ' + e.message });
  }

  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'import_students',
                  detail: `imported=${imported} updated=${updated} skipped=${skipped} scopeRejected=${scopeRejected}` });
  // errors carry the row number and reason for each skip so the UI can tell the
  // user WHICH rows failed and why, instead of only a count.
  _json(res, 200, { ok: true, imported, updated, skipped, scopeRejected, errors, warnings });
}

/* ══════════════════════════════════════════════════════════════════
   PER-STUDENT DETAIL
══════════════════════════════════════════════════════════════════ */
async function _studentReminders(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const stu = await _ddb.getStudentBySessionId(_seg(req.url, -2));
  if (!stu) return _json(res, 404, { error: 'Student not found' });
  // IDOR guard: verify this student belongs to the requesting user's schools
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(_schoolKey);
    if (!schools.includes(_schoolKey(stu.school))) {
      return _json(res, 403, { error: 'Forbidden' });
    }
  }
  _json(res, 200, { log: await _ddb.getReminderLog({ studentEmail: stu.email, limit: 50 }) });
}

async function _getNotes(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to the requesting user's schools
  const stu = await _ddb.getStudentBySessionId(sessionId);
  if (!stu) return _json(res, 404, { error: 'Student not found' });
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(_schoolKey);
    if (!schools.includes(_schoolKey(stu.school))) {
      return _json(res, 403, { error: 'Forbidden' });
    }
  }
  _json(res, 200, {
    notes: await _ddb.getStudentNotes(sessionId),
    tags:  await _ddb.getStudentTags(sessionId),
  });
}

async function _addNote(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: the student must be inside the user's schools and class limits.
  if (!(await _studentInScope(user, sessionId))) return _json(res, 403, { error: 'That student is not in your schools.' });
  const body = await _readBody(req, 8 * 1024);
  const { note } = body || {};
  if (!note || !String(note).trim()) return _json(res, 400, { error: 'note required' });
  const id = await _ddb.addStudentNote({ sessionId, authorId: user.id, note: String(note).trim() });
  _json(res, 201, { ok: true, id });
}

async function _delNote(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const parts  = req.url.split('/');
  const noteId = parseInt(parts[parts.length - 1], 10);
  if (!noteId) return _json(res, 400, { error: 'Invalid note id' });
  await _ddb.deleteStudentNote(noteId, user.id);
  _json(res, 200, { ok: true });
}

async function _setTags(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to requesting user's schools
  if (user.role !== 'admin') {
    const _stu = await _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = (await _userSchools(user)).map(_schoolKey);
    if (!_schools.includes(_schoolKey(_stu.school))) return _json(res, 403, { error: 'Forbidden' });
  }
  const body = await _readBody(req, 4 * 1024);
  await _ddb.setStudentTags(sessionId, Array.isArray((body||{}).tags) ? body.tags : [], user.id);
  _json(res, 200, { ok: true });
}

/* Staff support path: clear a student's AI-counsellor PIN so they can go
   through first-time setup again. School-scoped; revokes active sessions. */
// Issue or re-issue a student's access code. Same scope guard as reset-pin:
// management may only touch students in their assigned school(s).
async function _regenAccessCode(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  if (!(await _studentInScope(user, sessionId))) return _json(res, 403, { error: 'That student is not in your schools.' });
  try {
    const code = await _ddb.setStudentAccessCode(sessionId);
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'regen_access_code', target: sessionId });
    _json(res, 200, { ok: true, access_code: code });
  } catch (e) {
    process.stderr.write('[ERROR] [access-code] ' + e.message + '\n');
    _json(res, 500, { error: 'Server error' });
  }
}

async function _resetStudentPin(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // Same scope rule as every other student action (schools, then class/section limits).
  const stu = await _studentInScope(user, sessionId);
  if (!stu) return _json(res, 404, { error: 'Student not found in your schools.' });
  if (!stu.email) return _json(res, 400, { error: 'Student has no email on record.' });
  try {
    const cleared = await _cdb.clearStudentPin(stu.email);
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'reset_student_pin', target: sessionId });
    _json(res, 200, { ok: true, cleared,
      message: cleared ? 'PIN cleared. The student will set a new PIN on next login.'
                       : 'No PIN was set for this student.' });
  } catch (e) {
    process.stderr.write('[ERROR] [reset-pin] ' + e.message + '\n');
    _json(res, 500, { error: 'Server error' });
  }
}

/* ══════════════════════════════════════════════════════════════════
   AI-COUNSELLOR INSIGHTS — what the student is asking Aria
   Scoped like _studentReport. Read-only over the student's own chats;
   surfaces top questions + themes + summaries so staff can understand
   what a student is going through.
══════════════════════════════════════════════════════════════════ */
async function _studentInsights(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management', 'counsellor');
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  const stu = await _ddb.getStudentBySessionId(sessionId);
  if (!stu) return _json(res, 404, { error: 'Student not found' });
  // IDOR guard: non-admins may only inspect students in their assigned schools
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(_schoolKey);
    if (!schools.includes(_schoolKey(stu.school))) return _json(res, 403, { error: 'Forbidden' });
  }
  // Identity resolution: students imported in bulk (or added by staff without
  // an email) are stored with email = '' and talk to Aria via the access-code
  // login, which keys their chat_history rows on the synthetic identifier
  // `access:<session_id>`. Falling back to that identifier here is what makes
  // their Aria conversations visible to staff — gating on stu.email alone
  // returned an empty panel for every access-code student.
  const identity = stu.email || _cdb.accessIdentityFor(stu.session_id);
  if (!identity) {
    return _json(res, 200, { insights: { totalQuestions: 0, questions: [], themes: [], summaries: [], lastActivity: null } });
  }
  const insights = await _cdb.getStudentInsights(identity);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'view_insights', target: sessionId });
  _json(res, 200, { insights });
}

/* ══════════════════════════════════════════════════════════════════
   GROWTH JOURNEY — cross-class progress for a student
   Scoped like _studentReport. Reuses db.js getJourney via counsellor-db.
══════════════════════════════════════════════════════════════════ */
async function _studentJourney(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management', 'counsellor');
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  const stu = await _studentInScope(user, sessionId);
  if (!stu) return _json(res, 404, { error: 'Student not found in your schools.' });
  // The identity this student's own snapshot is filed under (email, an
  // unambiguous school + name match, or their own after an unlink).
  const identity = await _core.journeyIdentityFor(sessionId, stu);
  if (!identity) {
    return _json(res, 200, { journey: { attempts: [], deltas: [], has_journey: false } });
  }
  const journey = await _core.getJourney(identity);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'view_journey', target: sessionId });
  _json(res, 200, { journey });
}

async function _studentReport(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to requesting user's schools
  if (user.role !== 'admin') {
    const _stu = await _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = (await _userSchools(user)).map(_schoolKey);
    if (!_schools.includes(_schoolKey(_stu.school))) return _json(res, 403, { error: 'Forbidden' });
  }
  // Look up by session_id directly — email indirection broke on duplicate
  // or whitespace-padded emails and 404'd on students without reports.
  let report = null;
  try { report = await _cdb.getReportBySessionId(sessionId); } catch (_) {}
  if (!report) return _json(res, 404, { error: 'Student not found' });
  // No report yet (registered / in progress): 200 with has_report:false so
  // the drawer can show the student's profile instead of a raw error.
  const hasReport = !!(report.report && (report.report.fit_tier != null || report.report.generated_at));
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'view_report', target: sessionId });
  _json(res, 200, { report, has_report: hasReport });
}

/* PDF-ready data for the same renderer the student uses (download.js). Same
   role check + school-scoping IDOR guard as _studentReport. */
async function _studentReportPdfData(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  if (user.role !== 'admin') {
    const _stu = await _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = (await _userSchools(user)).map(_schoolKey);
    if (!_schools.includes(_schoolKey(_stu.school))) return _json(res, 403, { error: 'Forbidden' });
  }
  let data = null;
  try { data = await _ddb.getReportPdfData(sessionId); } catch (_) {}
  if (!data) return _json(res, 404, { error: 'No report available for this student yet.' });
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'download_report', target: sessionId });
  _json(res, 200, { ok: true, data });
}

/* ══════════════════════════════════════════════════════════════════
   SCHOOLS REGISTRY (admin only)
══════════════════════════════════════════════════════════════════ */
async function _listSchoolsReg(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  _json(res, 200, { schools: await _ddb.listRegisteredSchools() });
}

async function _upsertSchoolReg(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const body = await _readBody(req, 4 * 1024);
  const { id, name, city, state, active } = body || {};
  if (!name && !id) return _json(res, 400, { error: 'name required' });
  const newId = await _ddb.upsertRegisteredSchool({ id, name, city, state, active });
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: id ? 'update_school' : 'create_school', target: name });
  _json(res, 200, { ok: true, id: newId });
}

async function _delSchoolReg(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const id = _idParam(req);
  if (!id) return _json(res, 400, { error: 'Invalid id' });
  await _ddb.deleteRegisteredSchool(id);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_school', target: String(id) });
  _json(res, 200, { ok: true });
}

/* ══════════════════════════════════════════════════════════════════
   PROGRAMME ANALYTICS ROUTES
   Every list a dashboard can open comes from /drill with the same
   dimension + group keys that /breakdown counted, so a number and the
   students behind it can never disagree.
══════════════════════════════════════════════════════════════════ */
function _err(res, e, tag) {
  // Errors raised deliberately by our own code carry an HTTP status and a
  // message written for staff (e.g. "AI is not configured"); pass those on.
  if (e && Number.isInteger(e.status)) return _json(res, e.status, { error: e.message });
  process.stderr.write('[ERROR] [' + tag + '] ' + (e && e.stack || e) + '\n');
  _json(res, 500, { error: 'Server error' });
}

async function _catalogue(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const schools = await _userSchools(user);
    const dims = await _ddb.getDimensions();
    _json(res, 200, {
      dimensions: Object.entries(dims).map(([id, d]) => ({ id, label: d.label, question: d.question, multi: !!d.multi, population: d.population })),
      glossary: await _ddb.getGlossary(),
      settings_schema: _ddb.SETTINGS_SCHEMA,
      insight_metrics: _assistant.metricCatalogue(),
      ai_enabled: _assistant.aiEnabled(),
      schools,
      can_edit_settings: user.role !== 'counsellor',
      // Shared bands so every page colours levels and fit scores the same way.
      bands: { fit_tiers: _core.FIT_TIERS, stanine: _core.STANINE_BANDS },
      wellbeing_areas: _ddb.WELLBEING_AREAS,
      parameters: _ddb.PARAMETERS,
      seaa_concerns: _ddb.SEAA_CONCERNS,
      seaa_levels: _ddb.SEAA_LEVELS,
      // Limits the page applies itself, from the same constants the server enforces.
      limits: { small_school_students: _ddb.SMALL_SCHOOL_MAX_STUDENTS, insight_metrics: _assistant.MAX_INSIGHT_METRICS, import_bytes: IMPORT_MAX_BYTES, import_rows: IMPORT_MAX_ROWS },
    });
  } catch (e) { _err(res, e, 'catalogue'); }
}

async function _classes(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const schools = await _scopedSchools(user, res, _qs(req).get('school'));
    if (!schools) return;
    _json(res, 200, { classes: await _ddb.listClasses(schools) });
  } catch (e) { _err(res, e, 'classes'); }
}

async function _breakdown(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const qs = _qs(req);
    const sc = await _scopeQ(user, res, qs);
    if (!sc) return;
    _json(res, 200, await _ddb.getBreakdown(sc.schools, qs.get('dimension') || 'completion', { predicate: sc.predicate }));
  } catch (e) { _err(res, e, 'breakdown'); }
}

/* Pace and momentum for Insights (dashboard-db getPulse). */
async function _pulse(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const sc = await _scopeQ(user, res, _qs(req));
    if (!sc) return;
    _json(res, 200, await _ddb.getPulse(sc.schools, { predicate: sc.predicate }));
  } catch (e) { _err(res, e, 'pulse'); }
}

async function _drill(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const qs = _qs(req);
    const sc = await _scopeQ(user, res, qs);
    if (!sc) return;
    const status = qs.get('status');
    const out = await _ddb.getDrillStudents(sc.schools, {
      dimension: qs.get('dimension') || null,
      groups: (qs.get('groups') || qs.get('group') || '').split(',').map(x => x.trim()).filter(Boolean),
      classKey: qs.get('class') || null,
      status: ['completed', 'in_progress', 'not_started'].includes(status) ? status : null,
      search: qs.get('search') || '',
      limit: qs.get('limit'), offset: qs.get('offset'),
      idsOnly: qs.get('ids_only') === '1',
      predicate: sc.predicate,
    });
    _json(res, 200, out);
  } catch (e) { _err(res, e, 'drill'); }
}

async function _alerts(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const sc = await _scopeQ(user, res, _qs(req));
    if (!sc) return;
    _json(res, 200, await _ddb.getAlerts(sc.schools, { predicate: sc.predicate }));
  } catch (e) { _err(res, e, 'alerts'); }
}

async function _schoolSummary(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const sc = await _scopeQ(user, res, _qs(req));
    if (!sc) return;
    _json(res, 200, { schools: await _ddb.getSchoolSummary(sc.schools, { predicate: sc.predicate }), groups: await _ddb.getFollowUpGroups() });
  } catch (e) { _err(res, e, 'school-summary'); }
}

/* Schools → branches with progress, and the academic years on record, for
   the drill-down dashboard. Scoped like every other analytics route. */
async function _flow(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const qs = _qs(req);
    const schools = await _scopedSchools(user, res, qs.get('school'));
    if (!schools) return;
    const year = _yearParam(qs);
    if (year === undefined) return _json(res, 400, { error: 'year must be a four-digit academic start year, e.g. 2026.' });
    _json(res, 200, await _ddb.getFlowStructure(schools, { predicate: _predicateFor(user), year }));
  } catch (e) { _err(res, e, 'flow'); }
}

const MERGE_MAX_NAMES = 500;
/* Every school name on record, with students and group (admin only). */
async function _schoolNamesGet(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  try { _json(res, 200, await _ddb.listSchoolNames()); }
  catch (e) { _err(res, e, 'school-names'); }
}
/* Merge school names into one school (permanent; see dashboard-db mergeSchools). */
async function _schoolsMerge(req, res) {
  const user = await _requireRole(req, res, 'admin');
  if (!user) return;
  const b = await _readBody(req, 64 * 1024);           // size/JSON errors answered by the dispatcher
  if (!b || !Array.isArray(b.names) || !b.names.length || b.names.length > MERGE_MAX_NAMES) {
    return _json(res, 400, { error: `Tick between 1 and ${MERGE_MAX_NAMES} school names.` });
  }
  try {
    const r = await _ddb.mergeSchools({ names: b.names.map(String), school: b.school, group: b.group, userId: user.id });
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'merge_schools', target: r.school,
      detail: `Merged ${b.names.slice(0, 50).map(String).map(x => x.slice(0, 120)).join(', ')} into ${r.school}`
        + `${r.group ? ` (part of ${r.group})` : ''}; ${r.students_moved} student record(s) changed` });
    _json(res, 200, Object.assign({ ok: true }, r));
  } catch (e) { _err(res, e, 'merge-schools'); }
}

async function _ariaThemes(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const qs = _qs(req);
    const schools = await _scopedSchools(user, res, qs.get('school'));
    if (!schools) return;
    _json(res, 200, await _ddb.getAriaThemes(schools, { classKey: qs.get('class') || null, predicate: _predicateFor(user) }));
  } catch (e) { _err(res, e, 'aria-themes'); }
}

async function _getSettings(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const schools = await _scopedSchools(user, res, _qs(req).get('school'));
    if (!schools) return;
    const m = await _ddb.getSettingsMap(schools);
    _json(res, 200, {
      schema: _ddb.SETTINGS_SCHEMA, global: m.global,
      schools: schools.map(s => ({ school: s, settings: m.forSchool(s) })),
      can_edit: user.role !== 'counsellor',
    });
  } catch (e) { _err(res, e, 'settings'); }
}

async function _putSettings(req, res) {
  const user = await _requireRole(req, res, 'management', 'admin');
  if (!user) return;
  try {
    const body = await _readBody(req, 4 * 1024);
    const school = String((body && body.school) || '').trim();
    if (!school && user.role !== 'admin') return _json(res, 403, { error: 'Choose one of your schools; only an admin can change the network-wide default.' });
    if (school && !(await _scopedSchools(user, res, school))) return;
    // A setting for a school name that does not exist would silently apply to nothing.
    if (school && user.role === 'admin') {
      const known = (await _ddb.getAllSchools()).map(r => _schoolKey(r.school));
      if (!known.includes(_schoolKey(school))) return _json(res, 400, { error: 'No students are registered under that school name.' });
    }
    const saved = await _ddb.saveSettings({ school: school || null, values: (body && body.values) || {}, userId: user.id });
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'update_settings',
                          target: school || 'network-wide', detail: JSON.stringify(saved) });
    _json(res, 200, { ok: true, saved });
  } catch (e) { _err(res, e, 'settings-put'); }
}

/* ── AI Programme Intelligence ─────────────────────────────────────── */
async function _insights(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const body = await _readBody(req, 8 * 1024);
    const school = String((body && body.school) || '').trim();
    const schools = await _scopedSchools(user, res, school);
    if (!schools) return;
    const force = !!(body && body.force);
    const mode = body && body.mode === 'cached' ? 'cached' : null;
    // Only requests that may call the model count against the limits.
    if (!mode && _rl && !(await _rl('insights', String(user.id), LIMITS.insights))) {
      return _json(res, 429, { error: 'You have run the AI analysis many times this hour. Please try again later.' });
    }
    if (force && _rl && !(await _rl('insights-regen', String(user.id), LIMITS.insightsRegen))) {
      return _json(res, 429, { error: 'You have regenerated insights many times this hour. Press "Analyse" instead — it gives a fresh analysis whenever the numbers have changed.' });
    }
    const out = await _assistant.generateInsights({
      user, schools, predicate: _predicateFor(user),
      schoolLabel: school || (schools.length === 1 ? schools[0] : schools.length + ' schools'),
      metricIds: Array.isArray(body && body.metrics) ? body.metrics.map(String) : null, force, mode,
    });
    _json(res, 200, { insights: out });
  } catch (e) { _err(res, e, 'insights'); }
}

/* ── Dashboard assistant ───────────────────────────────────────────── */
async function _assistantChat(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    if (_rl && !(await _rl('assistant', String(user.id), LIMITS.assistant))) {
      return _json(res, 429, { error: 'You have reached the hourly limit for the assistant. Please try again later.' });
    }
    const body = await _readBody(req, 16 * 1024);
    const out = await _assistant.chat({
      user, conversationId: body && body.conversation_id, message: body && body.message, page: body && body.page,
      env: {
        user,
        predicate: _predicateFor(user),
        resolveSchools: (school) => _userSchools(user, school || ''),
        canSeeStudent: async (sid) => !!(await _studentInScope(user, sid)),
      },
    });
    _json(res, 200, out);
  } catch (e) { _err(res, e, 'assistant'); }
}

/* The page records what a confirmed action did, so the assistant knows on the
   next turn ("Added 1 student to Class 9"). Stored redacted like every turn. */
async function _assistantNote(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const b = (await _readBody(req, 4 * 1024)) || {};
    await _assistant.recordActionResult({ user, conversationId: b.conversation_id, text: b.text, resolveSchools: (sc) => _userSchools(user, sc || ''), predicate: _predicateFor(user) });
    _json(res, 200, { ok: true });
  } catch (e) { _err(res, e, 'assistant-note'); }
}

async function _assistantList(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  _json(res, 200, { conversations: await _assistant.listConversations(user.id) });
}

async function _assistantHistory(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const id = _qs(req).get('conversation_id') || '';
  if (!/^[a-f0-9]{16,40}$/.test(id)) return _json(res, 400, { error: 'conversation_id required' });
  _json(res, 200, { messages: await _assistant.getConversation(user.id, id) });
}

async function _assistantDelete(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  await _assistant.deleteConversation(user.id, _seg(req.url, -1));
  _json(res, 200, { ok: true });
}

/* One student's roster row with status and progress, for opening a profile
   from anywhere (a drill list, an alert, the assistant) — the drawer used to
   rely on the currently loaded page of the student list and showed a student
   from any other list as "not started". */
async function _studentBasic(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const stu = await _studentInScope(user, _seg(req.url, -1));
  if (!stu) return _json(res, 404, { error: 'Student not found in your schools.' });
  const g = _ddb.classGroupOf(stu.class);
  _json(res, 200, { student: Object.assign({}, stu, { class_key: g.key, class_label: g.label }) });
}

/* ── Bulk PDF data (the browser renders + zips) ────────────────────── */
const PDF_BATCH_MAX = 25;
async function _reportPdfBatch(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const body = await _readBody(req, 64 * 1024);
    const ids = [...new Set((Array.isArray(body && body.session_ids) ? body.session_ids : []).map(String))];
    if (!ids.length) return _json(res, 400, { error: 'session_ids required' });
    if (ids.length > PDF_BATCH_MAX) return _json(res, 400, { error: 'At most ' + PDF_BATCH_MAX + ' students per request.' });
    const allowed = [];
    for (const sid of ids) if (await _studentInScope(user, sid)) allowed.push(sid);
    const items = await _ddb.getReportPdfDataBatch(allowed);
    for (const sid of ids) if (!allowed.includes(sid)) items.push({ session_id: sid, data: null, error: 'Not in your schools' });
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'download_report_batch',
                          detail: `requested=${ids.length} served=${items.filter(i => i.data).length}` });
    _json(res, 200, { ok: true, items, max: PDF_BATCH_MAX });
  } catch (e) { _err(res, e, 'report-pdf-batch'); }
}

async function _journeyUnlink(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management', 'counsellor');
  if (!user) return;
  const sessionId = _seg(req.url, -3);
  if (!(await _studentInScope(user, sessionId))) return _json(res, 403, { error: 'Forbidden' });
  const n = await _core.unlinkJourneyAttempt(sessionId);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'unlink_journey', target: sessionId });
  _json(res, 200, { ok: true, unlinked: n });
}

/* ══════════════════════════════════════════════════════════════════
   UTILITY
══════════════════════════════════════════════════════════════════ */
function _seg(url, idx) {
  const segs = url.split('?')[0].split('/').filter(Boolean);
  return idx < 0 ? segs[segs.length + idx] : segs[idx];
}


/* ══════════════════════════════════════════════════════════════════
   PUBLIC (UNAUTHENTICATED) ACCESS-CODE ENDPOINTS
   Used by the student entry screen. These are the only dashboard-module
   handlers that do NOT require a staff session, so they are deliberately
   conservative: IP rate limiting, no enumeration of codes, and a single
   generic failure message that never reveals which field was wrong.
══════════════════════════════════════════════════════════════════ */

function _publicIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Names for the school+class picker. Rate limited because it is a roster read.
/* Schools that have at least one code-holding student. Public, like the
   names/classes lookups — it exposes only school names, which are already
   printed on the access-code slips handed to students, and it is what makes
   the entry form's school suggestions reflect reality instead of a hardcoded
   list of well-known schools. */
async function handleAccessSchools(req, res) {
  const qs = new URLSearchParams((req.url.split('?')[1]) || '');
  const q  = qs.get('q') || '';
  if (_rl && !(await _rl('access-schools', _publicIP(req), LIMITS.accessSchools))) {
    return _json(res, 429, { error: 'Too many requests. Please wait a moment.' });
  }
  try {
    const schools = await _ddb.listAccessSchools(q);
    _json(res, 200, { schools });
  } catch (e) {
    process.stderr.write('[ERROR] [access-schools] ' + e.message + '\n');
    _json(res, 500, { error: 'Server error' });
  }
}

async function handleAccessNames(req, res) {
  const qs = new URLSearchParams((req.url.split('?')[1]) || '');
  const school = qs.get('school') || '';
  const klass  = qs.get('class')  || '';
  if (!school) return _json(res, 400, { error: 'school is required' });
  /* A lookup, not a login attempt: every student triggers a few of these while
     filling the form, so the ceiling has to scale with a whole class on one IP
     (60/hour exhausted after roughly fifteen students). */
  if (_rl && !(await _rl('access-names', _publicIP(req), LIMITS.accessNames))) {
    return _json(res, 429, { error: 'Too many requests. Please wait a moment.' });
  }
  try {
    if (!klass) {
      // No class yet: return the school's actual class list so the entry form
      // can populate its dropdown. Imported classes are free text ("10-B"),
      // so a hardcoded Grade 9-12 list can never match them.
      const rows = await _ddb.listAccessClasses(school);
      return _json(res, 200, { classes: rows.map(r => r.class).filter(Boolean) });
    }
    const rows = await _ddb.listAccessNames(school, klass);
    _json(res, 200, { names: rows.map(r => r.full_name).filter(Boolean) });
  } catch (e) {
    process.stderr.write('[ERROR] [access-names] ' + e.message + '\n');
    _json(res, 500, { error: 'Server error' });
  }
}

// Redeem a code. On success returns the student profile so the client can
// resume straight into the assessment without re-registering.
async function handleAccessRedeem(req, res) {
  let body;
  try { body = await _readBody(req, 8 * 1024); }
  catch { return _json(res, 400, { error: 'Bad request' }); }

  const school = String((body && body.school) || '').trim();
  const klass  = String((body && body.class)  || '').trim();
  const name   = String((body && body.name)   || '').trim();
  const uid    = String((body && body.uid)    || '').trim();
  const code   = String((body && body.code)   || '').trim();
  // Two ways in: school + class + name + code, or school + Unique School ID + code.
  if (!school || !code || (!uid && (!klass || !name))) {
    return _json(res, 400, { error: uid || !(klass || name)
      ? 'School, Unique School ID and access code are all required.'
      : 'School, class, name and access code are all required.' });
  }
  /* Brute-force throttle, keyed per STUDENT rather than per IP.

     This was keyed on the public IP alone with a limit of 8 per hour. A school
     computer lab NATs every student to a single public address, so the ninth
     student of the day to start the assessment was told "Too many attempts"
     with perfectly correct details — the entire class was sharing one budget.
     The original comment ("generous for a mistyped code") was reasoning about
     one person retyping, not forty people on one router.

     Keying on IP + the student's name gives each student their own budget, so
     a lab of any size works, while repeated guesses against any ONE student
     from the same network are still capped. Combined with the 30^8 code
     keyspace that keeps guessing infeasible.

     A deliberately high pure-IP ceiling stays as a backstop against automated
     enumeration; ACCESS_REDEEM_IP_MAX can be raised for very large single-IP
     schools without a code change. */
  const _mu = require('./match-utils.js');
  const _who = uid ? 'uid:' + _mu.normUid(uid) : (_mu.normName(name).replace(/\s+/g, '') || 'anon');
  if (_rl && !(await _rl('access-redeem', _publicIP(req) + '|' + _who, LIMITS.redeemStudent))) {
    return _json(res, 429, { error: 'Too many attempts for this student. Please check the code with your teacher and try again shortly.' });
  }
  if (_rl && !(await _rl('access-redeem-ip', _publicIP(req), LIMITS.redeemNetwork))) {
    return _json(res, 429, { error: 'Too many requests from this network. Please wait a moment.' });
  }
  try {
    const stu = await _ddb.redeemAccessCode({ school, klass, name, uid: uid || null, code });
    if (!stu) {
      // Single generic message — never disclose which field failed.
      return _json(res, 401, { error: 'Those details do not match. Please check with your teacher.' });
    }
    _json(res, 200, { ok: true, student: stu });
  } catch (e) {
    process.stderr.write('[ERROR] [access-redeem] ' + e.message + '\n');
    _json(res, 500, { error: 'Server error' });
  }
}

module.exports = { init, handle, handleAccessNames, handleAccessSchools, handleAccessRedeem };
