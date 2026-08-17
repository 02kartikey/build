/* ════════════════════════════════════════════════════════════════════
   main.js
   Application entry point. This file:
     1. Imports every module so they execute their side-effects
        (constants, listeners, etc.) in the correct order.
     2. Re-exposes selected functions on the global window object so
        inline onclick="..." attributes in index.html keep working.
     3. Wires the DOMContentLoaded boot sequence and beforeunload save.

   To use: replace the old <script src="app.js"> tag in index.html with
       <script type="module" src="js/main.js"></script>
════════════════════════════════════════════════════════════════════ */

// ── Persistence + DB ──
import { S, DB, saveState, loadState, clearState, _isConfigured,
         _saveSession, _clearSession, _restoreSession } from './state.js';
import { showDbStatus } from './db-status.js';

// ── Routing & registration ──
import { navLogoClick, goPage, _showResumeOverlay, _doResume, _goPageReal,
         doRegister, PIP_IDX, doAccessLogin, loadAccessNames, loadAccessClasses } from './router.js';

// Expose routing functions immediately after router loads — before remaining
// imports — so inline onclick="goPage(...)" buttons never see "not defined"
// even if a later import throws.
window.goPage        = goPage;
window.navLogoClick  = navLogoClick;
window._goPageReal   = _goPageReal;
window._showResumeOverlay = _showResumeOverlay;
window._doResume     = _doResume;
window.doRegister    = doRegister;
// _m_-prefixed copies are what the inline-script shims in index.html forward
// to (see _accessFwd there). The unprefixed globals are kept for any direct
// callers. Registering both means the entry buttons work whether the module
// loads before or after the first click.
window.NM_MAIN_BUILD = 'NM-BUILD-2026-08-17-R1';
console.log('[NuMind] main.js build:', window.NM_MAIN_BUILD);
window._m_doAccessLogin   = doAccessLogin;
window._m_loadAccessNames = loadAccessNames;
window._m_loadAccessClasses = loadAccessClasses;
window._m_doRegister      = doRegister;
window._m_navLogoClick    = navLogoClick;
// goPage takes an argument, so index.html has a dedicated inline shim that
// forwards here. Registering _m_goPage lets that shim work even if the module
// graph loads after the first click (or a later import throws).
window._m_goPage          = goPage;
window.doAccessLogin   = doAccessLogin;
window.loadAccessNames = loadAccessNames;
window.loadAccessClasses = loadAccessClasses;

// ── Engine constants & scorers ──
import { CPI_AREAS, CPI_QS } from './engine/cpi.js';
import { SEA_DOMAINS, SEA_QS, DOMAIN_NAME, SEA_ENCOURAGE } from './engine/sea.js';
import { ENGINE } from './engine/scorers.js';
import { NMAP_DIMS, NMAP_RAW_STMTS, NMAP_PAGES, NMAP_ENCOURAGE } from './engine/nmap.js';
import { DAAB_SUBS, DAAB_KEYS, DAAB_VA_QS, DAAB_PA_QS, DAAB_NA_QS,
         DAAB_LSA_QS, DAAB_HMA_QS, DAAB_AR_QS, DAAB_MA_QS, DAAB_SA_QS,
         DAAB_SA_ROW_IMAGES, scoreDAAB, getStanine, stanineLabel } from './engine/daab.js';

// ── UI pages ──
import { startCPI, renderCPIQ, cpiSel, cpiNav, cpiJump, renderCPIMap, submitCPI } from './ui/cpi-page.js';
import { startNSEAAS, renderSEAPage, seaAns, trySeaNextPage, seaPageNav,
         renderSEASidebarNav, trySubmitNSEAAS } from './ui/sea-page.js';
import { startNMAP, beginNMAP, renderNMAPPage, nmapAns, tryNmapNextPage, nmapPageNav,
         renderNMAPSidebarNav, trySubmitNMAP, startTimer, stopTimer } from './ui/nmap-page.js';
import { startDAAB, renderDAABSub, beginDAABSection, advanceDAABSub, finishDAAB,
         renderVA, renderPA, renderNA, renderMCQ, renderAR, renderMA, renderSA,
         buildDAABResults } from './ui/daab-page.js';
import { buildResults, buildCharts, buildCareers, buildNMAPResults } from './ui/results.js';
import { initStateDropdown, populateCities } from './ui/registration.js';
import { restoreUI } from './ui/restore.js';

// ── Charts ──
import { switchChartTab, destroyChart } from './charts/core.js';
import { buildCPICharts } from './charts/cpi-charts.js';
import { buildSELCharts } from './charts/sea-charts.js';
import { buildNMAPCharts } from './charts/nmap-charts.js';
import { buildDAAbCharts } from './charts/daab-charts.js';
import { buildOverviewCharts } from './charts/overview-charts.js';
import { buildReportCharts } from './charts/report-charts.js';

// ── AI generation ──
import { generateAIReport, cancelReport } from './ai/generator.js';
import { renderAIReport, showAILoading, showAIError } from './ai/render.js';

// ── PDF ──
import { downloadPDF } from './pdf/download.js';

// ── DOM patches (must be called AFTER Object.assign below) ──
import { installPatches } from './dom-patches.js';

/* ─────────────────────────────────────────────────────────────────
   Re-expose to window for inline onclick="…" attributes in index.html.
   This is the bridge between ESM-scoped imports and HTML-attribute
   string lookups. If an inline handler exists in index.html, its
   identifier MUST be exposed here.
───────────────────────────────────────────────────────────────── */
Object.assign(window, {
  // routing
  navLogoClick, goPage, _showResumeOverlay, _doResume, _goPageReal, doRegister,
  doAccessLogin, loadAccessNames, loadAccessClasses,
  // assessment entry / nav
  startCPI, cpiSel, cpiNav, cpiJump, submitCPI,
  startNSEAAS, seaAns, trySeaNextPage, seaPageNav, trySubmitNSEAAS,
  startNMAP, beginNMAP, nmapAns, tryNmapNextPage, nmapPageNav, trySubmitNMAP,
  startDAAB, renderDAABSub, beginDAABSection, advanceDAABSub, finishDAAB,
  // results & charts
  buildResults, buildCharts, switchChartTab,
  // registration helpers
  initStateDropdown, populateCities,
  // AI + PDF entry points
  generateAIReport, cancelReport, renderAIReport, downloadPDF,
  // expose state + engine for debugging / for any inline JS that reads it
  S, DB, ENGINE,
});

// Install save-state wrappers NOW — window.* functions are populated above.
// This must run after Object.assign, not at module-load time.
installPatches();

/* ─────────────────────────────────────────────────────────────────
   Bootstrap — DOMContentLoaded handler (originally inline at line 221
   of the old app.js) restores any in-progress session.
───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function _initSession() {
  // Try to restore a saved session from sessionStorage; if found, show
  // the resume overlay so the user can continue where they left off.
  try {
    const savedPage = _restoreSession();
    const midPages = ['nmap','daab','cpi','nseaas','transition','transition2','transition3'];
    if (savedPage && midPages.includes(savedPage)) {
      _showResumeOverlay(savedPage);
    } else if (savedPage === 'results') {
      // Rebuild the results/report page from the restored scores before showing
      // it — _goPageReal alone would reveal an empty shell, since all result
      // content is rendered by buildResults().
      const hasScores = S && S.cpi && (S.cpi.scores || (S.sea && S.sea.scores));
      if (hasScores) {
        try { buildResults(); } catch (e) { console.warn('[NM] rebuild results failed:', e); }
        _goPageReal('results');
      } else {
        _goPageReal('landing');
      }
    } else if (savedPage === 'ready') {
      _goPageReal(savedPage);
    }
  } catch (e) {
    console.warn('[NM] init failed:', e);
  }

  // Init registration UI (state/city dropdowns).
  if (typeof initStateDropdown === 'function') {
    try { initStateDropdown(); } catch (e) {}
  }
  // Populate school suggestions on the access-code entry screen.
  if (typeof window._initAccessSchoolList === 'function') {
    try { window._initAccessSchoolList(); } catch (e) {}
  }
});

/* Save state when the page is about to unload */
window.addEventListener('beforeunload', () => {
  try { saveState(); } catch (e) {}
});

/* Surface silent saveSection failures (state.js) as a visible, non-blocking
   banner. The assessment flow is NOT interrupted — the student keeps going —
   but this is no longer invisible the way it was before. */
document.addEventListener('nm:section-save-failed', (e) => {
  const mod = (e.detail && e.detail.moduleKey) || 'section';
  try {
    showDbStatus('error', 'Progress for "' + mod + '" may not have saved — check your connection.');
  } catch (_) {}
});

console.log('[NuMind] modules loaded');

/* ── Interactive worked examples ─────────────────────────────────────────
   Every module intro shows a worked example. They used to be static with the
   answer pre-ticked — nothing to tap, nothing to learn. Now the options are
   real buttons: quiz-style examples (aptitude) reveal correct/incorrect
   feedback on tap; preference-style ones (personality / wellbeing /
   interests) accept any tap and reinforce "no right or wrong". One document-
   level delegated listener covers every page, including ones re-rendered
   later, with nothing to rebind. */
document.addEventListener('click', function (ev) {
  const opt = ev.target.closest('.eg-try');
  if (!opt) return;
  const scope = opt.closest('.eg-scope') || opt.closest('.daab-eg');
  if (!scope) return;
  const isQuiz = !!scope.querySelector('.eg-try[data-ok]');
  const multi  = scope.hasAttribute('data-eg-multi');

  if (isQuiz) {
    if (scope.classList.contains('eg-answered')) return; // locked after first try
    scope.classList.add('eg-answered');
    const right = opt.hasAttribute('data-ok');
    opt.classList.add(right ? 'eg-ok' : 'eg-no');
    scope.querySelectorAll('.eg-try[data-ok]').forEach(o => o.classList.add('eg-ok'));
    const fb = scope.querySelector('.eg-fb');
    if (fb) {
      fb.textContent = (right ? '✓ Correct! ' : '✗ Not quite — the highlighted one is right. ') + (fb.dataset.why || '');
      fb.classList.add(right ? 'eg-fb-ok' : 'eg-fb-no');
      fb.style.display = 'block';
    }
    return;
  }

  // preference mode: any answer is a good answer
  if (multi) opt.classList.toggle('eg-sel');
  else { scope.querySelectorAll('.eg-try').forEach(o => o.classList.remove('eg-sel')); opt.classList.add('eg-sel'); }
  const fb = scope.querySelector('.eg-fb');
  if (fb) { fb.style.display = 'block'; fb.classList.add('eg-fb-ok'); }
});
