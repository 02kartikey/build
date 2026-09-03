/* ════════════════════════════════════════════════════════════════════
   router.js
   Page navigation, resume overlay, registration.
════════════════════════════════════════════════════════════════════ */

import { S, _clearSession, _restoreSession, _saveSession, DB, _isConfigured, resetAssessmentState } from './state.js';
import { showDbStatus } from './db-status.js';
import { startNMAP, renderNMAPPage, renderNMAPSidebarNav, startTimer } from './ui/nmap-page.js';
import { renderCPIQ } from './ui/cpi-page.js';
import { renderSEAPage, renderSEASidebarNav } from './ui/sea-page.js';
import { renderDAABSub, renderDAABSideNav, clearDaabTimer } from './ui/daab-page.js';
import { buildResults } from './ui/results.js';

function navLogoClick() {
  const assessmentPages = ['nmap', 'daab', 'cpi', 'nseaas'];
  const currentPage = document.querySelector('.page.active');
  const currentId   = currentPage ? currentPage.id.replace('page-', '') : '';
  if (assessmentPages.includes(currentId)) {
    const ok = window.confirm('⚠️ You\'re in the middle of an assessment. Your progress is saved — you can resume when you come back. Leave anyway?');
    if (!ok) return;
    if (currentId === 'daab') {
      // Use the dedicated stop helper from daab-page.js — it owns the
      // timer state and resets it cleanly. (Earlier code reassigned an
      // imported `daabTimerInt` directly, which is a TypeError because
      // ES module imports are read-only bindings.)
      clearDaabTimer();
    }
  }
  goPage('landing');
}

function goPage(id) {
  _goPageReal(id);
  // Don't persist counsellor page to session — it's not an assessment page
  // and would incorrectly trigger the resume overlay on next load.
  if (id !== 'counsellor') _saveSession(id);
  // NOTE: the results snapshot is deliberately KEPT. It used to be cleared here,
  // which meant refreshing on the report page wiped the session and dropped the
  // student back on the landing page with no way back to their report. main.js
  // restores 'results' directly (no resume overlay), so keeping it is safe.
}

// NOTE: DOMContentLoaded boot sequence is handled exclusively in main.js.
// Do NOT add a second DOMContentLoaded listener here — it causes double
// session restore and page freezes.

function _showResumeOverlay(savedPage) {
  _goPageReal('landing');

  const overlay = document.createElement('div');
  overlay.id = 'resume-overlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center',
    'background:rgba(15,23,42,0.72);backdrop-filter:blur(6px)',
  ].join(';');

  const moduleLabel = {
    nmap:'Module 1 — Personality',
    daab:'Module 2 — Aptitude',
    cpi:'Module 3 — Career Interests',
    nseaas:'Module 4 — Social-Emotional',
    transition:'Between Module 1 & 2',
    transition2:'Between Module 2 & 3',
    transition3:'Between Module 3 & 4',
  }[savedPage] || 'Assessment';
  const subLabel = savedPage === 'daab' && S.daab.currentSub != null
    ? ` · Sub-test ${S.daab.currentSub + 1} of 8`
    : '';

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:2.5rem 2rem;max-width:420px;width:90%;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.25)">
      <div style="font-size:48px;margin-bottom:1rem">🔖</div>
      <h2 style="font-family:'Nunito',sans-serif;font-size:22px;font-weight:800;margin-bottom:.5rem;color:#1e293b">Session saved</h2>
      <p style="font-size:14px;color:#64748b;margin-bottom:.25rem">You were in the middle of:</p>
      <p style="font-size:15px;font-weight:700;color:#7c3aed;margin-bottom:1.75rem">${moduleLabel}${subLabel}</p>
      <button id="btn-resume" style="width:100%;padding:.85rem;border-radius:12px;border:none;background:#7c3aed;color:#fff;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:.75rem">
        ▶ Resume where I left off
      </button>
      <button id="btn-restart" style="width:100%;padding:.85rem;border-radius:12px;border:2px solid #e2e8f0;background:#fff;color:#64748b;font-size:14px;font-weight:600;cursor:pointer">
        ↺ Start over (clear saved progress)
      </button>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('btn-resume').addEventListener('click', function() {
    overlay.remove();
    _doResume(savedPage);
  });

  document.getElementById('btn-restart').addEventListener('click', function() {
    overlay.remove();
    _clearSession();
    _goPageReal('landing');
  });
}

function _doResume(savedPage) {
  if (savedPage === 'nmap') {
    goPage('nmap');
    typeof renderNMAPPage === 'function' && renderNMAPPage();
    typeof renderNMAPSidebarNav === 'function' && renderNMAPSidebarNav();
    if (S.nmap.startTime) startTimer('nmap-timer', S.nmap);

  } else if (savedPage === 'daab') {
    goPage('daab');
    requestAnimationFrame(() => {
      typeof renderDAABSideNav === 'function' && renderDAABSideNav();
      typeof renderDAABSub === 'function' && renderDAABSub(S.daab.currentSub || 0, true);
    });

  } else if (savedPage === 'cpi') {
    goPage('cpi');
    typeof renderCPIQ === 'function' && renderCPIQ();
    if (S.cpi.startTime) startTimer('cpi-timer', S.cpi);

  } else if (savedPage === 'nseaas') {
    goPage('nseaas');
    typeof renderSEAPage === 'function' && renderSEAPage();
    typeof renderSEASidebarNav === 'function' && renderSEASidebarNav();
    if (S.sea.startTime) startTimer('sea-timer', S.sea);

  } else if (savedPage === 'transition' || savedPage === 'transition2' || savedPage === 'transition3') {
    _goPageReal(savedPage);

  } else if (savedPage === 'ready' || savedPage === 'results') {
    if (S.cpi.scores && S.sea.scores && S.nmap.scores) {
      typeof buildResults === 'function' && buildResults();
    }
    _goPageReal('results');
  }
}

const PIP_IDX = { landing:0, register:0, nmap:1, transition:1, daab:2, transition2:2, cpi:3, transition3:3, nseaas:4, ready:5, results:5, counsellor:5 };

// Pages where staff login and AI counsellor resume chip must be hidden
const ASSESSMENT_PAGES = new Set(['nmap','daab','cpi','nseaas','transition','transition2','transition3','register','ready']);

function _goPageReal(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + id);
  if (!target) { console.warn('[Router] No page element found for id:', id); return; }
  target.classList.add('active');
  window.scrollTo(0, 0);

  // Hide staff login and nav during assessment; restore on home/results/counsellor
  const staffWrap = document.getElementById('staff-menu-wrap');
  if (staffWrap) staffWrap.style.display = ASSESSMENT_PAGES.has(id) ? 'none' : '';

  // Remove AI counsellor resume chip if navigating into a test
  if (ASSESSMENT_PAGES.has(id)) {
    const chip = document.getElementById('ac-resume-chip');
    if (chip) chip.remove();
  }

  const a = PIP_IDX[id] ?? 0;
  for (let i = 0; i < 6; i++) {
    const p = document.getElementById('pip' + i);
    if (!p) continue;
    p.classList.remove('now', 'done');
    if (i < a) p.classList.add('done');
    else if (i === a) p.classList.add('now');
  }

  for (let i = 0; i < 5; i++) {
    const c = document.getElementById('con' + i);
    if (c) c.classList.toggle('done', i < a);
  }
}

var _registering = false;

/* ══════════════════════════════════════════════════════════════════
   ACCESS-CODE LOGIN
   Path for students created by staff (bulk import / dashboard add).
   They pick school -> class -> their name, type the code the school gave
   them, and go straight into the assessment. No re-registration.
══════════════════════════════════════════════════════════════════ */

let _accessBusy = false;

// Populate the name dropdown once school + class are chosen.
/* Populate the Class dropdown from the server for the typed school. The old
   hardcoded Grade 9-12 options could never match free-text imported classes
   like "10-B", which made every such student unreachable from this form. */
/* Request sequencing.

   The school field fires both onchange and onblur, and each keystroke can
   start another lookup, so several requests are in flight at once. Without a
   guard each one clears the dropdown and appends its own results: two
   overlapping class lookups produced the duplicated "9, X, XI, XII, 9, X, XI,
   XII" list, and a slow names lookup for the previously-selected class could
   land after a newer one and repaint the list with the wrong class's students.

   Each loader owns a counter. A response only paints if it is still the most
   recent request for that loader; anything older is discarded. */
let _accessClassSeq = 0;
let _accessNameSeq  = 0;

function _resetNameSelect(msg) {
  const sel = document.getElementById('ac-name');
  if (!sel) return;
  sel.innerHTML = '<option value="">' + msg + '</option>';
  sel.disabled = true;
}

/* Populate the Class dropdown from the server for the typed school. The old
   hardcoded Grade 9-12 options could never match free-text imported classes
   like "10-B", which made every such student unreachable from this form. */
async function loadAccessClasses() {
  const sch = document.getElementById('ac-school');
  const cls = document.getElementById('ac-class');
  const err = document.getElementById('ac-err');
  if (!sch || !cls) return;
  const school = (sch.value || '').trim();

  const seq = ++_accessClassSeq;
  // Selecting a different school invalidates the class AND the name below it.
  _resetNameSelect('Select your school and class first\u2026');
  cls.innerHTML = '<option value="">Select\u2026</option>';
  if (!school) return;

  try {
    const r = await fetch('/api/student-access/names?school=' + encodeURIComponent(school));
    const j = await r.json();
    if (seq !== _accessClassSeq) return;          // a newer lookup superseded this one
    const classes = (j && j.classes) || [];
    if (!classes.length) {
      if (err) { err.textContent = 'No students with access codes found for that school. Please check the spelling with your teacher.'; err.style.display = 'block'; }
      return;
    }
    if (err) err.style.display = 'none';
    cls.innerHTML = '<option value="">Select\u2026</option>';
    classes.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; cls.appendChild(o); });
  } catch (_) {
    if (seq !== _accessClassSeq) return;
    if (err) { err.textContent = 'Could not load classes. Please check your connection.'; err.style.display = 'block'; }
  }
}

async function loadAccessNames() {
  const sch = document.getElementById('ac-school');
  const cls = document.getElementById('ac-class');
  const sel = document.getElementById('ac-name');
  const err = document.getElementById('ac-err');
  if (!sch || !cls || !sel) return;
  const school = (sch.value || '').trim(), klass = (cls.value || '').trim();

  const seq = ++_accessNameSeq;
  // Blank the list immediately. Leaving the previous class's students on screen
  // while the new request is in flight is what made it look like the class
  // filter was being ignored.
  _resetNameSelect(klass ? 'Loading\u2026' : 'Select your school and class first\u2026');
  if (!school || !klass) return;

  try {
    const r = await fetch('/api/student-access/names?school=' + encodeURIComponent(school) +
                          '&class=' + encodeURIComponent(klass));
    const j = await r.json();
    if (seq !== _accessNameSeq) return;           // stale response — discard
    const names = (j && j.names) || [];
    if (!names.length) {
      _resetNameSelect('No students found for this class');
      if (err) { err.textContent = 'No students found for that school and class. Please check with your teacher.'; err.style.display = 'block'; }
      return;
    }
    if (err) err.style.display = 'none';
    sel.innerHTML = '<option value="">Select your name\u2026</option>';
    names.forEach(n => {
      const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o);
    });
    sel.disabled = false;
  } catch (_) {
    if (seq !== _accessNameSeq) return;
    _resetNameSelect('Could not load names');
    if (err) { err.textContent = 'Could not load names. Please check your connection.'; err.style.display = 'block'; }
  }
}

async function doAccessLogin() {
  if (_accessBusy) return;
  const err = document.getElementById('ac-err');
  const btn = document.getElementById('ac-submit');
  const school = (document.getElementById('ac-school') || {}).value || '';
  const klass  = (document.getElementById('ac-class')  || {}).value || '';
  const name   = (document.getElementById('ac-name')   || {}).value || '';
  const code   = ((document.getElementById('ac-code')  || {}).value || '').trim().toUpperCase();

  if (!school || !klass || !name || !code) {
    if (err) { err.textContent = 'Please fill in all four fields.'; err.style.display = 'block'; }
    return;
  }
  _accessBusy = true;
  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
  if (err) err.style.display = 'none';

  try {
    const r = await fetch('/api/student-access/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ school, class: klass, name, code }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.student) {
      if (err) { err.textContent = j.error || 'Those details do not match. Please check with your teacher.'; err.style.display = 'block'; }
      return;
    }

    const st = j.student;
    // SECURITY: wipe whatever the previous browser user left in S before
    // adopting this student's identity — otherwise their answers prefill and
    // would be saved under this student's session on submit.
    resetAssessmentState();
    S.aiReport = null;
    if (typeof window !== 'undefined') window._lastAIReport = null;
    // Adopt the staff-created session so every save lands on the existing row.
    S.sessionId = st.session_id;
    S.student = {
      firstName: st.first_name || (st.full_name || '').split(' ')[0] || '',
      lastName:  st.last_name  || (st.full_name || '').split(' ').slice(1).join(' '),
      fullName:  st.full_name  || ((st.first_name || '') + ' ' + (st.last_name || '')).trim(),
      class: st.class || klass, section: st.section || '',
      school: st.school || school,
      schoolState: st.school_state || '', schoolCity: st.school_city || '',
      schoolLocation: [st.school_city, st.school_state].filter(Boolean).join(', '),
      age: st.age || '', gender: st.gender || '', email: st.email || '',
      registeredAt: new Date().toISOString(),
    };

    // Reuse the normal registration save so the growth-journey / retake locks
    // behave identically to a self-registered student.
    const { data } = await DB.saveRegistration(S.student, S.sessionId);
    if (data && data.sessionId && data.sessionId !== S.sessionId) S.sessionId = data.sessionId;

    if (data && data.attemptedThisClass) {
      window.alert('You have already completed the NuMind MAPS assessment for ' + (S.student.class || 'this class') + '.\n\n' +
        'We will take you to your AI Counsellor, where you can view your report and track your progress.');
      _saveSession('register');
      if (typeof goPage === 'function') goPage('counsellor');
      return;
    }

    _saveSession('register');
    startNMAP();
  } catch (_) {
    if (err) { err.textContent = 'Connection error. Please try again.'; err.style.display = 'block'; }
  } finally {
    _accessBusy = false;
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

async function doRegister() {
  if (_registering) return;

  const fn=document.getElementById('r-fn').value.trim(), ln=document.getElementById('r-ln').value.trim();
  const cls=document.getElementById('r-cls').value;
  // School: r-sch is a <select> whose "Other (type below)" option reveals a
  // free-text input (r-sch-other). getSchoolValue() (global, index.html)
  // resolves the real name; never persist the placeholder string itself.
  let sch = (typeof getSchoolValue === 'function')
    ? getSchoolValue()
    : document.getElementById('r-sch').value.trim();
  if (sch === 'Other (type below)') sch = '';
  const gen=document.getElementById('r-gen').value, con=document.getElementById('r-con').checked;
  const state=document.getElementById('r-state').value, city=document.getElementById('r-city').value;
  const email=document.getElementById('r-email').value.trim();
  let ok=true;
  [['fn',fn],['ln',ln],['cls',cls],['sch',sch],['gen',gen],['state',state],['city',city]].forEach(([k,v])=>{
    const e=document.getElementById('e-'+k); e.style.display=v?'none':'block'; if(!v) ok=false;
  });
  // Email validation
  const emailEl = document.getElementById('e-email');
  const emailValid = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (emailEl) emailEl.style.display = emailValid ? 'none' : 'block';
  if (!emailValid) ok = false;
  document.getElementById('e-con').style.display=con?'none':'block';
  if (!con) ok=false;
  if (!ok) return;

  _registering = true;
  const submitBtn = document.querySelector('[onclick="doRegister()"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '.6'; }

  try {
    S.student = {
      firstName:fn, lastName:ln, fullName:fn+' '+ln,
      class:cls, section:document.getElementById('r-sec').value.trim(),
      school:sch, schoolState:state, schoolCity:city,
      schoolLocation: city + ', ' + state,
      age:document.getElementById('r-age').value,
      gender:gen, email:email,
      registeredAt:new Date().toISOString(),
    };
    // SECURITY: registration is an explicit new-identity claim, so ALWAYS
    // mint a fresh sessionId and wipe any assessment state left in this
    // browser by a previous student. Reusing a restored sessionId here let a
    // new registrant inherit — and overwrite — the previous student's row and
    // answers on shared machines (the ON CONFLICT(session_id) upsert). The
    // legitimate "same person returns" case is handled by the server's email
    // match, whose returned sessionId we adopt below; the legitimate "resume
    // my own attempt" case is the resume overlay, never this path.
    resetAssessmentState();
    S.aiReport = null;
    if (typeof window !== 'undefined') window._lastAIReport = null;
    // Session id must be unguessable: /api/counsellor-unlock treats possession
    // of a valid session id as proof of identity (session-first unlock), so a
    // predictable id would expose another student's report and Aria. Date.now()
    // plus Math.random() is neither uniform nor cryptographically secure, so
    // use the platform CSPRNG and fall back only if it is unavailable.
    S.sessionId = 'NMSUITE-' + (function () {
      try {
        // getRandomValues is available in non-secure contexts too, whereas
        // randomUUID is HTTPS-only — try the broader one first so the weak
        // fallback below is effectively unreachable on any supported browser.
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          const a = new Uint8Array(16); crypto.getRandomValues(a);
          return Array.from(a, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        }
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
          return crypto.randomUUID().replace(/-/g, '').toUpperCase();
        }
      } catch (_) { /* fall through */ }
      // Last resort only (no Web Crypto at all). Weaker, so make it loud
      // rather than silent — a predictable id is a security regression.
      try { console.warn('[NM] Web Crypto unavailable — session id entropy is degraded.'); } catch (_) {}
      return Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    })();
    showDbStatus('saving','Saving your details…');
    const { data, error } = await DB.saveRegistration(S.student, S.sessionId);

    // ── Key: adopt the session_id the server returns ──────────────────
    // If this email was pre-created by an admin, the server returns the
    // admin-created session_id (not the one we just generated).
    // We must switch to that id so all subsequent section saves and the
    // final report are stored under the same row the admin created.
    if (data && data.sessionId && data.sessionId !== S.sessionId) {
      S.sessionId = data.sessionId;
    }

    if (error) {
      // Do NOT proceed into the assessment on a failed registration save.
      // S.sessionId is preserved (not regenerated) so the retry below reuses
      // the same id and will not create a duplicate row once it succeeds.
      showDbStatus('error', 'Could not save your details. Please check your connection and try again.');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; }
      _registering = false;
      return;
    }

    showDbStatus('saved', '✓ Details saved!');

    // Journey lock: already completed the assessment for THIS class. No retake
    // in the same class — they can retake only after moving up a class. Route
    // them to the AI counsellor to view their report and progress.
    if (data && data.attemptedThisClass) {
      window.alert(
        'You have already completed the NuMind MAPS assessment for ' + (S.student.class || 'this class') + '.\n\n' +
        'You can take it again next year in your next class — that is how we map your growth journey and show how far you have come.\n\n' +
        'We will take you to your AI Counsellor, where you can view your report and track your progress.'
      );
      _saveSession('register');
      if (typeof goPage === 'function') goPage('counsellor'); else startNMAP();
      return;
    }

    // Returning student whose class has advanced → a NEW attempt that adds a
    // fresh point to their growth journey (their earlier attempts are preserved).
    if (data && data.attemptsCount > 0) {
      const proceed = window.confirm(
        'Welcome back! You last completed the assessment in ' + (data.lastAttemptClass || 'an earlier class') + '.\n\n' +
        'Taking it now in ' + (S.student.class || 'your new class') + ' adds a new point to your growth journey, so you and your counsellor can see how you have progressed since then.\n\n' +
        'Click OK to begin, or Cancel to visit your AI Counsellor.'
      );
      if (proceed) {
        // Fresh attempt — clear the previous sitting's answers/scores so the
        // student actually re-takes the test (otherwise pages prefill the old
        // responses and the "new" attempt just re-submits an identical report).
        resetAssessmentState();
        _saveSession('register');
        startNMAP();
      } else {
        _saveSession('register');
        if (typeof goPage === 'function') goPage('counsellor'); else startNMAP();
      }
      return;
    }

    // Legacy path: a report exists but predates journey tracking (no attempt
    // history). Preserve the original retake-overwrites behaviour for these.
    // Test-already-taken gate: testTaken means a report exists in the backend.
    // The results page renders from LOCAL state only, so a returning user must
    // go to the AI counsellor (DB-backed) to view it — or explicitly retake.
    if (data && data.testTaken) {
      const retake = window.confirm(
        'Our records show you have already completed this assessment.\n\n' +
        'Click OK to RETAKE the test (this will update your existing report), ' +
        'or Cancel to go to your AI Counsellor to discuss your existing results.'
      );
      if (retake) {
        // Retake = a genuine fresh sitting, not a re-submit of the old answers.
        resetAssessmentState();
        _saveSession('register');
        startNMAP(); // flows into the same session_id row, regenerates report
      } else if (typeof goPage === 'function') {
        _saveSession('register');
        goPage('counsellor'); // existing report lives here, loaded from DB
      } else {
        resetAssessmentState();
        _saveSession('register');
        startNMAP();
      }
      return;
    }

    _saveSession('register');
    startNMAP();
  } catch (err) {
    // DB.saveRegistration already returns {error}; this catches anything
    // truly unexpected (e.g., a thrown DOM error from showDbStatus).
    console.error('[Register] unexpected error:', err);
    showDbStatus('error', 'Something went wrong — please try again.');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; }
  } finally {
    // Always release the lock so a stuck flag can never freeze the form.
    _registering = false;
  }
}

export { navLogoClick, goPage, _showResumeOverlay, _doResume, PIP_IDX, _goPageReal, doRegister, _registering, doAccessLogin, loadAccessNames, loadAccessClasses };
