/* ════════════════════════════════════════════════════════════════════
   counsellor-goals-db.js — NuMind MAPS
   --------------------------------------------------------------------
   Student "About me" custom context + milestones (Aria proposes,
   student accepts). Self-contained persistence layer on pg-core.js,
   matching the async conventions of counsellor-db.js.

   Tables are created by pg-core initSchema (see SCHEMA_SQL appended to
   pg-core.js): student_custom_context, student_milestones.

   Everything is keyed to the student's stable session_id, resolved from
   their (lowercased, CITEXT) email — the same identity the rest of the
   counsellor layer uses.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const pg = require('./pg-core.js');

const _norm = (email) => String(email || '').toLowerCase().trim();

/* Light email → session_id lookup (the full report assembly in
   counsellor-db.getReportByEmail is far heavier than we need here). */
async function _sessionIdFor(email) {
  const norm = _norm(email);
  if (!norm) return null;
  const row = await pg.one('SELECT session_id FROM students WHERE email = $1 LIMIT 1', [norm]);
  return row ? row.session_id : null;
}

const ALLOWED_FIELDS = ['goal', 'dream_career', 'constraints', 'strengths'];

/* ─── Custom context ("About me") ───────────────────────────────── */

/* Returns { fields: {...}, notes: '' } — always a usable shape, even when
   the student has never saved anything. */
async function getCustomContext(email) {
  const sid = await _sessionIdFor(email);
  if (!sid) return { fields: {}, notes: '' };
  const row = await pg.one(
    'SELECT fields, notes FROM student_custom_context WHERE session_id = $1 LIMIT 1',
    [sid]
  );
  if (!row) return { fields: {}, notes: '' };
  let fields = row.fields;
  if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch { fields = {}; } }
  return { fields: fields && typeof fields === 'object' ? fields : {}, notes: row.notes || '' };
}

/* Upsert. `fields` is filtered to the known labelled fields; `notes` is the
   free-text box. Both optional. */
async function saveCustomContext(email, { fields = {}, notes = '' } = {}) {
  const sid = await _sessionIdFor(email);
  if (!sid) return { ok: false, error: 'no_session' };

  const clean = {};
  ALLOWED_FIELDS.forEach((k) => {
    if (fields[k] != null) clean[k] = String(fields[k]).slice(0, 600);
  });
  const notesClean = String(notes || '').slice(0, 4000);

  await pg.exec(
    `INSERT INTO student_custom_context (session_id, fields, notes, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (session_id)
     DO UPDATE SET fields = EXCLUDED.fields, notes = EXCLUDED.notes, updated_at = now()`,
    [sid, JSON.stringify(clean), notesClean]
  );
  return { ok: true, fields: clean, notes: notesClean };
}

/* ─── Milestones ────────────────────────────────────────────────── */

function _rowToMilestone(r) {
  return {
    id:           Number(r.id),
    title:        r.title,
    detail:       r.detail || '',
    target_date:  r.target_date ? _dateStr(r.target_date) : null,
    status:       r.status,
    source:       r.source || 'aria',
    created_at:   r.created_at,
    completed_at: r.completed_at || null,
  };
}

function _dateStr(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch { return null; }
}

/* Active first (soonest target date), then completed (most recent first). */
async function getMilestones(email) {
  const sid = await _sessionIdFor(email);
  if (!sid) return [];
  const rows = await pg.many(
    `SELECT id, title, detail, target_date, status, source, created_at, completed_at
       FROM student_milestones
      WHERE session_id = $1
      ORDER BY (status = 'completed') ASC,
               COALESCE(target_date, DATE '2999-12-31') ASC,
               created_at ASC`,
    [sid]
  );
  return rows.map(_rowToMilestone);
}

/* Create a milestone. Used by the "Accept" action (source 'aria') and by
   any manual add (source 'student'). Validates + clamps the inputs. */
async function addMilestone(email, { title, detail = '', target_date = null, source = 'aria' } = {}) {
  const sid = await _sessionIdFor(email);
  if (!sid) return { ok: false, error: 'no_session' };

  const t = String(title || '').trim().slice(0, 120);
  if (!t) return { ok: false, error: 'title_required' };
  const d = String(detail || '').trim().slice(0, 500);
  const td = _validDate(target_date);
  const src = source === 'student' ? 'student' : 'aria';

  const row = await pg.one(
    `INSERT INTO student_milestones
       (session_id, title, detail, target_date, status, source, created_at)
     VALUES ($1, $2, $3, $4, 'active', $5, now())
     RETURNING id, title, detail, target_date, status, source, created_at, completed_at`,
    [sid, t, d, td, src]
  );
  return { ok: true, milestone: _rowToMilestone(row) };
}

/* Edit title/detail/target_date of an existing milestone (student's own). */
async function updateMilestone(email, id, { title, detail, target_date } = {}) {
  const sid = await _sessionIdFor(email);
  if (!sid) return { ok: false, error: 'no_session' };

  const sets = [];
  const params = [];
  let i = 1;
  if (title != null)       { sets.push(`title = $${i++}`);       params.push(String(title).trim().slice(0, 120)); }
  if (detail != null)      { sets.push(`detail = $${i++}`);      params.push(String(detail).trim().slice(0, 500)); }
  if (target_date !== undefined) {
    sets.push(`target_date = $${i++}`); params.push(_validDate(target_date));
    // A new/changed date means the student should be reminded again for it.
    sets.push(`reminder_sent_at = NULL`);
  }
  if (!sets.length) return { ok: false, error: 'nothing_to_update' };

  params.push(sid, Number(id));
  const row = await pg.one(
    `UPDATE student_milestones SET ${sets.join(', ')}
      WHERE session_id = $${i++} AND id = $${i}
      RETURNING id, title, detail, target_date, status, source, created_at, completed_at`,
    params
  );
  if (!row) return { ok: false, error: 'not_found' };
  return { ok: true, milestone: _rowToMilestone(row) };
}

/* Mark complete (or re-open). Ownership enforced by session_id. */
async function setMilestoneStatus(email, id, status) {
  const sid = await _sessionIdFor(email);
  if (!sid) return { ok: false, error: 'no_session' };
  const done = status === 'completed';
  const row = await pg.one(
    `UPDATE student_milestones
        SET status = $1,
            completed_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE session_id = $3 AND id = $4
      RETURNING id, title, detail, target_date, status, source, created_at, completed_at`,
    [done ? 'completed' : 'active', done, sid, Number(id)]
  );
  if (!row) return { ok: false, error: 'not_found' };
  return { ok: true, milestone: _rowToMilestone(row) };
}

async function deleteMilestone(email, id) {
  const sid = await _sessionIdFor(email);
  if (!sid) return { ok: false, error: 'no_session' };
  await pg.exec('DELETE FROM student_milestones WHERE session_id = $1 AND id = $2', [sid, Number(id)]);
  return { ok: true };
}

/* Milestones whose target_date is today or past and still active — used by
   the in-app "due" surfacing (and, later, an email reminder job). */
async function getDueMilestones(email) {
  const all = await getMilestones(email);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return all.filter((m) => {
    if (m.status === 'completed' || !m.target_date) return false;
    const d = new Date(m.target_date + 'T00:00:00');
    return d <= today;
  });
}

function _validDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* ─── Due-date email reminders (cluster-safe) ───────────────────────
   Atomically CLAIM up to `limit` due, active, not-yet-reminded milestones
   by stamping reminder_sent_at, then join students for the send. FOR UPDATE
   SKIP LOCKED + the reminder_sent_at stamp mean that with N cluster workers
   each milestone is handed to exactly one worker exactly once. */
async function claimDueMilestoneReminders(limit = 200) {
  const rows = await pg.many(
    `WITH claimed AS (
       UPDATE student_milestones sm
          SET reminder_sent_at = now()
        WHERE sm.id IN (
          SELECT id FROM student_milestones
           WHERE status = 'active'
             AND target_date IS NOT NULL
             AND target_date <= CURRENT_DATE
             AND reminder_sent_at IS NULL
           ORDER BY target_date
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING sm.id, sm.session_id, sm.title, sm.detail, sm.target_date
     )
     SELECT c.id, c.title, c.detail, c.target_date, s.email, s.first_name
       FROM claimed c
       JOIN students s ON s.session_id = c.session_id
      WHERE s.email IS NOT NULL`,
    [limit]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    detail: r.detail || '',
    target_date: _dateStr(r.target_date),
    email: r.email,
    firstName: r.first_name || 'there',
  }));
}

/* Release a claim so the next sweep retries — used when an email send fails. */
async function unclaimReminder(id) {
  await pg.exec('UPDATE student_milestones SET reminder_sent_at = NULL WHERE id = $1', [Number(id)]);
}

module.exports = {
  ALLOWED_FIELDS,
  getCustomContext,
  saveCustomContext,
  getMilestones,
  getDueMilestones,
  addMilestone,
  updateMilestone,
  setMilestoneStatus,
  deleteMilestone,
  claimDueMilestoneReminders,
  unclaimReminder,
};
