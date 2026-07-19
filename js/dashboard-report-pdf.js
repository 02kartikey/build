/* ════════════════════════════════════════════════════════════════════
   dashboard-report-pdf.js  —  NuMind MAPS (staff dashboards)
   --------------------------------------------------------------------
   Lets Super Admin / Management / Counsellor download a student's report
   as the EXACT same PDF the student gets on test completion — by feeding
   the student's saved DB data into the very same renderer (download.js).

   Load on each dashboard AFTER the inline dashboard script:
     <script type="module" src="./js/dashboard-report-pdf.js"></script>

   In each dashboard's loadDrawerReport(sid) success path, call:
     if (window.nmMountReportPdf) window.nmMountReportPdf(sid);
   ════════════════════════════════════════════════════════════════════ */

import { downloadPDF } from './pdf/download.js';

function _authToken() {
  // Dashboards declare `let _token` (not on window); it's persisted in
  // localStorage under a per-role key. Read that, falling back to window._token.
  try {
    return localStorage.getItem('admin_token')
        || localStorage.getItem('mgmt_token')
        || localStorage.getItem('couns_token')
        || (typeof window !== 'undefined' && window._token) || '';
  } catch (_) {
    return (typeof window !== 'undefined' && window._token) || '';
  }
}

function _headers() {
  const h = { 'Content-Type': 'application/json' };
  const t = _authToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  const meta = document.querySelector('meta[name="app-token"]');
  const at = meta ? (meta.getAttribute('content') || '') : (window._APP_TOKEN || '');
  if (at) h['X-App-Token'] = at;
  return h;
}

async function downloadStudentReportPDF(sid) {
  if (!sid) return;
  const btn = document.getElementById('nm-pdf-btn');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const r = await fetch('/api/dashboard/students/' + encodeURIComponent(sid) + '/report-pdf', {
      headers: _headers(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.data) {
      throw new Error((j && j.error) || ('Request failed (' + r.status + ')'));
    }
    await downloadPDF(j.data); // same renderer the student uses
  } catch (e) {
    alert('Could not download the report: ' + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || '\u2b07 Download PDF'; }
  }
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
    btn.textContent = '\u2b07 Download PDF';
    btn.style.cssText =
      'margin-left:auto;border:none;border-radius:8px;padding:7px 12px;' +
      'background:var(--brand3,var(--brand,#7c3aed));color:#fff;font-weight:700;font-size:12px;' +
      'cursor:pointer;white-space:nowrap';
    const name = overlay.querySelector('.dr-name') || overlay.querySelector('#rd-name');
    if (name && name.parentNode) {
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
