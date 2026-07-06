/* ════════════════════════════════════════════════════════════════════
   ai-counsellor.js  —  Frontend AI Counsellor (page-only, no bubble)

   Fixes applied:
   • All fetch calls include X-App-Token header (fixes 401)
   • Back to Report uses _goPageReal() not goPage() (fixes blank page)
   • Floating bubble removed entirely
   • hasCompletedAssessment on server now also passes on completed
     sections even before report generation
════════════════════════════════════════════════════════════════════ */

/* ── Handle 401 from any counsellor endpoint ─────────────────────
   When the server returns 401, the counsellor token has expired (8h TTL)
   or the session was invalidated. Clear the stale token from memory and
   localStorage, then reset to the unlock screen so the student can
   re-authenticate silently — they never see a raw "Unauthorized" error.
──────────────────────────────────────────────────────────────────── */
function _acHandle401() {
  // Clear stale token
  _AC.counsellorToken = null;
  _AC.unlocked        = false;
  try { localStorage.removeItem('nmind_ac_ctok'); } catch(_) {}
  // Show the lock screen again with a friendly message
  const lockCard   = document.getElementById('acp-lock-card');
  const lockLoader = document.getElementById('acp-lock-loading');
  const chatArea   = document.getElementById('acp-chat-area');
  const errEl      = document.getElementById('acp-email-err');
  if (lockLoader) lockLoader.style.display = 'none';
  if (lockCard)   lockCard.style.display   = '';
  if (chatArea)   chatArea.style.display   = 'none';
  if (errEl) {
    errEl.textContent   = 'Your session has expired. Please enter your email to continue.';
    errEl.style.display = 'block';
  }
  // Re-fill email if we know it
  const emailEl = document.getElementById('acp-email-input');
  if (emailEl && _AC.email) { emailEl.value = _AC.email; emailEl.disabled = false; }
}
// Read APP_TOKEN from <meta name="app-token"> injected by server.
// Falls back to window._APP_TOKEN for backwards compatibility.
// The meta tag approach keeps the token out of JS global scope.
function _acToken() {
  if (typeof document !== 'undefined') {
    var meta = document.querySelector('meta[name="app-token"]');
    if (meta) return meta.getAttribute('content') || '';
  }
  return (typeof window !== 'undefined' && window._APP_TOKEN) ? window._APP_TOKEN : '';
}

function _acHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const tok = _acToken();
  if (tok) h['X-App-Token'] = tok;
  // Include counsellor session token if available (prevents email spoofing)
  const ctok = (_AC && _AC.counsellorToken)
    || (typeof localStorage !== 'undefined' && localStorage.getItem('nmind_ac_ctok'))
    || '';
  if (ctok) h['X-Counsellor-Token'] = ctok;
  return h;
}

/* ── State ─────────────────────────────────────────────────────── */
const _AC = {
  email:           null,
  name:            null,
  counsellorToken: (function(){ try { return localStorage.getItem('nmind_ac_ctok') || null; } catch(_){ return null; }})(),
  unlocked:        false,
  messages:        [],
  streaming:       false,
  abortCtrl:       null,
  conversationId:  null,
  reportSummary:   null,
  fullScores:      null,  // full score arrays from unlock — enables report panel for returning users
};

/* ── DOM helpers ────────────────────────────────────────────────── */
function _acEl(id) { return document.getElementById(id); }

/* ── Email unlock ───────────────────────────────────────────────── */
/* ── Auth state for multi-step lock flow ───────────────────────── */
const _LOCK = { email: null, step: null, otpToken: null, purpose: 'register' };

/* ── Step manager (DOM-based) ───────────────────────────────────── */
function _makeLockInput(id, type, placeholder, inputmode, onEnter) {
  var el = document.createElement('input');
  el.id = id; el.type = type; el.placeholder = placeholder;
  if (inputmode) el.setAttribute('inputmode', inputmode);
  el.maxLength = 6;
  el.style.cssText = 'width:100%;padding:12px 14px;background:#faf9fc;border:1.5px solid var(--bdr2, #ccc8bf);border-radius:10px;color:#3c3454;font-size:20px;letter-spacing:0.3em;text-align:center;box-sizing:border-box;outline:none;margin-bottom:10px';
  if (onEnter) el.addEventListener('keydown', function(e){ if (e.key === 'Enter') onEnter(); });
  return el;
}
function _makeLockBtn(id, text, color, onClick) {
  var btn = document.createElement('button');
  btn.id = id; btn.textContent = text;
  btn.style.cssText = 'width:100%;padding:13px;background:' + color + ';border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;margin-bottom:10px;transition:opacity .15s';
  btn.addEventListener('click', onClick);
  return btn;
}
function _makeLockErr(id) {
  var el = document.createElement('div');
  el.id = id; el.style.cssText = 'display:none;color:#f87171;font-size:12px;margin-bottom:8px';
  return el;
}

function _lockStep(step, opts) {
  _LOCK.step = step;
  var card = _acEl('acp-lock-card');
  if (!card) return;
  ['acp-step-pin','acp-step-set-pin','acp-step-otp'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.parentNode.removeChild(el);
  });
  var container = card.querySelector('.nc-lock-form') || card;
  var wrap = document.createElement('div');

  // Email attribution line
  if (opts && opts.email) {
    var p = document.createElement('p');
    p.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.4);margin:0 0 14px';
    var strong = document.createElement('strong');
    strong.style.color = 'rgba(255,255,255,0.7)';
    strong.textContent = opts.email;
    p.textContent = 'Signing in as ';
    p.appendChild(strong);
    p.appendChild(document.createTextNode(' \xb7 '));
    var a = document.createElement('a'); a.href = 'javascript:void(0)';
    a.textContent = 'Change'; a.style.color = '#a78bfa';
    a.addEventListener('click', _lockReset);
    p.appendChild(a);
    wrap.appendChild(p);
  }

  if (step === 'otp') {
    wrap.id = 'acp-step-otp';
    var descOtp = document.createElement('p');
    descOtp.textContent = 'We sent a 6-digit code to your email. Enter it below to continue.';
    descOtp.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.55);margin:0 0 14px;line-height:1.5';
    wrap.appendChild(descOtp);
    wrap.appendChild(_makeLockInput('acp-otp-input', 'text', '\u2022\u2022\u2022\u2022\u2022\u2022', 'numeric', _acSubmitOtp));
    wrap.appendChild(_makeLockErr('acp-otp-err'));
    wrap.appendChild(_makeLockBtn('acp-otp-btn', 'Verify Code', 'linear-gradient(135deg,#6d28d9,#7c3aed)', _acSubmitOtp));
    var p3 = document.createElement('p');
    p3.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,0.3);text-align:center;margin:0';
    p3.appendChild(document.createTextNode("Didn't get a code? "));
    var resend = document.createElement('a'); resend.href = 'javascript:void(0)';
    resend.textContent = 'Resend'; resend.style.color = '#a78bfa';
    resend.addEventListener('click', _acResendOtp);
    p3.appendChild(resend);
    wrap.appendChild(p3);
    container.appendChild(wrap);
    setTimeout(function(){ var i = document.getElementById('acp-otp-input'); if (i) i.focus(); }, 100);
  }

  if (step === 'enter-pin') {
    wrap.id = 'acp-step-pin';
    var desc = document.createElement('p');
    desc.textContent = 'Enter your PIN to access your AI Counsellor.';
    desc.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.55);margin:0 0 14px';
    wrap.appendChild(desc);
    wrap.appendChild(_makeLockInput('acp-pin-input', 'password', '\u2022\u2022\u2022\u2022\u2022\u2022', 'numeric', _acSubmitPin));
    wrap.appendChild(_makeLockErr('acp-pin-err'));
    wrap.appendChild(_makeLockBtn('acp-pin-btn', 'Unlock', 'linear-gradient(135deg,#6d28d9,#7c3aed)', _acSubmitPin));
    var p2 = document.createElement('p');
    p2.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,0.3);text-align:center;margin:0';
    p2.appendChild(document.createTextNode('Forgot PIN? '));
    var forgot = document.createElement('a'); forgot.href = 'javascript:void(0)';
    forgot.textContent = 'Reset'; forgot.style.color = '#a78bfa';
    forgot.addEventListener('click', _acForgotPin);
    p2.appendChild(forgot);
    wrap.appendChild(p2);
    container.appendChild(wrap);
    setTimeout(function(){ var i = document.getElementById('acp-pin-input'); if (i) i.focus(); }, 100);
  }

  if (step === 'set-pin') {
    wrap.id = 'acp-step-set-pin';
    var desc = document.createElement('p');
    desc.textContent = 'Create a 4-6 digit PIN. You will use it to log in from any device.';
    desc.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.55);margin:0 0 14px;line-height:1.5';
    wrap.appendChild(desc);
    wrap.appendChild(_makeLockInput('acp-newpin-input', 'password', 'Create PIN', 'numeric', function(){
      var c = document.getElementById('acp-newpin-confirm'); if (c) c.focus();
    }));
    wrap.appendChild(_makeLockInput('acp-newpin-confirm', 'password', 'Confirm PIN', 'numeric', _acSetPin));
    wrap.appendChild(_makeLockErr('acp-setpin-err'));
    wrap.appendChild(_makeLockBtn('acp-setpin-btn', 'Set PIN & Enter', 'linear-gradient(135deg,#059669,#10b981)', _acSetPin));
    container.appendChild(wrap);
    setTimeout(function(){ var i = document.getElementById('acp-newpin-input'); if (i) i.focus(); }, 100);
  }
}

function _lockReset() {
  ['acp-step-otp','acp-step-pin','acp-step-set-pin'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.parentNode.removeChild(el);
  });
  var emailEl = _acEl('acp-email-input');
  if (emailEl) { emailEl.disabled = false; emailEl.value = ''; emailEl.focus(); }
  var btn = _acEl('acp-unlock-btn');
  if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Continue \u2192'; }
  var errEl = _acEl('acp-email-err');
  if (errEl) errEl.style.display = 'none';
  _LOCK.email = null; _LOCK.step = null; _LOCK.otpToken = null; _LOCK.purpose = 'register'; _LOCK._isReset = false;
}

async function acUnlock() {
  var emailEl = _acEl('acp-email-input');
  var errEl   = _acEl('acp-email-err');
  if (!emailEl) return;

  var email = emailEl.value.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (errEl) { errEl.textContent = 'Please enter a valid email address.'; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  _LOCK.email = email;

  var btn = _acEl('acp-unlock-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking\u2026'; }

  try {
    var resp = await fetch('/api/counsellor-unlock', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: email }),
    });
    var data = await resp.json();

    // Whatever the response, we now have something to show — reverse the
    // spinner state that goToCounsellor()'s fast path may have set (spinner
    // shown, lock-card hidden). Without this, a set-pin/enter-pin step or an
    // error gets built correctly into #acp-lock-card, but that container is
    // still display:none, leaving the student stuck on "Loading…" forever.
    var lockLoader = _acEl('acp-lock-loading');
    var lockCard   = _acEl('acp-lock-card');
    if (lockLoader) lockLoader.style.display = 'none';
    if (lockCard)   lockCard.style.display   = '';

    if (data.unlocked) { _acApplySession(data); return; }

    if (btn) { btn.style.display = 'none'; }
    emailEl.disabled = true;

    if (data.step === 'set-pin') {
      _lockStep('set-pin', { email: email });
    } else if (data.step === 'enter-pin') {
      _lockStep('enter-pin', { email: email });
    } else if (data.step === 'otp-sent') {
      _LOCK.purpose = data.purpose || 'register';
      _lockStep('otp', { email: email });
    } else {
      if (errEl) { errEl.textContent = data.error || 'Something went wrong.'; errEl.style.display = 'block'; }
      emailEl.disabled = false;
      if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Continue \u2192'; }
    }
  } catch (e) {
    var lockLoader2 = _acEl('acp-lock-loading');
    var lockCard2   = _acEl('acp-lock-card');
    if (lockLoader2) lockLoader2.style.display = 'none';
    if (lockCard2)   lockCard2.style.display   = '';
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Continue \u2192'; }
    if (errEl) { errEl.textContent = 'Connection error. Please try again.'; errEl.style.display = 'block'; }
  }
}

async function _acResendOtp() {
  // Re-send OTP for the current purpose (register or reset).
  if (!_LOCK.email) return;
  var errEl = document.getElementById('acp-otp-err');
  var resendLink = document.querySelector('#acp-step-otp a');
  try {
    if (resendLink) { resendLink.textContent = 'Sending\u2026'; resendLink.style.pointerEvents = 'none'; }
    if (_LOCK.purpose === 'reset') {
      await fetch('/api/counsellor-request-otp', {
        method: 'POST', headers: _acHeaders(),
        body: JSON.stringify({ email: _LOCK.email }),
      });
    } else {
      // Register-purpose OTPs are sent as a side effect of counsellor-unlock —
      // re-calling it with the same email resends a fresh code.
      await fetch('/api/counsellor-unlock', {
        method: 'POST', headers: _acHeaders(),
        body: JSON.stringify({ email: _LOCK.email }),
      });
    }
    if (errEl) { errEl.textContent = 'A new code has been sent.'; errEl.style.color = '#34d399'; errEl.style.display = 'block'; }
  } catch (_) {
    if (errEl) { errEl.textContent = 'Could not resend — check your connection.'; errEl.style.color = ''; errEl.style.display = 'block'; }
  } finally {
    if (resendLink) { resendLink.textContent = 'Resend'; resendLink.style.pointerEvents = ''; }
  }
}

async function _acSubmitOtp() {
  var otp   = (document.getElementById('acp-otp-input') || {value:''}).value.trim();
  var errEl = document.getElementById('acp-otp-err');
  var btn   = document.getElementById('acp-otp-btn');
  if (otp.length < 4) {
    if (errEl) { errEl.textContent = 'Please enter the 6-digit code.'; errEl.style.display = 'block'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying\u2026'; }
  if (errEl) errEl.style.display = 'none';
  try {
    var resp = await fetch('/api/counsellor-verify-otp', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: _LOCK.email, otp: otp, purpose: _LOCK.purpose }),
    });
    var data = await resp.json();
    if (!data.ok) {
      if (errEl) { errEl.textContent = data.error || 'Incorrect code. Try again.'; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Verify Code'; }
      return;
    }
    _LOCK.otpToken = data.otpToken;
    _lockStep('set-pin', { email: _LOCK.email, isReset: _LOCK.purpose === 'reset' });
  } catch (_) {
    if (errEl) { errEl.textContent = 'Connection error. Please try again.'; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Verify Code'; }
  }
}

async function _acSubmitPin() {
  var pin   = (document.getElementById('acp-pin-input') || {value:''}).value.trim();
  var errEl = document.getElementById('acp-pin-err');
  var btn   = document.getElementById('acp-pin-btn');
  if (!pin) {
    if (errEl) { errEl.textContent = 'Please enter your PIN.'; errEl.style.display = 'block'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Checking\u2026'; }
  if (errEl) errEl.style.display = 'none';
  try {
    var _ctrl = new AbortController();
    var _timeoutId = setTimeout(function(){ _ctrl.abort(); }, 15000);
    var resp = await fetch('/api/counsellor-verify-pin', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: _LOCK.email, pin: pin }),
      signal: _ctrl.signal,
    });
    clearTimeout(_timeoutId);
    var data = await resp.json();
    if (!data.unlocked) {
      if (errEl) { errEl.textContent = data.error || 'Incorrect PIN. Try again.'; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Unlock'; }
      return;
    }
    _acApplySession(data);
  } catch (e) {
    var _msg = (e && e.name === 'AbortError') ? 'Request timed out. Please try again.' : 'Connection error. Please try again.';
    if (errEl) { errEl.textContent = _msg; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Unlock'; }
  }
}

async function _acSetPin() {
  var pin     = (document.getElementById('acp-newpin-input')   || {value:''}).value.trim();
  var confirm = (document.getElementById('acp-newpin-confirm') || {value:''}).value.trim();
  var errEl   = document.getElementById('acp-setpin-err');
  var btn     = document.getElementById('acp-setpin-btn');
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    if (errEl) { errEl.textContent = 'PIN must be 4-6 digits (numbers only).'; errEl.style.display = 'block'; }
    return;
  }
  if (pin !== confirm) {
    if (errEl) { errEl.textContent = 'PINs do not match. Please try again.'; errEl.style.display = 'block'; }
    return;
  }
  if (!_LOCK.email) { _lockReset(); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
  if (errEl) errEl.style.display = 'none';
  try {
    // Use reset-pin (overwrites existing) when coming from "forgot PIN" flow
    // Use set-pin (blocks if PIN exists) for first-time setup
    var endpoint = (_LOCK.step === 'set-pin' && _LOCK._isReset) ? '/api/counsellor-reset-pin' : '/api/counsellor-set-pin';
    var resp = await fetch(endpoint, {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: _LOCK.email, pin: pin, otpToken: _LOCK.otpToken || undefined }),
    });
    var data = await resp.json();
    if (data.error) {
      if (errEl) { errEl.textContent = data.error; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Set PIN & Enter'; }
      if (data.step === 'enter-pin') _lockStep('enter-pin', { email: _LOCK.email });
      return;
    }
    if (data.unlocked) {
      _acApplySession(data);
    } else {
      _lockStep('enter-pin', { email: _LOCK.email });
    }
  } catch (_) {
    if (errEl) { errEl.textContent = 'Connection error. Please try again.'; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Set PIN'; }
  }
}

async function _acForgotPin() {
  if (!_LOCK.email) return;
  _LOCK._isReset = true;
  _LOCK.purpose  = 'reset';
  var errEl = document.getElementById('acp-pin-err');
  try {
    await fetch('/api/counsellor-request-otp', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: _LOCK.email }),
    });
  } catch (_) {
    // Fall through regardless — request-otp responds ok:true even on most
    // failures (anti-enumeration), so a network hiccup here is rare; the
    // OTP step's own "Resend" link covers the case where no email arrives.
  }
  _lockStep('otp', { email: _LOCK.email });
}

function _acApplySession(data) {
  _AC.email         = _LOCK.email || data.email;
  _AC.name          = data.name || 'Student';
  _AC.unlocked      = true;
  _AC.messages      = (data.history || []).map(function(h){ return { role: h.role, content: h.content }; });
  _AC.reportSummary = data.reportSummary || null;
  _AC.fullScores    = data.fullScores    || null;
  if (data.counsellorToken) {
    _AC.counsellorToken = data.counsellorToken;
    try { localStorage.setItem('nmind_ac_ctok', data.counsellorToken); } catch(_) {}
  }
  if (data.conversations) _AC._serverConvs = data.conversations;
  // Dispatch event so index.html patch can run the UI transition
  // (same as if acUnlock() had completed successfully)
  document.dispatchEvent(new CustomEvent('ac:unlocked', { detail: data }));
}

/* ── Change PIN from within the chat ────────────────────────────── */
async function acChangePinRequest() {
  if (!_AC.unlocked || !_AC.email) return;
  _LOCK.email = _AC.email; _LOCK._isReset = true; _LOCK.purpose = 'reset';
  var chat = document.getElementById('acp-chat');
  var lock = document.getElementById('acp-lock');
  if (chat) chat.style.display = 'none';
  if (lock) lock.style.display = '';
  // Server now requires OTP verification before any PIN reset when SMTP is
  // configured — even for an already-authenticated student. Request the
  // code, then show the OTP step (not set-pin directly, which would 401).
  try {
    await fetch('/api/counsellor-request-otp', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: _AC.email }),
    });
  } catch (_) {}
  _lockStep('otp', { email: _AC.email });
}
window.acChangePinRequest = acChangePinRequest;

window._lockStep    = _lockStep;
window._lockReset   = _lockReset;
window._acSubmitOtp = _acSubmitOtp;
window._acSubmitPin = _acSubmitPin;
window._acSetPin    = _acSetPin;
window._acForgotPin = _acForgotPin;
window._acApplySession = _acApplySession;

/* ── Send message ───────────────────────────────────────────────── */
async function acSend() {
  if (_AC.streaming) return;
  const inputEl = _acEl('acp-input');
  if (!inputEl) return;

  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  _acResizeTextarea(inputEl);

  _acAppendMessage('user', text, 'acp-messages');
  _AC.messages.push({ role: 'user', content: text });

  // Trigger rolling summary if we just hit an interval boundary
  await _acTriggerSummaryIfNeeded();

  const typingId = _acAddTyping('acp-messages');
  _AC.streaming  = true;
  _AC.abortCtrl  = new AbortController();

  try {
    const res = await fetch('/api/counsellor-chat', {
      method:  'POST',
      headers: _acHeaders(),
      body:    JSON.stringify({ email: _AC.email, message: text, history: _AC.messages.slice(-20), conversationId: _AC.conversationId || null }),
      signal:  _AC.abortCtrl.signal,
    });

    _acRemoveTyping(typingId);

    if (res.status === 401) {
      _acHandle401();
      return;
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: 'Server error' }));
      _acAppendMessage('assistant', errData.error || 'Something went wrong. Please try again.', 'acp-messages');
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText  = '';
    const streamEl = _acCreateStreamEl('acp-messages');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
      streamEl.innerHTML = '';
      streamEl.appendChild(window._acRenderMarkdown(fullText));
      _acScrollToBottom('acp-messages');
    }

    // Final render to guarantee fully-formatted output once streaming ends
    streamEl.innerHTML = '';
    streamEl.appendChild(window._acRenderMarkdown(fullText));
    streamEl.classList.remove('ac-streaming');
    // Only record assistant turn if we actually got content
    if (fullText.trim()) {
      _AC.messages.push({ role: 'assistant', content: fullText });
    } else {
      // Empty stream — remove the blank bubble so chat stays clean
      streamEl.closest('.ac-msg')?.remove();
    }

  } catch (err) {
    _acRemoveTyping(typingId);
    if (err.name !== 'AbortError') {
      // Append error bubble with a retry button
      const errText = err.message && err.message.includes('fetch')
        ? 'Connection lost. Check your network and try again.'
        : 'Something went wrong. Please try again.';
      _acAppendErrorWithRetry(errText, text, 'acp-messages');
    }
  } finally {
    _AC.streaming = false;
    _AC.abortCtrl = null;
  }
}

/* ── Clear history ──────────────────────────────────────────────── */
async function acClearHistory() {
  if (!_AC.email) return;
  if (!confirm('Clear your entire chat history? This cannot be undone.')) return;
  await fetch('/api/counsellor-clear-history', {
    method:  'POST',
    headers: _acHeaders(),
    body:    JSON.stringify({ email: _AC.email }),
  }).catch(() => {});
  _AC.messages = [];
  const el = _acEl('acp-messages');
  if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  // Show welcome screen again
  const welcome = _acEl('acp-welcome');
  if (welcome) welcome.style.display = '';
}

/* ── Render helpers ─────────────────────────────────────────────── */
function _acAppendMessage(role, content, containerId) {
  const el = _acEl(containerId);
  if (!el) return;
  const wrap   = document.createElement('div');
  wrap.className = `ac-msg ac-msg-${role}`;
  const bubble = document.createElement('div');
  bubble.className  = 'ac-bubble';
  bubble.textContent = content;
  wrap.appendChild(bubble);
  el.appendChild(wrap);
  _acScrollToBottom(containerId);
}

function _acCreateStreamEl(containerId) {
  const el = _acEl(containerId);
  if (!el) return { textContent: '', innerHTML: '', appendChild: () => {}, classList: { remove: () => {} } };
  const wrap   = document.createElement('div');
  wrap.className = 'ac-msg ac-msg-assistant';
  const bubble = document.createElement('div');
  bubble.className = 'ac-bubble ac-streaming';
  wrap.appendChild(bubble);
  el.appendChild(wrap);
  _acScrollToBottom(containerId);
  return bubble;
}

function _acAddTyping(containerId) {
  const el = _acEl(containerId);
  if (!el) return null;
  const id   = 'ac-typing-' + Date.now();
  const wrap = document.createElement('div');
  wrap.className = 'ac-msg ac-msg-assistant';
  wrap.id        = id;
  wrap.innerHTML = '<div class="ac-bubble ac-typing"><span></span><span></span><span></span></div>';
  el.appendChild(wrap);
  _acScrollToBottom(containerId);
  return id;
}

function _acRemoveTyping(id) {
  if (!id) return;
  const el = document.getElementById(id);
  if (el) el.remove();
}

function _acScrollToBottom(containerId) {
  const el = _acEl(containerId);
  if (el) el.scrollTop = el.scrollHeight;
}

function _acResizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/* ── Counsellor Connect Form ────────────────────────────────────── */
async function submitCounsellorQuery() {
  const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const showErr = (id, msg) => {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
  };

  const name    = get('cq-name');
  const email   = get('cq-email');
  const message = get('cq-message');
  const date    = get('cq-date');
  const time    = get('cq-time');

  let valid = true;
  if (!name)    { showErr('cq-err-name',    'Please enter your name.');    valid = false; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                  showErr('cq-err-email',   'Please enter a valid email.'); valid = false; }
  if (!message) { showErr('cq-err-message', 'Please describe your query.'); valid = false; }
  if (!valid) return;

  ['cq-err-name','cq-err-email','cq-err-message'].forEach(id => showErr(id, ''));

  const btn = document.getElementById('cq-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  try {
    const res = await fetch('/api/counsellor-query', {
      method:  'POST',
      headers: _acHeaders(),
      body:    JSON.stringify({ name, email, message, preferredDate: date, preferredTime: time }),
    });

    if (res.ok) {
      const formEl = document.getElementById('cq-form');
      const succEl = document.getElementById('cq-success');
      if (formEl) formEl.style.display = 'none';
      if (succEl) succEl.style.display = 'block';
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Something went wrong. Please try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Send My Query'; }
    }
  } catch (e) {
    alert('Connection error. Please try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Send My Query'; }
  }
}

/* ── Error bubble with retry ────────────────────────────────────── */
function _acAppendErrorWithRetry(errorText, originalMessage, containerId) {
  const el = _acEl(containerId);
  if (!el) return;
  const wrap   = document.createElement('div');
  wrap.className = 'ac-msg ac-msg-assistant';
  const av     = document.createElement('div');
  av.className = 'acp-msg-av';
  av.textContent = '✨';
  const bubble = document.createElement('div');
  bubble.className = 'ac-bubble';
  bubble.style.cssText = 'background:#fff8f0;border-color:#fde68a;color:var(--ink2)';
  const msg = document.createElement('span');
  msg.textContent = errorText;
  const retryBtn = document.createElement('button');
  retryBtn.className = 'ac-retry-btn';
  retryBtn.textContent = '↩ Retry';
  retryBtn.addEventListener('click', function() {
    wrap.remove();
    const inp = document.getElementById('acp-input');
    if (inp) { inp.value = originalMessage; }
    if (typeof acSend === 'function') acSend();
  });
  bubble.appendChild(msg);
  const retryWrap = document.createElement('div');
  retryWrap.style.marginTop = '6px';
  retryWrap.appendChild(retryBtn);
  bubble.appendChild(retryWrap);
  wrap.appendChild(av);
  wrap.appendChild(bubble);
  el.appendChild(wrap);
  _acScrollToBottom(containerId);
}

/* ── Navigate to/from counsellor page ──────────────────────────── */
function goToCounsellor() {
  if (typeof window.goPage === 'function') window.goPage('counsellor');

  // If student just came from results, S.student.email is in memory.
  // Show loading spinner immediately to avoid lock screen flash, then
  // pre-fill the email and auto-trigger unlock so they skip the gate.
  const email = window.S && window.S.student && window.S.student.email;
  if (email && !_AC.unlocked) {
    // Show spinner immediately — user should never see the email form
    // when arriving from their own results page.
    setTimeout(function() {
      const lockLoader = document.getElementById('acp-lock-loading');
      const lockCard   = document.getElementById('acp-lock-card');
      if (lockLoader && lockCard && !_AC.unlocked) {
        lockLoader.style.display = 'flex';
        lockCard.style.display   = 'none';
      }
    }, 0);

    const emailEl = _acEl('acp-email-input');
    if (emailEl) emailEl.value = email;
    // Small delay to let goPage() finish rendering the counsellor page
    setTimeout(function() {
      if (!_AC.unlocked && typeof window.acUnlock === 'function') {
        window.acUnlock();
      }
    }, 80);
  }
}

function goBackFromCounsellor() {
  // Determine whether we have in-memory assessment data to show results.
  // S is exposed on window by main.js. If scores are populated in memory,
  // buildResults() will work even though _clearSession() already cleared
  // localStorage (it fires when first navigating to results).
  const S = window.S;
  const hasScores = S && S.cpi && S.cpi.scores !== null &&
                    S.nmap && S.nmap.scores !== null;

  if (hasScores) {
    // Scores exist in memory — (re)build results and navigate there.
    // _goPageReal avoids re-triggering _clearSession (goPage would).
    if (typeof window.buildResults === 'function') window.buildResults();
    if (typeof window._goPageReal === 'function') window._goPageReal('results');
  } else {
    // Student reached counsellor via email unlock on a fresh page load —
    // no assessment data in memory. Send them home.
    if (typeof window._goPageReal === 'function') window._goPageReal('landing');
  }
}

/* ── Keyboard handler ───────────────────────────────────────────── */
function _acInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // Call window.acSend so the counsellor-ui.js patch runs (shows acp-messages,
    // hides welcome screen, fires chip suggestions). Bare acSend() would bypass
    // the patch and leave the welcome screen up on the first Enter-key send.
    if (typeof window.acSend === 'function') window.acSend();
    else acSend();
  }
  _acResizeTextarea(e.target);
}

/* ── Cross-device verification form ─────────────────────────────── */
// Shown when sessionId is absent or wrong (new device, incognito, mobile).
// Student proves ownership with name + class — both entered at registration.
function _acShowVerificationForm(email) {
  const lockCard = _acEl('acp-lock-card');
  if (!lockCard) return;
  // Inject the verification step if not already there
  if (!document.getElementById('acp-verify-section')) {
    const div = document.createElement('div');
    div.id = 'acp-verify-section';
    div.style.cssText = 'margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08)';
    div.innerHTML = `
      <p style="font-size:12.5px;color:rgba(255,255,255,0.55);margin:0 0 12px;line-height:1.5">
        <strong style="color:rgba(255,255,255,0.75)">New device detected.</strong><br>
        Please confirm two details from your registration to access your report.
      </p>
      <div style="margin-bottom:10px">
        <input id="acp-verify-name" type="text" placeholder="Full name (as you registered)"
          style="width:100%;padding:10px 12px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#fff;font-size:13px;box-sizing:border-box;outline:none">
      </div>
      <div style="margin-bottom:14px">
        <input id="acp-verify-class" type="text" placeholder="Class (e.g. 10, 11, 12)"
          style="width:100%;padding:10px 12px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#fff;font-size:13px;box-sizing:border-box;outline:none">
      </div>
      <div id="acp-verify-err" style="display:none;color:#f87171;font-size:12px;margin-bottom:8px"></div>
      <button onclick="acUnlockVerify()" id="acp-verify-btn"
        style="width:100%;padding:11px;background:linear-gradient(135deg,#6d28d9,#7c3aed);border:none;border-radius:10px;color:#fff;font-size:13px;font-weight:700;cursor:pointer">
        Verify & Unlock
      </button>`;
    lockCard.appendChild(div);
  }
  // Store email for the verify step
  document.getElementById('acp-verify-section').dataset.email = email;
  document.getElementById('acp-verify-section').style.display = 'block';
}

async function acUnlockVerify() {
  var section  = document.getElementById('acp-verify-section');
  var email    = section ? section.dataset.email : '';
  var fullName = (document.getElementById('acp-verify-name')  || {value:''}).value.trim();
  var cls      = (document.getElementById('acp-verify-class') || {value:''}).value.trim();
  var errEl    = document.getElementById('acp-verify-err');
  var btn      = document.getElementById('acp-verify-btn');
  if (!fullName || !cls) {
    if (errEl) { errEl.textContent = 'Please fill in both fields.'; errEl.style.display = 'block'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Checking\u2026'; }
  if (errEl) errEl.style.display = 'none';
  try {
    var resp = await fetch('/api/counsellor-verify-name', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: email, fullName: fullName, class: cls }),
    });
    var data = await resp.json();
    if (!data.unlocked) {
      if (errEl) { errEl.textContent = data.error || 'Details do not match. Please check your name and class.'; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Verify & Unlock'; }
      return;
    }
    _LOCK.email = email;
    _acApplySession(data);
  } catch (_) {
    if (errEl) { errEl.textContent = 'Connection error. Please try again.'; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Verify & Unlock'; }
  }
}
window.acUnlockVerify = acUnlockVerify;


/* ── Rolling summary trigger ────────────────────────────────────── */
const _AC_SUMMARY_INTERVAL = 20;
async function _acTriggerSummaryIfNeeded() {
  if (!_AC.email || !_AC.conversationId) return;
  if (_AC.messages.length > 0 && _AC.messages.length % _AC_SUMMARY_INTERVAL === 0) {
    const toSummarise = _AC.messages.slice(0, _AC_SUMMARY_INTERVAL);
    try {
      await fetch('/api/counsellor-summarise', {
        method: 'POST', headers: _acHeaders(),
        body: JSON.stringify({ conversationId: _AC.conversationId, messages: toSummarise }),
      });
      _AC.messages = _AC.messages.slice(_AC_SUMMARY_INTERVAL);
    } catch (_) {}
  }
}

/* ── Report panel ───────────────────────────────────────────────── */
function acToggleReportPanel() {
  const panel = document.getElementById('ac-report-panel');
  if (!panel) return;
  const open = panel.classList.toggle('open');
  const btn  = document.getElementById('acp-report-chip');
  if (btn) btn.classList.toggle('active', open);
  if (open) _acRenderReportPanel();
}

function _acRenderReportPanel() {
  const el = document.getElementById('ac-report-panel-body');
  if (!el || el.dataset.rendered === '1') return;
  el.dataset.rendered = '1';
  const fs = _AC.fullScores || {};
  const rs = _AC.reportSummary || {};
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const bar = (w,cls) => `<div class="arp-bar-track"><div class="arp-bar-fill ${cls||''}" style="width:${Math.round(Math.min(100,Math.max(0,w)))}%"></div></div>`;
  let html = '';

  // Status snapshot
  const statuses = [
    ['🧠', rs.personality_status, 'Personality'],
    ['📐', rs.aptitude_status,    'Aptitude'],
    ['🎯', rs.interest_status,    'Interests'],
    ['💚', rs.seaa_status,        'Wellbeing'],
  ].filter(s => s[1]);
  if (statuses.length) {
    html += `<div class="arp-section"><div style="display:grid;grid-template-columns:repeat(${statuses.length},1fr);gap:8px">`;
    html += statuses.map(([ic,v,l]) => `<div style="background:var(--sb2);border-radius:8px;padding:10px;text-align:center"><div style="font-size:15px;margin-bottom:3px">${ic}</div><div style="font-size:10px;color:var(--sbm);margin-bottom:3px">${l}</div><div style="font-size:11px;font-weight:700;color:var(--sbt)">${esc(v)}</div></div>`).join('');
    html += `</div></div>`;
  }

  if (rs.fit_score != null || rs.recommended_primary) {
    html += `<div class="arp-section"><div class="arp-head">📊 Overall Result</div>`;
    if (rs.fit_score != null) html += `<div class="arp-kv"><span>Fit Score</span><strong>${Math.round(rs.fit_score)}% <em>${esc(rs.fit_tier||'')}</em></strong></div>`;
    if (rs.recommended_primary) html += `<div class="arp-kv"><span>Best Stream</span><strong>${esc(rs.recommended_primary)}</strong></div>`;
    if (rs.recommended_alternate) html += `<div class="arp-kv"><span>Alternate</span><strong>${esc(rs.recommended_alternate)}</strong></div>`;
    html += `</div>`;
  }

  const _fitCols = [
    ['Strong Fit', rs.strong_fit_pathways, 'var(--green)'],
    ['Emerging Fit', rs.emerging_fit_pathways, 'var(--v2)'],
    ['Exploratory', rs.exploratory_pathways, 'var(--sbm)'],
  ].filter(([, arr]) => Array.isArray(arr) && arr.length);
  if (_fitCols.length) {
    html += `<div class="arp-section"><div style="display:grid;grid-template-columns:repeat(${_fitCols.length},1fr);gap:10px">`;
    html += _fitCols.map(([label, arr, col]) =>
      `<div style="background:var(--sb2);border-radius:9px;padding:10px 12px"><div style="font-size:10px;font-weight:700;color:${col};text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px">${label}</div>${arr.map(p => `<div style="font-size:12px;color:var(--sbt);padding:3px 0;border-bottom:1px solid var(--sbb)">${esc(p)}</div>`).join('')}</div>`
    ).join('');
    html += `</div></div>`;
  }

  const personality = (fs.personality && fs.personality.length) ? fs.personality : null;
  if (personality) {
    html += `<div class="arp-section"><div class="arp-head">🧠 Personality</div>`;
    html += personality.map(d => {
      const w = Math.round(((typeof d.stanine==='number'?d.stanine:5)-1)/8*100);
      return `<div class="arp-bar-row"><span>${esc(d.name||d.label||'')}</span>${bar(w)}<small>${esc(d.band||'')}</small></div>`;
    }).join('');
    html += `</div>`;
  }

  const aptitude = (fs.aptitude && fs.aptitude.length) ? fs.aptitude : null;
  if (aptitude) {
    html += `<div class="arp-section"><div class="arp-head">📐 Aptitude</div>`;
    html += aptitude.map(d => {
      const w = Math.round(((typeof d.stanine==='number'?d.stanine:5)-1)/8*100);
      return `<div class="arp-bar-row"><span>${esc(d.name||d.label||'')}</span>${bar(w)}<small>${esc(d.band||'')}</small></div>`;
    }).join('');
    html += `</div>`;
  }

  const interests = (fs.interests && fs.interests.length) ? fs.interests : null;
  if (interests) {
    html += `<div class="arp-section"><div class="arp-head">🎯 Interests</div>`;
    html += interests.slice(0,8).map(r => {
      const w = Math.round((r.score/20)*100);
      return `<div class="arp-bar-row"><span>${esc(r.label||'')}</span>${bar(w,'arp-bar-violet')}<small>${r.score}/20</small></div>`;
    }).join('');
    html += `</div>`;
  }

  const seaa = (fs.seaa && fs.seaa.length) ? fs.seaa : null;
  if (seaa) {
    html += `<div class="arp-section"><div class="arp-head">💚 Wellbeing</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">`;
    html += seaa.map(se => `<div style="background:var(--sb2);border-radius:7px;padding:10px;text-align:center"><div style="font-size:10px;color:var(--sbm);margin-bottom:4px">${esc(se.title)}</div><div style="font-size:16px;font-weight:800;color:var(--v2)">${se.score}</div><div style="font-size:10px;color:var(--sbm);margin-top:2px">${esc(se.cat_label||'')}</div></div>`).join('');
    html += `</div></div>`;
  }

  const careers = (fs.careers && fs.careers.length) ? fs.careers : null;
  if (careers) {
    html += `<div class="arp-section"><div class="arp-head">💼 Career Matches</div>`;
    html += careers.slice(0,6).map(c => `<div class="arp-kv"><span>${esc(c.career||'')}</span><strong>${c.suitability_pct||0}%</strong></div>`).join('');
    html += `</div>`;
  }

  // Narrative sections — the actual written report, previously never sent by
  // the server at all, so this panel could only ever show numbers.
  const narratives = [
    ['📋 Holistic Summary', rs.holistic_summary],
    ['🧠 Personality Profile', rs.personality_profile],
    ['📐 Aptitude Profile', rs.aptitude_profile],
    ['🎯 Interest Profile', rs.interest_profile],
    ['💡 Internal Motivators', rs.internal_motivators],
    ['💚 Wellbeing Guidance', rs.wellbeing_guidance],
    ['🎓 Stream Advice', rs.stream_advice],
  ].filter(([,v]) => v);
  if (narratives.length) {
    html += narratives.map(([t,v]) => `<div class="arp-section"><div class="arp-head">${t}</div><div class="prose-block">${esc(v)}</div></div>`).join('');
  }

  if (!html) html = `<div style="padding:20px;color:var(--sbm);text-align:center;font-size:13px"><div style="font-size:24px;margin-bottom:8px">📋</div>Ask Aria — she has your full report.</div>`;
  el.innerHTML = html;
}

window.acToggleReportPanel = acToggleReportPanel;

/* ── Expose on window for inline HTML handlers ──────────────────── */
window._AC                   = _AC;   // needed by auto-restore in index.html
window.acUnlock              = acUnlock;
window.acSend                = acSend;
window.acClearHistory        = acClearHistory;
window.submitCounsellorQuery = submitCounsellorQuery;
window.goToCounsellor        = goToCounsellor;
window.goBackFromCounsellor  = goBackFromCounsellor;
window._acInputKeydown       = _acInputKeydown;
window._acResizeTextarea     = _acResizeTextarea;

export { acUnlock, acSend, acClearHistory, submitCounsellorQuery, goToCounsellor, goBackFromCounsellor };
