/* ════════════════════════════════════════════════════════════════════
   dashboard-api.js  —  NuMind MAPS  |  All /api/dashboard/* routes
   Node.js 18+, CommonJS

   Role hierarchy:
     admin       — full access: all routes, all schools, user management
     management  — read: schools they oversee + reminder log; no user CRUD
     counsellor  — scoped: their school only; notes/tags/reminders; no /schools

   Email:
     _sendEmail is wired up in server.js via init(db, sendEmailFn).
     Both _sendReminder and _testEmail guard with if (!_sendEmail) → 503
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
let _sendEmail = null;
let _dbWrite   = fn => Promise.resolve(fn()); // default: sync fallback

function init(db, sendEmailFn, dbWriteFn) {
  _ddb.init(db);
  _cdb.init(db);
  _sendEmail = typeof sendEmailFn === 'function' ? sendEmailFn : null;
  if (typeof dbWriteFn === 'function') _dbWrite = dbWriteFn;
  // Purge stale sessions + reset tokens every hour — routed through write queue
  setInterval(() => {
    _dbWrite(() => _ddb.purgeExpiredSessions()).catch(e => {
      // Non-fatal — log but never crash
      if (e && !e.message.includes('database is locked')) {
        process.stderr.write('[WARN]  [Dashboard] purgeExpiredSessions: ' + e.message + '\n');
      }
    });
  }, 60 * 60 * 1000).unref();
}

/* ══════════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════════ */
function _readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); return reject(new Error('body_too_large')); }
      chunks.push(c);
    });
    req.on('end', () => {
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

function _auth(req) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? _ddb.verifyToken(token) : null;
}

function _requireRole(req, res, ...roles) {
  const user = _auth(req);
  if (!user) { _json(res, 401, { error: 'Unauthorized' }); return null; }
  if (roles.length && !roles.includes(user.role)) { _json(res, 403, { error: 'Forbidden' }); return null; }
  return user;
}

/* Derive scoped school list for the requesting user */
function _userSchools(user, overrideSchool = '') {
  if (user.role === 'admin') {
    return overrideSchool ? [overrideSchool] : _ddb.getAllSchools().map(r => r.school);
  }
  return user.schools;
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

    // ── Student data ─────────────────────────────────────────────
    if (method === 'GET'  && url === '/api/dashboard/students')        return _students(req, res);
    if (method === 'GET'  && url === '/api/dashboard/stats')           return _stats(req, res);
    if (method === 'GET'  && url === '/api/dashboard/trend')           return _trend(req, res);
    if (method === 'GET'  && url === '/api/dashboard/students/export') return _exportStudentsCsv(req, res);
    if (method === 'POST' && url === '/api/dashboard/send-reminder')   return await _sendReminder(req, res);
    if (method === 'POST' && url === '/api/dashboard/test-email')      return await _testEmail(req, res);

    // ── Student CRUD ─────────────────────────────────────────────
    if (method === 'POST'   && url === '/api/dashboard/students')                        return await _createStudent(req, res);
    if (method === 'POST'   && url === '/api/dashboard/students/import')                 return await _importStudents(req, res);
    if (method === 'PUT'    && url.match(/^\/api\/dashboard\/students\/[^/]+$/))         return await _updateStudent(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/students\/[^/]+$/))         return _delStudent(req, res);
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/reset$/))  return _resetAssessment(req, res);

    // ── Per-student detail ───────────────────────────────────────
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/reminders$/)) return _studentReminders(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes$/))     return _getNotes(req, res);
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes$/))     return await _addNote(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes\/[^/]+$/)) return _delNote(req, res);
    if (method === 'PUT'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/tags$/))      return await _setTags(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/report$/))    return _studentReport(req, res);

    // ── Schools + reminder log (management | admin) ──────────────
    if (method === 'GET' && url === '/api/dashboard/schools')      return _schools(req, res);
    if (method === 'GET' && url === '/api/dashboard/reminder-log') return _reminderLog(req, res);

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
    console.error('[Dashboard API]', err.message, err.stack);
    if (err.message === 'body_too_large') return _json(res, 413, { error: 'Payload too large' });
    if (err.message === 'invalid_json')   return _json(res, 400, { error: 'Invalid JSON' });
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
  const result = _ddb.login(email, password);
  if (!result) return _json(res, 401, { error: 'Invalid email or password' });
  _json(res, 200, result);
}

async function _logout(req, res) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) _ddb.logout(token);
  _json(res, 200, { ok: true });
}

function _me(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  _json(res, 200, { user });
}

async function _forgotPassword(req, res) {
  const body = await _readBody(req, 4 * 1024);
  const { email } = body || {};
  if (!email) return _json(res, 400, { error: 'email required' });
  const u = _ddb.getUserByEmail(email);
  if (!u) return _json(res, 200, { ok: true }); // anti-enumeration
  const token = _ddb.createPasswordResetToken(u.id);
  if (_sendEmail) {
    try {
      _sendEmail({
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
    } catch (e) { console.error('[Dashboard] forgot-password email error:', e.message); }
  }
  _json(res, 200, { ok: true, token }); // token returned so admin can relay if email not set
}

async function _resetPassword(req, res) {
  const body = await _readBody(req, 4 * 1024);
  const { token, password } = body || {};
  if (!token || !password) return _json(res, 400, { error: 'token and password required' });
  if (String(password).length < 6) return _json(res, 400, { error: 'Password must be at least 6 characters' });
  const ok = _ddb.consumePasswordResetToken(token, password);
  if (!ok) return _json(res, 400, { error: 'Token invalid or expired' });
  _json(res, 200, { ok: true });
}

async function _changePassword(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const body = await _readBody(req, 4 * 1024);
  const { current_password, new_password } = body || {};
  if (!current_password || !new_password) return _json(res, 400, { error: 'current_password and new_password required' });
  if (String(new_password).length < 6) return _json(res, 400, { error: 'Password must be at least 6 characters' });
  const check = _ddb.login(user.email, current_password);
  if (!check) return _json(res, 401, { error: 'Current password is incorrect' });
  _ddb.updateUser({ id: user.id, password: new_password });
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'change_password' });
  _json(res, 200, { ok: true });
}

/* ══════════════════════════════════════════════════════════════════
   AGGREGATE ANALYTICS
══════════════════════════════════════════════════════════════════ */
function _aggregateScores(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  try {
    const agg = _ddb.getAggregateScores(_userSchools(user));
    _json(res, 200, { aggregates: agg });
  } catch (e) { console.error('[aggregate-scores]', e.message); _json(res, 500, { error: 'Server error' }); }
}

function _wellbeingAlerts(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  try {
    const alerts = _ddb.getWellbeingAlerts(_userSchools(user));
    _json(res, 200, { alerts });
  } catch (e) { console.error('[wellbeing-alerts]', e.message); _json(res, 500, { error: 'Server error' }); }
}

function _careerDistribution(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  try {
    const distribution = _ddb.getCareerDistribution(_userSchools(user));
    _json(res, 200, { distribution });
  } catch (e) { console.error('[career-distribution]', e.message); _json(res, 500, { error: 'Server error' }); }
}

function _moduleTiming(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  try {
    const timing = _ddb.getModuleTiming(_userSchools(user));
    _json(res, 200, { timing });
  } catch (e) { console.error('[module-timing]', e.message); _json(res, 500, { error: 'Server error' }); }
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT DATA
══════════════════════════════════════════════════════════════════ */
function _students(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const qs      = new URLSearchParams(req.url.split('?')[1] || '');
  const cls     = qs.get('class')   || '';
  const section = qs.get('section') || '';
  const search  = qs.get('search')  || '';
  const school  = qs.get('school')  || '';
  const offset  = parseInt(qs.get('offset') || '0', 10);
  const limit   = Math.min(parseInt(qs.get('limit') || '100', 10), 2000);

  let schools = _userSchools(user, school);

  // Fine-grained permission scoping
  const p = user.permissions || {};
  if (user.role !== 'admin') {
    if (p.studentScope === 'class' && Array.isArray(p.allowedClasses) && p.allowedClasses.length) {
      if (cls && !p.allowedClasses.includes(cls)) return _json(res, 200, { students: [], count: 0 });
      if (!cls) {
        const rows = [];
        for (const ac of p.allowedClasses)
          rows.push(..._ddb.getStudentsBySchool(schools, { class: ac, section, search, limit, offset }));
        return _json(res, 200, { students: rows, count: rows.length });
      }
    }
    if (p.studentScope === 'section' && Array.isArray(p.allowedSections) && p.allowedSections.length) {
      if (section && !p.allowedSections.includes(section)) return _json(res, 200, { students: [], count: 0 });
      if (!section) {
        const rows = [];
        for (const as of p.allowedSections)
          rows.push(..._ddb.getStudentsBySchool(schools, { class: cls, section: as, search, limit, offset }));
        return _json(res, 200, { students: rows, count: rows.length });
      }
    }
  }

  const students = _ddb.getStudentsBySchool(schools, { class: cls, section, search, limit, offset });
  _json(res, 200, { students, count: students.length });
}

function _stats(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const qs     = new URLSearchParams(req.url.split('?')[1] || '');
  const school = qs.get('school') || '';
  const stats  = _ddb.countStudentsBySchool(_userSchools(user, school));
  _json(res, 200, { stats });
}

function _trend(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const qs   = new URLSearchParams(req.url.split('?')[1] || '');
  const days = Math.min(parseInt(qs.get('days') || '14', 10), 90);
  const trend = _ddb.getCompletionTrend(_userSchools(user, qs.get('school') || ''), days);
  _json(res, 200, { trend });
}

function _schools(req, res) {
  const user = _requireRole(req, res, 'management', 'admin');
  if (!user) return;
  const summaries = _ddb.getSchoolSummaries(_userSchools(user));
  _json(res, 200, { schools: summaries });
}

function _exportStudentsCsv(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const qs     = new URLSearchParams(req.url.split('?')[1] || '');
  const school = qs.get('school') || '';
  const cls    = qs.get('class')  || '';
  const status = qs.get('status') || '';
  const all      = _ddb.getStudentsBySchool(_userSchools(user, school), { class: cls, limit: 5000 });
  const filtered = status ? all.filter(s => s.status === status) : all;
  const esc = v => `"${String(v||'').replace(/"/g,'""')}"`;
  const header = ['Name','Email','School','Class','Section','Gender','Age','Status','Modules Done','Registered At','Completed At'];
  const rows = filtered.map(s => [
    esc(s.full_name), esc(s.email), esc(s.school), esc(s.class), esc(s.section),
    esc(s.gender), esc(s.age), esc(s.status), s.modules_done,
    esc(s.registered_at ? s.registered_at.slice(0,10) : ''),
    esc(s.completed_at  ? s.completed_at.slice(0,10)  : ''),
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
async function _sendReminder(req, res) {
  const user = _requireRole(req, res, 'counsellor', 'management', 'admin');
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

  const body = await _readBody(req, 32 * 1024);
  const { students, subject, message } = body || {};
  if (!Array.isArray(students) || !students.length) return _json(res, 400, { error: 'students array required' });
  if (!message) return _json(res, 400, { error: 'message required' });

  const emailSubject = subject || 'Reminder: Complete your NuMind MAPS Assessment';
  let sent = 0, failed = 0;

  for (const st of students) {
    if (!st.email) { failed++; continue; }
    try {
      _sendEmail({
        to:      st.email,
        subject: emailSubject,
        text: [
          `Dear ${st.full_name || st.firstName || 'Student'},`,
          '',
          message,
          '',
          'If you have any questions, please contact your school counsellor.',
          '',
          '— NuMind MAPS Team',
        ].join('\n'),
      });
      _ddb.logReminder({ studentEmail: st.email, sentBy: user.id, subject: emailSubject, message });
      sent++;
    } catch (e) {
      console.error('[Dashboard] reminder error for', st.email, e.message);
      failed++;
    }
  }

  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'send_reminder',
                  detail: `sent=${sent} failed=${failed}` });
  _json(res, 200, { ok: true, sent, failed });
}

async function _testEmail(req, res) {
  const user = _requireRole(req, res, 'counsellor', 'management', 'admin');
  if (!user) return;

  // ── Critical null-check ──
  if (!_sendEmail) {
    return _json(res, 503, {
      error: 'Email is not configured on this server. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your .env file, then restart.',
    });
  }

  const body = await _readBody(req, 4 * 1024);
  const to   = String((body || {}).to || '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return _json(res, 400, { error: 'Valid recipient email required' });
  }

  try {
    _sendEmail({
      to,
      subject: `[NuMind MAPS] Test Email — ${user.role} Dashboard`,
      text: [
        `Hi there,`,
        '',
        `This is a test email from the NuMind MAPS ${user.role} dashboard.`,
        '',
        `Sent by:  ${user.name} (${user.email})`,
        `Role:     ${user.role}`,
        `Time:     ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
        '',
        'If you received this, your SMTP configuration is working correctly. ✅',
        '',
        '— NuMind MAPS System',
      ].join('\n'),
    });
    _json(res, 200, { ok: true, message: `Test email dispatched to ${to}` });
  } catch (e) {
    _json(res, 500, { error: 'Failed to send: ' + e.message });
  }
}

/* ══════════════════════════════════════════════════════════════════
   REMINDER LOG
══════════════════════════════════════════════════════════════════ */
function _reminderLog(req, res) {
  const user = _requireRole(req, res, 'management', 'admin');
  if (!user) return;
  _json(res, 200, { log: _ddb.getReminderLog({ limit: 200 }) });
}

/* ══════════════════════════════════════════════════════════════════
   USER MANAGEMENT (admin only)
══════════════════════════════════════════════════════════════════ */
function _listUsers(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  _json(res, 200, { users: _ddb.listUsers() });
}

async function _createUser(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  const body = await _readBody(req);
  const { name, email, password, role, schools, permissions } = body || {};
  if (!name || !email || !password) return _json(res, 400, { error: 'name, email, password required' });
  if (!['counsellor','management','admin'].includes(role)) {
    return _json(res, 400, { error: 'role must be counsellor | management | admin' });
  }
  try {
    const id = _ddb.createUser({ name, email, password, role, schools: schools || [], permissions: permissions || {} });
    _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'create_user', target: email, detail: `role=${role}` });
    _json(res, 201, { ok: true, id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return _json(res, 409, { error: 'Email already exists' });
    throw e;
  }
}

async function _updateUser(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  if (!id) return _json(res, 400, { error: 'Invalid user id' });
  const body = await _readBody(req);
  if (body.permissions === null || body.permissions === undefined) delete body.permissions;
  _ddb.updateUser({ id, ...body });
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'update_user', target: String(id) });
  _json(res, 200, { ok: true });
}

function _deleteUser(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  if (!id) return _json(res, 400, { error: 'Invalid user id' });
  _ddb.deleteUser(id);
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_user', target: String(id) });
  _json(res, 200, { ok: true });
}

/* ══════════════════════════════════════════════════════════════════
   AUDIT LOG (admin only)
══════════════════════════════════════════════════════════════════ */
function _auditLog(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  _json(res, 200, { log: _ddb.getAuditLog({ limit: 500 }) });
}

/* ══════════════════════════════════════════════════════════════════
   STUDENT CRUD
══════════════════════════════════════════════════════════════════ */
async function _createStudent(req, res) {
  const user = _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const body = await _readBody(req, 16 * 1024);
  const { first_name, last_name, email, class: cls, section, school, age, gender, school_state, school_city } = body || {};
  if (!first_name || !school) return _json(res, 400, { error: 'first_name and school required' });
  const sid = _ddb.upsertStudent({ first_name, last_name, email, class: cls, section, school, age, gender, school_state, school_city });
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'create_student', target: sid,
                  detail: `${first_name} ${last_name||''} @ ${school}` });
  _json(res, 201, { ok: true, session_id: sid });
}

async function _updateStudent(req, res) {
  const user = _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const sessionId = _seg(req.url, -1);
  const body = await _readBody(req, 16 * 1024);
  _ddb.moveStudent(sessionId, body);
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'update_student', target: sessionId });
  _json(res, 200, { ok: true });
}

function _delStudent(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  const sessionId = _seg(req.url, -1);
  _ddb.deleteStudent(sessionId);
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_student', target: sessionId });
  _json(res, 200, { ok: true });
}

function _resetAssessment(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  _ddb.resetStudentAssessment(sessionId);
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'reset_assessment', target: sessionId });
  _json(res, 200, { ok: true });
}

async function _importStudents(req, res) {
  const user = _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const body = await _readBody(req, 2 * 1024 * 1024);
  const rows = (body && Array.isArray(body.rows)) ? body.rows : [];
  if (!rows.length) return _json(res, 400, { error: 'rows array required' });
  let imported = 0, skipped = 0;
  for (const r of rows.slice(0, 2000)) {
    if (!r.first_name && !r.full_name) { skipped++; continue; }
    try {
      const fn = r.first_name || (r.full_name || '').split(' ')[0];
      const ln = r.last_name  || (r.full_name || '').split(' ').slice(1).join(' ');
      _ddb.upsertStudent({
        first_name: fn, last_name: ln,
        email: r.email||'', class: r.class||r.Class||'', section: r.section||r.Section||'',
        school: r.school||r.School||'', age: r.age||'', gender: r.gender||'',
        school_state: r.school_state||'', school_city: r.school_city||'',
      });
      imported++;
    } catch (_) { skipped++; }
  }
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'import_students',
                  detail: `imported=${imported} skipped=${skipped}` });
  _json(res, 200, { ok: true, imported, skipped });
}

/* ══════════════════════════════════════════════════════════════════
   PER-STUDENT DETAIL
══════════════════════════════════════════════════════════════════ */
function _studentReminders(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const stu = _ddb.getStudentBySessionId(_seg(req.url, -2));
  if (!stu) return _json(res, 404, { error: 'Student not found' });
  _json(res, 200, { log: _ddb.getReminderLog({ studentEmail: stu.email, limit: 50 }) });
}

function _getNotes(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to the requesting user's schools
  const stu = _ddb.getStudentBySessionId(sessionId);
  if (!stu) return _json(res, 404, { error: 'Student not found' });
  if (user.role !== 'admin') {
    const schools = _userSchools(user).map(s => s.toLowerCase());
    if (!schools.includes((stu.school || '').toLowerCase())) {
      return _json(res, 403, { error: 'Forbidden' });
    }
  }
  _json(res, 200, {
    notes: _ddb.getStudentNotes(sessionId),
    tags:  _ddb.getStudentTags(sessionId),
  });
}

async function _addNote(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to requesting user's schools
  if (user.role !== 'admin') {
    const _stu = _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = _userSchools(user).map(s => s.toLowerCase());
    if (!_schools.includes((_stu.school || '').toLowerCase())) return _json(res, 403, { error: 'Forbidden' });
  }
  const body = await _readBody(req, 8 * 1024);
  const { note } = body || {};
  if (!note || !String(note).trim()) return _json(res, 400, { error: 'note required' });
  const id = _ddb.addStudentNote({ sessionId, authorId: user.id, note: String(note).trim() });
  _json(res, 201, { ok: true, id });
}

function _delNote(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const parts  = req.url.split('/');
  const noteId = parseInt(parts[parts.length - 1], 10);
  if (!noteId) return _json(res, 400, { error: 'Invalid note id' });
  _ddb.deleteStudentNote(noteId, user.id);
  _json(res, 200, { ok: true });
}

async function _setTags(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to requesting user's schools
  if (user.role !== 'admin') {
    const _stu = _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = _userSchools(user).map(s => s.toLowerCase());
    if (!_schools.includes((_stu.school || '').toLowerCase())) return _json(res, 403, { error: 'Forbidden' });
  }
  const body = await _readBody(req, 4 * 1024);
  _ddb.setStudentTags(sessionId, Array.isArray((body||{}).tags) ? body.tags : [], user.id);
  _json(res, 200, { ok: true });
}

function _studentReport(req, res) {
  const user = _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to requesting user's schools
  if (user.role !== 'admin') {
    const _stu = _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = _userSchools(user).map(s => s.toLowerCase());
    if (!_schools.includes((_stu.school || '').toLowerCase())) return _json(res, 403, { error: 'Forbidden' });
  }
  const stu = _ddb.getStudentBySessionId(sessionId);
  if (!stu)        return _json(res, 404, { error: 'Student not found' });
  if (!stu.email)  return _json(res, 404, { error: 'Student has no email — cannot look up report' });
  let report = null;
  try { report = _cdb.getReportByEmail(stu.email); } catch (_) {}
  if (!report) return _json(res, 404, { error: 'No completed report found for this student' });
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'view_report', target: sessionId });
  _json(res, 200, { report });
}

/* ══════════════════════════════════════════════════════════════════
   SCHOOLS REGISTRY (admin only)
══════════════════════════════════════════════════════════════════ */
function _listSchoolsReg(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  _json(res, 200, { schools: _ddb.listRegisteredSchools() });
}

async function _upsertSchoolReg(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  const body = await _readBody(req, 4 * 1024);
  const { id, name, city, state, active } = body || {};
  if (!name && !id) return _json(res, 400, { error: 'name required' });
  const newId = _ddb.upsertRegisteredSchool({ id, name, city, state, active });
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: id ? 'update_school' : 'create_school', target: name });
  _json(res, 200, { ok: true, id: newId });
}

function _delSchoolReg(req, res) {
  const user = _requireRole(req, res, 'admin');
  if (!user) return;
  const id = parseInt(_seg(req.url, -1), 10);
  if (!id) return _json(res, 400, { error: 'Invalid id' });
  _ddb.deleteRegisteredSchool(id);
  _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_school', target: String(id) });
  _json(res, 200, { ok: true });
}

/* ══════════════════════════════════════════════════════════════════
   UTILITY
══════════════════════════════════════════════════════════════════ */
function _seg(url, idx) {
  const segs = url.split('?')[0].split('/').filter(Boolean);
  return idx < 0 ? segs[segs.length + idx] : segs[idx];
}

module.exports = { init, handle };
