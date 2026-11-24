/* ════════════════════════════════════════════════════════════════════
   ai/render.js
   Report panel states: preparing, ready (PDF enabled) and error.
════════════════════════════════════════════════════════════════════ */

import { _saveSession } from '../state.js';
import { _aiState } from './generator.js';

// Panel state machine: preparing / ready / error. Students read the report
// as a PDF, so nothing is painted inline. Every lookup is null-safe.
function _setDisp(id, val) { const el = document.getElementById(id); if (el) el.style.display = val; }
function _setPdfBtn(enabled) {
  const pdfBtn = document.getElementById('pdf-download-btn');
  if (pdfBtn) { pdfBtn.disabled = !enabled; pdfBtn.classList.toggle('loading', !enabled); }
}

function showAILoading(on) {
  _setDisp('ai-report-loading', on ? 'block' : 'none');
  _setDisp('ai-report-ready',   'none');
  _setDisp('ai-report-error',   'none');
  if (on) _setPdfBtn(false);
}

function showAIError(msg) {
  _setDisp('ai-report-loading', 'none');
  _setDisp('ai-report-ready',   'none');
  _setDisp('ai-report-error',   'block');
  const m = document.getElementById('ai-error-msg');
  if (m) m.textContent = msg;
  _aiState.generating = false; // release lock so the user can retry
  // Even if AI failed, allow the score-driven PDF to download.
  _setPdfBtn(true);
}

// Report finished: show the "ready" state and enable the PDF download. The
// generated data lives in window._lastAIReport and is baked into the PDF.
function renderAIReport(data) {
  // Re-save the session now that the report exists. The snapshot written when
  // the student first landed on results predates generation, so without this
  // a refresh would still find no report and regenerate it.
  try { _saveSession('results'); } catch (e) {}
  _setDisp('ai-report-loading', 'none');
  _setDisp('ai-report-error',   'none');
  _setDisp('ai-report-ready',   'block');
  // A notice from an earlier instant (no-AI) report no longer applies; the
  // fallback path re-adds it after this call when it is still true.
  const oldNotice = document.getElementById('ai-instant-notice');
  if (oldNotice) oldNotice.remove();
  _aiState.generating = false; // release lock — report is done
  _setPdfBtn(true);
}

export { showAILoading, showAIError, renderAIReport };
