/* ════════════════════════════════════════════════════════════════════
   counsellor-db.js
   Counsellor feature DB layer — runs on top of the same numind.db.

   Tables managed here:
     counsellor_queries      — contact form submissions
     chat_history            — AI counsellor conversation turns
     counsellor_sessions     — persistent student session tokens
                               (replaces in-memory Map; survives restarts,
                                shared across PM2 cluster workers)
     rate_limits             — shared RL counters across cluster workers
     conversation_summaries  — rolling summaries for memory compression
════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');

let _db = null;

/* ─── Init ──────────────────────────────────────────────────────── */
function init(db) {
  if (_db) return; // idempotent
  _db = db;

  /* ── Step 1: Base tables ── */
  _db.exec(`
    CREATE TABLE IF NOT EXISTS counsellor_queries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      email           TEXT NOT NULL,
      message         TEXT NOT NULL,
      preferred_date  TEXT,
      preferred_time  TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      submitted_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cq_email     ON counsellor_queries(email);
    CREATE INDEX IF NOT EXISTS idx_cq_status    ON counsellor_queries(status);
    CREATE INDEX IF NOT EXISTS idx_cq_submitted ON counsellor_queries(submitted_at);

    CREATE TABLE IF NOT EXISTS chat_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT NOT NULL,
      session_id      TEXT,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ch_email   ON chat_history(email);
    CREATE INDEX IF NOT EXISTS idx_ch_session ON chat_history(session_id);
    CREATE INDEX IF NOT EXISTS idx_ch_created ON chat_history(created_at);

    /* ── Persistent counsellor session tokens ──
       Replaces in-memory Map; shared across PM2 workers, survives restarts. */
    CREATE TABLE IF NOT EXISTS counsellor_sessions (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ctok_email ON counsellor_sessions(email);
    CREATE INDEX IF NOT EXISTS idx_ctok_exp   ON counsellor_sessions(expires_at);

    /* ── Shared rate-limit counters ──
       key = 'scope:identifier'  e.g. 'chat:user@email.com'
       Enforces limits correctly across all cluster workers.        */
    CREATE TABLE IF NOT EXISTS rate_limits (
      key      TEXT PRIMARY KEY,
      count    INTEGER NOT NULL DEFAULT 0,
      reset_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rl_reset ON rate_limits(reset_at);

    /* ── Conversation summaries for memory compression ── */
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      summary         TEXT NOT NULL,
      message_count   INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_convsum_uniq  ON conversation_summaries(email, conversation_id);
    CREATE INDEX        IF NOT EXISTS idx_convsum_email ON conversation_summaries(email);

    /* ── Student PIN auth ──────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS student_pins (
      email       TEXT PRIMARY KEY,
      pin_hash    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    /* ── OTP table — first-time setup and PIN reset ─────────────────── */
    CREATE TABLE IF NOT EXISTS student_otps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email       TEXT NOT NULL,
      otp_hash    TEXT NOT NULL,
      purpose     TEXT NOT NULL DEFAULT 'register',
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_otp_email ON student_otps(email);
    CREATE INDEX IF NOT EXISTS idx_otp_exp   ON student_otps(expires_at);
  `);

  /* ── Step 2: ALTER TABLE guard for conversation_id ── */
  try { _db.exec('ALTER TABLE chat_history ADD COLUMN conversation_id TEXT'); } catch (_) {}

  /* ── Step 3: ALTER TABLE guards for counsellor_queries new columns ── */
  try { _db.exec('ALTER TABLE counsellor_queries ADD COLUMN admin_note TEXT'); }  catch (_) {}
  try { _db.exec('ALTER TABLE counsellor_queries ADD COLUMN updated_at TEXT'); }  catch (_) {}

  /* ── Step 3: Index on conversation_id (must follow ALTER TABLE) ── */
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_ch_conv ON chat_history(conversation_id);`);
}

/* ─── Counsellor query (contact form) ──────────────────────────── */
function saveQuery({ name, email, message, preferredDate, preferredTime }) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const info = _db.prepare(`
    INSERT INTO counsellor_queries
      (name, email, message, preferred_date, preferred_time, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    String(name  || '').slice(0, 200),
    String(email || '').toLowerCase().slice(0, 200),
    String(message || '').slice(0, 4000),
    preferredDate ? String(preferredDate).slice(0, 50) : null,
    preferredTime ? String(preferredTime).slice(0, 50) : null,
    new Date().toISOString(),
  );
  return info.lastInsertRowid;
}

function listQueries({ status, limit = 200, offset = 0 } = {}) {
  if (!_db) throw new Error('counsellor-db not initialised');
  if (status) {
    return _db.prepare(
      `SELECT * FROM counsellor_queries WHERE status = ? ORDER BY submitted_at DESC LIMIT ? OFFSET ?`
    ).all(status, limit, offset);
  }
  return _db.prepare(
    `SELECT * FROM counsellor_queries ORDER BY submitted_at DESC LIMIT ? OFFSET ?`
  ).all(limit, offset);
}

function updateQuery(id, { status, adminNote } = {}) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const fields = [];
  const vals   = [];
  if (status)    { fields.push('status = ?');     vals.push(String(status).slice(0, 50)); }
  if (adminNote !== undefined) {
                   fields.push('admin_note = ?'); vals.push(adminNote ? String(adminNote).slice(0, 2000) : null); }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  vals.push(new Date().toISOString(), Number(id));
  _db.prepare(`UPDATE counsellor_queries SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

/* ─── Report lookup by email ────────────────────────────────────── */
function getReportByEmail(email) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return null;

  // LEFT JOIN — works even if report_summary hasn't been generated yet.
  // A student who completed sections but whose AI report failed/hasn't run
  // will still be unlocked; Aria will have their raw scores but no prose summaries.
  const student = _db.prepare(`
    SELECT s.*,
           rs.holistic_summary, rs.aptitude_profile, rs.interest_profile,
           rs.internal_motivators, rs.personality_profile, rs.wellbeing_guidance,
           rs.stream_advice, rs.fit_score, rs.fit_tier, rs.personality_status,
           rs.aptitude_status, rs.interest_status, rs.seaa_status,
           rs.avg_personality_stanine, rs.avg_aptitude_stanine,
           rs.recommended_primary, rs.recommended_alternate, rs.recommended_exploratory,
           rs.strong_fit_pathways, rs.emerging_fit_pathways, rs.exploratory_pathways,
           rs.top_personality_traits_json, rs.strong_aptitudes_json,
           rs.emerging_aptitudes_json, rs.top3_interests_json,
           rs.generated_at
    FROM   students s
    LEFT JOIN report_summary rs ON rs.session_id = s.session_id
    WHERE  LOWER(s.email) = ?
    ORDER  BY s.registered_at DESC
    LIMIT  1
  `).get(norm);

  if (!student) return null;

  const personality = _db.prepare(
    `SELECT name, stanine, band FROM report_personality WHERE session_id = ? ORDER BY position`
  ).all(student.session_id);

  const aptitude = _db.prepare(
    `SELECT key, name, stanine, band, raw_score, max_score FROM report_aptitude WHERE session_id = ? ORDER BY position`
  ).all(student.session_id);

  const interests = _db.prepare(
    `SELECT label, score, level FROM report_interests WHERE session_id = ? ORDER BY rank`
  ).all(student.session_id);

  const seaa = _db.prepare(
    `SELECT key, title, score, category, cat_label FROM report_seaa WHERE session_id = ?`
  ).all(student.session_id);

  const careers = _db.prepare(
    `SELECT career, alignment, suitability_pct, rationale FROM report_careers WHERE session_id = ? ORDER BY position`
  ).all(student.session_id);

  const jp = (v) => { try { return JSON.parse(v); } catch { return null; } };

  return {
    student: {
      firstName: student.first_name,
      lastName:  student.last_name,
      fullName:  student.full_name,
      class:     student.class,
      section:   student.section,
      school:    student.school,
      age:       student.age,
      gender:    student.gender,
      email:     student.email,
    },
    report: {
      holistic_summary:    student.holistic_summary,
      aptitude_profile:    student.aptitude_profile,
      interest_profile:    student.interest_profile,
      internal_motivators: student.internal_motivators,
      personality_profile: student.personality_profile,
      wellbeing_guidance:  student.wellbeing_guidance,
      stream_advice:       student.stream_advice,
      fit_score:           student.fit_score,
      fit_tier:            student.fit_tier,
      personality_status:  student.personality_status,
      aptitude_status:     student.aptitude_status,
      interest_status:     student.interest_status,
      seaa_status:         student.seaa_status,
      avg_personality_stanine:  student.avg_personality_stanine,
      avg_aptitude_stanine:     student.avg_aptitude_stanine,
      recommended_primary:      student.recommended_primary,
      recommended_alternate:    student.recommended_alternate,
      recommended_exploratory:  student.recommended_exploratory,
      strong_fit_pathways:      jp(student.strong_fit_pathways),
      emerging_fit_pathways:    jp(student.emerging_fit_pathways),
      exploratory_pathways:     jp(student.exploratory_pathways),
      top_personality_traits:   jp(student.top_personality_traits_json),
      strong_aptitudes:         jp(student.strong_aptitudes_json),
      emerging_aptitudes:       jp(student.emerging_aptitudes_json),
      top3_interests:           jp(student.top3_interests_json),
      generated_at:             student.generated_at,
    },
    personality,
    aptitude,
    interests,
    seaa,
    careers,
    session_id: student.session_id,
  };
}

/* ─── Check if student has completed assessment (by email) ──────── */
function hasCompletedAssessment(email) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return false;

  // Path 1: full report generated
  const withReport = _db.prepare(`
    SELECT 1 FROM students s
    JOIN   report_summary rs ON rs.session_id = s.session_id
    WHERE  LOWER(s.email) = ?
    LIMIT  1
  `).get(norm);
  if (withReport) return true;

  // Path 2: all 4 section scores saved (report generation may have failed)
  const withSections = _db.prepare(`
    SELECT 1 FROM students s
    JOIN   assessments a ON a.session_id = s.session_id
    WHERE  LOWER(s.email) = ?
      AND  a.nmap_scores_json    IS NOT NULL
      AND  a.cpi_scores_json     IS NOT NULL
      AND  a.sea_scores_json     IS NOT NULL
      AND  a.daab_va_scores_json IS NOT NULL
    LIMIT  1
  `).get(norm);
  if (withSections) return true;

  // Path 3: student row exists with any completed assessment data
  // Catches edge cases where individual section saves succeeded but
  // the assessments join above fails due to partial data
  const withCompleted = _db.prepare(`
    SELECT 1 FROM students s
    LEFT JOIN assessments a ON a.session_id = s.session_id
    WHERE  LOWER(s.email) = ?
      AND  (s.completed_at IS NOT NULL OR a.session_id IS NOT NULL)
    LIMIT  1
  `).get(norm);
  return !!withCompleted;
}

/* ─── Chat history ──────────────────────────────────────────────── */
function saveMessage({ email, sessionId, conversationId, role, content }) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const info = _db.prepare(`
    INSERT INTO chat_history (email, session_id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    String(email || '').toLowerCase().slice(0, 200),
    sessionId      ? String(sessionId).slice(0, 64)      : null,
    conversationId ? String(conversationId).slice(0, 64) : null,
    role === 'assistant' ? 'assistant' : 'user',
    String(content || '').slice(0, 16000),
    new Date().toISOString(),
  );
  return info.lastInsertRowid;
}

function getHistory(email, { limit = 60, conversationId } = {}) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return [];
  let rows;
  if (conversationId) {
    rows = _db.prepare(`
      SELECT role, content, created_at, conversation_id FROM chat_history
      WHERE  LOWER(email) = ? AND conversation_id = ?
      ORDER  BY created_at DESC LIMIT ?
    `).all(norm, conversationId, limit);
  } else {
    rows = _db.prepare(`
      SELECT role, content, created_at, conversation_id FROM chat_history
      WHERE  LOWER(email) = ?
      ORDER  BY created_at DESC LIMIT ?
    `).all(norm, limit);
  }
  return rows.reverse();
}

function getConversations(email) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return [];
  const convs = _db.prepare(`
    SELECT
      conversation_id,
      MIN(CASE WHEN role = 'user' THEN content END) AS first_user_msg,
      MAX(created_at)                                AS last_at,
      COUNT(*)                                       AS message_count
    FROM chat_history
    WHERE LOWER(email) = ? AND conversation_id IS NOT NULL
    GROUP BY conversation_id
    ORDER BY last_at DESC
    LIMIT 20
  `).all(norm);
  return convs.map(c => ({
    conversation_id: c.conversation_id,
    title: c.first_user_msg
      ? (c.first_user_msg.substring(0, 42) + (c.first_user_msg.length > 42 ? '…' : ''))
      : 'Conversation',
    last_at:       c.last_at,
    message_count: c.message_count,
  }));
}

function clearHistory(email) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  _db.prepare(`DELETE FROM chat_history WHERE LOWER(email) = ?`).run(norm);
}

/* ─── Conversation summaries ────────────────────────────────────── */
function saveConversationSummary({ email, conversationId, summary, messageCount }) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  const now  = new Date().toISOString();
  _db.prepare(`
    INSERT INTO conversation_summaries
      (email, conversation_id, summary, message_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email, conversation_id) DO UPDATE SET
      summary       = excluded.summary,
      message_count = excluded.message_count,
      updated_at    = excluded.updated_at
  `).run(norm, String(conversationId).slice(0, 64), String(summary).slice(0, 8000), messageCount || 0, now, now);
}

function getConversationSummary(email, conversationId) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email || '').toLowerCase().trim();
  return _db.prepare(`
    SELECT summary, message_count, updated_at FROM conversation_summaries
    WHERE LOWER(email) = ? AND conversation_id = ?
  `).get(norm, String(conversationId)) || null;
}

/* ─── Persistent counsellor session tokens ──────────────────────── */
const COUNSELLOR_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function issueToken(email) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const token     = crypto.randomBytes(32).toString('hex');
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + COUNSELLOR_TTL_MS).toISOString();
  _db.prepare(`
    INSERT INTO counsellor_sessions (token, email, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, String(email).toLowerCase().trim(), now.toISOString(), expiresAt);
  return token;
}

function verifyToken(token) {
  if (!_db) return null;
  if (!token) return null;
  const row = _db.prepare(`
    SELECT email FROM counsellor_sessions
    WHERE token = ? AND expires_at > ?
  `).get(String(token), new Date().toISOString());
  return row ? row.email : null;
}

function pruneTokens() {
  if (!_db) return;
  _db.prepare(`DELETE FROM counsellor_sessions WHERE expires_at <= ?`)
     .run(new Date().toISOString());
}

/* ─── Shared rate limiting (across PM2 workers via SQLite) ──────── */
/**
 * Check and increment a rate-limit counter.
 * scope    — e.g. 'chat', 'unlock', 'query'
 * key      — e.g. email address or IP
 * limit    — max requests in the window
 * windowMs — window length in milliseconds
 *
 * Returns { allowed: bool, retryAfter: seconds }
 */
function rlCheck(scope, key, limit, windowMs) {
  if (!_db) return { allowed: true }; // fail open if DB not ready
  const rlKey   = scope + ':' + String(key).slice(0, 200);
  const now     = new Date();
  const nowIso  = now.toISOString();
  const resetAt = new Date(now.getTime() + (windowMs || 3600000)).toISOString();

  // Atomic upsert + read inside a transaction.
  // Without this, two concurrent workers can both read count=N before either
  // writes count=N+1, letting both pass through a saturated limit.
  const result = _db.transaction(() => {
    // Upsert: insert first row OR reset/increment existing
    _db.prepare(`
      INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count    = CASE WHEN reset_at <= ? THEN 1         ELSE count + 1 END,
        reset_at = CASE WHEN reset_at <= ? THEN ?         ELSE reset_at  END
    `).run(rlKey, resetAt, nowIso, nowIso, resetAt);

    return _db.prepare(
      `SELECT count, reset_at FROM rate_limits WHERE key = ?`
    ).get(rlKey);
  })();

  if (!result) return { allowed: true };

  if (result.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((new Date(result.reset_at) - now) / 1000));
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

function rlPrune() {
  if (!_db) return;
  _db.prepare(`DELETE FROM rate_limits WHERE reset_at <= ?`).run(new Date().toISOString());
}

/* ─── Student PIN auth ──────────────────────────────────────────── */
const _crypto = require('crypto');

function _hashPin(plain) {
  const salt = _crypto.randomBytes(16).toString('hex');
  const hash = _crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return salt + ':' + hash;
}

function _verifyPin(plain, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const candidate    = _crypto.scryptSync(String(plain), salt, 32).toString('hex');
    return _crypto.timingSafeEqual(Buffer.from(candidate,'hex'), Buffer.from(hash,'hex'));
  } catch { return false; }
}

function hasPinSet(email) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email||'').toLowerCase().trim();
  return !!_db.prepare('SELECT 1 FROM student_pins WHERE email = ?').get(norm);
}

function verifyStudentPin(email, pin) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email||'').toLowerCase().trim();
  const row  = _db.prepare('SELECT pin_hash FROM student_pins WHERE email = ?').get(norm);
  if (!row) return false;
  return _verifyPin(String(pin).trim(), row.pin_hash);
}

function setStudentPin(email, pin) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm = String(email||'').toLowerCase().trim();
  const now  = new Date().toISOString();
  const hash = _hashPin(String(pin).trim());
  _db.prepare(`
    INSERT INTO student_pins (email, pin_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET pin_hash=excluded.pin_hash, updated_at=excluded.updated_at
  `).run(norm, hash, now, now);
}

/* ─── OTPs ──────────────────────────────────────────────────────── */
const OTP_TTL_MS = 10 * 60 * 1000;

function createOtp(email, purpose) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm      = String(email||'').toLowerCase().trim();
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();
  // Invalidate existing unused OTPs for same email+purpose
  _db.prepare('UPDATE student_otps SET used=1 WHERE email=? AND purpose=? AND used=0').run(norm, purpose);
  const plain   = String(Math.floor(100000 + require('crypto').randomInt(900000)));
  const otpHash = require('crypto').createHash('sha256').update(plain+norm).digest('hex');
  _db.prepare(`
    INSERT INTO student_otps (email, otp_hash, purpose, expires_at, used, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(norm, otpHash, purpose||'register', expiresAt, now.toISOString());
  return plain;
}

function verifyOtp(email, otp, purpose) {
  if (!_db) throw new Error('counsellor-db not initialised');
  const norm      = String(email||'').toLowerCase().trim();
  const plain     = String(otp||'').trim();
  const nowIso    = new Date().toISOString();
  const candidate = require('crypto').createHash('sha256').update(plain+norm).digest('hex');
  const row = _db.prepare(`
    SELECT id, otp_hash FROM student_otps
    WHERE email=? AND purpose=? AND used=0 AND expires_at>?
    ORDER BY created_at DESC LIMIT 1
  `).get(norm, purpose||'register', nowIso);
  if (!row) return false;
  let valid = false;
  try { valid = require('crypto').timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(row.otp_hash,'hex')); } catch { return false; }
  if (valid) _db.prepare('UPDATE student_otps SET used=1 WHERE id=?').run(row.id);
  return valid;
}

function pruneOtps() {
  if (!_db) return;
  const cutoff = new Date(Date.now() - OTP_TTL_MS*2).toISOString();
  _db.prepare('DELETE FROM student_otps WHERE expires_at<=? OR used=1').run(cutoff);
}

function close() { /* shares DB from db.js — stub for graceful shutdown */ }

module.exports = {
  init,
  saveQuery, listQueries, updateQuery,
  getReportByEmail, hasCompletedAssessment,
  saveMessage, getHistory, getConversations, clearHistory,
  saveConversationSummary, getConversationSummary,
  issueToken, verifyToken, pruneTokens,
  rlCheck, rlPrune,
  hasPinSet, verifyStudentPin, setStudentPin,
  createOtp, verifyOtp, pruneOtps,
  close,
};
