/* ════════════════════════════════════════════════════════════════════
   signup-gate-ui.js — lock screen for self-registration.

   Keeps the "Register myself" tab visible so students can see the option
   exists, but swaps the form for an explanation and points them at the
   access-code route instead.

   This is UX ONLY. The control that actually stops free signups is
   signup-gate.js on the server — anyone can call doRegister() from the
   console, so the form being hidden proves nothing. Both are needed: this
   one so students understand what happened, that one so it holds.

   SELF-CONTAINED BY DESIGN
   ────────────────────────
   It builds its own panel at runtime and wraps the existing handlers, so
   index.html needs exactly one script tag and no surgery. That also means it
   applies cleanly whatever revision of index.html is currently deployed.

   INSTALL — one line in index.html, immediately before </body>:

       <script src="signup-gate-ui.js"></script>

   It must come AFTER the inline script that defines switchEntryMode (which
   sits near the top of index.html), which end-of-body satisfies.

   TURNING IT OFF
   ──────────────
   Set ALLOW_SELF_SIGNUP=true on the server. This file asks
   /api/signup-status on load and unlocks itself when the server says signups
   are open, so flipping the env var is enough — no need to pull the script
   tag. If that route was not wired, it stays locked, which is the safe
   assumption given this file was installed deliberately.
════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Copy shown on the lock screen. Edit freely. ────────────────── */
  var CONTACT_EMAIL = 'social.numind@gmail.com';
  var CONTACT_LABEL = 'Talk to us about bringing NuMind to your school';

  var HEADING = 'Self-registration is closed right now';
  var BODY    = 'NuMind MAPS is currently available through partner schools. ' +
                'Your school issues each student an access code, which unlocks ' +
                'the full assessment and your AI counsellor.';
  var ACTION  = 'Already at a partner school? Ask your class teacher or ' +
                'counsellor for your access code, then use the other tab.';

  /* ── State ──────────────────────────────────────────────────────── */
  var locked = true;          // assume locked until the server says otherwise

  /* ── Panel ──────────────────────────────────────────────────────── */
  function buildPanel() {
    var existing = document.getElementById('entry-locked');
    if (existing) return existing;

    var host = document.getElementById('entry-self');
    if (!host || !host.parentNode) return null;

    var el = document.createElement('div');
    el.className = 'card cp';
    el.id = 'entry-locked';
    el.style.display = 'none';
    el.innerHTML = [
      '<div style="text-align:center;padding:8px 4px 4px">',
      '  <div style="width:56px;height:56px;margin:0 auto 18px;border-radius:16px;',
      '              display:flex;align-items:center;justify-content:center;',
      '              background:rgba(21,125,140,.08);border:1px solid rgba(21,125,140,.18)">',
      '    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#157d8c"',
      '         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '      <rect x="3" y="11" width="18" height="11" rx="2"/>',
      '      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
      '    </svg>',
      '  </div>',
      '  <h3 style="margin:0 0 10px;font-size:19px;font-weight:800;color:var(--ink,#13303a)">',
      '    ' + esc(HEADING),
      '  </h3>',
      '  <p style="margin:0 auto 16px;max-width:430px;font-size:13.5px;line-height:1.75;',
      '            color:var(--ink3,#5b7078)">' + esc(BODY) + '</p>',
      '  <div style="margin:0 auto 20px;max-width:430px;padding:12px 14px;border-radius:12px;',
      '              background:rgba(21,125,140,.05);border:1px solid rgba(21,125,140,.14);',
      '              font-size:13px;line-height:1.7;color:var(--ink2,#2c4a54)">',
      '    ' + esc(ACTION),
      '  </div>',
      '  <button type="button" class="btn btn-primary btn-full" id="entry-locked-go"',
      '          style="margin-bottom:14px">🔑 I have an access code</button>',
      '  <div style="font-size:12.5px;color:var(--ink4,#7d9199)">',
      '    ' + esc(CONTACT_LABEL) + '<br>',
      '    <a href="mailto:' + esc(CONTACT_EMAIL) + '" style="color:var(--brand,#157d8c);font-weight:700;',
      '       text-decoration:none">' + esc(CONTACT_EMAIL) + '</a>',
      '  </div>',
      '</div>',
    ].join('\n');

    host.parentNode.insertBefore(el, host.nextSibling);

    var go = el.querySelector('#entry-locked-go');
    if (go) {
      go.addEventListener('click', function () {
        if (typeof window.switchEntryMode === 'function') window.switchEntryMode('code');
      });
    }
    return el;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Mark the tab so the restriction is visible before it is clicked ── */
  function markTab() {
    var ts = document.getElementById('tab-self');
    if (!ts || ts.dataset.gated === '1') return;
    ts.dataset.gated = '1';
    ts.dataset.originalLabel = ts.textContent;
    ts.textContent = '🔒 Register myself';
    ts.title = HEADING;
    ts.style.opacity = '.72';
  }

  function restoreTab() {
    var ts = document.getElementById('tab-self');
    if (!ts || ts.dataset.gated !== '1') return;
    if (ts.dataset.originalLabel) ts.textContent = ts.dataset.originalLabel;
    ts.title = '';
    ts.style.opacity = '';
    delete ts.dataset.gated;
  }

  /* The access-code panel ends with "Don't have a code? Register yourself
     instead", which now leads straight to the lock screen — an invitation to a
     dead end, and the single most likely thing a confused student clicks.
     Rewrite it to say what they should actually do. */
  function retargetFallbackLink() {
    var panel = document.getElementById('entry-code');
    if (!panel) return;
    var link = panel.querySelector('a[onclick*="switchEntryMode"]');
    if (!link) return;
    var row = link.parentNode;
    if (!row || row.dataset.gated === '1') return;
    row.dataset.gated = '1';
    row.dataset.originalHtml = row.innerHTML;
    row.innerHTML = 'No code yet? Ask your class teacher or counsellor. ' +
      '<a href="mailto:' + esc(CONTACT_EMAIL) + '" style="color:var(--brand,#157d8c);' +
      'font-weight:700;text-decoration:none">Schools can get in touch here</a>.';
  }

  function restoreFallbackLink() {
    var panel = document.getElementById('entry-code');
    if (!panel) return;
    var row = panel.querySelector('[data-gated="1"]');
    if (!row || !row.dataset.originalHtml) return;
    row.innerHTML = row.dataset.originalHtml;
    delete row.dataset.gated;
  }

  /* The hero line invites self-registration ("Otherwise, register yourself"),
     which contradicts the lock screen a click later. */
  function retitleHero() {
    var hero = document.querySelector('#page-register .reg-hero p');
    if (!hero || hero.dataset.gated === '1') return;
    hero.dataset.gated = '1';
    hero.dataset.originalText = hero.textContent;
    hero.textContent = 'Enter the access code your school gave you to begin.';
  }

  function restoreHero() {
    var hero = document.querySelector('#page-register .reg-hero p');
    if (!hero || hero.dataset.gated !== '1') return;
    if (hero.dataset.originalText) hero.textContent = hero.dataset.originalText;
    delete hero.dataset.gated;
  }

  /* ── Wrap the tab switcher ──────────────────────────────────────── */
  var originalSwitch = window.switchEntryMode;

  function gatedSwitch(mode) {
    if (typeof originalSwitch === 'function') {
      try { originalSwitch(mode); } catch (_) { /* keep going — panels below */ }
    }
    var selfPanel   = document.getElementById('entry-self');
    var lockedPanel = locked ? buildPanel() : document.getElementById('entry-locked');

    if (!locked) {
      if (lockedPanel) lockedPanel.style.display = 'none';
      return;
    }
    if (mode === 'self') {
      if (selfPanel)   selfPanel.style.display = 'none';
      if (lockedPanel) lockedPanel.style.display = '';
    } else {
      if (lockedPanel) lockedPanel.style.display = 'none';
    }
  }

  window.switchEntryMode = gatedSwitch;

  /* ── Neutralise the submit handler ───────────────────────────────────
     Defence in depth only. The form is hidden by the tab wrapper above and
     the server refuses the write regardless, so this layer exists for someone
     calling doRegister() from the console.

     Two things fight us:

     1. index.html declares `function doRegister(){…}` at the top level of an
        inline script. Per CreateGlobalFunctionBinding that produces a global
        property with configurable:FALSE, so Object.defineProperty on it
        throws TypeError. (Verified: Node reports
        {writable:true,enumerable:true,configurable:false} for a real global
        function declaration, and defineProperty on it throws. An earlier
        version of this file assumed an accessor would hold and was wrong.)

     2. main.js then runs Object.assign(window, { … doRegister … }) when its
        module graph loads, replacing whatever we put there.

     So: attempt the accessor (it holds where the property IS configurable),
     and regardless of that, re-assert a plain assignment from apply(), which
     runs on an interval long enough to outlast the deferred module graph. */
  var realRegister = window.doRegister;

  function blockedRegister() {
    if (!locked) {
      if (typeof realRegister === 'function') return realRegister.apply(this, arguments);
      return;
    }
    if (typeof window.switchEntryMode === 'function') window.switchEntryMode('self');
    var panel = document.getElementById('entry-locked');
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  try {
    Object.defineProperty(window, 'doRegister', {
      configurable: true,
      get: function () { return blockedRegister; },
      set: function (v) { realRegister = v; },   // accepted, then ignored
    });
  } catch (_) {
    window.doRegister = blockedRegister;         // non-configurable: plain write
  }

  /* Re-assert after anything overwrites it, capturing the real implementation
     on the way past so unlocking can hand it back. */
  function assertOverride() {
    if (!locked) {
      if (window.doRegister === blockedRegister && typeof realRegister === 'function') {
        try { window.doRegister = realRegister; } catch (_) {}
      }
      return;
    }
    if (window.doRegister !== blockedRegister) {
      if (typeof window.doRegister === 'function') realRegister = window.doRegister;
      try { window.doRegister = blockedRegister; } catch (_) {}
    }
  }

  /* Belt and braces: the submit button carries onclick="doRegister()". If the
     override is ever lost, a disabled button still cannot fire it. */
  function gateSubmitButton() {
    var selfPanel = document.getElementById('entry-self');
    if (!selfPanel) return;
    var btn = selfPanel.querySelector('[onclick*="doRegister"]');
    if (!btn) return;
    if (locked) {
      if (btn.dataset.gated === '1') return;
      btn.dataset.gated = '1';
      btn.dataset.originalOnclick = btn.getAttribute('onclick') || '';
      btn.removeAttribute('onclick');
      btn.disabled = true;
      btn.style.opacity = '.5';
      btn.style.cursor = 'not-allowed';
    } else if (btn.dataset.gated === '1') {
      if (btn.dataset.originalOnclick) btn.setAttribute('onclick', btn.dataset.originalOnclick);
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = '';
      delete btn.dataset.gated;
    }
  }

  /* ── Apply, and re-apply once the deferred modules have painted ──── */
  function apply() {
    assertOverride();
    gateSubmitButton();
    if (locked) {
      markTab();
      retitleHero();
      retargetFallbackLink();
      buildPanel();
      var selfPanel = document.getElementById('entry-self');
      var tabSelf   = document.getElementById('tab-self');
      // If the page happens to be sitting on the self tab already, swap now.
      if (selfPanel && selfPanel.style.display !== 'none' &&
          tabSelf && tabSelf.classList.contains('active')) {
        gatedSwitch('self');
      }
    } else {
      restoreTab();
      restoreHero();
      restoreFallbackLink();
      var lk = document.getElementById('entry-locked');
      if (lk) lk.style.display = 'none';
    }
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  onReady(function () {
    apply();
    // The register page is rendered by the router, so its nodes may not exist
    // at DOMContentLoaded. A few short re-applies cost nothing and avoid a
    // race against the deferred module graph.
    // ~12s of re-application: long enough to outlast a slow deferred module
    // graph on a poor school connection, then it stops and costs nothing.
    var tries = 0;
    var t = setInterval(function () {
      apply();
      if (++tries >= 30) clearInterval(t);
    }, 400);

    /* Ask the server rather than assume. If signups were reopened via
       ALLOW_SELF_SIGNUP, unlock without needing this file pulled. A missing
       route or a failed request leaves it locked. */
    try {
      fetch('/api/signup-status', { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (j && j.selfSignupOpen === true) { locked = false; apply(); }
        })
        .catch(function () { /* stay locked */ });
    } catch (_) { /* stay locked */ }
  });
})();
