/* ════════════════════════════════════════════════════════════════════
   state.js — application state, server save helpers, persistence.

   localStorage here is UX convenience only, never auth:
   · nm_state_* / nm_last_session — resume in-progress answers
   · numind_session_v1            — pre-fill registration on resume
   · nmind_ac_ctok                — counsellor token (verified against the
     counsellor_sessions DB table on every request; 8h server-side TTL)
   The security boundary is the SERVER: every write is validated against
   the DB (APP_TOKEN + existing session_id) before persisting.
════════════════════════════════════════════════════════════════════ */

// Always "configured" now — the server owns the DB. Kept as a function
// rather than a constant `true` so callers depending on this name keep
// working with no behavioural surprises.
function _isConfigured() { return true; }

// Structured client-side logger — silent in production, active in dev
// Set localStorage.setItem('numind_debug','1') to enable in browser console
const _log = (function() {
  var debug = false;
  try { debug = !!localStorage.getItem('numind_debug'); } catch(_) {}
  var noop = function() {};
  return {
    log:   debug ? console.log.bind(console,'[NuMind]')   : noop,
    // warn/error stay active regardless of the debug flag — a save
    // failure must always leave a trace somewhere, not just when a
    // developer happens to have manually flipped on debug logging.
    warn:  console.warn.bind(console,'[NuMind]'),
    error: console.error.bind(console,'[NuMind]'),
  };
})();

// Read auth tokens from <meta> tags injected server-side.
// APP_TOKEN is never exposed as window._APP_TOKEN — it's read from
// <meta name="app-token"> so it stays out of the global JS scope.
function _getRequestHeaders() {
  const csrfMeta  = document.querySelector('meta[name="csrf-token"]');
  const appMeta   = document.querySelector('meta[name="app-token"]');
  const h = { 'Content-Type': 'application/json' };
  // Prefer meta tag (new server); fall back to window global (legacy server)
  const appToken = appMeta
    ? (appMeta.getAttribute('content') || '')
    : ((typeof window !== 'undefined' && window._APP_TOKEN) ? window._APP_TOKEN : '');
  if (appToken)  h['X-App-Token']  = appToken;
  if (csrfMeta)  h['X-CSRF-Token'] = csrfMeta.getAttribute('content') || '';
  return h;
}

const DB = {

  async saveRegistration(student, sessionId, _attempt = 0) {
    const MAX_RETRIES = 3;
    try {
      const res = await fetch('/api/save-registration', {
        method:  'POST',
        headers: _getRequestHeaders(),
        body:    JSON.stringify({ student, sessionId }),
      });
      if (res.status === 503 && _attempt < MAX_RETRIES) {
        // Server's write queue was momentarily saturated — this is a real,
        // measured condition under load (see load-test results), not a
        // permanent failure. Retry with the server's own suggested delay.
        let retryAfterSec = 3;
        try { const body = await res.clone().json(); if (body?.retry_after) retryAfterSec = body.retry_after; } catch (_) {}
        _log.warn(`[DB] saveRegistration busy (503), retrying in ${retryAfterSec}s (attempt ${_attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, retryAfterSec * 1000));
        return DB.saveRegistration(student, sessionId, _attempt + 1);
      }
      if (!res.ok) {
        const msg = await res.text();
        _log.error('[DB] saveRegistration HTTP ' + res.status + ':', msg);
        return { data: null, error: { message: msg } };
      }
      const data = await res.json();
      _log.log('[DB] Registration saved. sessionId:', data.sessionId || sessionId);
      return { data, error: null };
    } catch (err) {
      _log.error('[DB] saveRegistration fetch failed:', err.message);
      return { data: null, error: { message: err.message } };
    }
  },

  // Called after each module completes — saves raw answers + scores so data
  // survives a failed report generation. Fire-and-forget: never blocks the
  // assessment flow. Retries once on 503 (write queue busy) before giving up.
  saveSection(sessionId, moduleKey, answers, scores, duration, _attempt = 0) {
    const MAX_RETRIES = 2;
    const fail = (reason) => {
      _log.warn('[DB] saveSection failed:', moduleKey, sessionId, reason);
      try {
        document.dispatchEvent(new CustomEvent('nm:section-save-failed', {
          detail: { moduleKey, sessionId, reason },
        }));
      } catch (_) {}
    };
    if (!sessionId) { fail('no sessionId'); return; }
    fetch('/api/save-section', {
      method:  'POST',
      headers: _getRequestHeaders(),
      body: JSON.stringify({ sessionId, moduleKey, answers, scores, duration }),
    })
      .then(r => {
        if (r.status === 503 && _attempt < MAX_RETRIES) {
          r.json().then(body => {
            const retryAfterSec = body?.retry_after || 3;
            _log.warn(`[DB] saveSection busy (503) for ${moduleKey}, retrying in ${retryAfterSec}s`);
            setTimeout(() => {
              DB.saveSection(sessionId, moduleKey, answers, scores, duration, _attempt + 1);
            }, retryAfterSec * 1000);
          }).catch(() => fail('HTTP 503 (unparseable body)'));
          return;
        }
        if (!r.ok) r.text().then(t => fail('HTTP ' + r.status + ': ' + t));
        else _log.log('[DB] Section saved:', moduleKey, sessionId);
      })
      .catch(e => fail('network: ' + e.message));
  },

  // Kept as a stub for callers that still invoke it. Completion is now
  // recorded automatically by the server when /api/save-report fires.
  async markCompleted(sessionId) {
    return { data: null, error: null };
  },
};


const S = {
  student: {}, sessionId: null,
  cpi:  { answers: Array.from({length:20}, ()=>[]), scores: null, startTime: null, duration: 0, currentQ: 0 },
  sea:  { answers: new Array(60).fill(null), scores: null, startTime: null, duration: 0, currentPage: 0 },
  nmap: { answers: new Array(63).fill(null), scores: null, startTime: null, duration: 0, currentDim: 0 },
  daab: {
    va:  { answers: new Array(20).fill(null), scores: null, startTime: null, duration: 0, timerStartedAt: null },
    pa:  { answers: new Array(50).fill(null), scores: null, startTime: null, duration: 0, currentPage: 0, timerStartedAt: null },
    na:  { answers: new Array(20).fill(null), scores: null, startTime: null, duration: 0, timerStartedAt: null },
    lsa: { answers: new Array(20).fill(null), scores: null, startTime: null, duration: 0, timerStartedAt: null },
    hma: { answers: new Array(20).fill(null), scores: null, startTime: null, duration: 0, timerStartedAt: null },
    ar:  { answers: new Array(20).fill(null), scores: null, startTime: null, duration: 0, timerStartedAt: null },
    ma:  { answers: new Array(20).fill(null), scores: null, startTime: null, duration: 0, timerStartedAt: null },
    sa:  { answers: new Array(20).fill(null), scores: null, startTime: null, duration: 0, timerStartedAt: null },
    currentSub: 0,
  },
  timerInt: null,
};

const _SESSION_KEY = 'numind_session_v1';

function _saveSession(activePage) {
  try {
    const snap = {
      student:   S.student,
      sessionId: S.sessionId,
      cpi:  { answers: S.cpi.answers,  scores: S.cpi.scores,  duration: S.cpi.duration, currentQ: S.cpi.currentQ, startTime: S.cpi.startTime },
      sea:  { answers: S.sea.answers,  scores: S.sea.scores,  duration: S.sea.duration,  currentPage: S.sea.currentPage, startTime: S.sea.startTime },
      nmap: { answers: S.nmap.answers, scores: S.nmap.scores, duration: S.nmap.duration, currentDim: S.nmap.currentDim, startTime: S.nmap.startTime },
      daab: {
        va:  { answers: S.daab.va.answers,  scores: S.daab.va.scores,  duration: S.daab.va.duration,  currentPage: S.daab.va.currentPage  || 0, timerStartedAt: S.daab.va.timerStartedAt  || null },
        pa:  { answers: S.daab.pa.answers,  scores: S.daab.pa.scores,  duration: S.daab.pa.duration,  currentPage: S.daab.pa.currentPage  || 0, timerStartedAt: S.daab.pa.timerStartedAt  || null },
        na:  { answers: S.daab.na.answers,  scores: S.daab.na.scores,  duration: S.daab.na.duration,  currentPage: S.daab.na.currentPage  || 0, timerStartedAt: S.daab.na.timerStartedAt  || null },
        lsa: { answers: S.daab.lsa.answers, scores: S.daab.lsa.scores, duration: S.daab.lsa.duration, currentPage: S.daab.lsa.currentPage || 0, timerStartedAt: S.daab.lsa.timerStartedAt || null },
        hma: { answers: S.daab.hma.answers, scores: S.daab.hma.scores, duration: S.daab.hma.duration, currentPage: S.daab.hma.currentPage || 0, timerStartedAt: S.daab.hma.timerStartedAt || null },
        ar:  { answers: S.daab.ar.answers,  scores: S.daab.ar.scores,  duration: S.daab.ar.duration,  currentPage: S.daab.ar.currentPage  || 0, timerStartedAt: S.daab.ar.timerStartedAt  || null },
        ma:  { answers: S.daab.ma.answers,  scores: S.daab.ma.scores,  duration: S.daab.ma.duration,  currentPage: S.daab.ma.currentPage  || 0, timerStartedAt: S.daab.ma.timerStartedAt  || null },
        sa:  { answers: S.daab.sa.answers,  scores: S.daab.sa.scores,  duration: S.daab.sa.duration,  currentPage: S.daab.sa.currentPage  || 0, timerStartedAt: S.daab.sa.timerStartedAt  || null },
        currentSub: S.daab.currentSub,
      },
      activePage: activePage || null,
      savedAt: Date.now(),
    };
    localStorage.setItem(_SESSION_KEY, JSON.stringify(snap));
  } catch (e) {
    _log.warn('[Session] Could not save snapshot:', e.message);
  }
}

function _clearSession() {
  try { localStorage.removeItem(_SESSION_KEY); } catch (_) {}
}

function _restoreSession() {
  try {
    const raw = localStorage.getItem(_SESSION_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap.savedAt || Date.now() - snap.savedAt > 4 * 60 * 60 * 1000) {
      _clearSession();
      return null;
    }
    S.student   = snap.student   || {};
    S.sessionId = snap.sessionId || null;

    if (snap.cpi) {
      if (Array.isArray(snap.cpi.answers)) {
        S.cpi.answers.splice(0, S.cpi.answers.length, ...snap.cpi.answers);
      }
      S.cpi.scores    = snap.cpi.scores    || null;
      S.cpi.duration  = snap.cpi.duration  || 0;
      S.cpi.startTime = snap.cpi.startTime || null;
      if (snap.cpi.currentQ != null) S.cpi.currentQ = snap.cpi.currentQ;
    }

    if (snap.sea) {
      if (Array.isArray(snap.sea.answers)) {
        S.sea.answers.splice(0, S.sea.answers.length, ...snap.sea.answers);
      }
      S.sea.scores      = snap.sea.scores      || null;
      S.sea.duration    = snap.sea.duration    || 0;
      S.sea.currentPage = snap.sea.currentPage || 0;
      S.sea.startTime   = snap.sea.startTime   || null;
    }
    
    if (snap.nmap) {
      if (Array.isArray(snap.nmap.answers)) {
        S.nmap.answers.splice(0, S.nmap.answers.length, ...snap.nmap.answers);
      }
      S.nmap.scores     = snap.nmap.scores     || null;
      S.nmap.duration   = snap.nmap.duration   || 0;
      S.nmap.currentDim = snap.nmap.currentDim || 0;
      S.nmap.startTime  = snap.nmap.startTime  || null;
    }

    if (snap.daab) {
      ['va','pa','na','lsa','hma','ar','ma','sa'].forEach(k => {
        if (!snap.daab[k]) return;
        if (Array.isArray(snap.daab[k].answers)) {
          S.daab[k].answers.splice(0, S.daab[k].answers.length, ...snap.daab[k].answers);
        }
        S.daab[k].scores   = snap.daab[k].scores   || null;
        S.daab[k].duration = snap.daab[k].duration || 0;
        if (snap.daab[k].currentPage != null) {
          S.daab[k].currentPage = snap.daab[k].currentPage;
        }
        if (snap.daab[k].timerStartedAt != null) {
          S.daab[k].timerStartedAt = snap.daab[k].timerStartedAt;
        }
      });
      S.daab.currentSub = snap.daab.currentSub || 0;
    }
    _log.log('[Session] Restored from snapshot (page:', snap.activePage, ')');
    return snap.activePage || null;
  } catch (e) {
    _log.warn('[Session] Could not restore snapshot:', e.message);
    _clearSession();
    return null;
  }
}

function saveState() {
  if (!S.sessionId) return;
  try {
    // timerInt is a live interval handle — don't serialise it
    const snapshot = JSON.parse(JSON.stringify({ ...S, timerInt: null }));
    // Stamp with savedAt so the boot-time sweeper can age out stale keys.
    snapshot._savedAt = Date.now();
    localStorage.setItem('nm_state_' + S.sessionId, JSON.stringify(snapshot));
    localStorage.setItem('nm_last_session', S.sessionId);
  } catch (e) {
    _log.warn('[NM] saveState failed:', e);
  }
}

function loadState() {
  try {
    const sid = localStorage.getItem('nm_last_session');
    if (!sid) return false;
    const raw = localStorage.getItem('nm_state_' + sid);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    // Merge into S — keep live references (timerInt stays null from parsed)
    Object.assign(S, parsed);
    S.timerInt = null; // always reset live timer handle
    return true;
  } catch (e) {
    _log.warn('[NM] loadState failed (corrupt data?):', e);
    return false;
  }
}

function clearState() {
  try {
    const sid = localStorage.getItem('nm_last_session');
    if (sid) localStorage.removeItem('nm_state_' + sid);
    localStorage.removeItem('nm_last_session');
  } catch (e) {
    _log.warn('[NM] clearState failed:', e);
  }
}

/* Reset the IN-MEMORY assessment answers/scores to blank for a fresh attempt,
   and drop the persisted snapshots so a reload can't restore the old answers.
   Keeps identity (S.student / S.sessionId). Used when a returning student
   starts a NEW attempt (next class) or retakes — otherwise the pages prefill
   from the previous sitting and the "new" attempt just re-submits old answers,
   producing an identical report with no real growth to map. Uses splice so any
   live references held by the assessment pages to S.<mod>.answers stay valid. */
function resetAssessmentState() {
  S.cpi.answers.splice(0, S.cpi.answers.length, ...Array.from({ length: 20 }, () => []));
  S.cpi.scores = null; S.cpi.startTime = null; S.cpi.duration = 0; S.cpi.currentQ = 0;

  S.sea.answers.splice(0, S.sea.answers.length, ...new Array(60).fill(null));
  S.sea.scores = null; S.sea.startTime = null; S.sea.duration = 0; S.sea.currentPage = 0;

  S.nmap.answers.splice(0, S.nmap.answers.length, ...new Array(63).fill(null));
  S.nmap.scores = null; S.nmap.startTime = null; S.nmap.duration = 0; S.nmap.currentDim = 0;

  const _daabLens = { va: 20, pa: 50, na: 20, lsa: 20, hma: 20, ar: 20, ma: 20, sa: 20 };
  Object.keys(_daabLens).forEach((k) => {
    const sub = S.daab[k];
    if (!sub) return;
    sub.answers.splice(0, sub.answers.length, ...new Array(_daabLens[k]).fill(null));
    sub.scores = null; sub.startTime = null; sub.duration = 0; sub.timerStartedAt = null;
    if ('currentPage' in sub) sub.currentPage = 0;
  });
  S.daab.currentSub = 0;

  // Clear both persistence layers so a boot-time restore can't repopulate S.
  try { _clearSession(); } catch (_) {}
  try {
    if (S.sessionId) localStorage.removeItem('nm_state_' + S.sessionId);
    localStorage.removeItem('nm_last_session');
  } catch (_) {}

  _log.log('[NM] Assessment state reset for a fresh attempt.');
}

/* Sweep stale nm_state_* keys on load: shared/kiosk devices accumulate
   orphaned per-session snapshots until localStorage hits quota. Drop keys
   older than 4h or with unparseable payloads. */
(function _sweepStaleNmStateKeys() {
  try {
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    const lastSid = localStorage.getItem('nm_last_session');
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('nm_state_')) continue;
      // Never sweep the currently-tracked session — _restoreSession on
      // boot may still need it.
      if (lastSid && k === 'nm_state_' + lastSid) continue;
      try {
        const raw = localStorage.getItem(k);
        if (!raw) { toDelete.push(k); continue; }
        const parsed = JSON.parse(raw);
        // Old entries written before _savedAt was added will lack the
        // field — treat them as stale (this is a one-time migration).
        if (!parsed || typeof parsed._savedAt !== 'number' || parsed._savedAt < cutoff) {
          toDelete.push(k);
        }
      } catch (_) {
        // Corrupt JSON — drop it.
        toDelete.push(k);
      }
    }
    toDelete.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    if (toDelete.length) _log.log(`[NM] Swept ${toDelete.length} stale nm_state_* key(s)`);
  } catch (e) {
    // localStorage might be unavailable (private mode, etc.) — silently skip.
    _log.warn('[NM] sweep failed:', e && e.message);
  }
})();

export { _isConfigured, DB, S, _SESSION_KEY, _saveSession, _clearSession, _restoreSession, saveState, loadState, clearState, resetAssessmentState };
