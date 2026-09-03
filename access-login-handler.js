/* ════════════════════════════════════════════════════════════════════
   access-login-handler.js
   ════════════════════════════════════════════════════════════════════

   Route handler for POST /api/counsellor-access-login.

   Lets an email-less, bulk-imported student log into Aria using the same
   four-field credential they use to start the assessment (school + class
   + name + code). No email, no OTP, no PIN — the access code IS the
   credential.

   HOW IT WORKS
   ────────────
   1. Verifies (school + class + name + code) against students.access_code
      via the same constant-time compare the dashboard/registration flow uses.
   2. Loads the student's report by session_id.
   3. If no report yet, refuses — the student must finish the assessment first.
   4. Reuses server.js's own _jsonUnlocked(res, identity, reportObj) to
      issue a counsellor token, load history + conversations + journey, and
      emit the same JSON shape that /api/counsellor-verify-pin returns. That
      makes the existing frontend `_acApplySession(data)` handler consume it
      without modification.

   The "identity" passed to _jsonUnlocked is `access:<session_id>`. Every
   downstream DB helper (getReportByEmail, getJourney, _sessionIdFor in
   goals-db) has been taught to detect that prefix and route to the
   session-based path — so zero call sites in server.js need to change.

   HOW TO WIRE INTO server.js — see the two-line change already applied
   for you further down in this batch.
════════════════════════════════════════════════════════════════════ */

'use strict';

module.exports = function buildAccessLoginHandler(deps) {
  const {
    cdb,           // require('./counsellor-db.js')
    log,           // { info, warn, error }
    _json,         // (res, status, body) => void
    _readBody,     // async (req, maxBytes?) => object
    _checkToken,   // (req) => boolean  — APP_TOKEN guard
    _rlCheckDb,    // async (scope, key, limit, windowMs) => { allowed, retryAfter }
    _jsonUnlocked, // async (res, identity, reportObj) => void
  } = deps;

  // Rate-limit window kept consistent with the rest of the counsellor
  // endpoints. Overridable via deps for tests.
  const RL_WINDOW_MS = deps.RL_WINDOW_MS || 60 * 1000;
  const RL_LIMIT     = deps.RL_LIMIT     || 15;

  // Basic shape guard on the code — matches dashboard-db.generateAccessCode's
  // 8-char default with generous headroom in case the length is tuned later.
  const CODE_SHAPE = /^[A-Z0-9]{6,12}$/;

  return async function _handleCounsellorAccessLogin(req, res) {
    // 1. App-token guard — same as every other public API route.
    if (!_checkToken(req)) return _json(res, 401, { error: 'Unauthorized' });

    // 2. Body parse.
    let body;
    try { body = await _readBody(req); }
    catch (e) { return _json(res, e.message === 'body_too_large' ? 413 : 400, { error: e.message }); }

    const school = String(body?.school || '').trim();
    const klass  = String(body?.class  || '').trim();
    const name   = String(body?.name   || '').trim();
    const code   = String(body?.code   || '').trim().toUpperCase();

    if (!school || !klass || !name || !code) {
      return _json(res, 400, { error: 'All four fields are required.' });
    }
    if (!CODE_SHAPE.test(code)) {
      // Cheap shape reject before hitting the DB. Doesn't leak which field
      // was wrong — the redeem step below is constant-time on the code itself.
      return _json(res, 400, { error: 'Access code format looks wrong. Please check with your teacher.' });
    }

    // 3. Rate-limit by school+class+name — bounds brute-force attempts on any
    //    one code without penalising unrelated students on the same box.
    const rlKey = 'ac:' + school.toLowerCase() + '|' + klass.toLowerCase() + '|' + name.toLowerCase();
    const rl = await _rlCheckDb('access-login', rlKey, RL_LIMIT, RL_WINDOW_MS);
    if (!rl.allowed) {
      res.writeHead(429, { 'Retry-After': String(rl.retryAfter), 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Too many attempts. Please wait a minute.' }));
    }

    // 4. Verify the four-field credential.
    let student;
    try {
      student = await cdb.redeemAccessCodeForCounsellor({ school, klass, name, code });
    } catch (e) {
      log.error('[counsellor-access-login] verify error:', e.message);
      return _json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
    if (!student || !student.session_id) {
      return _json(res, 200, { unlocked: false,
        error: 'Those details do not match. Please check with your teacher.' });
    }

    // 5. Report must exist. Without one, Aria has nothing to talk about —
    //    steer the student back to finish the assessment.
    let reportObj;
    try {
      reportObj = await cdb.getReportBySessionId(student.session_id);
    } catch (e) {
      log.error('[counsellor-access-login] report load error:', e.message);
      return _json(res, 500, { error: 'Could not load your report. Please try again.' });
    }
    if (!reportObj || !reportObj.report ||
        (reportObj.report.fit_tier == null && reportObj.report.generated_at == null)) {
      return _json(res, 200, { unlocked: false,
        error: 'You need to finish the assessment before Aria can help you. Please complete all four sections first.' });
    }

    // 6. Success — identity is the synthetic `access:<session_id>` string.
    const identity = cdb.accessIdentityFor(student.session_id);
    log.info('[unlock]', identity, '| verified via: access-code');
    return _jsonUnlocked(res, identity, reportObj);
  };
};
