/* ════════════════════════════════════════════════════════════════════
   dashboard-report-pdf.js  —  NuMind MAPS (staff dashboards)
   --------------------------------------------------------------------
   Lets Super Admin / Management / Counsellor download a student's report
   as the EXACT same PDF the student gets on test completion — by feeding
   the student's saved DB data into the very same renderer (download.js) —
   and download many students' reports at once as a ZIP.

   Load on each dashboard AFTER the inline dashboard script:
     <script type="module" src="./js/dashboard-report-pdf.js"></script>

   Exposes:
     window.downloadStudentReportPDF(sid)      one report, saved directly
     window.nmMountReportPdf(sid)              "Download PDF" button in the drawer
     window.nmHideReportPdf()
     window.nmDownloadReportsZip(ids, opts)    many reports → ZIP file(s)

   All requests go through the page's own `_api()` helper, so the signed-in
   role's token is always the one used.
   ════════════════════════════════════════════════════════════════════ */

import { downloadPDF } from './pdf/download.js';

const JSZIP_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
// Browsers hold a ZIP in memory until it is saved; above this size the
// download is split into numbered parts so large schools never exhaust
// the tab's memory.
const ZIP_PART_MAX_BYTES = 150 * 1024 * 1024;
// Requested per call; the server replies with its own maximum and we follow it.
const DEFAULT_BATCH = 25;

function _apiCall(method, url, body, timeout) {
  if (typeof window._api !== 'function') throw new Error('Dashboard is not ready yet.');
  return window._api(method, url, body, true, timeout);
}

async function downloadStudentReportPDF(sid) {
  if (!sid) return;
  const btn = document.getElementById('nm-pdf-btn');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const j = await _apiCall('GET', '/api/dashboard/students/' + encodeURIComponent(sid) + '/report-pdf');
    if (!j || !j.data) throw new Error((j && j.error) || 'No report data');
    await downloadPDF(j.data); // same renderer the student uses
  } catch (e) {
    alert('Could not download the report: ' + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || 'Download PDF'; }
  }
}

/* ── Bulk: many reports → ZIP ─────────────────────────────────────── */
let _jszipPromise = null;
function _loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!_jszipPromise) {
    _jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = JSZIP_SRC;
      s.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('ZIP library failed to load')));
      s.onerror = () => { _jszipPromise = null; reject(new Error('Could not load the ZIP library. Check your internet connection.')); };
      document.head.appendChild(s);
    });
  }
  return _jszipPromise;
}

// Keeps letters in any script (Devanagari names stay readable); drops characters
// that are unsafe in file names.
const _part = (v) => String(v == null ? '' : v).normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '_');

/* "Class_10_A_Asha_Verma.pdf" — sorts naturally by class, section, name. */
function _fileNameFor(student, used) {
  const st = student || {};
  const cls = _part(st.class).replace(/^class_?/i, '');
  const base = [cls ? 'Class_' + cls : '', _part(st.section), _part(st.fullName || st.firstName) || 'Student']
    .filter(Boolean).join('_');
  let name = base + '.pdf', n = 2;
  while (used.has(name.toLowerCase())) name = base + '_' + (n++) + '.pdf';
  used.add(name.toLowerCase());
  return name;
}

function _saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* nmDownloadReportsZip(ids, { label, onProgress, signal })
     ids        — student session ids (already filtered by the caller)
     label      — used in the ZIP file name
     onProgress — called with { done, total, added, skipped, part }
     signal     — any object; set signal.cancelled = true to stop early
   Resolves { added, skipped, failed, parts, cancelled, skippedNames }. */
async function nmDownloadReportsZip(ids, opts = {}) {
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) throw new Error('No students selected.');
  const JSZip = await _loadJSZip();
  const signal = opts.signal || {};
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const stamp = new Date().toISOString().slice(0, 10);
  const label = _part(opts.label || 'NuMind_reports').slice(0, 60) || 'NuMind_reports';
  const used = new Set();

  let zip = new JSZip(), partBytes = 0, partFiles = 0, parts = 0;
  let done = 0, added = 0, skipped = 0, failed = 0, batch = DEFAULT_BATCH;
  const skippedNames = [];

  const flush = async (isLast) => {
    if (!partFiles) return;
    parts++;
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const suffix = (isLast && parts === 1) ? '' : '_part' + parts;
    _saveBlob(blob, `${label}_${stamp}${suffix}.zip`);
    zip = new JSZip(); partBytes = 0; partFiles = 0;
  };

  let failure = null;
  try {
  for (let i = 0; i < list.length && !signal.cancelled; ) {
    const chunk = list.slice(i, i + batch);
    const r = await _apiCall('POST', '/api/dashboard/students/report-pdf-batch', { session_ids: chunk }, 120000);
    if (r && r.max && r.max < batch) batch = r.max;
    i += chunk.length;
    for (const item of (r.items || [])) {
      if (signal.cancelled) break;
      if (!item.data) {
        skipped++;
        if (item.error !== 'No report yet') failed++;
      } else {
        try {
          const { blob } = await downloadPDF(item.data, { returnBlob: true });
          if (partFiles && partBytes + blob.size > ZIP_PART_MAX_BYTES) await flush(false);
          zip.file(_fileNameFor(item.data.student, used), blob);
          partBytes += blob.size; partFiles++; added++;
        } catch (e) {
          failed++; skipped++;
          skippedNames.push((item.data.student && item.data.student.fullName) || item.session_id);
        }
      }
      done++;
      progress({ done, total: list.length, added, skipped, part: parts + (partFiles ? 1 : 0) });
      // Let the page repaint between renders so the progress bar moves.
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  } catch (e) { failure = e; }
  // Whatever was prepared is saved even if a request failed part-way.
  await flush(true);
  if (failure) { failure.message = (failure.message || 'Download failed') + (added ? ` — ${added} report(s) prepared before the error were saved.` : ''); throw failure; }
  return { added, skipped, failed, parts, cancelled: !!signal.cancelled, skippedNames };
}

/* Inserts (once) a "Download PDF" button into the open student drawer and
   points it at the given session id. Placed next to the student name when
   present, else at the top of the drawer overlay. */
function mountPdfButton(sid) {
  // admin/counsellor use #d-overlay + .dr-name; management uses #rd-overlay + #rd-name.
  const overlay = document.getElementById('d-overlay') || document.getElementById('rd-overlay');
  if (!overlay) return;
  let btn = document.getElementById('nm-pdf-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'nm-pdf-btn';
    btn.type = 'button';
    btn.textContent = 'Download PDF';
    btn.className = 'btn btn-primary btn-sm';
    const actions = overlay.querySelector('#dr-actions');
    const name = overlay.querySelector('.dr-name') || overlay.querySelector('#rd-name');
    if (actions) {
      actions.insertBefore(btn, actions.firstChild);        // first of the header actions
    } else if (name && name.parentNode) {
      name.parentNode.insertBefore(btn, name.nextSibling);
    } else {
      btn.style.margin = '10px 16px';
      overlay.insertBefore(btn, overlay.firstChild);
    }
  }
  btn.onclick = function () { downloadStudentReportPDF(sid); };
  btn.style.display = '';
}

/* Hide the button (e.g. when a drawer opens on a student with no report). */
function hidePdfButton() {
  const btn = document.getElementById('nm-pdf-btn');
  if (btn) btn.style.display = 'none';
}

window.downloadStudentReportPDF = downloadStudentReportPDF;
window.nmMountReportPdf = mountPdfButton;
window.nmHideReportPdf = hidePdfButton;
window.nmDownloadReportsZip = nmDownloadReportsZip;
