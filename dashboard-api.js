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
    const match = (user.schools || []).find(
      s => String(s).toLowerCase() === String(overrideSchool).toLowerCase()
    );
    return match ? [match] : [];
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
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/reset-pin$/)) return await _resetStudentPin(req, res);

    // ── Per-student detail ───────────────────────────────────────
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/reminders$/)) return _studentReminders(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes$/))     return _getNotes(req, res);
    if (method === 'POST'   && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes$/))     return await _addNote(req, res);
    if (method === 'DELETE' && url.match(/^\/api\/dashboard\/students\/[^/]+\/notes\/[^/]+$/)) return _delNote(req, res);
    if (method === 'PUT'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/tags$/))      return await _setTags(req, res);
    if (method === 'GET'    && url.match(/^\/api\/dashboard\/students\/[^/]+\/report$/))    return _studentReport(req, res);

    // ── At-risk (all roles, school-scoped) ───────────────────────
    if (method === 'GET' && url === '/api/dashboard/at-risk')      return _atRisk(req, res);

    // ── Counsellor directory (management | admin) ────────────────
    if (method === 'GET' && url === '/api/dashboard/counsellors')  return _counsellors(req, res);

    // ── Schools + reminder log (management | admin) ──────────────
    if (method === 'GET' && url === '/api/dashboard/schools')      return _schools(req, res);
    if (method === 'GET' && url === '/api/dashboard/reminder-log') return _reminderLog(req, res);

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
    } catch (e) { process.stderr.write('[ERROR] [Dashboard] forgot-password email error: ' + e.message + '\n'); }
    // When SMTP is configured, token travels via email only — never in the response.
    return _json(res, 200, { ok: true });
  }
  // SMTP not configured: return token in response so admin can relay it manually.
  // This path should only occur in development / internal admin use.
  return _json(res, 200, { ok: true, token });
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
    const alerts = await _ddb.getWellbeingAlerts(await _userSchools(user));
    _json(res, 200, { alerts });
  } catch (e) { process.stderr.write('[ERROR] [wellbeing-alerts] ' + e.message + '\n'); _json(res, 500, { error: 'Server error' }); }
}

async function _careerDistribution(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const distribution = await _ddb.getCareerDistribution(await _userSchools(user));
    _json(res, 200, { distribution });
  } catch (e) { process.stderr.write('[ERROR] [career-distribution] ' + e.message + '\n'); _json(res, 500, { error: 'Server error' }); }
}

async function _moduleTiming(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  try {
    const timing = await _ddb.getModuleTiming(await _userSchools(user));
    _json(res, 200, { timing });
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
      if (cls && !p.allowedClasses.includes(cls)) return _json(res, 200, { students: [], count: 0 });
      if (!cls) {
        const rows = [];
        for (const ac of p.allowedClasses)
          rows.push(...await _ddb.getStudentsBySchool(schools, { class: ac, section, search, limit, offset }));
        return _json(res, 200, { students: rows, count: rows.length });
      }
    }
    if (p.studentScope === 'section' && Array.isArray(p.allowedSections) && p.allowedSections.length) {
      if (section && !p.allowedSections.includes(section)) return _json(res, 200, { students: [], count: 0 });
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

async function _trend(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const qs   = new URLSearchParams(req.url.split('?')[1] || '');
  const days = Math.min(parseInt(qs.get('days') || '14', 10), 90);
  // getCompletionTrend is now cache-backed — instant on hit, live on miss
  const trend = await _ddb.getCompletionTrend(await _userSchools(user, qs.get('school') || ''), days);
  _json(res, 200, { trend });
}

async function _atRisk(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const qs   = new URLSearchParams(req.url.split('?')[1] || '');
  const days = Math.min(Math.max(parseInt(qs.get('days') || '3', 10), 1), 60);
  const students = await _ddb.getAtRiskStudents(await _userSchools(user, qs.get('school') || ''), { days });
  _json(res, 200, { students, days });
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
  const filtered = await _ddb.getStudentsBySchool(await _userSchools(user, school), { class: cls, status, limit: 50000 });
  const esc = v => `"${String(v||'').replace(/"/g,'""')}"`;
  // pg returns TIMESTAMPTZ as Date objects (SQLite returned ISO strings) — normalise.
  const day = v => v ? new Date(v).toISOString().slice(0,10) : '';
  const header = ['Name','Email','School','Class','Section','Gender','Age','Status','Modules Done','Registered At','Completed At'];
  const rows = filtered.map(s => [
    esc(s.full_name), esc(s.email), esc(s.school), esc(s.class), esc(s.section),
    esc(s.gender), esc(s.age), esc(s.status), s.modules_done,
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

  const body = await _readBody(req, 32 * 1024);
  const { students, subject, message } = body || {};
  if (!Array.isArray(students) || !students.length) return _json(res, 400, { error: 'students array required' });
  if (!message) return _json(res, 400, { error: 'message required' });

  // Scope guard: verify each target email belongs to a real student within
  // the caller's assigned school(s) — prevents using this endpoint to email
  // arbitrary addresses (including ones with no corresponding student at all).
  let inScope = students;
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(s => s.toLowerCase());
    // Resolve each student's school first (async), then filter synchronously.
    const checked = await Promise.all(students.map(async (st) => {
      if (!st.email) return null;
      const stu = _ddb.getStudentByEmail ? await _ddb.getStudentByEmail(st.email) : null;
      return (stu && schools.includes((stu.school || '').toLowerCase())) ? st : null;
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
      _sendEmail({
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
                  detail: `sent=${sent} failed=${failed} scopeRejected=${students.length - inScope.length}` });
  _json(res, 200, { ok: true, sent, failed, scopeRejected: students.length - inScope.length });
}

async function _testEmail(req, res) {
  const user = await _requireRole(req, res, 'counsellor', 'management', 'admin');
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
  const { first_name, last_name, email, class: cls, section, school, age, gender, school_state, school_city } = body || {};
  if (!first_name || !school) return _json(res, 400, { error: 'first_name and school required' });
  // Scope guard: management may only create students under their assigned school(s)
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!schools.includes(String(school).toLowerCase())) {
      return _json(res, 403, { error: 'You can only add students to your assigned school(s).' });
    }
  }
  // Upsert: existing email → update that row in place; otherwise create.
  const sid = await _ddb.upsertStudent({ first_name, last_name, email, class: cls, section, school, age, gender, school_state, school_city });
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'create_student', target: sid,
                  detail: `${first_name} ${last_name || ''} @ ${school}` });
  _json(res, 201, { ok: true, session_id: sid });
}

async function _updateStudent(req, res) {
  const user = await _requireRole(req, res, 'admin', 'management');
  if (!user) return;
  const sessionId = _seg(req.url, -1);
  // IDOR guard: management may only edit students in their assigned schools
  if (user.role !== 'admin') {
    const stu = await _ddb.getStudentBySessionId(sessionId);
    if (!stu) return _json(res, 404, { error: 'Student not found' });
    const schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!schools.includes((stu.school || '').toLowerCase())) {
      return _json(res, 403, { error: 'Forbidden' });
    }
  }
  const body = await _readBody(req, 16 * 1024);
  await _ddb.moveStudent(sessionId, body);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'update_student', target: sessionId });
  _json(res, 200, { ok: true });
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
  const body = await _readBody(req, 2 * 1024 * 1024);
  let rows = (body && Array.isArray(body.rows)) ? body.rows : [];
  if (!rows.length) return _json(res, 400, { error: 'rows array required' });

  // Scope guard: management may only import rows for their assigned school(s).
  // Filtered here (not per-row inside the transaction) so the rejection count
  // is visible to the caller via the existing skipped counter.
  let scopeRejected = 0;
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(s => s.toLowerCase());
    const before = rows.length;
    rows = rows.filter(r => schools.includes(String(r.school || '').toLowerCase()));
    scopeRejected = before - rows.length;
    if (!rows.length) {
      return _json(res, 403, { error: 'None of the rows match your assigned school(s).' });
    }
  }

  // One _dbWrite slot + one SQLite transaction: atomic, and never blocks
  // the event loop with thousands of individual auto-transactions.
  let imported = 0, skipped = 0;
  try {
    await _dbWrite(async () => {
      const doImport = await _ddb.runImportTransaction(rows.slice(0, 2000));
      imported = doImport.imported;
      skipped  = doImport.skipped;
    });
  } catch (e) {
    process.stderr.write('[ERROR] [import_students] ' + e.message + '\n');
    return _json(res, 500, { error: 'Import failed: ' + e.message });
  }

  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'import_students',
                  detail: `imported=${imported} skipped=${skipped} scopeRejected=${scopeRejected}` });
  _json(res, 200, { ok: true, imported, skipped, scopeRejected });
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
    const schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!schools.includes((stu.school || '').toLowerCase())) {
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
    const schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!schools.includes((stu.school || '').toLowerCase())) {
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
  // IDOR guard: verify this student belongs to requesting user's schools
  if (user.role !== 'admin') {
    const _stu = await _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!_schools.includes((_stu.school || '').toLowerCase())) return _json(res, 403, { error: 'Forbidden' });
  }
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
    const _schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!_schools.includes((_stu.school || '').toLowerCase())) return _json(res, 403, { error: 'Forbidden' });
  }
  const body = await _readBody(req, 4 * 1024);
  await _ddb.setStudentTags(sessionId, Array.isArray((body||{}).tags) ? body.tags : [], user.id);
  _json(res, 200, { ok: true });
}

/* Staff support path: clear a student's AI-counsellor PIN so they can go
   through first-time setup again. School-scoped; revokes active sessions. */
async function _resetStudentPin(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  const stu = await _ddb.getStudentBySessionId(sessionId);
  if (!stu) return _json(res, 404, { error: 'Student not found' });
  if (user.role !== 'admin') {
    const schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!schools.includes((stu.school || '').toLowerCase())) return _json(res, 403, { error: 'Forbidden' });
  }
  if (!stu.email) return _json(res, 400, { error: 'Student has no email on record.' });
  try {
    const cleared = await _dbWrite(() => _cdb.clearStudentPin(stu.email));
    await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'reset_student_pin', target: sessionId });
    _json(res, 200, { ok: true, cleared,
      message: cleared ? 'PIN cleared. The student will set a new PIN on next login.'
                       : 'No PIN was set for this student.' });
  } catch (e) {
    process.stderr.write('[ERROR] [reset-pin] ' + e.message + '\n');
    _json(res, 500, { error: 'Server error' });
  }
}

async function _studentReport(req, res) {
  const user = await _requireRole(req, res);
  if (!user) return;
  const sessionId = _seg(req.url, -2);
  // IDOR guard: verify this student belongs to requesting user's schools
  if (user.role !== 'admin') {
    const _stu = await _ddb.getStudentBySessionId(sessionId);
    if (!_stu) return _json(res, 404, { error: 'Student not found' });
    const _schools = (await _userSchools(user)).map(s => s.toLowerCase());
    if (!_schools.includes((_stu.school || '').toLowerCase())) return _json(res, 403, { error: 'Forbidden' });
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
  const id = parseInt(_seg(req.url, -1), 10);
  if (!id) return _json(res, 400, { error: 'Invalid id' });
  await _ddb.deleteRegisteredSchool(id);
  await _ddb.auditLog({ userId: user.id, userEmail: user.email, action: 'delete_school', target: String(id) });
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
