/* ════════════════════════════════════════════════════════════════════
   ai-counsellor.js  —  Frontend AI Counsellor (page-only, no bubble)

   Fixes applied:
   • All fetch calls include X-App-Token header (fixes 401)
   • Back to Report uses _goPageReal() not goPage() (fixes blank page)
   • Floating bubble removed entirely
   • hasCompletedAssessment on server now also passes on completed
     sections even before report generation
════════════════════════════════════════════════════════════════════ */

/* ── Auth token helper ──────────────────────────────────────────── */
// Injected by server into HTML as window._APP_TOKEN before </head>
function _acToken() {
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
  el.style.cssText = 'width:100%;padding:12px 14px;background:rgba(255,255,255,0.07);border:1.5px solid rgba(255,255,255,0.15);border-radius:10px;color:#fff;font-size:20px;letter-spacing:0.3em;text-align:center;box-sizing:border-box;outline:none;margin-bottom:10px';
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
  ['acp-step-otp','acp-step-pin','acp-step-set-pin'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.parentNode.removeChild(el);
  });
  var container = card.querySelector('.nc-lock-form') || card;
  var wrap = document.createElement('div');

  // Email attribution line with "Change" link
  if (opts && opts.email) {
    var p = document.createElement('p');
    p.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.4);margin:0 0 14px';
    p.innerHTML = 'Signing in as <strong style="color:rgba(255,255,255,0.7)">' + opts.email + '</strong> \xb7 ';
    var a = document.createElement('a'); a.href = 'javascript:void(0)';
    a.textContent = 'Change'; a.style.color = '#a78bfa';
    a.addEventListener('click', _lockReset);
    p.appendChild(a);
    wrap.appendChild(p);
  }

  if (step === 'otp-sent') {
    wrap.id = 'acp-step-otp';
    var desc = document.createElement('p');
    desc.textContent = (opts && opts.purpose === 'reset')
      ? 'A PIN reset code was sent to your email. Enter it below.'
      : 'A 6-digit code was sent to your email. Enter it to create your PIN.';
    desc.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.55);margin:0 0 14px;line-height:1.5';
    wrap.appendChild(desc);
    wrap.appendChild(_makeLockInput('acp-otp-input', 'text', '6-digit code', 'numeric', _acSubmitOtp));
    wrap.appendChild(_makeLockErr('acp-otp-err'));
    wrap.appendChild(_makeLockBtn('acp-otp-btn', 'Verify Code', 'linear-gradient(135deg,#6d28d9,#7c3aed)', _acSubmitOtp));
    var p2 = document.createElement('p');
    p2.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,0.3);text-align:center;margin:0';
    p2.appendChild(document.createTextNode('Did not receive it? Check spam or '));
    var resend = document.createElement('a'); resend.href = 'javascript:void(0)';
    resend.textContent = 'resend'; resend.style.color = '#a78bfa';
    resend.addEventListener('click', function() { _acResendOtp(); });
    p2.appendChild(resend);
    wrap.appendChild(p2);
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
    forgot.textContent = 'Reset via email'; forgot.style.color = '#a78bfa';
    forgot.addEventListener('click', _acForgotPin);
    p2.appendChild(forgot);
    wrap.appendChild(p2);
    container.appendChild(wrap);
    setTimeout(function(){ var i = document.getElementById('acp-pin-input'); if (i) i.focus(); }, 100);
  }

  if (step === 'set-pin') {
    wrap.id = 'acp-step-set-pin';
    var isReset = opts && opts.isReset;
    var desc = document.createElement('p');
    desc.textContent = isReset ? 'Set your new PIN (4-6 digits).' : 'Almost there! Create a 4-6 digit PIN. You will use it to log in from any device.';
    desc.style.cssText = 'font-size:13px;color:rgba(255,255,255,0.55);margin:0 0 14px;line-height:1.5';
    wrap.appendChild(desc);
    wrap.appendChild(_makeLockInput('acp-newpin-input', 'password', 'Create PIN', 'numeric', function(){
      var c = document.getElementById('acp-newpin-confirm'); if (c) c.focus();
    }));
    wrap.appendChild(_makeLockInput('acp-newpin-confirm', 'password', 'Confirm PIN', 'numeric', _acSetPin));
    wrap.appendChild(_makeLockErr('acp-setpin-err'));
    wrap.appendChild(_makeLockBtn('acp-setpin-btn', isReset ? 'Save New PIN' : 'Set PIN and Enter', 'linear-gradient(135deg,#059669,#10b981)', _acSetPin));
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
  _LOCK.email = null; _LOCK.step = null; _LOCK.otpToken = null; _LOCK.purpose = 'register';
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
  _LOCK.purpose = 'register';

  var btn = _acEl('acp-unlock-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking\u2026'; }

  // Same-device fast path: sessionId from localStorage
  var sessionId = null;
  try {
    var raw = localStorage.getItem('numind_session_v1');
    if (raw) { var snap = JSON.parse(raw); sessionId = snap.sessionId || null; }
  } catch (_) {}

  try {
    var _ctrl = new AbortController();
    var _timeoutId = setTimeout(function(){ _ctrl.abort(); }, 15000);
    var resp = await fetch('/api/counsellor-unlock', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: email, sessionId: sessionId }),
      signal: _ctrl.signal,
    });
    clearTimeout(_timeoutId);
    var data = await resp.json();

    if (data.unlocked) {
      // Instant unlock (same device) — apply and dispatch
      _acApplySession(data);
      return;
    }

    if (btn) { btn.style.display = 'none'; }
    emailEl.disabled = true;

    if (data.step === 'otp-sent') {
      _lockStep('otp-sent', { email: email, purpose: 'register' });
    } else if (data.step === 'enter-pin') {
      _lockStep('enter-pin', { email: email });
    } else if (data.step === 'verify-name') {
      // SMTP not configured — fall back to name+class identity verification
      _acShowVerificationForm(email);
    } else {
      if (errEl) { errEl.textContent = data.error || 'Something went wrong.'; errEl.style.display = 'block'; }
      emailEl.disabled = false;
      if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Continue \u2192'; }
    }
  } catch (e) {
    if (btn) { btn.style.display = ''; btn.disabled = false; btn.textContent = 'Continue \u2192'; }
    var _msg = (e && e.name === 'AbortError') ? 'Request timed out. Please try again.' : 'Connection error. Please try again.';
    if (errEl) { errEl.textContent = _msg; errEl.style.display = 'block'; }
  }
}

async function _acResendOtp() {
  // Re-send OTP for the current purpose (register or reset)
  if (!_LOCK.email) return;
  try {
    var endpoint = _LOCK.purpose === 'reset' ? '/api/counsellor-reset-otp' : '/api/counsellor-unlock';
    var body     = _LOCK.purpose === 'reset'
      ? JSON.stringify({ email: _LOCK.email })
      : JSON.stringify({ email: _LOCK.email, resend: true });
    await fetch(endpoint, { method: 'POST', headers: _acHeaders(), body: body });
    var errEl = document.getElementById('acp-otp-err');
    if (errEl) { errEl.textContent = 'Code resent! Check your email.'; errEl.style.color = '#34d399'; errEl.style.display = 'block'; }
    setTimeout(function(){ if (errEl) { errEl.style.display = 'none'; errEl.style.color = '#f87171'; } }, 3000);
  } catch (_) {}
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
  if (!_LOCK.otpToken) {
    if (errEl) { errEl.textContent = 'Session expired. Please start again.'; errEl.style.display = 'block'; }
    _lockReset(); return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
  if (errEl) errEl.style.display = 'none';
  try {
    var headers = Object.assign({}, _acHeaders(), { 'X-Counsellor-Otp-Token': _LOCK.otpToken });
    var isReset = _LOCK.purpose === 'reset';
    var resp = await fetch('/api/counsellor-set-pin', {
      method: 'POST', headers: headers,
      body: JSON.stringify({ email: _LOCK.email, pin: pin, changeOnly: isReset }),
    });
    var data = await resp.json();
    _LOCK.otpToken = null;
    if (data.error) {
      if (errEl) { errEl.textContent = data.error; errEl.style.display = 'block'; }
      if (btn) { btn.disabled = false; btn.textContent = isReset ? 'Save New PIN' : 'Set PIN and Enter'; }
      return;
    }
    if (data.unlocked) {
      _acApplySession(data);
    } else {
      // PIN reset complete — go back to PIN entry screen
      _lockStep('enter-pin', { email: _LOCK.email });
      var p = document.getElementById('acp-pin-err');
      if (p) { p.textContent = 'PIN updated! Enter your new PIN to continue.'; p.style.color = '#34d399'; p.style.display = 'block'; }
    }
  } catch (_) {
    if (errEl) { errEl.textContent = 'Connection error. Please try again.'; errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Set PIN'; }
  }
}

async function _acForgotPin() {
  // Send a reset OTP via unauthenticated endpoint
  if (!_LOCK.email) return;
  var forgotLink = document.querySelector('#acp-step-pin a');
  if (forgotLink) { forgotLink.textContent = 'Sending\u2026'; }
  try {
    var resp = await fetch('/api/counsellor-reset-otp', {
      method: 'POST', headers: _acHeaders(),
      body: JSON.stringify({ email: _LOCK.email }),
    });
    var data = await resp.json();
    if (data.ok) {
      _LOCK.purpose = 'reset';
      _lockStep('otp-sent', { email: _LOCK.email, purpose: 'reset' });
    } else {
      // Show error inline
      var errEl = document.getElementById('acp-pin-err');
      if (errEl) { errEl.textContent = data.error || 'Could not send reset code.'; errEl.style.display = 'block'; }
    }
  } catch (_) {
    var errEl = document.getElementById('acp-pin-err');
    if (errEl) { errEl.textContent = 'Connection error. Please try again.'; errEl.style.display = 'block'; }
  }
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
  if (!_AC.unlocked) return;
  try {
    var resp = await fetch('/api/counsellor-request-otp', {
      method: 'POST', headers: _acHeaders(),
    });
    var data = await resp.json();
    if (!data.ok) { alert(data.error || 'Could not send code. Please try again.'); return; }
    _LOCK.email = _AC.email;
    _LOCK.purpose = 'reset';
    _LOCK.otpToken = null;
    var chat = document.getElementById('acp-chat');
    var lock = document.getElementById('acp-lock');
    if (chat) chat.style.display = 'none';
    if (lock) lock.style.display = '';
    var emailEl = _acEl('acp-email-input');
    if (emailEl) { emailEl.value = _AC.email; emailEl.disabled = true; }
    _lockStep('otp-sent', { email: _AC.email, purpose: 'reset' });
  } catch (_) { alert('Connection error. Please try again.'); }
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
  const fs = _AC.fullScores;
  const S  = window.S;
  const rs = _AC.reportSummary;
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const bar = (w,cls) => `<div class="arp-bar-track"><div class="arp-bar-fill ${cls||''}" style="width:${Math.round(Math.min(100,Math.max(0,w)))}%"></div></div>`;
  let html = '';

  if (rs) {
    html += `<div class="arp-section"><div class="arp-head">📊 Overall Result</div>`;
    if (rs.fit_score != null) html += `<div class="arp-kv"><span>Fit Score</span><strong>${Math.round(rs.fit_score)}% <em>${esc(rs.fit_tier||'')}</em></strong></div>`;
    if (rs.recommended_primary) html += `<div class="arp-kv"><span>Best Stream</span><strong>${esc(rs.recommended_primary)}</strong></div>`;
    html += `</div>`;
  }

  const personality = (fs&&fs.personality&&fs.personality.length) ? fs.personality
    : (S&&S.nmap&&S.nmap.scores&&S.nmap.scores.dims) ? S.nmap.scores.dims : null;
  if (personality&&personality.length) {
    html += `<div class="arp-section"><div class="arp-head">🧠 Personality</div>`;
    html += personality.map(d => {
      const w = Math.round(((typeof d.stanine==='number'?d.stanine:5)-1)/8*100);
      return `<div class="arp-bar-row"><span>${esc(d.name||d.label||'')}</span>${bar(w)}<small>${esc(d.band||'')}</small></div>`;
    }).join('');
    html += `</div>`;
  }

  const interests = (fs&&fs.interests&&fs.interests.length) ? fs.interests : null;
  if (interests) {
    html += `<div class="arp-section"><div class="arp-head">🎯 Interests</div>`;
    html += interests.slice(0,8).map(r => {
      const w = Math.round((r.score/20)*100);
      return `<div class="arp-bar-row"><span>${esc(r.label||'')}</span>${bar(w,'arp-bar-violet')}<small>${r.score}/20</small></div>`;
    }).join('');
    html += `</div>`;
  }

  if (!html) html = `<div style="padding:20px;color:#94a3b8;text-align:center;font-size:13px"><div style="font-size:24px;margin-bottom:8px">📋</div>Ask Aria — she has your full report.</div>`;
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
