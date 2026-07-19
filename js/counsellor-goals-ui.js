/* ════════════════════════════════════════════════════════════════════
   counsellor-goals-ui.js  —  NuMind MAPS (student-facing, Aria page)
   --------------------------------------------------------------------
   "About me" + milestones, presented as a proper slide-over drawer that
   matches the existing report panel (.arp-panel): dimmed scrim, right
   sheet, clear ✕ close (+ scrim-click + Esc). Opened from a "Goals" pill
   in the counsellor topbar, shown only once Aria is unlocked.

   Also turns Aria's [[MILESTONE]]{...}[[/MILESTONE]] chat tokens into an
   Accept card.

   Load AFTER ai-counsellor.js:
     <script src="./js/counsellor-goals-ui.js?v=2"></script>
   ════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var API_CONTEXT    = '/api/counsellor-context';
  var API_MILESTONES = '/api/counsellor-milestones';
  var MILESTONE_RE   = /\[\[MILESTONE\]\]\s*(\{[\s\S]*?\})\s*\[\[\/MILESTONE\]\]/g;

  /* ── Auth ────────────────────────────────────────────────────────── */
  function appToken() {
    var m = document.querySelector('meta[name="app-token"]');
    if (m && m.getAttribute('content')) return m.getAttribute('content');
    return window._APP_TOKEN || '';
  }
  function counsellorToken() {
    try {
      if (window._AC && window._AC.counsellorToken) return window._AC.counsellorToken;
      return localStorage.getItem('nmind_ac_ctok') || '';
    } catch (_) { return ''; }
  }
  function loggedIn() { return !!counsellorToken(); }
  function headers() {
    var h = { 'Content-Type': 'application/json' };
    var a = appToken(); if (a) h['X-App-Token'] = a;
    var c = counsellorToken(); if (c) h['X-Counsellor-Token'] = c;
    return h;
  }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: headers(), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  /* ── Helpers ─────────────────────────────────────────────────────── */
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function setVal(id, v) { var e = document.getElementById(id); if (e) e.value = v || ''; }
  function daysUntil(d) { if (!d) return null; var t = new Date(d + 'T00:00:00'); if (isNaN(t)) return null; var n = new Date(); n.setHours(0, 0, 0, 0); return Math.round((t - n) / 86400000); }
  function fmtDate(d) { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch (_) { return d; } }
  function dueChip(d) {
    var n = daysUntil(d); if (n == null) return '';
    if (n < 0)  return '<span class="nmg-chip nmg-chip-over">Overdue</span>';
    if (n === 0) return '<span class="nmg-chip nmg-chip-soon">Due today</span>';
    if (n <= 7) return '<span class="nmg-chip nmg-chip-soon">Due in ' + n + 'd</span>';
    return '<span class="nmg-chip nmg-chip-far">' + esc(fmtDate(d)) + '</span>';
  }

  var _panel, _built = false;

  /* ── Build drawer + topbar pill ──────────────────────────────────── */
  function mount() {
    if (_built || !document.getElementById('page-counsellor')) return;
    _built = true;
    injectCSS();
    buildPill();
    buildDrawer();
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  function buildPill() {
    var right = document.querySelector('#page-counsellor .nc-topbar-right');
    if (!right || document.getElementById('nmg-pill')) return;
    var pill = el('div', 'nmg-pill', '<span aria-hidden="true">🎯</span> Goals');
    pill.id = 'nmg-pill';
    pill.setAttribute('role', 'button');
    pill.style.display = 'none';
    pill.addEventListener('click', open);
    var reportChip = document.getElementById('acp-report-chip');
    if (reportChip) right.insertBefore(pill, reportChip);
    else right.insertBefore(pill, right.firstChild);
    syncPillVisibility();
  }

  // Show the Goals pill once Aria is unlocked (token present) or the Report
  // pill is visible. Robust to same-session unlock via observer + short poll.
  function syncPillVisibility() {
    var pill = document.getElementById('nmg-pill');
    if (!pill) return;
    var report = document.getElementById('acp-report-chip');
    function shouldShow() { return loggedIn() || (report && report.style.display !== 'none'); }
    pill.style.display = shouldShow() ? '' : 'none';
    if (report && window.MutationObserver && !pill._obs) {
      pill._obs = new MutationObserver(function () { pill.style.display = shouldShow() ? '' : 'none'; });
      pill._obs.observe(report, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    if (!pill._poll) {
      var tries = 0;
      pill._poll = setInterval(function () {
        pill.style.display = shouldShow() ? '' : 'none';
        if (shouldShow() || ++tries > 40) { clearInterval(pill._poll); pill._poll = null; }
      }, 1500);
    }
  }

  function field(id, label, ph) {
    return '<label class="nmg-lbl">' + esc(label) + '</label>' +
           '<input class="nmg-in" id="' + id + '" placeholder="' + esc(ph) + '" maxlength="600">';
  }

  function buildDrawer() {
    _panel = el('div', 'nmg-panel');
    _panel.id = 'nmg-panel';
    _panel.innerHTML =
      '<div class="nmg-scrim"></div>' +
      '<div class="nmg-sheet" role="dialog" aria-label="Goals and profile">' +
        '<div class="nmg-head">' +
          '<span>My Goals &amp; Profile</span>' +
          '<button type="button" class="nmg-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="nmg-scroll">' +

          '<section class="nmg-sec">' +
            '<div class="nmg-sec-h">My milestones</div>' +
            '<p class="nmg-sec-sub">Your next steps. Aria suggests these in chat — accept one and it appears here. You can add your own too.</p>' +
            '<div id="nmg-mlist" class="nmg-mlist"></div>' +
            '<div class="nmg-add">' +
              '<input class="nmg-in" id="nmg-newtitle" placeholder="Add your own milestone…" maxlength="120">' +
              '<div class="nmg-add-row">' +
                '<input class="nmg-in nmg-date" id="nmg-newdate" type="date" aria-label="Target date">' +
                '<button type="button" class="nmg-btn nmg-btn-primary" id="nmg-add-btn">Add</button>' +
              '</div>' +
            '</div>' +
          '</section>' +

          '<section class="nmg-sec">' +
            '<div class="nmg-sec-h">About me</div>' +
            '<p class="nmg-sec-sub">Aria reads this to give you more personal advice. Only you can see it.</p>' +
            field('nmg-goal', 'My goal', 'e.g. Become a doctor') +
            field('nmg-dream', 'A career I dream about', 'e.g. Cardiologist') +
            field('nmg-strengths', "Things I'm good at", 'e.g. Biology, helping people') +
            field('nmg-constraints', 'Worries / constraints', 'e.g. Family wants engineering') +
            '<label class="nmg-lbl">Anything else Aria should know</label>' +
            '<textarea class="nmg-in nmg-ta" id="nmg-notes" rows="3" placeholder="In your own words…" maxlength="4000"></textarea>' +
            '<div class="nmg-saverow">' +
              '<button type="button" class="nmg-btn nmg-btn-primary" id="nmg-save">Save</button>' +
              '<span class="nmg-saved" id="nmg-saved"></span>' +
            '</div>' +
          '</section>' +

        '</div>' +
      '</div>';
    document.body.appendChild(_panel);

    _panel.querySelector('.nmg-scrim').addEventListener('click', close);
    _panel.querySelector('.nmg-x').addEventListener('click', close);
    _panel.querySelector('#nmg-save').addEventListener('click', saveContext);
    _panel.querySelector('#nmg-add-btn').addEventListener('click', addOwnMilestone);
  }

  /* ── Open / close ────────────────────────────────────────────────── */
  function open() {
    if (!_panel) return;
    _panel.classList.add('nmg-open');
    document.body.style.overflow = 'hidden';
    loadContext();
    loadMilestones();
  }
  function close() {
    if (!_panel) return;
    _panel.classList.remove('nmg-open');
    document.body.style.overflow = '';
  }

  /* ── About me ────────────────────────────────────────────────────── */
  function loadContext() {
    if (!loggedIn()) return;
    api('GET', API_CONTEXT).then(function (d) {
      if (!d || !d.ok || !d.context) return;
      var f = d.context.fields || {};
      setVal('nmg-goal', f.goal); setVal('nmg-dream', f.dream_career);
      setVal('nmg-strengths', f.strengths); setVal('nmg-constraints', f.constraints);
      setVal('nmg-notes', d.context.notes);
    }).catch(function () {});
  }
  function saveContext() {
    if (!loggedIn()) { flash('Please unlock Aria first.'); return; }
    var b = document.getElementById('nmg-save');
    if (b) { b.disabled = true; b.textContent = 'Saving…'; }
    api('PUT', API_CONTEXT, {
      fields: { goal: val('nmg-goal'), dream_career: val('nmg-dream'), strengths: val('nmg-strengths'), constraints: val('nmg-constraints') },
      notes: val('nmg-notes'),
    }).then(function (d) { flash(d && d.ok ? 'Saved — Aria will use this.' : ((d && d.error) || 'Could not save.')); })
      .catch(function () { flash('Could not save.'); })
      .finally(function () { if (b) { b.disabled = false; b.textContent = 'Save'; } });
  }
  function flash(msg) {
    var e = document.getElementById('nmg-saved'); if (!e) return;
    e.textContent = msg; e.style.opacity = '1';
    setTimeout(function () { e.style.opacity = '0'; }, 2500);
  }

  /* ── Milestones ──────────────────────────────────────────────────── */
  function loadMilestones() {
    if (!loggedIn()) return;
    api('GET', API_MILESTONES).then(function (d) { renderList((d && d.milestones) || []); }).catch(function () {});
  }
  function renderList(list) {
    var wrap = document.getElementById('nmg-mlist'); if (!wrap) return;
    if (!list.length) { wrap.innerHTML = '<div class="nmg-empty">No milestones yet — ask Aria <em>"what should I do next?"</em></div>'; return; }
    wrap.innerHTML = '';
    list.forEach(function (m) {
      var done = m.status === 'completed';
      var card = el('div', 'nmg-m' + (done ? ' nmg-m-done' : ''));
      card.innerHTML =
        '<button type="button" class="nmg-check" aria-label="Toggle complete">' + (done ? '✓' : '') + '</button>' +
        '<div class="nmg-m-main">' +
          '<div class="nmg-m-title">' + esc(m.title) + '</div>' +
          (m.detail ? '<div class="nmg-m-detail">' + esc(m.detail) + '</div>' : '') +
          (!done && m.target_date ? '<div class="nmg-m-due">' + dueChip(m.target_date) + '</div>' : '') +
        '</div>' +
        '<button type="button" class="nmg-del" aria-label="Delete">&times;</button>';
      card.querySelector('.nmg-check').addEventListener('click', function () {
        api('PATCH', API_MILESTONES, { id: m.id, status: done ? 'active' : 'completed' }).then(loadMilestones).catch(function () {});
      });
      card.querySelector('.nmg-del').addEventListener('click', function () {
        api('DELETE', API_MILESTONES, { id: m.id }).then(loadMilestones).catch(function () {});
      });
      wrap.appendChild(card);
    });
  }
  function addOwnMilestone() {
    if (!loggedIn()) return;
    var t = document.getElementById('nmg-newtitle'), dt = document.getElementById('nmg-newdate'), b = document.getElementById('nmg-add-btn');
    var title = t ? t.value.trim() : ''; if (!title) { if (t) t.focus(); return; }
    var date = dt && dt.value ? dt.value : null;
    if (b) { b.disabled = true; b.textContent = '…'; }
    api('POST', API_MILESTONES, { title: title, target_date: date, source: 'student' })
      .then(function (d) { if (d && d.ok) { if (t) t.value = ''; if (dt) dt.value = ''; loadMilestones(); } })
      .catch(function () {})
      .finally(function () { if (b) { b.disabled = false; b.textContent = 'Add'; } });
  }

  /* ── Chat integration: token parsing + Accept cards ──────────────── */
  function stripMilestones(text) {
    if (!text) return text;
    var out = String(text).replace(MILESTONE_RE, '').trim();
    var open = out.lastIndexOf('[[MILESTONE]]');
    if (open !== -1 && out.indexOf('[[/MILESTONE]]', open) === -1) out = out.slice(0, open).trim();
    return out;
  }
  function extractMilestones(text) {
    var out = [], m; MILESTONE_RE.lastIndex = 0;
    while ((m = MILESTONE_RE.exec(text)) !== null) {
      try {
        var o = JSON.parse(m[1]);
        if (o && o.title) out.push({
          title: String(o.title).slice(0, 120),
          detail: o.detail ? String(o.detail).slice(0, 500) : '',
          target_date: /^\d{4}-\d{2}-\d{2}$/.test(o.target_date || '') ? o.target_date : null,
        });
      } catch (_) {}
    }
    return out;
  }
  function renderAcceptCards(streamEl, fullText) {
    var suggestions = extractMilestones(fullText);
    if (!suggestions.length || !streamEl) return;
    var host = streamEl.closest ? (streamEl.closest('.ac-msg') || streamEl) : streamEl;
    suggestions.forEach(function (s) {
      var card = el('div', 'nmg-accept');
      var when = s.target_date ? fmtDate(s.target_date) : '';
      card.innerHTML =
        '<div class="nmg-accept-h">🎯 Suggested milestone</div>' +
        '<div class="nmg-accept-t">' + esc(s.title) + '</div>' +
        (s.detail ? '<div class="nmg-accept-d">' + esc(s.detail) + (when ? ' · ' + esc(when) : '') + '</div>'
                  : (when ? '<div class="nmg-accept-d">Target ' + esc(when) + '</div>' : '')) +
        '<div class="nmg-accept-actions">' +
          '<button type="button" class="nmg-accept-yes">Add to my milestones</button>' +
          '<button type="button" class="nmg-accept-no">Not now</button>' +
        '</div>';
      var yes = card.querySelector('.nmg-accept-yes'), no = card.querySelector('.nmg-accept-no');
      yes.addEventListener('click', function () {
        yes.disabled = true; yes.textContent = 'Adding…';
        api('POST', API_MILESTONES, { title: s.title, detail: s.detail, target_date: s.target_date, source: 'aria' })
          .then(function (d) {
            if (d && d.ok) { card.innerHTML = '<div class="nmg-accept-done">✓ Added to your milestones</div>'; loadMilestones(); }
            else { yes.disabled = false; yes.textContent = 'Add to my milestones'; }
          }).catch(function () { yes.disabled = false; yes.textContent = 'Add to my milestones'; });
      });
      no.addEventListener('click', function () { card.remove(); });
      host.parentNode ? host.parentNode.insertBefore(card, host.nextSibling) : host.appendChild(card);
    });
  }

  /* ── CSS ─────────────────────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById('nmg-css')) return;
    var css =
      '.nmg-panel{--sb:#f6f7fe;--sb2:rgba(96,84,196,.05);--sbb:rgba(96,84,196,.12);--sbt:#3a4166;--sbm:#8b90b3;--v:#6a5fc7;--v2:#8b7fe0}' +
      '.nmg-pill{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:4px 10px;' +
        'border-radius:20px;background:var(--vbg,#efeafe);border:1px solid var(--vbd,#d9cffb);color:var(--v,#5c4fb5);cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s}' +
      '.nmg-pill:hover{background:#e6ddff;border-color:#c4b5fd}' +

      '.nmg-panel{position:fixed;inset:0;z-index:9600;display:none}' +
      '.nmg-panel.nmg-open{display:block}' +
      '.nmg-scrim{position:absolute;inset:0;background:rgba(0,0,0,.55);animation:nmg-fade .25s ease}' +
      '@keyframes nmg-fade{from{opacity:0}to{opacity:1}}' +
      '.nmg-sheet{position:absolute;top:0;right:0;height:100%;width:min(440px,100%);' +
        'background:var(--sb,#1a1438);border-left:1px solid var(--sbb,rgba(255,255,255,.08));' +
        'display:flex;flex-direction:column;animation:nmg-slide .28s cubic-bezier(.16,1,.3,1);box-shadow:-24px 0 60px rgba(0,0,0,.35)}' +
      '@keyframes nmg-slide{from{transform:translateX(28px);opacity:0}to{transform:none;opacity:1}}' +
      '.nmg-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;' +
        'border-bottom:1px solid var(--sbb,rgba(255,255,255,.08));font-family:var(--fd,"Poppins",sans-serif);' +
        'font-size:16px;font-weight:700;color:var(--sbt,#fff);flex-shrink:0}' +
      '.nmg-x{background:var(--sb2,rgba(255,255,255,.06));border:none;color:var(--sbm,#a89fc9);width:30px;height:30px;' +
        'border-radius:50%;cursor:pointer;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .12s}' +
      '.nmg-x:hover{background:var(--sbb,rgba(96,84,196,.12));color:#2a3050}' +
      '.nmg-scroll{flex:1;overflow-y:auto;padding:20px 22px 40px}' +

      '.nmg-sec{margin-bottom:30px}' +
      '.nmg-sec-h{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--v2,#a99bef);margin-bottom:4px}' +
      '.nmg-sec-sub{font-size:12px;line-height:1.5;color:var(--sbm,#a89fc9);margin:0 0 14px}' +

      '.nmg-lbl{display:block;font-size:11.5px;font-weight:600;color:var(--sbt,#e8e4f5);margin:14px 0 5px}' +
      '.nmg-in{width:100%;box-sizing:border-box;background:#fff;' +
        'border:1px solid var(--sbb,rgba(255,255,255,.12));border-radius:9px;padding:9px 11px;font-size:13px;' +
        'font-family:inherit;color:var(--sbt,#fff);transition:border-color .12s,background .12s}' +
      '.nmg-in::placeholder{color:var(--sbm,#8a80ad)}' +
      '.nmg-in:focus{outline:none;border-color:var(--v2,#8b7fe0);background:#fff;box-shadow:0 0 0 3px rgba(139,127,224,.12)}' +
      '.nmg-ta{resize:vertical;min-height:64px;line-height:1.5}' +
      '.nmg-date{color-scheme:dark}' +

      '.nmg-saverow{display:flex;align-items:center;gap:12px;margin-top:16px}' +
      '.nmg-saved{font-size:11.5px;color:#0f9d76;opacity:0;transition:opacity .2s}' +
      '.nmg-btn{border:none;border-radius:9px;padding:9px 18px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;transition:filter .12s,opacity .12s}' +
      '.nmg-btn-primary{background:var(--v,#6b5fc7);color:#fff}' +
      '.nmg-btn-primary:hover{filter:brightness(1.08)}' +
      '.nmg-btn:disabled{opacity:.55;cursor:default}' +

      '.nmg-mlist{display:flex;flex-direction:column;gap:9px;margin-bottom:16px}' +
      '.nmg-empty{font-size:12.5px;line-height:1.5;color:var(--sbm,#a89fc9);padding:14px;border:1px dashed var(--sbb,rgba(255,255,255,.14));border-radius:10px;text-align:center}' +
      '.nmg-empty em{color:var(--v2,#a99bef);font-style:normal}' +
      '.nmg-m{display:flex;align-items:flex-start;gap:11px;background:var(--sb2,rgba(255,255,255,.05));' +
        'border:1px solid var(--sbb,rgba(255,255,255,.1));border-radius:11px;padding:11px 12px}' +
      '.nmg-m-done{opacity:.55}.nmg-m-done .nmg-m-title{text-decoration:line-through}' +
      '.nmg-check{flex:none;width:22px;height:22px;margin-top:1px;border:2px solid var(--v2,#a99bef);border-radius:6px;' +
        'background:transparent;color:#fff;font-size:12px;font-weight:800;cursor:pointer;line-height:1;display:flex;align-items:center;justify-content:center}' +
      '.nmg-m-done .nmg-check{background:var(--v,#6b5fc7);border-color:var(--v,#6b5fc7)}' +
      '.nmg-m-main{flex:1;min-width:0}' +
      '.nmg-m-title{font-size:13.5px;font-weight:600;color:var(--sbt,#fff);line-height:1.35}' +
      '.nmg-m-detail{font-size:12px;color:var(--sbm,#a89fc9);margin-top:3px;line-height:1.45}' +
      '.nmg-m-due{margin-top:6px}' +
      '.nmg-del{flex:none;background:none;border:none;color:var(--sbm,#8a80ad);font-size:18px;line-height:1;cursor:pointer;padding:0 2px;transition:color .12s}' +
      '.nmg-del:hover{color:#dc2626}' +
      '.nmg-chip{display:inline-block;font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px}' +
      '.nmg-chip-over{background:rgba(220,38,38,.1);color:#b91c1c}' +
      '.nmg-chip-soon{background:rgba(217,119,6,.12);color:#b45309}' +
      '.nmg-chip-far{background:rgba(106,95,199,.12);color:#6a5fc7}' +

      '.nmg-add{display:flex;flex-direction:column;gap:8px;padding-top:4px}' +
      '.nmg-add-row{display:flex;gap:8px}' +
      '.nmg-add-row .nmg-date{flex:1}' +
      '.nmg-add-row .nmg-btn{flex:none;padding:9px 16px}' +

      '.nmg-accept{margin:10px 0 4px;border:1px solid #ddd6fe;background:#f5f3ff;border-radius:14px;padding:13px 15px;max-width:540px}' +
      '.nmg-accept-h{font-size:11px;font-weight:800;letter-spacing:.03em;color:#6d5fc7;text-transform:uppercase}' +
      '.nmg-accept-t{font-size:14.5px;font-weight:700;color:#1f2937;margin-top:4px;line-height:1.35}' +
      '.nmg-accept-d{font-size:12.5px;color:#6b7280;margin-top:3px;line-height:1.45}' +
      '.nmg-accept-actions{display:flex;gap:9px;margin-top:11px;flex-wrap:wrap}' +
      '.nmg-accept-yes{border:none;border-radius:9px;padding:8px 14px;background:#6b5fc7;color:#fff;font-weight:700;font-size:12.5px;cursor:pointer}' +
      '.nmg-accept-yes:hover{filter:brightness(1.06)}.nmg-accept-yes:disabled{opacity:.6;cursor:default}' +
      '.nmg-accept-no{border:1px solid #d1d5db;border-radius:9px;padding:8px 14px;background:#fff;color:#6b7280;font-weight:700;font-size:12.5px;cursor:pointer}' +
      '.nmg-accept-done{font-size:13.5px;font-weight:700;color:#059669}';
    var s = el('style'); s.id = 'nmg-css'; s.textContent = css; document.head.appendChild(s);
  }

  /* ── Public API + init ───────────────────────────────────────────── */
  window.NMGoals = {
    stripMilestones: stripMilestones,
    extractMilestones: extractMilestones,
    renderAcceptCards: renderAcceptCards,
    open: open, close: close,
    refresh: function () { loadContext(); loadMilestones(); },
    syncPill: syncPillVisibility,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
