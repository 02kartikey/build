/* ════════════════════════════════════════════════════════════════════
   counsellor-db.js — NuMind MAPS  |  Counsellor feature layer (PostgreSQL)
   --------------------------------------------------------------------
   Async rewrite on pg-core.js. Schema now lives in pg-core (initSchema);
   this module keeps only behaviour. Every DB function is async.

   Conversions from better-sqlite3:
     • ? → $1,$2,…; .get/.all/.run → pg.one/pg.many/pg.exec/pg.tx.
     • lastInsertRowid → RETURNING id.
     • LOWER(email) comparisons dropped where the column is app-normalised
       to lowercase on write (email stored lowercased). The students.email
       column is CITEXT, so joins on it are case-insensitive without LOWER().
     • used 0/1 → BOOLEAN; UPDATE ... used = TRUE.
     • rlCheck transaction → pg.tx with the same upsert-then-read logic.

   The in-memory report cache is unchanged (not DB-bound). init() no longer
   receives a db handle — it just triggers schema readiness via db.js._initDb.
   The parameter is kept for call-site compatibility but ignored.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');
const pg     = require('./pg-core.js');

let _ready = false;

/* ─── Init ──────────────────────────────────────────────────────── */
/* Legacy signature init(db) — the argument is ignored now; schema creation
   is owned by pg-core via db.js._initDb(). Kept so server.js needn't change. */
async function init(_db) {
  if (_ready) return;
  await require('./db.js')._initDb();
  _ready = true;
}

/* ─── Counsellor query (contact form) ──────────────────────────── */
async function saveQuery({ name, email, message, preferredDate, preferredTime }) {
  const row = await pg.one(
    `INSERT INTO counsellor_queries
       (name, email, message, preferred_date, preferred_time, status, submitted_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6)
     RETURNING id`,
    [
      String(name  || '').slice(0, 200),
      String(email || '').toLowerCase().slice(0, 200),
      String(message || '').slice(0, 4000),
      preferredDate ? String(preferredDate).slice(0, 50) : null,
      preferredTime ? String(preferredTime).slice(0, 50) : null,
      new Date().toISOString(),
    ]
  );
  return row ? row.id : null;
}

async function listQueries({ status, limit = 200, offset = 0, schools } = {}) {
  // School scoping: join students on email (CITEXT → case-insensitive join),
  // then filter on students.school. That column is plain TEXT, so the school
  // comparison must lower-case BOTH sides — otherwise a casing mismatch between
  // the stored school name and the caller's assigned-school list silently drops
  // queries. Mirrors dashboard-db.js's `LOWER(s.school) IN (lowercased list)`.
  if (Array.isArray(schools) && schools.length) {
    const lowered = schools.map(s => String(s).toLowerCase());
    // Build positional placeholders for the school list.
    if (status) {
      const ph = lowered.map((_, i) => `$${i + 1}`).join(',');
      const params = [...lowered, status, limit, offset];
      return pg.many(
        `SELECT cq.* FROM counsellor_queries cq
         JOIN students st ON st.email = cq.email
         WHERE LOWER(st.school) IN (${ph})
           AND cq.status = $${lowered.length + 1}
         ORDER BY cq.submitted_at DESC
         LIMIT $${lowered.length + 2} OFFSET $${lowered.length + 3}`,
        params
      );
    }
    const ph = lowered.map((_, i) => `$${i + 1}`).join(',');
    const params = [...lowered, limit, offset];
    return pg.many(
      `SELECT cq.* FROM counsellor_queries cq
       JOIN students st ON st.email = cq.email
       WHERE LOWER(st.school) IN (${ph})
       ORDER BY cq.submitted_at DESC
       LIMIT $${lowered.length + 1} OFFSET $${lowered.length + 2}`,
      params
    );
  }
  if (status) {
    return pg.many(
      `SELECT * FROM counsellor_queries WHERE status = $1 ORDER BY submitted_at DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset]
    );
  }
  return pg.many(
    `SELECT * FROM counsellor_queries ORDER BY submitted_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}

async function updateQuery(id, { status, adminNote } = {}) {
  const fields = [];
  const vals   = [];
  let n = 1;
  if (status) { fields.push(`status = $${n++}`); vals.push(String(status).slice(0, 50)); }
  if (adminNote !== undefined) {
    fields.push(`admin_note = $${n++}`);
    vals.push(adminNote ? String(adminNote).slice(0, 2000) : null);
  }
  if (!fields.length) return;
  fields.push(`updated_at = $${n++}`);
  vals.push(new Date().toISOString());
  vals.push(Number(id));
  await pg.exec(`UPDATE counsellor_queries SET ${fields.join(', ')} WHERE id = $${n}`, vals);
}

/* ─── Report cache (in-memory, not DB-bound; unchanged) ─────────── */
const _REPORT_CACHE_TTL = 8 * 60 * 60 * 1000;
const _REPORT_CACHE_MAX = 500;
const _reportCache      = new Map(); // norm_email → { report, cachedAt }

function _reportCacheGet(norm) {
  const entry = _reportCache.get(norm);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > _REPORT_CACHE_TTL) { _reportCache.delete(norm); return undefined; }
  return entry.report;
}

function _reportCacheSet(norm, report) {
  if (_reportCache.size >= _REPORT_CACHE_MAX) {
    _reportCache.delete(_reportCache.keys().next().value); // evict oldest
  }
  _reportCache.set(norm, { report, cachedAt: Date.now() });
}

function _invalidateReportCache(email) {
  if (!email) return;
  _reportCache.delete(String(email).toLowerCase().trim());
}

/* Shared SELECT for a student + joined report_summary. */
const _REPORT_SELECT = `
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
  LEFT JOIN report_summary rs ON rs.session_id = s.session_id`;

/* ─── Report lookup by session_id ───────────────────────────────── */
async function getReportBySessionId(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const student = await pg.one(`${_REPORT_SELECT} WHERE s.session_id = $1 LIMIT 1`, [sid]);
  if (!student) return null;
  return _buildReportPayload(student);
}

/* ─── Report lookup by email ────────────────────────────────────── */
async function getReportByEmail(email) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return null;

  const cached = _reportCacheGet(norm);
  if (cached !== undefined) return cached;

  const student = await pg.one(
    `${_REPORT_SELECT} WHERE s.email = $1 ORDER BY s.registered_at DESC LIMIT 1`,
    [norm]
  );
  if (!student) { _reportCacheSet(norm, null); return null; }

  const result = await _buildReportPayload(student);
  _reportCacheSet(norm, result);
  return result;
}

/* Shared assembly for both lookup paths (email + session_id). */
async function _buildReportPayload(student) {
  let [personality, aptitude, interests, seaa, careers] = await Promise.all([
    pg.many(`SELECT name, stanine, band FROM report_personality WHERE session_id = $1 ORDER BY position`, [student.session_id]),
    pg.many(`SELECT key, name, stanine, band, raw_score, max_score FROM report_aptitude WHERE session_id = $1 ORDER BY position`, [student.session_id]),
    pg.many(`SELECT label, score, level FROM report_interests WHERE session_id = $1 ORDER BY rank`, [student.session_id]),
    pg.many(`SELECT key, title, score, category, cat_label FROM report_seaa WHERE session_id = $1`, [student.session_id]),
    pg.many(`SELECT career, alignment, suitability_pct, rationale FROM report_careers WHERE session_id = $1 ORDER BY position`, [student.session_id]),
  ]);

  // Legacy backfill: derive missing child sections from raw assessment scores.
  if (!personality.length || !aptitude.length || !interests.length || !seaa.length || !careers.length) {
    try {
      const row = await pg.one('SELECT * FROM assessments WHERE session_id = $1', [student.session_id]);
      if (row) {
        const derived = require('./db.js').deriveDisplayRowsFromAssessmentRow(row);
        if (!personality.length && derived.personality.length) personality = derived.personality;
        if (!aptitude.length    && derived.aptitude.length)    aptitude    = derived.aptitude;
        if (!interests.length   && derived.interests.length)   interests   = derived.interests;
        if (!seaa.length        && derived.seaa.length)        seaa        = derived.seaa;
        // Careers backfill: map derived rows to the same 4-field shape the DB
        // query returns, so both paths hand the renderers an identical shape.
        if (!careers.length     && derived.careers.length) {
          careers = derived.careers.map(c => ({
            career:          c.career,
            alignment:       c.alignment,
            suitability_pct: c.suitability_pct,
            rationale:       c.rationale,
          }));
        }
      }
    } catch (_) { /* best-effort — never fail the report for a backfill */ }
  }

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

/* ─── Longitudinal journey (delegates to db.js) ─────────────────── */
async function getJourney(email) {
  return require('./db.js').getJourney(email);
}

/* ─── Student question insights (staff dashboards) ──────────────────
   Surfaces what a student has been asking Aria so a counsellor / super
   admin can understand what they're going through: their questions, the
   recurring themes, and the rolling AI summaries. Read-only over data
   the student has already generated in their own counsellor chats. */
const _THEME_RULES = [
  { key:'streams',   label:'Stream & Subjects',    rx:/\b(stream|science|commerce|arts|humanit|subject|pcm|pcb|biology|which stream)\b/i },
  { key:'exams',     label:'Exams & Entrance',     rx:/\b(jee|neet|boards?|cuet|clat|nda|cat|gate|upsc|olympiad|entrance|exam|marks|percentage|cut-?off)\b/i },
  { key:'careers',   label:'Careers & Jobs',       rx:/\b(career|job|profession|salary|scope|which field|what should i (become|do)|future)\b/i },
  { key:'colleges',  label:'Colleges & Courses',   rx:/\b(college|university|course|degree|admission|iit|nit|iim|aiims|placement)\b/i },
  { key:'wellbeing', label:'Stress & Wellbeing',   rx:/\b(stress|anxi|pressure|scared|afraid|worried|worry|overwhelm|depress|panic|nervous|failure|tension|burnout|demotivat|can'?t focus)\b/i },
  { key:'family',    label:'Family & Peers',       rx:/\b(parents?|father|mother|mom|dad|family|expectation|compare|friends?|peer|classmate)\b/i },
  { key:'prep',      label:'Study & Prep',         rx:/\b(how (do|to) (i )?(study|prepare)|study plan|improve|practice|coaching|time-?table|revision|concentrate|skill)\b/i },
  { key:'confusion', label:'Confused / Undecided', rx:/\b(confus|not sure|don'?t know|undecided|can'?t decide|which (one|option)|help me choose|feeling lost)\b/i },
];

function _classifyThemes(texts) {
  const counts = {};
  for (const t of texts) {
    const s = String(t || '');
    if (!s) continue;
    for (const rule of _THEME_RULES) {
      if (rule.rx.test(s)) counts[rule.key] = (counts[rule.key] || 0) + 1;
    }
  }
  return _THEME_RULES
    .filter(r => counts[r.key])
    .map(r => ({ key: r.key, label: r.label, count: counts[r.key] }))
    .sort((a, b) => b.count - a.count);
}

async function getStudentInsights(email, { questionLimit = 25, scanLimit = 300 } = {}) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return { totalQuestions: 0, questions: [], themes: [], summaries: [], lastActivity: null };

  const rows = await pg.many(
    `SELECT content, created_at, conversation_id
       FROM chat_history
      WHERE email = $1 AND role = 'user'
      ORDER BY created_at DESC
      LIMIT $2`,
    [norm, Math.min(scanLimit, 1000)]
  );
  const totalRow = await pg.one(
    `SELECT COUNT(*)::int AS n FROM chat_history WHERE email = $1 AND role = 'user'`,
    [norm]
  );
  const themes    = _classifyThemes(rows.map(r => r.content));
  const questions = rows.slice(0, questionLimit).map(r => ({
    text: String(r.content || '').slice(0, 500),
    at:   r.created_at,
    conversation_id: r.conversation_id,
  }));
  const summaries = await pg.many(
    `SELECT conversation_id, summary, message_count, updated_at
       FROM conversation_summaries
      WHERE email = $1
      ORDER BY updated_at DESC
      LIMIT 8`,
    [norm]
  );
  return {
    totalQuestions: totalRow ? totalRow.n : 0,
    questions,
    themes,
    summaries,
    lastActivity: rows.length ? rows[0].created_at : null,
  };
}

/* ─── Check if student has completed assessment (by email) ──────── */
async function hasCompletedAssessment(email) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return false;
  const row = await pg.one(
    `SELECT 1 FROM students s
     LEFT JOIN assessments a      ON a.session_id  = s.session_id
     LEFT JOIN report_summary rs  ON rs.session_id = s.session_id
     WHERE s.email = $1
       AND (
         rs.session_id IS NOT NULL
         OR (
           a.nmap_scores_json    IS NOT NULL AND
           a.cpi_scores_json     IS NOT NULL AND
           a.sea_scores_json     IS NOT NULL AND
           a.daab_va_scores_json IS NOT NULL
         )
         OR s.completed_at IS NOT NULL
         OR a.session_id IS NOT NULL
       )
     LIMIT 1`,
    [norm]
  );
  return !!row;
}

/* ─── Chat history ──────────────────────────────────────────────── */
async function saveMessage({ email, sessionId, conversationId, role, content }) {
  const row = await pg.one(
    `INSERT INTO chat_history (email, session_id, conversation_id, role, content, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id`,
    [
      String(email || '').toLowerCase().slice(0, 200),
      sessionId      ? String(sessionId).slice(0, 64)      : null,
      conversationId ? String(conversationId).slice(0, 64) : null,
      role === 'assistant' ? 'assistant' : 'user',
      String(content || '').slice(0, 16000),
      new Date().toISOString(),
    ]
  );
  return row ? row.id : null;
}

async function getHistory(email, { limit = 60, conversationId } = {}) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return [];
  let rows;
  if (conversationId) {
    rows = await pg.many(
      `SELECT role, content, created_at, conversation_id FROM chat_history
       WHERE email = $1 AND conversation_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [norm, conversationId, limit]
    );
  } else {
    rows = await pg.many(
      `SELECT role, content, created_at, conversation_id FROM chat_history
       WHERE email = $1
       ORDER BY created_at DESC LIMIT $2`,
      [norm, limit]
    );
  }
  return rows.reverse();
}

async function getConversations(email) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return [];
  const convs = await pg.many(
    `SELECT
       ch.conversation_id,
       (SELECT c2.content FROM chat_history c2
        WHERE c2.email = ch.email
          AND c2.conversation_id = ch.conversation_id
          AND c2.role = 'user'
        ORDER BY c2.created_at ASC, c2.id ASC LIMIT 1) AS first_user_msg,
       MAX(ch.created_at)                              AS last_at,
       COUNT(*)                                        AS message_count
     FROM chat_history ch
     WHERE ch.email = $1 AND ch.conversation_id IS NOT NULL
     GROUP BY ch.conversation_id, ch.email
     ORDER BY last_at DESC
     LIMIT 20`,
    [norm]
  );
  return convs.map(c => ({
    conversation_id: c.conversation_id,
    title: c.first_user_msg
      ? (c.first_user_msg.substring(0, 42) + (c.first_user_msg.length > 42 ? '…' : ''))
      : 'Conversation',
    last_at:       c.last_at,
    message_count: Number(c.message_count),
  }));
}

async function clearHistory(email) {
  const norm = String(email || '').toLowerCase().trim();
  await pg.exec(`DELETE FROM chat_history WHERE email = $1`, [norm]);
}

/* ─── Conversation summaries ────────────────────────────────────── */
async function saveConversationSummary({ email, conversationId, summary, messageCount }) {
  const norm = String(email || '').toLowerCase().trim();
  const now  = new Date().toISOString();
  await pg.exec(
    `INSERT INTO conversation_summaries
       (email, conversation_id, summary, message_count, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email, conversation_id) DO UPDATE SET
       summary       = EXCLUDED.summary,
       message_count = EXCLUDED.message_count,
       updated_at    = EXCLUDED.updated_at`,
    [norm, String(conversationId).slice(0, 64), String(summary).slice(0, 8000), messageCount || 0, now, now]
  );
}

async function getConversationSummary(email, conversationId) {
  const norm = String(email || '').toLowerCase().trim();
  return pg.one(
    `SELECT summary, message_count, updated_at FROM conversation_summaries
     WHERE email = $1 AND conversation_id = $2`,
    [norm, String(conversationId)]
  );
}

/* ─── Persistent counsellor session tokens ──────────────────────── */
const COUNSELLOR_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

async function issueToken(email) {
  const token     = crypto.randomBytes(32).toString('hex');
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + COUNSELLOR_TTL_MS).toISOString();
  await pg.exec(
    `INSERT INTO counsellor_sessions (token, email, created_at, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [token, String(email).toLowerCase().trim(), now.toISOString(), expiresAt]
  );
  return token;
}

async function verifyToken(token) {
  if (!token) return null;
  const row = await pg.one(
    `SELECT email FROM counsellor_sessions WHERE token = $1 AND expires_at > $2`,
    [String(token), new Date().toISOString()]
  );
  return row ? row.email : null;
}

async function pruneTokens() {
  await pg.exec(`DELETE FROM counsellor_sessions WHERE expires_at <= $1`, [new Date().toISOString()]);
}

/* ─── Shared rate limiting (across PM2 workers via Postgres) ─────── */
async function rlCheck(scope, key, limit, windowMs) {
  const rlKey   = scope + ':' + String(key).slice(0, 200);
  const now     = new Date();
  const nowIso  = now.toISOString();
  const resetAt = new Date(now.getTime() + (windowMs || 3600000)).toISOString();

  // Atomic upsert + read inside one transaction — prevents two workers both
  // reading count=N before either writes N+1.
  let result;
  try {
    result = await pg.tx(async (c) => {
      await c.query(
        `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE SET
           count    = CASE WHEN rate_limits.reset_at <= $3 THEN 1       ELSE rate_limits.count + 1 END,
           reset_at = CASE WHEN rate_limits.reset_at <= $3 THEN $2      ELSE rate_limits.reset_at  END`,
        [rlKey, resetAt, nowIso]
      );
      const r = await c.query(`SELECT count, reset_at FROM rate_limits WHERE key = $1`, [rlKey]);
      return r.rows[0];
    });
  } catch (_) {
    return { allowed: true }; // fail open if DB errors
  }

  if (!result) return { allowed: true };

  if (result.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((new Date(result.reset_at) - now) / 1000));
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

async function rlPrune() {
  await pg.exec(`DELETE FROM rate_limits WHERE reset_at <= $1`, [new Date().toISOString()]);
}

/* ─── Student PIN auth ──────────────────────────────────────────── */
function _hashPin(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return salt + ':' + hash;
}

function _verifyPin(plain, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const candidate    = crypto.scryptSync(String(plain), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(candidate,'hex'), Buffer.from(hash,'hex'));
  } catch { return false; }
}

async function hasPinSet(email) {
  const norm = String(email||'').toLowerCase().trim();
  const row = await pg.one('SELECT 1 FROM student_pins WHERE email = $1', [norm]);
  return !!row;
}

async function clearStudentPin(email) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return false;
  const info = await pg.exec('DELETE FROM student_pins WHERE email = $1', [norm]);
  await pg.exec('DELETE FROM counsellor_sessions WHERE email = $1', [norm]); // revoke sessions
  return info.rowCount > 0;
}

async function verifyStudentPin(email, pin) {
  const norm = String(email||'').toLowerCase().trim();
  const row  = await pg.one('SELECT pin_hash FROM student_pins WHERE email = $1', [norm]);
  if (!row) return false;
  return _verifyPin(String(pin).trim(), row.pin_hash);
}

async function setStudentPin(email, pin) {
  const norm = String(email||'').toLowerCase().trim();
  const now  = new Date().toISOString();
  const hash = _hashPin(String(pin).trim());
  await pg.exec(
    `INSERT INTO student_pins (email, pin_hash, created_at, updated_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = EXCLUDED.updated_at`,
    [norm, hash, now, now]
  );
}

/* ─── OTPs ──────────────────────────────────────────────────────── */
const OTP_TTL_MS = 10 * 60 * 1000;

async function createOtp(email, purpose) {
  const norm      = String(email||'').toLowerCase().trim();
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();
  await pg.exec('UPDATE student_otps SET used = TRUE WHERE email = $1 AND purpose = $2 AND used = FALSE', [norm, purpose || 'register']);
  const plain   = String(Math.floor(100000 + crypto.randomInt(900000)));
  const otpHash = crypto.createHash('sha256').update(plain+norm).digest('hex');
  await pg.exec(
    `INSERT INTO student_otps (email, otp_hash, purpose, expires_at, used, created_at)
     VALUES ($1,$2,$3,$4,FALSE,$5)`,
    [norm, otpHash, purpose||'register', expiresAt, now.toISOString()]
  );
  return plain;
}

async function verifyOtp(email, otp, purpose) {
  const norm      = String(email||'').toLowerCase().trim();
  const plain     = String(otp||'').trim();
  const nowIso    = new Date().toISOString();
  const candidate = crypto.createHash('sha256').update(plain+norm).digest('hex');
  const row = await pg.one(
    `SELECT id, otp_hash FROM student_otps
     WHERE email = $1 AND purpose = $2 AND used = FALSE AND expires_at > $3
     ORDER BY created_at DESC LIMIT 1`,
    [norm, purpose||'register', nowIso]
  );
  if (!row) return false;
  let valid = false;
  try { valid = crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(row.otp_hash,'hex')); } catch { return false; }
  if (valid) await pg.exec('UPDATE student_otps SET used = TRUE WHERE id = $1', [row.id]);
  return valid;
}

async function pruneOtps() {
  const cutoff = new Date(Date.now() - OTP_TTL_MS*2).toISOString();
  await pg.exec('DELETE FROM student_otps WHERE expires_at <= $1 OR used = TRUE', [cutoff]);
}

/* ─── OTP stage tokens (DB-backed, cluster-safe) ───────────────── */
const OTP_STAGE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function issueOtpStageToken(email) {
  const token     = crypto.randomBytes(24).toString('hex');
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + OTP_STAGE_TTL_MS).toISOString();
  const norm      = String(email).toLowerCase().trim();
  await pg.exec('DELETE FROM otp_stage_tokens WHERE email = $1', [norm]);
  await pg.exec(
    'INSERT INTO otp_stage_tokens (token, email, created_at, expires_at) VALUES ($1,$2,$3,$4)',
    [token, norm, now.toISOString(), expiresAt]
  );
  return token;
}

async function verifyOtpStageToken(token, email) {
  if (!token || !email) return false;
  const norm = String(email).toLowerCase().trim();
  const row  = await pg.one(
    'SELECT token FROM otp_stage_tokens WHERE token = $1 AND email = $2 AND expires_at > $3',
    [String(token), norm, new Date().toISOString()]
  );
  if (!row) return false;
  await pg.exec('DELETE FROM otp_stage_tokens WHERE token = $1', [String(token)]); // single-use
  return true;
}

async function pruneOtpStageTokens() {
  await pg.exec('DELETE FROM otp_stage_tokens WHERE expires_at <= $1', [new Date().toISOString()]);
}

async function close() { /* pool owned by pg-core; nothing to do here */ }

module.exports = {
  init,
  saveQuery, listQueries, updateQuery,
  getReportByEmail, getReportBySessionId, hasCompletedAssessment, _invalidateReportCache,
  getJourney, getStudentInsights,
  saveMessage, getHistory, getConversations, clearHistory,
  saveConversationSummary, getConversationSummary,
  issueToken, verifyToken, pruneTokens,
  issueOtpStageToken, verifyOtpStageToken, pruneOtpStageTokens,
  rlCheck, rlPrune,
  hasPinSet, verifyStudentPin, setStudentPin, clearStudentPin,
  createOtp, verifyOtp, pruneOtps,
  close,
};
