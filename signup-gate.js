/* ════════════════════════════════════════════════════════════════════
   signup-gate.js — server-side enforcement: registration by access code only.

   WHY THIS EXISTS
   ───────────────
   Self-registration gives anyone the full assessment and AI counsellor for
   free. This closes that path while leaving school-issued access codes
   working, so paying schools are unaffected.

   WHY IT CANNOT BE UI-ONLY
   ────────────────────────
   Hiding the form stops nobody: /api/save-registration is reachable from the
   console in one fetch(), and the client's own `doRegister` can be invoked
   directly. The lock screen is UX; this file is the actual control.

   HOW THE TWO PATHS ARE TOLD APART
   ────────────────────────────────
   Both the access-code and self-registration flows end at
   DB.saveRegistration() → POST /api/save-registration, so the endpoint alone
   cannot be blocked. They differ in one reliable way:

     access code   doAccessLogin() redeems the code, then adopts the staff
                   -created session_id. That row already exists in `students`
                   and always carries an access_code — redeemAccessCode()
                   only ever returns rows WHERE access_code IS NOT NULL.

     self-register doRegister() mints a fresh unguessable 'NMSUITE-…' id.
                   No row exists for it, and no access_code is involved.

   So: a registration is allowed when it belongs to a student the school
   already issued a code to. Everything else is a new free signup.

   TURNING IT BACK ON
   ──────────────────
   Set ALLOW_SELF_SIGNUP=true in the environment and restart. No code change,
   no redeploy of this file. Absent or any other value = self-signup closed,
   so a mis-deploy fails toward the safe state rather than reopening the leak.

   WIRING (two lines in server.js) — see the bottom of this file.
════════════════════════════════════════════════════════════════════ */

'use strict';

const pg = require('./pg-core.js');

const ENV_FLAG = 'ALLOW_SELF_SIGNUP';

/* Self-signup is open ONLY when explicitly enabled. Defaulting to closed
   means an environment that loses its config does not silently start giving
   the product away again. */
function selfSignupOpen() {
  const v = String(process.env[ENV_FLAG] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/* Does this registration belong to a student a school already issued a code
   to? Two ways that can be true:

     1. session_id matches a row that has an access_code — the normal
        access-code flow, where doAccessLogin adopted the staff row's id.

     2. email matches a row that has an access_code — covers the case the
        registration handler already supports, where a student was bulk
        -imported WITH an email and the server matches them by it rather than
        by session_id. Without this they would be blocked despite their school
        having paid for them. */
async function hasAccessCodeEntitlement({ sessionId, email }) {
  const sid  = String(sessionId || '').trim();
  const mail = String(email || '').toLowerCase().trim();

  if (sid) {
    const row = await pg.one(
      `SELECT 1 AS ok FROM students
        WHERE session_id = $1 AND access_code IS NOT NULL AND btrim(access_code) <> ''
        LIMIT 1`,
      [sid]
    );
    if (row) return true;
  }

  if (mail) {
    const row = await pg.one(
      `SELECT 1 AS ok FROM students
        WHERE email = $1 AND access_code IS NOT NULL AND btrim(access_code) <> ''
        LIMIT 1`,
      [mail]
    );
    if (row) return true;
  }

  return false;
}

/* Decide whether a registration may proceed.

   Returns { allow: boolean, reason: string, status?, body? }.
   `status` and `body` are the HTTP response to send when allow is false, so
   the caller stays a two-line change.

   FAILS CLOSED on a database error. That is deliberate: this check runs
   immediately before saveRegistration, which hits the same database — if the
   query cannot run, the write that follows would not have succeeded either,
   so blocking adds no new breakage while an open failure would reopen the
   leak exactly when nobody is watching. */
async function checkSignupAllowed({ sessionId, email }) {
  if (selfSignupOpen()) {
    return { allow: true, reason: 'self_signup_open' };
  }

  let entitled;
  try {
    entitled = await hasAccessCodeEntitlement({ sessionId, email });
  } catch (err) {
    process.stderr.write('[signup-gate] entitlement check failed: ' + err.message + '\n');
    return {
      allow:  false,
      reason: 'check_failed',
      status: 503,
      body: {
        error: 'We could not verify your access just now. Please try again in a moment.',
        signupClosed: true,
      },
    };
  }

  if (entitled) return { allow: true, reason: 'access_code' };

  return {
    allow:  false,
    reason: 'self_signup_closed',
    status: 403,
    body: {
      error: 'Self-registration is currently closed. NuMind MAPS is available ' +
             'through partner schools — please ask your school for an access code.',
      signupClosed: true,
    },
  };
}

/* Served to the browser so the lock screen reflects the real server state
   rather than a hardcoded assumption. Deliberately returns nothing else —
   it is an unauthenticated endpoint. */
function publicStatus() {
  return { selfSignupOpen: selfSignupOpen() };
}

/* ════════════════════════════════════════════════════════════════════
   OPTIONAL — closes a SEPARATE, PRE-EXISTING leak. Not wired by default.

   /api/ai-report is guarded only by _checkToken (APP_TOKEN), which ships to
   every browser inside index.html as <meta name="app-token">. Anyone who
   views source can read it and POST arbitrary prompts to that route, which
   streams gpt-4o on your OpenAI account. It never checks who is asking: the
   client already sends an X-Session-ID header, and server.js allows it
   through CORS, but nothing reads it.

   That is unrelated to registration and predates this gate — closing
   registration does NOT close it. It is arguably the costlier leak of the
   two, since it spends money per request rather than per student.

   Left opt-in deliberately: it sits on the critical report-generation path,
   so if the session check is wrong, every student's report breaks. Wire it
   only after confirming the header arrives (log it for a day first).

   TO ENABLE — in server.js, inside _handleAIReport, after the _checkToken
   line and before the OpenAI call:

       const ok = await signupGate.checkReportAllowed(req);
       if (!ok.allow) return _json(res, ok.status, ok.body);

   Requires ENFORCE_REPORT_SESSION=true in .env as a second switch, so
   dropping the code in does not change behaviour until you say so. */
function reportSessionEnforced() {
  const v = String(process.env.ENFORCE_REPORT_SESSION || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function checkReportAllowed(req) {
  if (!reportSessionEnforced()) return { allow: true, reason: 'not_enforced' };

  const sid = String((req.headers && (req.headers['x-session-id'] || req.headers['X-Session-ID'])) || '').trim();
  if (!sid) {
    return { allow: false, reason: 'no_session', status: 401,
             body: { error: 'Session required.' } };
  }
  try {
    const row = await pg.one('SELECT 1 AS ok FROM students WHERE session_id = $1 LIMIT 1', [sid]);
    if (row) return { allow: true, reason: 'session_ok' };
  } catch (err) {
    process.stderr.write('[signup-gate] report session check failed: ' + err.message + '\n');
    return { allow: false, reason: 'check_failed', status: 503,
             body: { error: 'Could not verify your session. Please try again.' } };
  }
  return { allow: false, reason: 'unknown_session', status: 401,
           body: { error: 'Session not recognised. Please register first.' } };
}

module.exports = {
  checkSignupAllowed, selfSignupOpen, publicStatus,
  checkReportAllowed, reportSessionEnforced,
};

/* ════════════════════════════════════════════════════════════════════
   WIRING — server.js

   1. With the other requires near the top:

        const signupGate = require('./signup-gate.js');

   2. Inside _handleSaveRegistration, immediately after sessionId is
      validated and BEFORE the dbModule.saveRegistration call:

        const gate = await signupGate.checkSignupAllowed({
          sessionId,
          email: student && student.email,
        });
        if (!gate.allow) return _json(res, gate.status, gate.body);

   3. (Optional but recommended) register the status route alongside the
      other public GETs, so the lock screen can ask the server rather than
      assume:

        if (method === 'GET' && pathname === '/api/signup-status')
          return _json(res, 200, signupGate.publicStatus());
   ════════════════════════════════════════════════════════════════════ */
