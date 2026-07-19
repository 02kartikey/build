/* ════════════════════════════════════════════════════════════════════
   db.js — NuMind MAPS  |  Core student/assessment/report layer (PostgreSQL)
   --------------------------------------------------------------------
   Async rewrite on top of pg-core.js. Public API is unchanged in name/shape
   but every DB-touching function is now `async` and returns a Promise.
   Callers in server.js already `await` the write path via _dbWrite, and the
   read path (getFullReport etc.) must now be awaited too.

   Conversions from the better-sqlite3 version:
     • @named params → $1,$2,… positional; helpers one()/many()/exec()/tx().
     • INSERT OR REPLACE → INSERT … ON CONFLICT … DO UPDATE (explicit keys).
     • is_fallback stored as BOOLEAN (was 0/1). CASE guards compare = FALSE.
     • db.transaction(fn)() → await tx(async (c) => { ... }).
     • Case-insensitive email now handled by CITEXT, so LOWER() wrappers on
       the email column are dropped (kept in JS .trim()/.toLowerCase() for
       normalisation of the stored value only).

   The pure derivation helpers (no DB access) are carried over verbatim.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const pg = require('./pg-core.js');

const MODULES = [
  'cpi', 'sea', 'nmap',
  'daab_va', 'daab_pa', 'daab_na', 'daab_lsa',
  'daab_hma', 'daab_ar', 'daab_ma', 'daab_sa',
];

/* One-time schema init. Kept name-compatible with the old _initDb(). */
let _schemaReady = null;
async function _initDb() {
  if (!_schemaReady) _schemaReady = pg.initSchema();
  await _schemaReady;
  return pg;
}

/* ══════════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════════ */

async function saveRegistration(student, sessionId) {
  if (!sessionId) throw new Error('saveRegistration: sessionId is required');
  await _initDb();
  const norm = String(student.email || '').toLowerCase().trim();
  const nowIso = new Date().toISOString();

  // Journey lock: a completed attempt is snapshotted per (email, class) in
  // report_history. A student may retake ONLY in a new class. We surface the
  // counts here so the client can gate same-class retakes and welcome-back a
  // returning student whose class has advanced.
  const cls = String(student.class || '').trim();
  const _hist = norm
    ? await pg.many(`SELECT class FROM report_history WHERE email = $1 ORDER BY attempt_no ASC`, [norm])
    : [];
  const attemptsCount = _hist.length;
  const attemptedThisClass = !!(cls && _hist.some(h => String(h.class || '').trim().toLowerCase() === cls.toLowerCase()));
  const _lock = {
    attemptsCount,
    attemptedThisClass,
    lastAttemptClass: attemptsCount ? _hist[_hist.length - 1].class : null,
  };

  try {
    return await pg.tx(async (c) => {
      // Atomic find-or-create keyed on email. Lookup + insert share one
      // transaction; the CITEXT unique-ish email index is the cross-process backstop.
      if (norm) {
        const existing = await _getStudentByEmailTx(c, norm);
        if (existing) {
          return { session_id: existing.session_id, existing: true, testTaken: existing.fit_tier != null, ..._lock };
        }
      }

      await c.query(
        `INSERT INTO students (
           session_id, first_name, last_name, full_name, class, section,
           school, school_state, school_city, age, gender, email, registered_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (session_id) DO UPDATE SET
           first_name   = EXCLUDED.first_name,
           last_name    = EXCLUDED.last_name,
           full_name    = EXCLUDED.full_name,
           class        = EXCLUDED.class,
           section      = EXCLUDED.section,
           school       = EXCLUDED.school,
           school_state = EXCLUDED.school_state,
           school_city  = EXCLUDED.school_city,
           age          = EXCLUDED.age,
           gender       = EXCLUDED.gender,
           email        = EXCLUDED.email
           -- registered_at intentionally omitted: preserved after first INSERT`,
        [
          sessionId,
          student.firstName || '',
          student.lastName  || '',
          student.fullName  || `${student.firstName || ''} ${student.lastName || ''}`.trim(),
          student.class       || '',
          student.section     || '',
          student.school      || '',
          student.schoolState || '',
          student.schoolCity  || '',
          String(student.age || ''),
          student.gender || '',
          norm,
          student.registeredAt || nowIso,
        ]
      );

      // Auto-register unseen school names. Best-effort — never fail registration.
      const schoolName = String(student.school || '').trim();
      if (schoolName) {
        try {
          const already = await c.query(
            `SELECT id FROM schools_registry WHERE name = $1`, [schoolName]
          );
          if (already.rowCount === 0) {
            await c.query(
              `INSERT INTO schools_registry (name, city, state, added_at, active)
               VALUES ($1,$2,$3,$4,TRUE)
               ON CONFLICT (name) DO NOTHING`,
              [schoolName, student.schoolCity || null, student.schoolState || null, nowIso]
            );
            try {
              await c.query(
                `INSERT INTO audit_log (user_id, user_email, action, target, detail, ip, ts)
                 VALUES (NULL, $1, 'school_auto_registered', $2, $3, NULL, $4)`,
                [
                  norm || 'unknown',
                  schoolName,
                  JSON.stringify({ city: student.schoolCity || null, state: student.schoolState || null, via: 'student_registration' }),
                  nowIso,
                ]
              );
            } catch (_) { /* audit_log unavailable — non-fatal */ }
          }
        } catch (_) { /* schools_registry unavailable — non-fatal */ }
      }

      return { session_id: sessionId, existing: false, testTaken: false, ..._lock };
    });
  } catch (e) {
    // Concurrent insert committed the same email first — reuse its row.
    // Postgres unique violation is SQLSTATE 23505.
    if (norm && (e.code === '23505')) {
      const row = await getStudentByEmail(norm);
      if (row) return { session_id: row.session_id, existing: true, testTaken: row.fit_tier != null, ..._lock };
    }
    throw e;
  }
}

async function saveSection(sessionId, moduleKey, payload) {
  if (!sessionId)                   throw new Error('saveSection: sessionId is required');
  if (!MODULES.includes(moduleKey)) throw new Error('saveSection: unknown module ' + moduleKey);
  await _initDb();

  const now = new Date().toISOString();
  const p   = payload || {};
  const dur = Math.floor(p.duration || 0);

  await pg.tx(async (c) => {
    await c.query(
      `INSERT INTO assessments (session_id, saved_at) VALUES ($1,$2)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, now]
    );
    await c.query(
      `UPDATE assessments SET
         ${moduleKey}_raw_answers      = $2,
         ${moduleKey}_scores_json      = $3,
         ${moduleKey}_duration_seconds = $4,
         ${moduleKey}_completed_at     = $5,
         saved_at                      = $6
       WHERE session_id = $1`,
      [
        sessionId,
        JSON.stringify(p.raw_answers ?? null),
        JSON.stringify(p.scores      ?? null),
        dur,
        now,
        now,
      ]
    );
    await c.query(
      `INSERT INTO section_progress (session_id, module_key, submitted_at, duration_seconds)
       VALUES ($1,$2,$3,$4)`,
      [sessionId, moduleKey, now, dur]
    );
  });
}

async function saveReport({ sessionId, student, assessments, report }) {
  if (!sessionId) throw new Error('saveReport: sessionId is required');
  await _initDb();
  const now = new Date().toISOString();

  await pg.tx(async (c) => {
    /* 1) Student */
    if (student) {
      const norm = String(student.email || '').toLowerCase().trim();
      await c.query(
        `INSERT INTO students (
           session_id, first_name, last_name, full_name, class, section,
           school, school_state, school_city, age, gender, email, registered_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (session_id) DO UPDATE SET
           first_name   = EXCLUDED.first_name,
           last_name    = EXCLUDED.last_name,
           full_name    = EXCLUDED.full_name,
           class        = EXCLUDED.class,
           section      = EXCLUDED.section,
           school       = EXCLUDED.school,
           school_state = EXCLUDED.school_state,
           school_city  = EXCLUDED.school_city,
           age          = EXCLUDED.age,
           gender       = EXCLUDED.gender,
           email        = EXCLUDED.email`,
        [
          sessionId,
          student.firstName || '',
          student.lastName  || '',
          student.fullName  || `${student.firstName || ''} ${student.lastName || ''}`.trim(),
          student.class       || '',
          student.section     || '',
          student.school      || '',
          student.schoolState || '',
          student.schoolCity  || '',
          String(student.age || ''),
          student.gender || '',
          norm,
          student.registeredAt || now,
        ]
      );
    }

    /* 2) Assessments */
    if (assessments && typeof assessments === 'object') {
      await c.query(
        `INSERT INTO assessments (session_id, saved_at) VALUES ($1,$2)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, now]
      );
      for (const m of MODULES) {
        let p = assessments[m];
        if (!p && m.startsWith('daab_') && assessments.daab) p = assessments.daab[m.slice(5)];
        if (!p) continue;
        await c.query(
          `UPDATE assessments SET
             ${m}_raw_answers      = $2,
             ${m}_scores_json      = $3,
             ${m}_duration_seconds = $4,
             ${m}_completed_at     = $5,
             saved_at              = $6
           WHERE session_id = $1`,
          [
            sessionId,
            JSON.stringify(p.raw_answers ?? null),
            JSON.stringify(p.scores      ?? null),
            Math.floor(p.duration || 0),
            p.completed_at || now,
            now,
          ]
        );
      }
    }

    /* 3) Derive display rows (pure, no DB) */
    const personality = _derivePersonality(assessments || {});
    const aptitude    = _deriveAptitude(assessments    || {});
    const interests   = _deriveInterests(assessments   || {});
    const seaa        = _deriveSeaa(assessments        || {});
    const careers     = _deriveCareers(report          || {}, interests);

    /* 4) Child-table upserts */
    for (const row of personality) {
      await c.query(
        `INSERT INTO report_personality (session_id, position, name, stanine, band)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (session_id, position) DO UPDATE SET
           name = EXCLUDED.name, stanine = EXCLUDED.stanine, band = EXCLUDED.band`,
        [sessionId, row.position, row.name, row.stanine, row.band]
      );
    }
    for (const row of aptitude) {
      await c.query(
        `INSERT INTO report_aptitude (session_id, position, key, name, stanine, band, raw_score, max_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (session_id, key) DO UPDATE SET
           position = EXCLUDED.position, name = EXCLUDED.name, stanine = EXCLUDED.stanine,
           band = EXCLUDED.band, raw_score = EXCLUDED.raw_score, max_score = EXCLUDED.max_score`,
        [sessionId, row.position, row.key, row.name, row.stanine, row.band, row.raw_score, row.max_score]
      );
    }
    for (const row of interests) {
      await c.query(
        `INSERT INTO report_interests (session_id, rank, label, score, level)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (session_id, rank) DO UPDATE SET
           label = EXCLUDED.label, score = EXCLUDED.score, level = EXCLUDED.level`,
        [sessionId, row.rank, row.label, row.score, row.level]
      );
    }
    for (const row of seaa) {
      await c.query(
        `INSERT INTO report_seaa (session_id, key, title, score, category, cat_label)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (session_id, key) DO UPDATE SET
           title = EXCLUDED.title, score = EXCLUDED.score,
           category = EXCLUDED.category, cat_label = EXCLUDED.cat_label`,
        [sessionId, row.key, row.title, row.score, row.category, row.cat_label]
      );
    }
    // Careers are position-keyed; clear then re-insert inside the same tx.
    await c.query(`DELETE FROM report_careers WHERE session_id = $1`, [sessionId]);
    for (const row of careers) {
      await c.query(
        `INSERT INTO report_careers (
           session_id, position, career, cluster,
           interest_fit, aptitude_fit, personality_fit, seaa_fit,
           suitability_pct, alignment, rationale
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          sessionId, row.position, row.career, row.cluster,
          row.interest_fit, row.aptitude_fit, row.personality_fit, row.seaa_fit,
          row.suitability_pct, row.alignment, row.rationale,
        ]
      );
    }

    /* 5) Report summary (fallback prose-preservation guard) */
    if (report && typeof report === 'object') {
      const PROSE_FIELDS = [
        'holistic_summary','aptitude_profile','interest_profile',
        'internal_motivators','personality_profile','wellbeing_guidance','stream_advice',
      ];
      const missing = PROSE_FIELDS.filter(f => !report[f]);
      if (missing.length) process.stderr.write('[WARN]  [DB] saveReport: missing AI fields for ' + sessionId + ' — ' + missing.join(', ') + '\n');

      const summary    = _deriveSummary(personality, aptitude, interests, seaa, careers, report);
      const isFallback = !!report._fallback;

      await c.query(
        `INSERT INTO report_summary (
           session_id, generated_at, is_fallback,
           holistic_summary, aptitude_profile, interest_profile,
           internal_motivators, personality_profile, wellbeing_guidance, stream_advice,
           avg_personality_stanine, avg_aptitude_stanine, top_interest_score,
           fit_score, fit_tier,
           personality_status, aptitude_status, interest_status, seaa_status,
           strong_fit_pathways, emerging_fit_pathways, exploratory_pathways,
           recommended_primary, recommended_alternate, recommended_exploratory,
           top_personality_traits_json, strong_aptitudes_json, emerging_aptitudes_json,
           top3_interests_json
         ) VALUES (
           $1,$2,$3,
           $4,$5,$6,
           $7,$8,$9,$10,
           $11,$12,$13,
           $14,$15,
           $16,$17,$18,$19,
           $20,$21,$22,
           $23,$24,$25,
           $26,$27,$28,
           $29
         )
         ON CONFLICT (session_id) DO UPDATE SET
           generated_at = EXCLUDED.generated_at,
           is_fallback  = EXCLUDED.is_fallback,
           holistic_summary    = CASE WHEN EXCLUDED.is_fallback = FALSE THEN EXCLUDED.holistic_summary    ELSE report_summary.holistic_summary    END,
           aptitude_profile    = CASE WHEN EXCLUDED.is_fallback = FALSE THEN EXCLUDED.aptitude_profile    ELSE report_summary.aptitude_profile    END,
           interest_profile    = CASE WHEN EXCLUDED.is_fallback = FALSE THEN EXCLUDED.interest_profile    ELSE report_summary.interest_profile    END,
           internal_motivators = CASE WHEN EXCLUDED.is_fallback = FALSE THEN EXCLUDED.internal_motivators ELSE report_summary.internal_motivators END,
           personality_profile = CASE WHEN EXCLUDED.is_fallback = FALSE THEN EXCLUDED.personality_profile ELSE report_summary.personality_profile END,
           wellbeing_guidance  = CASE WHEN EXCLUDED.is_fallback = FALSE THEN EXCLUDED.wellbeing_guidance  ELSE report_summary.wellbeing_guidance  END,
           stream_advice       = CASE WHEN EXCLUDED.is_fallback = FALSE THEN EXCLUDED.stream_advice       ELSE report_summary.stream_advice       END,
           avg_personality_stanine     = EXCLUDED.avg_personality_stanine,
           avg_aptitude_stanine        = EXCLUDED.avg_aptitude_stanine,
           top_interest_score          = EXCLUDED.top_interest_score,
           fit_score                   = EXCLUDED.fit_score,
           fit_tier                    = EXCLUDED.fit_tier,
           personality_status          = EXCLUDED.personality_status,
           aptitude_status             = EXCLUDED.aptitude_status,
           interest_status             = EXCLUDED.interest_status,
           seaa_status                 = EXCLUDED.seaa_status,
           strong_fit_pathways         = EXCLUDED.strong_fit_pathways,
           emerging_fit_pathways       = EXCLUDED.emerging_fit_pathways,
           exploratory_pathways        = EXCLUDED.exploratory_pathways,
           recommended_primary         = EXCLUDED.recommended_primary,
           recommended_alternate       = EXCLUDED.recommended_alternate,
           recommended_exploratory     = EXCLUDED.recommended_exploratory,
           top_personality_traits_json = EXCLUDED.top_personality_traits_json,
           strong_aptitudes_json       = EXCLUDED.strong_aptitudes_json,
           emerging_aptitudes_json     = EXCLUDED.emerging_aptitudes_json,
           top3_interests_json         = EXCLUDED.top3_interests_json`,
        [
          sessionId, now, isFallback,
          report.holistic_summary    || '',
          report.aptitude_profile    || '',
          report.interest_profile    || '',
          report.internal_motivators || '',
          report.personality_profile || '',
          report.wellbeing_guidance  || '',
          report.stream_advice       || '',
          summary.avg_personality_stanine,
          summary.avg_aptitude_stanine,
          summary.top_interest_score,
          summary.fit_score,
          summary.fit_tier,
          summary.personality_status,
          summary.aptitude_status,
          summary.interest_status,
          summary.seaa_status,
          summary.strong_fit_pathways,
          summary.emerging_fit_pathways,
          summary.exploratory_pathways,
          summary.recommended_primary,
          summary.recommended_alternate,
          summary.recommended_exploratory,
          summary.top_personality_traits_json,
          summary.strong_aptitudes_json,
          summary.emerging_aptitudes_json,
          summary.top3_interests_json,
        ]
      );

      await c.query(`UPDATE students SET report_generated_at = $2 WHERE session_id = $1`, [sessionId, now]);

      /* 5b) Longitudinal snapshot — one immutable row per (email, class).
         Powers the growth-journey mapping and the same-class retake lock,
         without disturbing the live report_* tables (which hold the latest). */
      const _who   = (await c.query(`SELECT email, class FROM students WHERE session_id = $1`, [sessionId])).rows[0] || {};
      const _email = String(_who.email || '').toLowerCase().trim();
      const _cls   = String(_who.class  || '').trim();
      if (_email && _cls) {
        const _metrics = {
          aptitude:    aptitude.map(a    => ({ key: a.key, name: a.name, stanine: a.stanine })),
          personality: personality.map(p => ({ name: p.name, stanine: p.stanine })),
          interests:   interests.slice(0, 5).map(i => ({ label: i.label, score: i.score, level: i.level })),
          seaa:        seaa.map(s        => ({ key: s.key, title: s.title, cat_label: s.cat_label })),
        };
        // Stable attempt number: reuse this class's number, else next in sequence.
        const _ex = (await c.query(`SELECT attempt_no FROM report_history WHERE email = $1 AND class = $2`, [_email, _cls])).rows[0];
        let _attemptNo;
        if (_ex) {
          _attemptNo = _ex.attempt_no;
        } else {
          const _cnt = (await c.query(`SELECT COUNT(*)::int AS n FROM report_history WHERE email = $1`, [_email])).rows[0];
          _attemptNo = (_cnt ? _cnt.n : 0) + 1;
        }
        await c.query(
          `INSERT INTO report_history (
             email, session_id, class, attempt_no, generated_at,
             fit_score, fit_tier, avg_personality_stanine, avg_aptitude_stanine, top_interest_score,
             personality_status, aptitude_status, interest_status, seaa_status,
             recommended_primary, metrics_json
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (email, class) DO UPDATE SET
             session_id              = EXCLUDED.session_id,
             generated_at            = EXCLUDED.generated_at,
             fit_score               = EXCLUDED.fit_score,
             fit_tier                = EXCLUDED.fit_tier,
             avg_personality_stanine = EXCLUDED.avg_personality_stanine,
             avg_aptitude_stanine    = EXCLUDED.avg_aptitude_stanine,
             top_interest_score      = EXCLUDED.top_interest_score,
             personality_status      = EXCLUDED.personality_status,
             aptitude_status         = EXCLUDED.aptitude_status,
             interest_status         = EXCLUDED.interest_status,
             seaa_status             = EXCLUDED.seaa_status,
             recommended_primary     = EXCLUDED.recommended_primary,
             metrics_json            = EXCLUDED.metrics_json`,
          [
            _email, sessionId, _cls, _attemptNo, now,
            summary.fit_score, summary.fit_tier,
            summary.avg_personality_stanine, summary.avg_aptitude_stanine, summary.top_interest_score,
            summary.personality_status, summary.aptitude_status, summary.interest_status, summary.seaa_status,
            summary.recommended_primary, JSON.stringify(_metrics),
          ]
        );
      }
    } else {
      process.stderr.write('[WARN]  [DB] saveReport: no report object for session ' + sessionId + '\n');
    }

    /* 6) Mark completed */
    await c.query(`UPDATE students SET completed_at = $2 WHERE session_id = $1`, [sessionId, now]);
  });
}

/* Read-time derivation from a raw assessments row (columns *_scores_json).
   Pure — no DB access. Unchanged from the SQLite version. */
function deriveDisplayRowsFromAssessmentRow(row) {
  if (!row) return { personality: [], aptitude: [], interests: [], seaa: [], careers: [] };
  const jp = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const a = {
    cpi:  { scores: jp(row.cpi_scores_json) },
    sea:  { scores: jp(row.sea_scores_json) },
    nmap: { scores: jp(row.nmap_scores_json) },
  };
  for (const k of ['va','pa','na','lsa','hma','ar','ma','sa'])
    a['daab_' + k] = { scores: jp(row['daab_' + k + '_scores_json']) };
  const interests = _deriveInterests(a);
  return {
    personality: row.nmap_scores_json ? _derivePersonality(a) : [],
    aptitude:    Object.keys(a).some(k => k.startsWith('daab_') && a[k].scores) ? _deriveAptitude(a) : [],
    interests,
    seaa:        row.sea_scores_json ? _deriveSeaa(a) : [],
    // Careers backfill mirrors the other sections: with no AI career_table in a
    // raw assessment row, _deriveCareers falls back to the interest-derived
    // clusters. Empty interests → empty careers (nothing to derive from).
    careers:     interests.length ? _deriveCareers({}, interests) : [],
  };
}

async function getFullReport(sessionId) {
  await _initDb();
  const [student, assessments, summary, personality, aptitude, interests, seaa, careers] = await Promise.all([
    pg.one(`SELECT * FROM students          WHERE session_id = $1`, [sessionId]),
    pg.one(`SELECT * FROM assessments       WHERE session_id = $1`, [sessionId]),
    pg.one(`SELECT * FROM report_summary    WHERE session_id = $1`, [sessionId]),
    pg.many(`SELECT * FROM report_personality WHERE session_id = $1 ORDER BY position`, [sessionId]),
    pg.many(`SELECT * FROM report_aptitude    WHERE session_id = $1 ORDER BY position`, [sessionId]),
    pg.many(`SELECT * FROM report_interests   WHERE session_id = $1 ORDER BY rank`,     [sessionId]),
    pg.many(`SELECT * FROM report_seaa        WHERE session_id = $1`,                   [sessionId]),
    pg.many(`SELECT * FROM report_careers     WHERE session_id = $1 ORDER BY position`, [sessionId]),
  ]);
  return { student, assessments, summary, personality, aptitude, interests, seaa, careers };
}

async function getSectionProgress(sessionId) {
  await _initDb();
  return pg.many(
    `SELECT module_key, submitted_at, duration_seconds
     FROM section_progress WHERE session_id = $1 ORDER BY id ASC`,
    [sessionId]
  );
}

/* Shared email → student+summary snapshot query (used in and out of tx). */
const _EMAIL_LOOKUP_SQL = `
  SELECT s.*, rs.fit_tier, rs.fit_score, rs.recommended_primary, rs.seaa_status
  FROM students s
  LEFT JOIN report_summary rs ON rs.session_id = s.session_id
  WHERE s.email = $1
  ORDER BY s.registered_at DESC
  LIMIT 1`;

async function _getStudentByEmailTx(client, norm) {
  const r = await client.query(_EMAIL_LOOKUP_SQL, [norm]);
  return r.rows[0] || null;
}

async function getStudentByEmail(email) {
  if (!email) return null;
  await _initDb();
  return pg.one(_EMAIL_LOOKUP_SQL, [String(email).toLowerCase().trim()]);
}

async function resolveStudentByEmail(email) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return { session_id: null, exists: false, testTaken: false };
  await _initDb();
  const row = await pg.one(_EMAIL_LOOKUP_SQL, [norm]);
  if (!row) return { session_id: null, exists: false, testTaken: false };
  return { session_id: row.session_id, exists: true, testTaken: row.fit_tier != null };
}

async function getStudentBySessionId(sessionId) {
  if (!sessionId) return null;
  await _initDb();
  return pg.one(`SELECT * FROM students WHERE session_id = $1`, [String(sessionId)]);
}

/* ══════════════════════════════════════════════════════════════════
   JOURNEY — longitudinal growth across attempts (one per class)
   Returns the ordered attempt snapshots, rich deltas between each
   consecutive pair (aptitude/personality/interests/wellbeing changes,
   band crossings, status shifts, recommended-path changes, a direction
   and a plain-language narrative), and an overall first→latest summary.
   Consumed by the student banner, the AI counsellor (Aria), and staff
   dashboards.
══════════════════════════════════════════════════════════════════ */
const _JOURNEY_BAND = (s) => (typeof s === 'number' ? (s >= 7 ? 'Strength' : s >= 4 ? 'Developing' : 'Needs Attention') : null);
const _STATUS_RANK  = { 'Support Needed': 0, 'Needs Attention': 0, 'Emerging': 0, 'Developing': 1, 'Strength': 2, 'Strong': 2 };
const _readyRank = (s) => {
  const t = String(s || '').toLowerCase();
  if (t.includes('strong') || t.includes('high') || t.includes('secure') || t.includes('ready')) return 2;
  if (t.includes('support') || t.includes('needs') || t.includes('low') || t.includes('concern') || t.includes('risk')) return 0;
  return 1;
};

function _dimDeltas(prevArr, curArr, keyField) {
  const prevMap = {};
  (prevArr || []).forEach(x => { prevMap[x[keyField]] = x.stanine; });
  return (curArr || [])
    .filter(x => typeof prevMap[x[keyField]] === 'number' && typeof x.stanine === 'number' && x.stanine !== prevMap[x[keyField]])
    .map(x => {
      const from = prevMap[x[keyField]], to = x.stanine, fb = _JOURNEY_BAND(from), tb = _JOURNEY_BAND(to);
      return { key: x.key, name: x.name || x[keyField], from, to, delta: to - from, from_band: fb, to_band: tb, crossed: fb !== tb };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

function _interestDeltas(prevArr, curArr) {
  const prevMap = {};
  (prevArr || []).forEach(i => { prevMap[i.label] = i.score; });
  const changes = (curArr || [])
    .filter(i => typeof prevMap[i.label] === 'number' && typeof i.score === 'number' && i.score !== prevMap[i.label])
    .map(i => ({ label: i.label, from: prevMap[i.label], to: i.score, delta: i.score - prevMap[i.label] }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const pTop = (prevArr && prevArr[0]) ? prevArr[0].label : null;
  const cTop = (curArr && curArr[0]) ? curArr[0].label : null;
  return { changes, shift: (pTop && cTop && pTop !== cTop) ? { from_label: pTop, to_label: cTop } : null };
}

function _seaaDeltas(prevArr, curArr) {
  const prevMap = {};
  (prevArr || []).forEach(s => { prevMap[s.key] = s.cat_label; });
  return (curArr || [])
    .filter(s => prevMap[s.key] && s.cat_label && s.cat_label !== prevMap[s.key])
    .map(s => ({ key: s.key, title: s.title, from: prevMap[s.key], to: s.cat_label, up: _readyRank(s.cat_label) > _readyRank(prevMap[s.key]) }));
}

function _statusDeltas(prev, cur) {
  const out = [];
  [['Personality', 'personality_status'], ['Aptitude', 'aptitude_status'], ['Interests', 'interest_status'], ['Wellbeing', 'seaa_status']]
    .forEach(([dimension, f]) => {
      if (prev[f] && cur[f] && prev[f] !== cur[f]) {
        out.push({ dimension, from: prev[f], to: cur[f], up: (_STATUS_RANK[cur[f]] || 0) > (_STATUS_RANK[prev[f]] || 0) });
      }
    });
  return out;
}

function _transitionDirection(d) {
  const gains = d.aptitude_changes.filter(c => c.delta > 0).length + d.personality_changes.filter(c => c.delta > 0).length + d.seaa_changes.filter(s => s.up).length;
  const drops = d.aptitude_changes.filter(c => c.delta < 0).length + d.personality_changes.filter(c => c.delta < 0).length + d.seaa_changes.filter(s => !s.up).length;
  const fit = typeof d.fit_score_delta === 'number' ? d.fit_score_delta : 0;
  if (fit > 3 || (gains - drops) >= 3) return 'improved';
  if (fit < -3 || (drops - gains) >= 3) return 'declined';
  if (gains > drops) return 'improved';
  if (drops > gains) return 'mixed';
  return 'steady';
}

function _transitionNarrative(d) {
  const P = [];
  if (typeof d.fit_score_delta === 'number' && d.fit_score_delta !== 0) {
    const n = Math.abs(d.fit_score_delta);
    P.push(`Overall fit ${d.fit_score_delta > 0 ? 'rose' : 'dropped'} ${n} point${n === 1 ? '' : 's'}${d.fit_tier_from !== d.fit_tier_to ? ` (${d.fit_tier_from} → ${d.fit_tier_to})` : ''}.`);
  }
  const crossedUp = d.aptitude_changes.filter(c => c.crossed && c.delta > 0);
  const gains = d.aptitude_changes.filter(c => c.delta > 0);
  const drops = d.aptitude_changes.filter(c => c.delta < 0);
  if (crossedUp.length) P.push(`New aptitude strength${crossedUp.length > 1 ? 's' : ''}: ${crossedUp.slice(0, 3).map(c => `${c.name} (${c.from_band} → ${c.to_band})`).join(', ')}.`);
  else if (gains.length) P.push(`Aptitude gains: ${gains.slice(0, 3).map(c => `${c.name} (+${c.delta})`).join(', ')}.`);
  const persUp = d.personality_changes.filter(c => c.delta > 0);
  if (persUp.length) P.push(`Personality growth in ${persUp.slice(0, 2).map(c => c.name).join(', ')}.`);
  const wellUp = d.seaa_changes.filter(s => s.up);
  const wellDown = d.seaa_changes.filter(s => !s.up);
  if (wellUp.length) P.push(`Social-emotional readiness improved in ${wellUp.slice(0, 2).map(s => s.title).join(', ')}.`);
  if (d.interest_shift) P.push(`Top interest shifted from ${d.interest_shift.from_label} to ${d.interest_shift.to_label}.`);
  if (d.pathway_change) P.push(`Recommended path updated from ${d.pathway_change.from} to ${d.pathway_change.to}.`);
  const watch = [];
  if (drops.length) watch.push(...drops.slice(0, 2).map(c => `${c.name} (${c.delta})`));
  if (wellDown.length) watch.push(...wellDown.slice(0, 1).map(s => s.title));
  if (watch.length) P.push(`To watch: ${watch.join(', ')}.`);
  return P.join(' ') || 'Scores held steady across this period, with no major shifts.';
}

function _highlightsOf(d) {
  const gains = [];
  d.aptitude_changes.filter(c => c.delta > 0).slice(0, 3).forEach(c => gains.push(`${c.name} ${c.crossed ? `(${c.from_band} → ${c.to_band})` : `(+${c.delta})`}`));
  d.seaa_changes.filter(s => s.up).slice(0, 2).forEach(s => gains.push(`${s.title} (${s.to})`));
  d.personality_changes.filter(c => c.delta > 0 && c.crossed).slice(0, 1).forEach(c => gains.push(`${c.name} (${c.from_band} → ${c.to_band})`));
  const watch = [];
  d.aptitude_changes.filter(c => c.delta < 0).slice(0, 2).forEach(c => watch.push(`${c.name} (${c.delta})`));
  d.seaa_changes.filter(s => !s.up).slice(0, 1).forEach(s => watch.push(`${s.title} (${s.to})`));
  return { gains, watch };
}

async function getJourney(email) {
  await _initDb();
  const norm = String(email || '').toLowerCase().trim();
  if (!norm) return { attempts: [], deltas: [], overall: null, has_journey: false };

  const rows = await pg.many(
    `SELECT class, attempt_no, generated_at, fit_score, fit_tier,
            avg_personality_stanine, avg_aptitude_stanine, top_interest_score,
            personality_status, aptitude_status, interest_status, seaa_status,
            recommended_primary, metrics_json
       FROM report_history
      WHERE email = $1
      ORDER BY attempt_no ASC, generated_at ASC`,
    [norm]
  );

  const attempts = rows.map(r => {
    const m = (r.metrics_json && typeof r.metrics_json === 'object') ? r.metrics_json : {};
    return {
      class:                   r.class,
      attempt_no:              r.attempt_no,
      generated_at:            r.generated_at,
      fit_score:               r.fit_score,
      fit_tier:                r.fit_tier,
      avg_personality_stanine: r.avg_personality_stanine,
      avg_aptitude_stanine:    r.avg_aptitude_stanine,
      top_interest_score:      r.top_interest_score,
      personality_status:      r.personality_status,
      aptitude_status:         r.aptitude_status,
      interest_status:         r.interest_status,
      seaa_status:             r.seaa_status,
      recommended_primary:     r.recommended_primary,
      aptitude:    Array.isArray(m.aptitude)    ? m.aptitude    : [],
      personality: Array.isArray(m.personality) ? m.personality : [],
      interests:   Array.isArray(m.interests)   ? m.interests   : [],
      seaa:        Array.isArray(m.seaa)        ? m.seaa        : [],
    };
  });

  const _d = (a, b) => (typeof a === 'number' && typeof b === 'number') ? Number((a - b).toFixed(2)) : null;

  const _pairDelta = (prev, cur) => {
    const intd = _interestDeltas(prev.interests, cur.interests);
    const d = {
      from_class: prev.class, to_class: cur.class,
      from_attempt: prev.attempt_no, to_attempt: cur.attempt_no,
      from_date: prev.generated_at, to_date: cur.generated_at,
      fit_score_from: prev.fit_score, fit_score_to: cur.fit_score, fit_score_delta: _d(cur.fit_score, prev.fit_score),
      fit_tier_from: prev.fit_tier, fit_tier_to: cur.fit_tier,
      avg_aptitude_delta:    _d(cur.avg_aptitude_stanine, prev.avg_aptitude_stanine),
      avg_personality_delta: _d(cur.avg_personality_stanine, prev.avg_personality_stanine),
      top_interest_delta:    _d(cur.top_interest_score, prev.top_interest_score),
      aptitude_changes:    _dimDeltas(prev.aptitude, cur.aptitude, 'key'),
      personality_changes: _dimDeltas(prev.personality, cur.personality, 'name'),
      interest_changes:    intd.changes,
      interest_shift:      intd.shift,
      seaa_changes:        _seaaDeltas(prev.seaa, cur.seaa),
      status_changes:      _statusDeltas(prev, cur),
      pathway_change:      (prev.recommended_primary && cur.recommended_primary && prev.recommended_primary !== cur.recommended_primary)
                             ? { from: prev.recommended_primary, to: cur.recommended_primary } : null,
    };
    d.direction  = _transitionDirection(d);
    d.narrative  = _transitionNarrative(d);
    d.highlights = _highlightsOf(d);
    return d;
  };

  const deltas = [];
  for (let i = 1; i < attempts.length; i++) deltas.push(_pairDelta(attempts[i - 1], attempts[i]));

  let overall = null;
  if (attempts.length >= 2) {
    const first = attempts[0], last = attempts[attempts.length - 1];
    const od = _pairDelta(first, last);
    overall = {
      span_from_class: first.class, span_to_class: last.class,
      attempts_count: attempts.length,
      fit_score_from: first.fit_score, fit_score_to: last.fit_score, fit_score_delta: od.fit_score_delta,
      fit_tier_from: first.fit_tier, fit_tier_to: last.fit_tier,
      direction: od.direction,
      narrative: od.narrative,
      highlights: od.highlights,
      status_changes: od.status_changes,
      pathway_change: od.pathway_change,
      interest_shift: od.interest_shift,
      top_gains: od.aptitude_changes.filter(c => c.delta > 0).slice(0, 4),
      top_drops: od.aptitude_changes.filter(c => c.delta < 0).slice(0, 4),
    };
  }

  return { attempts, deltas, overall, has_journey: attempts.length >= 2 };
}

/* One-off migration: snapshot existing completed reports into report_history so
   students who finished BEFORE journey tracking existed still count as their
   first attempt (and get the same-class retake lock instead of the legacy
   overwrite dialog). Idempotent — ON CONFLICT (email, class) DO NOTHING, so it
   is safe to re-run. Dry-run by default; pass { commit:true } to write. */
async function backfillJourneyHistory({ commit = false, email = null } = {}) {
  await _initDb();
  const params = [];
  let where = `WHERE rs.session_id IS NOT NULL
                 AND COALESCE(TRIM(s.class), '') <> ''
                 AND COALESCE(TRIM(s.email::text), '') <> ''`;
  if (email) { params.push(String(email).toLowerCase().trim()); where += ` AND s.email = $1`; }

  const students = await pg.many(
    `SELECT s.session_id, s.email, s.class,
            rs.generated_at, rs.fit_score, rs.fit_tier,
            rs.avg_personality_stanine, rs.avg_aptitude_stanine, rs.top_interest_score,
            rs.personality_status, rs.aptitude_status, rs.interest_status, rs.seaa_status,
            rs.recommended_primary
       FROM students s
       JOIN report_summary rs ON rs.session_id = s.session_id
       ${where}
      ORDER BY s.email, rs.generated_at ASC`,
    params
  );

  let created = 0, skipped = 0;
  for (const st of students) {
    const norm = String(st.email || '').toLowerCase().trim();
    const cls  = String(st.class  || '').trim();
    if (!norm || !cls) { skipped++; continue; }

    const exists = await pg.one(`SELECT 1 FROM report_history WHERE email = $1 AND class = $2`, [norm, cls]);
    if (exists) { skipped++; continue; }

    const [apt, pers, ints, seaa] = await Promise.all([
      pg.many(`SELECT key, name, stanine   FROM report_aptitude    WHERE session_id = $1 ORDER BY position`, [st.session_id]),
      pg.many(`SELECT name, stanine         FROM report_personality WHERE session_id = $1 ORDER BY position`, [st.session_id]),
      pg.many(`SELECT label, score, level   FROM report_interests   WHERE session_id = $1 ORDER BY rank`,     [st.session_id]),
      pg.many(`SELECT key, title, cat_label FROM report_seaa        WHERE session_id = $1`,                   [st.session_id]),
    ]);
    const metrics = {
      aptitude:    apt.map(a  => ({ key: a.key, name: a.name, stanine: a.stanine })),
      personality: pers.map(p => ({ name: p.name, stanine: p.stanine })),
      interests:   ints.slice(0, 5).map(i => ({ label: i.label, score: i.score, level: i.level })),
      seaa:        seaa.map(s => ({ key: s.key, title: s.title, cat_label: s.cat_label })),
    };

    console.log(`[backfill-journey] ${norm} — ${cls} (fit ${st.fit_score == null ? '?' : st.fit_score}, ${st.fit_tier || '?'})`);
    if (!commit) { created++; continue; }

    const cntRow    = await pg.one(`SELECT COUNT(*)::int AS n FROM report_history WHERE email = $1`, [norm]);
    const attemptNo = (cntRow ? cntRow.n : 0) + 1;
    const gen       = st.generated_at || new Date().toISOString();
    const res = await pg.exec(
      `INSERT INTO report_history (
         email, session_id, class, attempt_no, generated_at,
         fit_score, fit_tier, avg_personality_stanine, avg_aptitude_stanine, top_interest_score,
         personality_status, aptitude_status, interest_status, seaa_status, recommended_primary, metrics_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (email, class) DO NOTHING`,
      [
        norm, st.session_id, cls, attemptNo, gen,
        st.fit_score, st.fit_tier, st.avg_personality_stanine, st.avg_aptitude_stanine, st.top_interest_score,
        st.personality_status, st.aptitude_status, st.interest_status, st.seaa_status, st.recommended_primary,
        JSON.stringify(metrics),
      ]
    );
    if (res.rowCount) created++; else skipped++;
  }

  console.log(`[backfill-journey] ${commit ? 'COMMITTED' : 'dry-run'}: ${created} snapshot(s) ${commit ? 'created' : 'would be created'}, ${skipped} skipped`);
  return { created, skipped, committed: commit };
}

async function close() {
  await pg.close();
  _schemaReady = null;
}

/* ══════════════════════════════════════════════════════════════════
   DERIVATION HELPERS  (pure — no DB access; carried over verbatim)
══════════════════════════════════════════════════════════════════ */

const NMAP_TITLES = [
  'Leadership & Motivation','Assertiveness','Cautiousness',
  'Adaptability & Flexibility','Ethical Awareness','Creativity & Innovation',
  'Curiosity & Learning','Discipline & Sincerity','Patience & Resilience',
];
const DAAB_DISPLAY_ORDER = ['va','pa','na','sa','ma','ar','lsa','hma'];
const DAAB_LABELS = {
  va:'Verbal Ability', pa:'Perceptual Ability', na:'Numerical Ability',
  lsa:'Legal Studies Ability', hma:'Health & Medical Aptitude',
  ar:'Abstract Reasoning', ma:'Mechanical Ability', sa:'Spatial Ability',
};
const _stanineBand = (s) => s >= 7 ? 'Strength' : s >= 4 ? 'Developing' : 'Needs Attention';
const _cpiLevel    = (sc) => sc >= 15 ? 'Strong' : sc >= 8 ? 'Moderate' : 'Low';
const _seaCatLabel = (cat) => {
  if (cat === 'A' || cat === 'B') return 'Strong Readiness';
  if (cat === 'C')                return 'Developing Readiness';
  return                              'Support Needed';
};
const SCORE_WORDS = new Set(['High','Moderate','Low','Strength','Developing','Needs Attention']);

function _derivePersonality(assessments) {
  const nmap = assessments && assessments.nmap && assessments.nmap.scores;
  const dims = (nmap && Array.isArray(nmap.dims) && nmap.dims.length) ? nmap.dims : [];
  const out  = [];
  for (let i = 0; i < 9; i++) {
    const d   = dims[i] || {};
    const stn = (typeof d.stanine === 'number' && d.stanine > 0) ? d.stanine : 5;
    const name = d.name || (d.label && !SCORE_WORDS.has(d.label) ? d.label : NMAP_TITLES[i]);
    out.push({ position: i, name: name || NMAP_TITLES[i], stanine: stn, band: _stanineBand(stn) });
  }
  return out;
}

function _deriveAptitude(assessments) {
  const daab = (assessments && assessments.daab) || {};
  return DAAB_DISPLAY_ORDER.map((key, i) => {
    const sub = daab[key] || (assessments && assessments['daab_' + key]) || {};
    const sc  = sub.scores || {};
    const stn = (typeof sc.stanine === 'number' && sc.stanine > 0) ? sc.stanine : 5;
    return {
      position: i, key, name: DAAB_LABELS[key], stanine: stn,
      band: sc.label || _stanineBand(stn),
      raw_score: (typeof sc.raw === 'number') ? sc.raw : null,
      max_score: (typeof sc.max === 'number') ? sc.max : null,
    };
  });
}

/* One-off historical correction for the female DAAB norm bug. The norm tables
   live only in the frontend engine (engine/daab.js), so getStanine/label are
   inlined here — this is the server-side counterpart. Only the gender-split
   subtests (VA/PA/NA/AR) are recomputed. */
const _DAAB_GENDER_SUBS = ['va', 'pa', 'na', 'ar'];
const _DAAB_NORMS = {
  va: { F: [[0,1],[2,2],[3,3],[4,5],[6,6],[7,8],[9,9],[10,11],[12,20]], M: [[0,0],[1,2],[3,3],[4,4],[5,6],[7,7],[8,8],[9,10],[11,20]] },
  pa: { F: [[0,18],[19,22],[23,27],[28,31],[32,35],[36,39],[40,44],[45,48],[49,50]], M: [[0,18],[19,22],[23,27],[28,31],[32,35],[36,40],[41,44],[45,48],[49,50]] },
  na: { F: [[0,4],[5,6],[7,8],[9,10],[11,12],[13,13],[14,15],[16,17],[18,20]], M: [[0,5],[6,7],[8,9],[10,10],[11,12],[13,14],[15,16],[17,18],[19,20]] },
  ar: { F: [[0,3],[4,5],[6,7],[8,9],[10,11],[12,13],[14,15],[16,17],[18,20]], M: [[0,2],[3,4],[5,6],[7,8],[9,10],[11,12],[13,14],[15,16],[17,20]] },
};
function _daabStanine(key, raw, gender) {
  const g = String(gender || '').trim().charAt(0).toUpperCase() === 'F' ? 'F' : 'M';
  const table = _DAAB_NORMS[key] && _DAAB_NORMS[key][g];
  if (!table) return 5;
  for (let i = 0; i < table.length; i++) if (raw >= table[i][0] && raw <= table[i][1]) return i + 1;
  if (raw < table[0][0]) return 1;
  for (let i = table.length - 1; i >= 0; i--) if (raw >= table[i][0]) return i + 1;
  return 1;
}
function _daabLabel(s) {
  if (s <= 1) return 'Very Low';
  if (s <= 2) return 'Needs Attention';
  if (s <= 3) return 'Below Average';
  if (s <= 4) return 'Slightly Below Avg';
  if (s === 5) return 'Average';
  if (s <= 6) return 'Slightly Above Avg';
  if (s <= 7) return 'Above Average';
  if (s <= 8) return 'High';
  return 'Very High';
}

async function rescoreDaabFemale({ commit = false, email = null } = {}) {
  await _initDb();
  const cols = _DAAB_GENDER_SUBS.map(k => `a.daab_${k}_scores_json`).join(', ');
  const params = [];
  let where = `WHERE LOWER(LEFT(TRIM(s.gender), 1)) = 'f'`;
  if (email) { params.push(String(email).toLowerCase().trim()); where += ` AND s.email = $1`; }

  const rows = await pg.many(
    `SELECT s.session_id, s.email, s.gender, ${cols}
       FROM students s JOIN assessments a ON a.session_id = s.session_id
       ${where} ORDER BY s.email`,
    params
  );

  let studentsChanged = 0, subtestsChanged = 0, summaries = 0;
  for (const row of rows) {
    const sid = row.session_id;
    const changes = [];
    for (const key of _DAAB_GENDER_SUBS) {
      const rawJson = row[`daab_${key}_scores_json`];
      if (!rawJson) continue;
      let p;
      try { p = JSON.parse(rawJson); } catch { continue; }
      if (!p || typeof p.raw !== 'number') continue;
      const oldStn = typeof p.stanine === 'number' ? p.stanine : null;
      const newStn = _daabStanine(key, p.raw, row.gender);
      if (newStn === oldStn) continue;
      p.stanine = newStn;
      p.label = _daabLabel(newStn);
      changes.push({ key, raw: p.raw, oldStn, newStn, label: p.label, json: p });
    }
    if (!changes.length) continue;

    studentsChanged++;
    subtestsChanged += changes.length;
    console.log(`[rescore-daab] ${row.email}: ` + changes.map(c => `${c.key.toUpperCase()} ${c.oldStn}->${c.newStn}`).join(', '));
    if (!commit) continue;

    await pg.tx(async (c) => {
      for (const ch of changes) {
        await c.query(`UPDATE assessments SET daab_${ch.key}_scores_json = $1 WHERE session_id = $2`, [JSON.stringify(ch.json), sid]);
        await c.query(`UPDATE report_aptitude SET stanine = $1, band = $2 WHERE session_id = $3 AND key = $4`, [ch.newStn, ch.label, sid, ch.key]);
      }
      const apt = (await c.query(`SELECT name, stanine FROM report_aptitude WHERE session_id = $1`, [sid])).rows;
      if (apt.length) {
        const avg = apt.reduce((s, r) => s + r.stanine, 0) / apt.length;
        const res = await c.query(
          `UPDATE report_summary SET avg_aptitude_stanine = $1, aptitude_status = $2,
             strong_aptitudes_json = $3, emerging_aptitudes_json = $4 WHERE session_id = $5`,
          [
            Number(avg.toFixed(2)),
            avg >= 6.5 ? 'Strength' : avg >= 4 ? 'Developing' : 'Support Needed',
            JSON.stringify(apt.filter(r => r.stanine >= 7).map(r => r.name)),
            JSON.stringify(apt.filter(r => r.stanine >= 4 && r.stanine <= 6).map(r => r.name)),
            sid,
          ]
        );
        if (res.rowCount) summaries++;
      }
    });
  }

  console.log(`[rescore-daab] ${commit ? 'committed' : 'dry-run'}: ${studentsChanged} students, ${subtestsChanged} subtests, ${summaries} summaries`);
  return { studentsChanged, subtestsChanged, summaries, committed: commit };
}

function _deriveInterests(assessments) {
  const cpi    = assessments && assessments.cpi && assessments.cpi.scores;
  const ranked = (cpi && Array.isArray(cpi.ranked)) ? cpi.ranked : [];
  return ranked.slice(0, 8).map((r, i) => ({
    rank:  i + 1,
    label: r.label || r.name || '—',
    score: typeof r.score === 'number' ? r.score : 0,
    level: r.level || _cpiLevel(typeof r.score === 'number' ? r.score : 0),
  }));
}

function _deriveSeaa(assessments) {
  const sea = (assessments && assessments.sea && assessments.sea.scores) || {};
  const dom = sea.domScores || { S: 0, E: 0, A: 0 };
  const cls = sea.cls       || {};
  return [
    { key:'S', title:'Social Adjustment',    score: dom.S || 0, category: (cls.S||{}).cat || null, cat_label: _seaCatLabel((cls.S||{}).cat) },
    { key:'E', title:'Emotional Adjustment', score: dom.E || 0, category: (cls.E||{}).cat || null, cat_label: _seaCatLabel((cls.E||{}).cat) },
    { key:'A', title:'Academic Adjustment',  score: dom.A || 0, category: (cls.A||{}).cat || null, cat_label: _seaCatLabel((cls.A||{}).cat) },
  ];
}

function _deriveCareers(report, derivedInterests) {
  const tbl = report && (report.career_table || report.career_table_json);
  let parsed = [];
  if (Array.isArray(tbl)) parsed = tbl;
  else if (typeof tbl === 'string') { try { parsed = JSON.parse(tbl); } catch (_) {} }

  const _normFit = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'high' || s === 'h') return 'High';
    if (s === 'low'  || s === 'l') return 'Low';
    return 'Moderate';
  };

  if (Array.isArray(parsed) && parsed.length) {
    return parsed.map((r, i) => {
      const pct = Math.round(parseFloat(r.suitability_pct) || 0);
      return {
        position: i, career: r.career || r.cluster || '—', cluster: r.cluster || null,
        interest_fit: _normFit(r.interest_fit), aptitude_fit: _normFit(r.aptitude_fit),
        personality_fit: _normFit(r.personality_fit), seaa_fit: _normFit(r.seaa_fit),
        suitability_pct: pct,
        alignment: r.alignment || (pct >= 80 ? 'Strong Fit' : pct >= 65 ? 'Emerging Fit' : 'Exploratory'),
        rationale: r.rationale || null,
      };
    });
  }

  return (derivedInterests || []).slice(0, 6).map((it, i) => ({
    position: i, career: it.label, cluster: it.label,
    interest_fit: it.level === 'Strong' ? 'High' : it.level === 'Moderate' ? 'Moderate' : 'Low',
    aptitude_fit: 'Moderate', personality_fit: 'Moderate', seaa_fit: 'Moderate',
    suitability_pct: Math.round((it.score / 20) * 100),
    alignment: it.score >= 15 ? 'Strong Fit' : it.score >= 8 ? 'Emerging Fit' : 'Exploratory',
    rationale: null,
  }));
}

function _deriveSummary(personality, aptitude, interests, seaa, careers, report) {
  const avgPers = personality.length ? personality.reduce((s,d) => s + d.stanine, 0) / personality.length : 5;
  const avgApt  = aptitude.length    ? aptitude.reduce((s,d) => s + d.stanine, 0)    / aptitude.length    : 5;
  const topInterestScore = (interests[0] && interests[0].score) || 0;

  const _pct = (s) => ((s - 1) / 8) * 100;
  let fitRaw  = (_pct(avgPers) * 0.30) + (_pct(avgApt) * 0.30) + ((topInterestScore / 20) * 100 * 0.40);
  for (const c of seaa) {
    if (c.cat_label === 'Support Needed')            fitRaw -= 7;
    else if (c.cat_label === 'Developing Readiness') fitRaw -= 3;
  }
  const fitScore = Math.max(0, Math.min(100, Math.round(fitRaw)));
  const fitTier  = fitScore >= 75 ? 'Strong Fit' : fitScore >= 55 ? 'Emerging Fit' : 'Exploratory Fit';

  const persStatus = avgPers >= 6.5 ? 'Strength' : avgPers >= 4 ? 'Developing' : 'Support Needed';
  const aptStatus  = avgApt  >= 6.5 ? 'Strength' : avgApt  >= 4 ? 'Developing' : 'Support Needed';
  const cpiStatus  = topInterestScore >= 15 ? 'Strength' : topInterestScore >= 8 ? 'Developing' : 'Support Needed';

  const seaWorst = seaa.reduce((w, c) => {
    if (c.cat_label === 'Support Needed') return 'Support Needed';
    if (c.cat_label === 'Developing Readiness' && w !== 'Support Needed') return 'Developing';
    return w;
  }, 'Strength');

  const strongFits   = careers.filter(c => (c.alignment||'').includes('Strong')).map(c => c.career);
  const emergingFits = careers.filter(c => (c.alignment||'').includes('Emerging')).map(c => c.career);
  const exploratory  = careers.filter(c => (c.alignment||'').includes('Exploratory')).map(c => c.career);
  const top3         = interests.slice(0, 3);

  return {
    avg_personality_stanine:     Number(avgPers.toFixed(2)),
    avg_aptitude_stanine:        Number(avgApt.toFixed(2)),
    top_interest_score:          topInterestScore,
    fit_score:                   fitScore,
    fit_tier:                    fitTier,
    personality_status:          persStatus,
    aptitude_status:             aptStatus,
    interest_status:             cpiStatus,
    seaa_status:                 seaWorst,
    strong_fit_pathways:         JSON.stringify(strongFits),
    emerging_fit_pathways:       JSON.stringify(emergingFits),
    exploratory_pathways:        JSON.stringify(exploratory),
    recommended_primary:         strongFits[0]  || emergingFits[0] || (top3[0] && top3[0].label) || 'Multidisciplinary',
    recommended_alternate:       strongFits[1]  || emergingFits[1] || emergingFits[0] || (top3[1] && top3[1].label) || 'Multidisciplinary',
    recommended_exploratory:     exploratory[0] || (top3[2] && top3[2].label) || 'Multidisciplinary',
    top_personality_traits_json: JSON.stringify(
      personality.slice().sort((a,b) => b.stanine - a.stanine).slice(0,3)
        .map(t => ({ name: t.name, stanine: t.stanine, label: t.band }))
    ),
    strong_aptitudes_json:   JSON.stringify(aptitude.filter(a => a.stanine >= 7).map(a => a.name)),
    emerging_aptitudes_json: JSON.stringify(aptitude.filter(a => a.stanine >= 4 && a.stanine <= 6).map(a => a.name)),
    top3_interests_json:     JSON.stringify(top3),
  };
}

module.exports = {
  deriveDisplayRowsFromAssessmentRow,
  _initDb,
  saveRegistration,
  saveSection,
  saveReport,
  getFullReport,
  getSectionProgress,
  getStudentByEmail,
  resolveStudentByEmail,
  getStudentBySessionId,
  getJourney,
  backfillJourneyHistory,
  rescoreDaabFemale,
  close,
  MODULES,
};
