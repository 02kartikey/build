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

  try {
    return await pg.tx(async (c) => {
      // Atomic find-or-create keyed on email. Lookup + insert share one
      // transaction; the CITEXT unique-ish email index is the cross-process backstop.
      if (norm) {
        const existing = await _getStudentByEmailTx(c, norm);
        if (existing) {
          return { session_id: existing.session_id, existing: true, testTaken: existing.fit_tier != null };
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

      return { session_id: sessionId, existing: false, testTaken: false };
    });
  } catch (e) {
    // Concurrent insert committed the same email first — reuse its row.
    // Postgres unique violation is SQLSTATE 23505.
    if (norm && (e.code === '23505')) {
      const row = await getStudentByEmail(norm);
      if (row) return { session_id: row.session_id, existing: true, testTaken: row.fit_tier != null };
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
  if (!row) return { personality: [], aptitude: [], interests: [], seaa: [] };
  const jp = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const a = {
    cpi:  { scores: jp(row.cpi_scores_json) },
    sea:  { scores: jp(row.sea_scores_json) },
    nmap: { scores: jp(row.nmap_scores_json) },
  };
  for (const k of ['va','pa','na','lsa','hma','ar','ma','sa'])
    a['daab_' + k] = { scores: jp(row['daab_' + k + '_scores_json']) };
  return {
    personality: row.nmap_scores_json ? _derivePersonality(a) : [],
    aptitude:    Object.keys(a).some(k => k.startsWith('daab_') && a[k].scores) ? _deriveAptitude(a) : [],
    interests:   _deriveInterests(a),
    seaa:        row.sea_scores_json ? _deriveSeaa(a) : [],
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
  va:'Verbal Ability', pa:'Perceptual Speed', na:'Numerical Ability',
  lsa:'Legal Studies Ability', hma:'Health & Medical Apt.',
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
  close,
  MODULES,
};
