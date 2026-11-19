/* ════════════════════════════════════════════════════════════════════
   js/dashboard-common.js — NuMind MAPS staff dashboards (shared)
   --------------------------------------------------------------------
   Loaded by the Admin, Management and Counsellor dashboards AFTER their
   inline script. Everything here talks to the server through the page's
   own `_api(method, url, body)` helper, so auth headers and timeouts stay
   in one place per page.

   Provides (window.NM):
     • plain-English help (glossary popovers) for every term
     • the student-list modal behind any number (drill-down)
     • the class-wise explorer (every chart broken down by class)
     • What needs attention (live alerts) and the AI analysis card
     • programme trend anchored to Week 1 of the programme
     • career-interest / subject-stream distribution with a toggle
     • year-on-year journey summary + a journey strip for the profile
     • bulk report download (ZIP) and reminders from any list
     • the dashboard assistant (chatbot)

   No inline event handlers are generated: every clickable element carries
   data-* attributes and is handled by one delegated listener, so names
   containing quotes can never break out into script.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.NM) return;

  /* ── basics ───────────────────────────────────────────────────────── */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = (o) => esc(JSON.stringify(o));
  const api = (m, u, b, t) => window._api(m, u, b, true, t);
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(Array.isArray(v) ? v.join(',') : v)).join('&');
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
  const toast = (m, t) => (typeof window.toast === 'function' ? window.toast(m, t) : alert(m));
  const STATUS = { completed: ['Completed', 'ok'], in_progress: ['In progress', 'warn'], not_started: ['Not started', 'mute'] };
  // How much each panel shows before "Show more". Presentation only; limits
  // the server enforces come from NM.cat.limits.
  const UI = Object.freeze({ ALERT_ROWS: 5, TABLE_ROWS: 8, CLASS_CHIPS: 8, DIST_ROWS: 10, INSIGHT_POLL_MS: 2500, INSIGHT_WAIT_MS: 180000 });
  // Limits the server enforces, from the catalogue (loaded before any panel mounts).
  const limit = (k) => (NM.cat && NM.cat.limits && NM.cat.limits[k]) || Infinity;
  // A colour token from the page (e.g. --ok) as rgba with the given alpha, for
  // charts, which draw on canvas and cannot use CSS variables directly.
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const tokenAlpha = (name, a) => {
    const m = /^#([0-9a-f]{6})$/i.exec(cssVar(name));
    if (!m) return cssVar(name) || 'gray';
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const roleKey = () => (NM.me && NM.me.role) || 'staff';
  const store = {
    get(k, d) { try { const v = localStorage.getItem('nm:' + roleKey() + ':' + k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('nm:' + roleKey() + ':' + k, JSON.stringify(v)); } catch (_) {} },
  };

  /* ── styles (use the host page's CSS variables) ──────────────────── */
  const CSS = `
.nm-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--border2,#ccd);background:var(--surface,#fff);color:var(--ink4,#678);font:700 10px/1 var(--font,sans-serif);cursor:help;margin-left:5px;vertical-align:middle;padding:0}
.nm-help:hover{border-color:var(--brand2);color:var(--brand2)}
.nm-pop{position:fixed;z-index:3000;max-width:340px;background:var(--surface,#fff);border:1px solid var(--border2,#ccd);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:12px 14px;font:13px/1.55 var(--font,sans-serif);color:var(--ink2,#234)}
.nm-pop b{color:var(--ink,#123);display:block;margin-bottom:4px}.nm-pop .why{margin-top:6px;color:var(--ink4,#678);font-size:12px}
.nm-ov{position:fixed;inset:0;z-index:2500;background:rgba(10,25,35,.5);display:flex;align-items:flex-start;justify-content:center;padding:4vh 16px;overflow-y:auto}
.nm-modal{background:var(--surface,#fff);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.25);width:100%;max-width:980px;display:flex;flex-direction:column;max-height:92vh}
.nm-modal.sm{max-width:560px}
.nm-mh{display:flex;gap:12px;align-items:flex-start;padding:18px 22px;border-bottom:1px solid var(--border,#e5e7eb)}
.nm-mh h3{font:800 16px/1.3 var(--font,sans-serif);color:var(--ink,#123);margin:0}.nm-mh p{font-size:12.5px;color:var(--ink4,#678);margin:4px 0 0;line-height:1.5}
.nm-x{margin-left:auto;background:var(--bg2,#eee);border:1px solid var(--border,#ddd);width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:15px;color:var(--ink4);flex-shrink:0}
.nm-mb{padding:16px 22px;overflow-y:auto}.nm-mf{padding:12px 22px;border-top:1px solid var(--border,#e5e7eb);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;align-items:center}
.nm-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.nm-in{padding:7px 11px;border-radius:9px;border:1.5px solid var(--border,#ddd);background:var(--surface,#fff);font:12.5px var(--font,sans-serif);color:var(--ink2)}
.nm-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:9px;border:1.5px solid var(--border,#ddd);background:var(--surface,#fff);color:var(--ink2,#234);font:600 12.5px var(--font,sans-serif);cursor:pointer;white-space:nowrap}
.nm-btn:hover{border-color:var(--brand2);color:var(--brand2)}.nm-btn:disabled{opacity:.45;cursor:not-allowed}
.nm-btn.pri{background:var(--brand2);color:#fff;border-color:var(--brand2)}.nm-btn.pri:hover{color:#fff;background:var(--brand);border-color:var(--brand)}
.nm-btn.sm{padding:4px 9px;font-size:11.5px}
.nm-tbl{width:100%;border-collapse:collapse;font:13px var(--font,sans-serif)}
.nm-tbl th{text-align:left;padding:9px 12px;font-size:12px;font-weight:600;color:var(--ink4);background:var(--surface2,#f8f9fc);border-bottom:1px solid var(--border);white-space:nowrap}
.nm-tbl td{padding:10px 12px;border-bottom:1px solid var(--border,#eee);color:var(--ink3,#456);vertical-align:middle}
.nm-tbl tr:hover td{background:var(--surface2,#f7f9fa)}
.nm-link{color:var(--ink,#123);font-weight:600;cursor:pointer;background:none;border:none;padding:0;font:inherit;text-align:left}.nm-link:hover{color:var(--brand2);text-decoration:underline}
.nm-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid transparent;white-space:nowrap}
.nm-chip.ok{background:color-mix(in srgb,var(--ok) 10%,transparent);color:var(--ok);border-color:color-mix(in srgb,var(--ok) 25%,transparent)}
.nm-chip.warn{background:color-mix(in srgb,var(--warn) 10%,transparent);color:var(--warn);border-color:color-mix(in srgb,var(--warn) 25%,transparent)}
.nm-chip.bad{background:color-mix(in srgb,var(--danger) 8%,transparent);color:var(--danger);border-color:color-mix(in srgb,var(--danger) 22%,transparent)}
.nm-chip.mute{background:var(--bg2,#eee);color:var(--ink4)}
.nm-chip.click{cursor:pointer}.nm-chip.click:hover{filter:brightness(.95);text-decoration:underline}
.nm-note{font-size:12px;color:var(--ink4,#678);line-height:1.55;background:var(--surface2,#f6f8f9);border:1px solid var(--border,#eee);border-radius:9px;padding:9px 12px;margin-bottom:12px}
.nm-empty{padding:28px 12px;text-align:center;color:var(--ink4);font-size:13px}
.nm-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(0,0,0,.12);border-top-color:var(--brand2);border-radius:50%;animation:nmspin .7s linear infinite;vertical-align:middle}
@keyframes nmspin{to{transform:rotate(360deg)}}
.nm-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.nm-tab{padding:6px 11px;border-radius:999px;border:1.5px solid var(--border,#ddd);background:var(--surface);font:600 12px var(--font,sans-serif);color:var(--ink3);cursor:pointer}
.nm-tab.on{background:var(--brand4);border-color:var(--brand2);color:var(--brand)}
.nm-heat{text-align:center;cursor:pointer;font-variant-numeric:tabular-nums;min-width:84px}
.nm-heat:hover{outline:2px solid var(--brand2);outline-offset:-2px}
.nm-heat .n{font-weight:800;color:var(--ink,#123)}.nm-heat .p{font-size:10.5px;color:var(--ink4)}
.nm-sec{font:700 13.5px var(--font,sans-serif);color:var(--ink);margin:2px 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nm-metrics{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px}.nm-metrics[hidden]{display:none}
.nm-mchip{padding:5px 10px;border-radius:999px;border:1.5px solid var(--border2,#ccd);background:var(--surface);font:600 11.5px var(--font,sans-serif);color:var(--ink3);cursor:pointer}
.nm-mchip.on{background:var(--brand4);border-color:var(--brand2);color:var(--brand)}
.nm-dist-row{display:grid;grid-template-columns:minmax(120px,190px) 1fr 54px 40px;gap:10px;align-items:center;padding:6px 4px;border-radius:7px;cursor:pointer}
.nm-dist-row:hover{background:var(--surface2)}.nm-dist-row[hidden]{display:none}
.nm-dist-bar{height:9px;border-radius:999px;background:var(--bg2,#eee);overflow:hidden}.nm-dist-bar>i{display:block;height:100%;border-radius:999px;background:var(--brand2)}
.nm-dist-l{font-size:12.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nm-dist-n{font-weight:800;font-size:12.5px;text-align:right;color:var(--ink)}.nm-dist-p{font-size:11px;color:var(--ink4);text-align:right}
.nm-jstrip{display:flex;align-items:stretch;gap:0;overflow-x:auto;padding:4px 2px 8px}
.nm-jstep{min-width:150px;border:1.5px solid var(--border);border-radius:12px;padding:10px 12px;background:var(--surface)}
.nm-jstep.last{border-color:var(--brand2);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand2) 10%,transparent)}
.nm-jarrow{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:64px;font-size:11px;font-weight:800}
.nm-jbox{border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin:0 0 14px;background:color-mix(in srgb,var(--brand2) 5%,var(--surface,#fff))}
.nm-prog{position:fixed;right:18px;bottom:86px;z-index:2600;width:340px;background:var(--surface);border:1px solid var(--border2);border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.2);padding:14px 16px;font:13px var(--font,sans-serif)}
.nm-prog .bar{height:8px;border-radius:999px;background:var(--bg2);overflow:hidden;margin:9px 0}.nm-prog .bar i{display:block;height:100%;background:var(--brand2);transition:width .2s}
.nm-fab{position:fixed;right:20px;bottom:20px;z-index:2400;display:flex;align-items:center;gap:8px;padding:11px 16px 11px 12px;border-radius:999px;border:1px solid var(--border);cursor:pointer;color:var(--ink);font:650 13.5px var(--font,sans-serif);background:var(--surface);box-shadow:var(--shadow-lg)}.nm-fab i{width:22px;height:22px;border-radius:50%;background:var(--ai-grad,var(--brand2));display:inline-block}.nm-fab:hover{border-color:var(--brand2)}
.nm-chat{position:fixed;right:18px;bottom:18px;z-index:2450;width:min(440px,calc(100vw - 24px));height:min(680px,calc(100vh - 36px));background:var(--surface,#fff);border:1px solid var(--border2);border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;font-family:var(--font,sans-serif)}
.nm-chat-h{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px 10px;padding:14px 14px 12px;background:var(--surface);color:var(--ink);border-bottom:1px solid var(--border);position:relative}.nm-chat-h::before{content:'';position:absolute;inset:0 0 auto 0;height:3px;background:var(--ai-grad,var(--brand2))}
.nm-chat-tools{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap}.nm-chat-x{padding:4px 9px!important}.nm-chat-h b{font-size:14.5px;color:var(--ink)}.nm-chat-h small{display:block;font-size:11.5px;color:var(--ink4)}
.nm-chat-h button{background:var(--surface);border:1px solid var(--border);color:var(--ink3);border-radius:8px;padding:5px 9px;cursor:pointer;font-size:12px;font-weight:600}.nm-chat-h button:hover{border-color:var(--brand2);color:var(--brand2)}
.nm-chat-b{flex:1;overflow-y:auto;padding:16px;background:var(--bg,#f4f5f9)}
.nm-msg{max-width:92%;margin-bottom:10px;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.55;color:var(--ink2);word-wrap:break-word}
.nm-msg.u{margin-left:auto;background:var(--brand2);color:#fff;border-bottom-right-radius:4px;max-width:85%}
.nm-msg.a{background:var(--surface,#fff);border:1px solid var(--border);border-bottom-left-radius:4px}
.nm-msg.a table{border-collapse:collapse;margin:8px 0;font-size:12.5px;width:100%}.nm-msg.a td,.nm-msg.a th{border:1px solid var(--border);padding:5px 8px;text-align:left}.nm-msg.a th{background:var(--surface2);font-weight:650;color:var(--ink3)}.nm-msg.a h4{font:700 13px var(--font);color:var(--ink);margin:10px 0 4px}.nm-msg.a h4:first-child{margin-top:0}.nm-msg.a .lead{font-weight:650;color:var(--ink);margin-bottom:6px}
.nm-msg.a ul{margin:4px 0 4px 18px;padding:0}.nm-msg.a p{margin:0 0 6px}
.nm-act{border:1px solid var(--border2);border-left:3px solid var(--brand2);border-radius:10px;padding:11px 12px;margin-top:10px;background:var(--surface)}
.nm-act-t{font-weight:700;color:var(--ink);font-size:13px}.nm-act-s{font-size:12px;color:var(--ink4);margin:3px 0}.nm-act-s b{color:var(--ink2)}
.nm-form{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin-top:8px}.nm-form .nm-fld:has(textarea),.nm-form .nm-fld:has(.nm-ms),.nm-form .nm-fld:has(input[type=file]){grid-column:1/-1}
.nm-fld{display:flex;flex-direction:column;gap:3px;min-width:0}.nm-fld label{font-size:11.5px;font-weight:650;color:var(--ink3)}.nm-fld label i{color:var(--danger);font-style:normal}
.nm-fld small{font-size:11px;color:var(--ink4);line-height:1.4}
.nm-fld input,.nm-fld select,.nm-fld textarea{width:100%;box-sizing:border-box;font:12.5px var(--font,sans-serif);padding:6px 8px;border-radius:7px;border:1px solid var(--border2);background:var(--surface);color:var(--ink)}
.nm-ms{display:flex;flex-wrap:wrap;gap:4px 12px;max-height:120px;overflow:auto;border:1px solid var(--border2);border-radius:7px;padding:6px 8px}.nm-ms label{font-size:12px;font-weight:500;color:var(--ink2);display:flex;gap:5px;align-items:center}
.nm-filesum{font-size:11.5px;color:var(--ink3);margin-top:2px}.nm-filesum .bad,.nm-act-r.bad{color:var(--danger)}
.nm-act-f{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}.nm-act-r{font-size:12px;color:var(--ink3)}.nm-act-r.ok{color:var(--ok);font-weight:600}
.nm-code{font-family:var(--mono,monospace);letter-spacing:.08em;color:var(--ink);background:var(--surface3);padding:1px 6px;border-radius:5px}
.nm-chat-win{display:flex;gap:6px}
.nm-chat.wide{width:min(1040px,calc(100vw - 36px));height:calc(100vh - 36px)}.nm-chat.wide .nm-msg.a{max-width:86%}.nm-chat.wide .nm-chat-b{padding:20px 28px}
@media(max-width:560px){.nm-form{grid-template-columns:1fr}}
.nm-chat-f{display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);background:var(--surface)}
.nm-chat-f textarea{flex:1;resize:none;height:42px;max-height:120px;border:1.5px solid var(--border2);border-radius:10px;padding:10px;font:13px var(--font,sans-serif)}
.nm-sugg{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.nm-sugg button{border:1px solid var(--border2);background:var(--surface);border-radius:999px;padding:5px 10px;font:12px var(--font,sans-serif);color:var(--ink3);cursor:pointer;text-align:left}
.nm-sugg button:hover{border-color:var(--brand2);color:var(--brand2)}
.nm-chart-wrap{position:relative;height:230px}
body.nm-modal-open .d-overlay,body.nm-modal-open .rd-overlay{z-index:2550}
body.nm-modal-open .d-overlay .drawer{z-index:2551}
body.nm-modal-open .overlay.open{z-index:2600}
@media(max-width:700px){.nm-dist-row{grid-template-columns:1fr 1fr 44px 36px}}
/* headline numbers */
.nm-kpis{display:grid;grid-template-columns:minmax(260px,1.6fr) repeat(4,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.nm-kpi{display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;font:inherit;color:var(--ink2);cursor:pointer;box-shadow:var(--shadow);position:relative}
.nm-kpi:hover{border-color:var(--brand2)}
.nm-kpi.wide{cursor:default}.nm-kpi.wide:hover{border-color:var(--border)}
.nm-kpi-l{font-size:13px;font-weight:600;color:var(--ink3);display:flex;align-items:center}
.nm-kpi-v{font-size:28px;font-weight:750;color:var(--ink);letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums}
.nm-kpi-v small{font-size:13px;font-weight:500;color:var(--ink4);letter-spacing:0;margin-left:6px}
.nm-kpi-s{font-size:12px;color:var(--ink4);line-height:1.4}.nm-kpi-s b{color:var(--ink2)}
.nm-kpi.ok .nm-kpi-v{color:var(--ok)}.nm-kpi.warn .nm-kpi-v{color:var(--warn)}.nm-kpi.bad .nm-kpi-v{color:var(--danger)}
.nm-stack{position:relative;display:flex;width:100%;height:8px;border-radius:999px;background:var(--surface3);overflow:visible;margin:6px 0 4px}
.nm-stack.lg{height:12px}
.nm-stack i{display:block;height:100%}.nm-stack i:first-child{border-radius:999px 0 0 999px}
.nm-stack i.c{background:var(--ok)}.nm-stack i.p{background:#E9B061}
.nm-stack b{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ink);border-radius:2px;transform:translateX(-1px)}
@media(max-width:1100px){.nm-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.nm-kpi.wide{grid-column:1/-1}}
/* overview: summary row, two cards, one tabbed card */
.ov-summary{margin-bottom:16px}
.ov-grid{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:16px;margin-bottom:16px;align-items:start}
.ov-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);min-width:0}
.ov-card.ai{position:relative;overflow:hidden}.ov-card.ai::before{content:'';position:absolute;inset:0 0 auto 0;height:3px;background:var(--ai-grad,var(--brand2))}
.ov-ch{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px 12px;flex-wrap:wrap}
.ov-ch h2{display:flex;align-items:center;gap:8px;font-size:15.5px;font-weight:700;color:var(--ink);margin:0;letter-spacing:-.005em}
.ov-ch p{font-size:12.5px;color:var(--ink4);margin:3px 0 0;max-width:62ch;line-height:1.5}
.ov-ch.sm{margin:18px 0 8px;align-items:center;padding:0}.ov-ch h4{font-size:14px;font-weight:700;color:var(--ink);margin:0}
.ov-act{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ov-cb{padding:0 20px 18px}
.ai-dot{width:12px;height:12px;border-radius:50%;background:var(--ai-grad,var(--brand2));display:inline-block}
.ov-settings{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--ink4);margin:0 0 10px;flex-wrap:wrap}.ov-settings b{color:var(--ink2);font-weight:650}
.ov-clear{font-size:13px;color:var(--ink3);background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;line-height:1.5}
/* expandable rows (alerts and insights) */
.ov-alert{border:1px solid var(--border);border-radius:10px;margin-bottom:6px;background:var(--surface)}
.ov-alert.more{display:none}
.ov-alert-h{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;padding:10px 12px;font:inherit;color:var(--ink);cursor:pointer;border-radius:10px}
.ov-alert-h:hover{background:var(--surface2)}.ov-alert.open>.ov-alert-h{border-bottom:1px solid var(--border);border-radius:10px 10px 0 0}
.ov-alert-h .t{flex:1;font-size:13px;font-weight:600;line-height:1.4;min-width:0}
.ov-alert-h .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;background:var(--brand2)}
.ov-alert-h .dot.bad{background:var(--danger)}.ov-alert-h .dot.warn{background:var(--warn)}.ov-alert-h .dot.ok{background:var(--ok)}.ov-alert-h .dot.info{background:var(--brand2)}
.chev{width:8px;height:8px;border-right:1.5px solid var(--ink4);border-bottom:1.5px solid var(--ink4);transform:rotate(45deg);margin:0 4px 3px 2px;transition:transform .15s;flex-shrink:0;display:inline-block}
.ov-alert.open>.ov-alert-h .chev,.chev.open{transform:rotate(-135deg);margin-bottom:-2px}
.ov-alert-b{padding:10px 14px 12px 31px;background:var(--surface2)}
.ov-why{font-size:12.5px;color:var(--ink3);line-height:1.55;margin:0 0 6px}.ov-why b{color:var(--ink2);font-weight:650}
.ov-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
.ov-more{display:block;margin:6px 0 0;font-size:12.5px;color:var(--brand2)}
.ov-tblwrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface);margin:4px 0 8px}
.ov-mini th,.ov-mini td{padding:7px 10px;font-size:12.5px}.ov-mini .r{text-align:right}.ov-mini small{color:var(--ink4);font-weight:500}
.ov-mini b.bad,b.bad{color:var(--danger)}.ov-mini b.warn,b.warn{color:var(--warn)}b.ok,span.ok{color:var(--ok);font-weight:650}
/* AI analysis card */
.ov-aibar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}.ov-aibar [data-f="n"]{margin-left:4px;color:var(--brand)}
.ov-aits{font-size:12px;color:var(--ink4);margin-left:auto}.ov-aits b.warn{font-weight:600}
.ov-aihead{font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.5;margin:0 0 10px}
/* tabs */
.ov-tabs{display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--border);overflow-x:auto}
.ov-tab{background:none;border:0;border-bottom:2px solid transparent;padding:10px 14px;font:600 13.5px var(--font,sans-serif);color:var(--ink4);cursor:pointer;white-space:nowrap;margin-bottom:-1px}
.ov-tab:hover{color:var(--ink)}.ov-tab.on{color:var(--brand);border-bottom-color:var(--brand)}
.ov-panel>.ov-ch{padding-top:18px}.ov-panel>.ov-sum{padding:0 20px}.ov-panel>.ov-cb{padding-top:4px}
.ov-panel .card{box-shadow:none;border-color:var(--border)}
.ov-moretr td,.ov-smallhead td{background:var(--surface2);font-size:12.5px}.ov-smallhead small{color:var(--ink4);font-weight:500;margin-left:6px}.ov-smallhead .chev{margin-right:8px}
.nm-field{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--ink4)}
.nm-sel{padding:7px 30px 7px 11px;border-radius:9px;border:1px solid var(--border2);background:var(--surface);font:600 13px var(--font,sans-serif);color:var(--ink);max-width:100%}
.nm-q{font-size:12.5px;color:var(--ink4);line-height:1.5}.nm-foot{font-size:11.5px;color:var(--ink4);margin-top:8px;line-height:1.5}
@media(max-width:1100px){.ov-grid{grid-template-columns:1fr}}
.nm-ai-btn{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;border:1px solid var(--border2);background:var(--surface);color:var(--ink2);font:600 12.5px var(--font,sans-serif);cursor:pointer}
.nm-ai-btn i{width:12px;height:12px;border-radius:50%;background:var(--ai-grad,var(--brand2))}
.nm-ai-btn:hover,.nm-ai-btn.on{border-color:var(--lav,#6B3FD4);color:var(--lav,#6B3FD4)}
.nm-sum{position:relative;border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:14px 18px 12px;margin-bottom:16px;overflow:hidden}
.nm-sum::before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:var(--ai-grad,var(--brand2))}
.nm-sum-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}.nm-sum-top b{color:var(--ink);font-size:13.5px}.nm-sum-top span{font-size:12px;color:var(--ink4);flex:1}
.nm-sum-head{font-size:14px;font-weight:600;color:var(--ink);margin:0 0 8px;line-height:1.5}
.nm-sum-list{margin:0;padding:0;list-style:none;display:grid;gap:8px}
.nm-sum-list li{position:relative;padding-left:16px;font-size:13px;line-height:1.55;color:var(--ink2)}
.nm-sum-list li::before{content:'';position:absolute;left:0;top:7px;width:7px;height:7px;border-radius:50%;background:var(--brand2)}
.nm-sum-list li.critical::before{background:var(--danger)}.nm-sum-list li.warning::before{background:var(--warn)}.nm-sum-list li.positive::before{background:var(--ok)}
.nm-sum-do{color:var(--ink4)}.nm-sum-note{font-size:13px;color:var(--ink4);margin:0}
.nm-wbs{display:inline-flex;gap:4px;justify-content:flex-end}
.nm-wb{display:inline-flex;align-items:center;gap:3px;border:1px solid color-mix(in srgb,var(--danger) 22%,transparent);background:color-mix(in srgb,var(--danger) 6%,transparent);color:var(--danger);border-radius:6px;padding:1px 6px;font:600 12px var(--font,sans-serif);cursor:pointer;font-variant-numeric:tabular-nums}
.nm-wb i{font-style:normal;font-size:10.5px;color:var(--ink4);font-weight:700}.nm-wb:hover{background:color-mix(in srgb,var(--danger) 12%,transparent)}
.nm-wb.zero{border-color:var(--border);background:transparent;color:var(--ink5);cursor:default}
.ov-tot td{background:var(--surface2)}
.nm-wbline{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);margin-top:6px;padding-top:8px;font-size:11.5px;color:var(--ink4);font-weight:600}
/* top-bar school picker */
.nm-scope-wrap{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--ink4)}
.nm-scope{max-width:280px;padding:7px 30px 7px 11px;border-radius:9px;border:1px solid var(--border2);background:var(--surface);font:600 13px var(--font,sans-serif);color:var(--ink)}
/* schools & classes */
.sb-wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:20px;align-items:start}.sb-wrap.one{grid-template-columns:minmax(0,1fr)}
.sb-list{position:sticky;top:76px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;max-height:calc(100vh - 100px);overflow:auto}
.sb-list .nm-in{width:100%;margin-bottom:8px}
.sb-item{display:grid;gap:4px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:10px;padding:10px 12px;cursor:pointer;font:inherit}
.sb-item:hover{background:var(--surface2)}.sb-item.on{background:var(--brand4);border-color:color-mix(in srgb,var(--brand2) 25%,transparent)}
.sb-name{font-weight:650;color:var(--ink);font-size:13.5px}.sb-sub{font-size:11.5px;color:var(--ink4)}
.sb-meta{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--ink2)}
.nm-bar-mini{position:relative;flex:1;height:6px;border-radius:999px;background:var(--surface3)}.nm-bar-mini i{display:block;height:100%;border-radius:999px}
.nm-bar-mini i.ok{background:var(--ok)}.nm-bar-mini i.warn{background:var(--warn)}.nm-bar-mini i.bad{background:var(--danger)}
.nm-bar-mini b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.6}
.sb-detail{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 22px;min-width:0}
.sb-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
.sb-head h3{font-size:20px;font-weight:750;color:var(--ink);margin:0;letter-spacing:-.01em}.sb-head p{font-size:13px;color:var(--ink4);margin:4px 0 0}
.sb-actions{display:flex;gap:8px;flex-wrap:wrap}
.sb-progress{margin:16px 0 4px}
.sb-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--ink3);margin-top:6px}
.sb-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.sb-legend i.c{background:var(--ok)}.sb-legend i.p{background:#E9B061}.sb-legend i.n{background:var(--surface3);box-shadow:inset 0 0 0 1px var(--border2)}.sb-legend i.t{background:var(--ink);width:2px}
.sb-h4{font-size:14px;font-weight:700;color:var(--ink);margin:22px 0 8px}
.sb-tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
.sb-tbl{margin:0}.sb-tbl .r{text-align:right}.sb-tbl tbody th,.sb-tbl tfoot th{text-align:left;font-weight:650;color:var(--ink);padding:10px 12px;background:transparent;border-bottom:1px solid var(--border)}
.sb-tbl tfoot td,.sb-tbl tfoot th{background:var(--surface2);font-weight:700}
.sb-cell{background:none;border:0;padding:2px 4px;border-radius:6px;font:600 13.5px var(--font,sans-serif);color:var(--ink);cursor:pointer;font-variant-numeric:tabular-nums}
.sb-cell small{font-size:11px;font-weight:500;color:var(--ink4);margin-left:5px}
.sb-cell:hover{background:var(--brand4);color:var(--brand)}
.sb-cell.ok{color:var(--ok)}.sb-cell.warn{color:var(--warn)}.sb-cell.bad{color:var(--danger)}
.sb-zero{color:var(--ink5);font-size:12.5px}.sb-tbl td.sb-top{min-width:150px;max-width:220px;white-space:normal;line-height:1.35}.sb-tbl th,.sb-tbl td{padding-left:10px;padding-right:10px}.sb-foot{font-size:12px;color:var(--ink4);margin:10px 0 0}
@media(max-width:1000px){.sb-wrap{grid-template-columns:1fr}.sb-list{position:static;max-height:none}}
/* drill list: Unique School ID next to the name */
.nm-uid{display:inline-block;margin-left:6px;padding:0 6px;border-radius:5px;background:var(--surface3);color:var(--ink3);font-size:11px;font-weight:600;vertical-align:1px}
`;
  const styleEl = document.createElement('style'); styleEl.textContent = CSS; document.head.appendChild(styleEl);

  const NM = window.NM = { esc, attr, api, qs, fmtDate, store, STATUS, UI, cssVar, tokenAlpha, me: null, cat: null, classes: null };

  /* ── session context (who is signed in, catalogue, classes) ──────── */
  let _ctxPromise = null;
  NM.ready = function () {
    if (!_ctxPromise) {
      _ctxPromise = Promise.all([api('GET', '/api/dashboard/me'), api('GET', '/api/dashboard/catalogue'), api('GET', '/api/dashboard/classes')])
        .then(([me, cat, cls]) => { NM.me = me.user; NM.cat = cat; NM.classes = cls.classes || []; return NM; })
        .catch(e => { _ctxPromise = null; throw e; });
    }
    return _ctxPromise;
  };
  NM.classKeyFor = (label) => {
    if (!label) return '';
    const l = String(label).toLowerCase().replace(/^class\s*/, '').trim();
    const hit = (NM.classes || []).find(c => c.label.toLowerCase() === String(label).toLowerCase() || c.key === 'g' + l || c.labels.some(x => String(x).toLowerCase() === l));
    return hit ? hit.key : '';
  };
  // Colour/CSS-class helpers driven by the server's shared bands.
  NM.fitTone = (score) => {
    const t = (NM.cat && NM.cat.bands && NM.cat.bands.fit_tiers) || [];
    if (typeof score !== 'number' || !t.length) return 'var(--ink4)';
    const i = t.findIndex(x => score >= x.min);
    return i === 0 ? 'var(--ok)' : i === t.length - 1 ? 'var(--danger)' : 'var(--warn)';
  };
  NM.stanineLevel = (n) => {
    const b = (NM.cat && NM.cat.bands && NM.cat.bands.stanine) || null;
    if (!b || typeof n !== 'number') return 'mid';
    return n >= b.strength ? 'high' : n >= b.developing ? 'mid' : 'low';
  };
  NM.stanineTone = (n) => ({ high: 'var(--ok)', mid: 'var(--warn)', low: 'var(--danger)' })[NM.stanineLevel(n)];
  NM.stanineClass = (n) => ({ high: 's79', mid: 's46', low: 's13' })[NM.stanineLevel(n)];
  NM.dim = (id) => ((NM.cat && NM.cat.dimensions) || []).find(d => d.id === id) || { id, label: id, question: '' };

  /* ── plain-English help ─────────────────────────────────────────── */
  NM.help = (term) => `<button type="button" class="nm-help" data-nm="help" data-term="${esc(term)}" aria-label="What does this mean?">?</button>`;
  let _pop = null;
  function showHelp(btn) {
    if (_pop) { _pop.remove(); _pop = null; }
    const term = String(btn.getAttribute('data-term') || '').toLowerCase();
    const g = ((NM.cat && NM.cat.glossary) || []).find(e => e.term.toLowerCase() === term || e.aliases.some(a => a === term))
      || ((NM.cat && NM.cat.glossary) || []).find(e => e.term.toLowerCase().includes(term) || e.aliases.some(a => term.includes(a)));
    const text = btn.getAttribute('data-text');
    _pop = document.createElement('div'); _pop.className = 'nm-pop';
    _pop.innerHTML = g ? `<b>${esc(g.term)}</b>${esc(g.meaning)}<div class="why">${esc(g.why)}</div>` : `<b>${esc(btn.getAttribute('data-term') || '')}</b>${esc(text || 'No description yet.')}`;
    document.body.appendChild(_pop);
    const r = btn.getBoundingClientRect();
    const left = Math.min(window.innerWidth - _pop.offsetWidth - 10, Math.max(10, r.left - 20));
    const top = r.bottom + 8 + _pop.offsetHeight > window.innerHeight ? r.top - _pop.offsetHeight - 8 : r.bottom + 8;
    _pop.style.left = left + 'px'; _pop.style.top = Math.max(8, top) + 'px';
  }
  NM.openGlossary = async function () {
    await NM.ready();
    const m = modal({ title: 'What the dashboard terms mean', sub: 'Plain-English explanations of every term and number used on this dashboard and in the student reports.', small: false });
    m.body.innerHTML = '<table class="nm-tbl"><thead><tr><th>Term</th><th>What it means</th><th>Why it matters</th></tr></thead><tbody>'
      + NM.cat.glossary.map(g => `<tr><td style="font-weight:700;color:var(--ink);white-space:nowrap">${esc(g.term)}</td><td>${esc(g.meaning)}</td><td style="color:var(--ink4)">${esc(g.why)}</td></tr>`).join('')
      + '</tbody></table>';
  };

  /* ── modal ──────────────────────────────────────────────────────── */
  function modal({ title, sub, small, footer }) {
    const ov = document.createElement('div'); ov.className = 'nm-ov';
    ov.innerHTML = `<div class="nm-modal${small ? ' sm' : ''}" role="dialog" aria-modal="true"><div class="nm-mh"><div><h3></h3><p></p></div><button class="nm-x" type="button" aria-label="Close">✕</button></div><div class="nm-mb"></div>${footer ? '<div class="nm-mf"></div>' : ''}</div>`;
    ov.querySelector('h3').textContent = title || '';
    const p = ov.querySelector('.nm-mh p'); if (sub) p.innerHTML = sub; else p.remove();
    // While a list is open, a profile opened from it must sit above it.
    const syncBody = () => document.body.classList.toggle('nm-modal-open', !!document.querySelector('.nm-ov'));
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); syncBody(); };
    const drawerOpen = () => !!document.querySelector('.d-overlay.open,.rd-overlay.open,.overlay.open');
    const onKey = (e) => { if (e.key === 'Escape' && !drawerOpen() && ov === [...document.querySelectorAll('.nm-ov')].pop()) close(); };
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.nm-x')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov); syncBody();
    return { el: ov, body: ov.querySelector('.nm-mb'), foot: ov.querySelector('.nm-mf'), close };
  }
  NM.modal = modal;

  /* ── open a student's profile from anywhere ─────────────────────── */
  // Each dashboard's openDrawer() loads the student itself, so a profile
  // opens correctly from any list, alert or assistant answer.
  NM.openStudent = function (sid) {
    if (sid && typeof window.openDrawer === 'function') window.openDrawer(sid);
  };

  /* ── drill-down: the students behind any number ─────────────────── */
  const PAGE = 50;
  // Builds the list UI into `host` (which must contain a [data-f="body"] and
  // a [data-f="foot"] element). Used by the modal and by inline lists.
  async function buildDrill(host, o, dim) {
    const body = host.querySelector('[data-f="body"]'), foot = host.querySelector('[data-f="foot"]');
    const state = { offset: 0, total: 0, rows: [], selected: new Set(), allMatching: false };
    body.innerHTML = `<div class="nm-bar"><select class="nm-in" data-f="class" aria-label="Class"><option value="">All classes</option>${(NM.classes || []).map(c => `<option value="${esc(c.key)}"${c.key === o.classKey ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
      <select class="nm-in" data-f="status" aria-label="Status"><option value="">Any status</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === o.status ? ' selected' : ''}>${v[0]}</option>`).join('')}</select>
      <input class="nm-in" data-f="search" type="search" placeholder="Search name, email or Unique School ID" style="min-width:240px" value="${esc(o.search)}" aria-label="Search">
      <span style="flex:1"></span><span data-f="count" style="font-size:12.5px;color:var(--ink4)"></span></div>
      <div data-f="desc"></div><div data-f="list" style="overflow-x:auto"><div class="nm-empty"><span class="nm-spin"></span></div></div><div data-f="pager" class="nm-bar" style="justify-content:space-between;margin:10px 0 0"></div>`;
    foot.innerHTML = `<span data-f="sel" style="font-size:12.5px;color:var(--ink4);margin-right:auto"></span>
      <button class="nm-btn" data-f="selall">Select all matching</button>
      <button class="nm-btn" data-f="csv">Export list (CSV)</button>
      <button class="nm-btn" data-f="remind">Send reminder</button>
      <button class="nm-btn pri" data-f="zip" title="Students without a generated report are skipped">Download reports (ZIP)</button>`;
    const $ = (k) => host.querySelector('[data-f="' + k + '"]');
    let gl = new Map();
    if (dim) {
      gl = await groupDescriptions(o.dimension, o.school);
      const descs = o.groups.map(g => gl.get(g)).filter(Boolean);
      if (descs.length) $('desc').innerHTML = '<div class="nm-note">' + descs.map(d => `<b>${esc(d.label)}:</b> ${esc(d.description)}`).join('<br>') + '</div>';
    }
    // When a list mixes groups (or a student can be in several), show why
    // each student is on it.
    const showWhy = dim && (o.groups.length !== 1 || dim.multi);
    // org / branch / year come from the drill-down dashboard; empty values are dropped.
    const params = () => ({ dimension: o.dimension, groups: o.groups, class: $('class').value, school: o.school, org: o.org, branch: o.branch, year: o.year, status: $('status').value, search: $('search').value.trim() });
    const label = o.title || (dim ? dim.label : 'students');
    const selInfo = () => { $('sel').textContent = state.allMatching ? `All ${state.total} matching students selected` : state.selected.size ? state.selected.size + ' selected' : 'Tick students, or use "Select all matching"'; };
    async function load() {
      $('list').innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
      try {
        const r = await api('GET', '/api/dashboard/drill?' + qs(Object.assign(params(), { limit: PAGE, offset: state.offset })));
        state.total = r.total; state.rows = r.students;
        $('count').textContent = r.total + ' student' + (r.total === 1 ? '' : 's');
        if (!r.students.length) { $('list').innerHTML = '<div class="nm-empty">No students match.</div>'; $('pager').innerHTML = ''; selInfo(); return; }
        $('list').innerHTML = `<table class="nm-tbl"><thead><tr><th style="width:28px"><input type="checkbox" data-f="pageall" aria-label="Select this page"></th><th>Student</th><th>Class</th><th>Status</th>${showWhy ? '<th>Why listed</th>' : ''}<th>Career fit ${NM.help('Integrated Fit Score')}</th><th>Top interest</th><th>Last activity</th></tr></thead><tbody>`
          + r.students.map(s => {
            const st = STATUS[s.status] || ['—', 'mute'];
            return `<tr><td><input type="checkbox" data-sid="${esc(s.session_id)}"${state.allMatching || state.selected.has(s.session_id) ? ' checked' : ''} aria-label="Select"></td>
              <td><button class="nm-link" data-nm="student" data-sid="${esc(s.session_id)}">${esc(s.full_name || s.first_name || '—')}</button>${s.student_uid ? `<span class="nm-uid" title="Unique School ID">${esc(s.student_uid)}</span>` : ''}<div style="font-size:11px;color:var(--ink5)">${esc(s.school || '')}${s.email ? ', ' + esc(s.email) : ''}</div></td>
              <td style="white-space:nowrap">${esc(s.class_label)}${s.section ? ' – ' + esc(s.section) : ''}</td>
              <td><span class="nm-chip ${st[1]}">${st[0]}</span>${s.status !== 'completed' ? `<div style="font-size:10.5px;color:var(--ink5);margin-top:2px">${s.modules_done || 0} of 4 parts done</div>` : ''}</td>
              ${showWhy ? `<td>${(s.matched || []).map(k => `<span class="nm-chip mute">${esc((gl.get(k) || {}).label || k)}</span>`).join(' ')}</td>` : ''}
              <td>${esc(s.fit_tier || '—')}</td><td>${esc(s.top_interest || '—')}</td>
              <td style="font-size:11.5px;color:var(--ink4);white-space:nowrap">${fmtDate(s.last_activity || s.completed_at || s.registered_at)}</td></tr>`;
          }).join('') + '</tbody></table>';
        const pages = Math.ceil(r.total / PAGE), cur = Math.floor(state.offset / PAGE) + 1;
        $('pager').innerHTML = pages > 1 ? `<span style="font-size:12px;color:var(--ink4)">Showing ${state.offset + 1}–${Math.min(state.offset + PAGE, r.total)} of ${r.total}</span>
          <span><button class="nm-btn sm" data-f="prev"${cur <= 1 ? ' disabled' : ''}>← Previous</button> <button class="nm-btn sm" data-f="next"${cur >= pages ? ' disabled' : ''}>Next</button></span>` : '';
      } catch (e) { $('list').innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
      selInfo();
    }
    async function selectedIds() {
      if (state.allMatching) return (await api('GET', '/api/dashboard/drill?' + qs(Object.assign(params(), { ids_only: 1 })))).ids;
      return [...state.selected];
    }
    const resetSel = () => { state.offset = 0; state.allMatching = false; state.selected.clear(); };
    let t;
    host.addEventListener('input', (e) => { if (e.target === $('search')) { clearTimeout(t); t = setTimeout(() => { resetSel(); load(); }, 350); } });
    host.addEventListener('change', (e) => {
      if (e.target === $('class') || e.target === $('status')) { resetSel(); load(); return; }
      if (e.target.matches('input[data-sid]')) { state.allMatching = false; e.target.checked ? state.selected.add(e.target.dataset.sid) : state.selected.delete(e.target.dataset.sid); selInfo(); }
      if (e.target.matches('[data-f="pageall"]')) { state.allMatching = false; host.querySelectorAll('input[data-sid]').forEach(cb => { cb.checked = e.target.checked; e.target.checked ? state.selected.add(cb.dataset.sid) : state.selected.delete(cb.dataset.sid); }); selInfo(); }
    });
    host.addEventListener('click', async (e) => {
      const f = e.target.closest('[data-f]'); if (!f || !host.contains(f)) return;
      const k = f.dataset.f;
      if (k === 'prev') { state.offset = Math.max(0, state.offset - PAGE); load(); }
      if (k === 'next') { state.offset += PAGE; load(); }
      if (k === 'selall') { state.allMatching = true; host.querySelectorAll('input[data-sid]').forEach(cb => { cb.checked = true; }); selInfo(); }
      if (k === 'csv') exportCsv(params(), label);
      if (k === 'zip' || k === 'remind') {
        try {
          const ids = await selectedIds();
          if (!ids.length) return toast('Select at least one student first.', 'error');
          if (k === 'zip') NM.downloadReports(ids, label);
          else NM.composeReminder({ ids, label });
        } catch (err) { toast(err.message, 'error'); }
      }
    });
    host._nmRender = load;
    load();
  }
  function normDrill(opts) {
    const o = Object.assign({ groups: [], classKey: '', school: '', status: '', search: '' }, opts || {});
    o.groups = Array.isArray(o.groups) ? o.groups : (o.groups ? [o.groups] : []);
    return o;
  }
  NM.openDrill = async function (opts) {
    await NM.ready();
    const o = normDrill(opts);
    const dim = o.dimension ? NM.dim(o.dimension) : null;
    const m = modal({ title: o.title || (dim ? dim.label : 'Students'), sub: esc(o.subtitle || (dim ? dim.question : '')), footer: true });
    m.body.setAttribute('data-f', 'body'); m.foot.setAttribute('data-f', 'foot');
    buildDrill(m.el, o, dim);
  };
  // The same list, embedded in a page section.
  NM.mountDrillList = async function (el, opts) {
    if (!el) return;
    await NM.ready();
    const o = normDrill(opts);
    const dim = o.dimension ? NM.dim(o.dimension) : null;
    el.innerHTML = '<div data-f="body"></div><div data-f="foot" class="nm-bar" style="justify-content:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)"></div>';
    await buildDrill(el, o, dim);
  };

  /* A student's wellbeing as its three areas, for the profile's summary tile. */
  NM.wbStudentHtml = function (seaa) {
    const tone = (c) => /support/i.test(c || '') ? 'var(--danger)' : /develop/i.test(c || '') ? 'var(--warn)' : /strong|strength|well/i.test(c || '') ? 'var(--ok)' : 'var(--ink4)';
    const rows = NM.wbAreas().map(a => {
      const r = (seaa || []).find(x => String(x.key).toUpperCase() === a.key || String(x.title || '').toLowerCase().startsWith(a.label.toLowerCase()));
      return `<div style="display:flex;justify-content:space-between;gap:6px;font-size:11.5px;line-height:1.5"><span style="color:var(--ink4)">${esc(a.label)}</span><b style="color:${tone(r && r.cat_label)};white-space:nowrap">${esc(r ? ({ 'Support Needed': 'Needs support', 'Strong Readiness': 'Strong', 'Developing Readiness': 'Developing' }[r.cat_label] || r.cat_label || '—') : '—')}</b></div>`;
    }).join('');
    return `<div style="text-align:left">${rows}</div>`;
  };
  /* ── Wellbeing support, always split into its three areas ──────── */
  NM.wbAreas = () => (NM.cat && NM.cat.wellbeing_areas) || [{ key: 'S', label: 'Social' }, { key: 'E', label: 'Emotional' }, { key: 'A', label: 'Academic' }];
  // One clickable count per area; `base` is the drill (school, class) to narrow.
  NM.wbCells = (counts, base, sep) => NM.wbAreas().map(a => {
    const n = (counts && counts[a.key]) || 0;
    return n ? `<button type="button" class="nm-wb" data-nm="drill" data-o="${attr(Object.assign({}, base, { dimension: 'wellbeing_need', groups: [a.key], title: ((base && base.title) ? base.title + ' · ' : '') + a.label + ' support' }))}" title="${esc(a.label)} adjustment needs support"><i>${esc(a.label[0])}</i>${n.toLocaleString('en-IN')}</button>`
             : `<span class="nm-wb zero" title="${esc(a.label)}"><i>${esc(a.label[0])}</i>0</span>`;
  }).join(sep || '');
  /* Areas × classes table from the wellbeing_need breakdown (or from rows
     already counted). Each cell opens its students. */
  NM.wbTable = function (rows, totals, base) {
    const A = NM.wbAreas();
    const cell = (n, extra) => n ? `<button type="button" class="sb-cell bad" data-nm="drill" data-o="${attr(Object.assign({}, base, extra, { dimension: 'wellbeing_need' }))}">${n.toLocaleString('en-IN')}</button>` : '<span class="sb-zero">0</span>';
    return `<div class="ov-tblwrap"><table class="nm-tbl ov-mini"><thead><tr><th>Class</th>${A.map(a => `<th class="r" title="${esc(a.description || '')}">${esc(a.label)}</th>`).join('')}</tr></thead><tbody>`
      + rows.map(r => `<tr><td>${esc(r.label)}</td>${A.map(a => `<td class="r">${cell((r.counts || {})[a.key] || 0, { groups: [a.key], classKey: r.class_key, title: r.label + ' · ' + a.label + ' support' })}</td>`).join('')}</tr>`).join('')
      + (totals ? `<tr class="ov-tot"><td><b>All classes</b></td>${A.map(a => `<td class="r"><b>${cell(totals[a.key] || 0, { groups: [a.key], title: a.label + ' support' })}</b></td>`).join('')}</tr>` : '')
      + `</tbody></table></div>`;
  };
  // The same table built from the server's wellbeing_need breakdown.
  NM.mountWbByClass = async function (el, { school } = {}) {
    if (!el) return;
    try {
      const b = await api('GET', '/api/dashboard/breakdown?' + qs({ dimension: 'wellbeing_need', school }));
      const t = Object.fromEntries(b.groups.map(g => [g.key, g.total]));
      el.innerHTML = NM.wbTable(b.classes.filter(c => NM.wbAreas().some(a => c.counts[a.key])).map(c => ({ label: c.label, class_key: c.key, counts: c.counts })), t, { school });
    } catch (e) { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  };

  /* ── follow-up page: every reason a student needs action ─────────── */
  NM.mountFollowUp = async function (el, { school, initial } = {}) {
    if (!el) return;
    await NM.ready();
    el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
    try {
      const b = await api('GET', '/api/dashboard/breakdown?' + qs({ dimension: 'attention', school }));
      const groups = b.groups.filter(g => g.key !== 'on_track');
      let cur = initial && groups.some(g => g.key === initial) ? initial : (groups.find(g => g.total) || groups[0] || {}).key;
      el.innerHTML = `<div class="nm-note">${esc(b.dimension.question)} Each student appears under one reason only. Change how many days count as "stalled" with the programme settings. ${NM.help('Stalled')}</div>`
        + `<div class="nm-tabs" data-f="fu-tabs">${groups.map(g => `<button class="nm-tab" data-g="${esc(g.key)}" title="${esc(g.description)}">${esc(g.label)} <b>${g.total}</b></button>`).join('')}</div><div data-f="fu-list"></div>`;
      const draw = () => {
        el.querySelectorAll('[data-f="fu-tabs"] [data-g]').forEach(t => t.classList.toggle('on', t.dataset.g === cur));
        const g = groups.find(x => x.key === cur);
        const holder = el.querySelector('[data-f="fu-list"]');
        holder.replaceWith(holder.cloneNode(false)); // drop listeners of the previous list
        const list = el.querySelector('[data-f="fu-list"]');
        if (cur === 'support') {
          // Wellbeing support is shown by area and class before the students.
          list.innerHTML = '<div class="nm-sec" style="margin-top:4px">By area and class</div><div data-f="wb"></div><div data-f="wbl"></div>';
          NM.mountWbByClass(list.querySelector('[data-f="wb"]'), { school });
          NM.mountDrillList(list.querySelector('[data-f="wbl"]'), { dimension: 'attention', groups: [cur], school, title: g ? g.label : 'Follow-up' });
        } else NM.mountDrillList(list, { dimension: 'attention', groups: [cur], school, title: g ? g.label : 'Follow-up' });
      };
      el.querySelector('[data-f="fu-tabs"]').addEventListener('click', (e) => { const t = e.target.closest('[data-g]'); if (t) { cur = t.dataset.g; draw(); } });
      el._nmRender = () => NM.mountFollowUp(el, { school, initial: cur });
      if (cur) draw();
    } catch (e) { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  };

  /* ── short preview of any list with a "View all" button ───────────── */
  // "3+ days" when every school in view uses the same follow-up setting.
  NM.followUpText = (settings) => {
    const list = (settings.schools || []).map(x => x.settings.follow_up_after_days);
    const vals = [...new Set(list.length ? list : [settings.global.follow_up_after_days])];
    return vals.length === 1 ? vals[0] + '+ day' + (vals[0] === 1 ? '' : 's') : 'longer than each school’s follow-up setting';
  };
  NM.sinceText = (iso) => {
    if (!iso) return '—';
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago';
  };

  const _groupCache = new Map();
  async function groupDescriptions(dimension, school) {
    const key = dimension + '|' + (school || '');
    if (!_groupCache.has(key)) {
      _groupCache.set(key, api('GET', '/api/dashboard/breakdown?' + qs({ dimension, school }))
        .then(b => new Map(b.groups.map(g => [g.key, g]))).catch(() => new Map()));
    }
    return _groupCache.get(key);
  }

  async function exportCsv(params, label) {
    try {
      const all = [];
      for (let off = 0; ; off += 500) {
        const r = await api('GET', '/api/dashboard/drill?' + qs(Object.assign({}, params, { limit: 500, offset: off })));
        all.push(...r.students); if (all.length >= r.total || !r.students.length) break;
      }
      downloadCsv([['Name', 'Unique School ID', 'Email', 'School', 'Class', 'Section', 'Status', 'Parts done (of 4)', 'Career fit', 'Top interest', 'Wellbeing', 'Registered', 'Last activity']]
        .concat(all.map(s => [s.full_name, s.student_uid, s.email, s.school, s.class_label, s.section, (STATUS[s.status] || [s.status])[0], s.modules_done, s.fit_tier, s.top_interest, s.seaa_status, fmtDate(s.registered_at), fmtDate(s.last_activity)])), label);
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  }
  // Rows (first one the header) to a CSV download that Excel opens cleanly.
  function downloadCsv(rows, label) {
    // Text starting with = + - @ would run as a formula in Excel; prefix it.
    const cell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = String(label).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  // Every school in view with its progress against its own target.
  NM.exportSchools = async function () {
    try {
      const { schools } = await api('GET', '/api/dashboard/school-summary');
      const list = NM.scope.school ? schools.filter(x => x.school === NM.scope.school) : schools;
      downloadCsv([['School', 'Registered', 'Completed', 'In progress', 'Not started', 'Completion %', 'Target %', 'Need follow-up']]
        .concat(list.map(x => [x.school, x.total, x.completed, x.in_progress, x.not_started, x.completion_pct, x.target_pct, x.follow_up])), 'schools');
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  };

  // Download any list as CSV without opening it (every matching student).
  NM.exportList = function (drill, label) {
    const d = normDrill(drill);
    return exportCsv({ dimension: d.dimension, groups: d.groups, class: d.classKey, school: d.school, status: d.status, search: d.search }, label || d.title || 'students');
  };

  /* ── reminders to any list ──────────────────────────────────────── */
  const REMINDER_CHUNK = 200; // well under the server's per-request maximum
  NM.composeReminder = async function ({ ids, label, subject, message, onSent }) {
    const m = modal({ title: 'Send a reminder email', sub: `To: <b>${esc(label)}</b> (${ids.length} student${ids.length === 1 ? '' : 's'}). Students without an email on record are skipped.`, small: true, footer: true });
    m.body.innerHTML = `<label style="font-size:12px;font-weight:700;color:var(--ink3)">Subject</label><input class="nm-in" data-f="subj" style="width:100%;margin:4px 0 12px">
      <label style="font-size:12px;font-weight:700;color:var(--ink3)">Message</label><textarea class="nm-in" data-f="msg" rows="6" style="width:100%;margin-top:4px;resize:vertical"></textarea>
      <div class="nm-note" style="margin-top:10px">Each email starts with "Dear &lt;student name&gt;," and ends with a line asking them to contact their school counsellor. It is logged in the reminder history.</div>`;
    m.el.querySelector('[data-f="subj"]').value = subject || 'Reminder: complete your NuMind MAPS assessment';
    m.el.querySelector('[data-f="msg"]').value = message || 'Your NuMind MAPS assessment is not finished yet. Your progress is saved, so you can continue exactly where you stopped. Completing all four parts gives you your personal career report.';
    m.foot.innerHTML = '<button class="nm-btn" data-f="cancel">Cancel</button><button class="nm-btn pri" data-f="send">Send emails</button>';
    m.foot.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      if (b.dataset.f === 'cancel') return m.close();
      b.disabled = true; b.textContent = 'Sending…';
      try {
        const subj = m.el.querySelector('[data-f="subj"]').value.trim(), msg = m.el.querySelector('[data-f="msg"]').value.trim();
        if (!msg) throw new Error('Write a message first.');
        let sent = 0, failed = 0, noEmail = 0;
        for (let i = 0; i < ids.length; i += REMINDER_CHUNK) {
          b.textContent = `Sending… ${Math.min(i + REMINDER_CHUNK, ids.length)} of ${ids.length}`;
          const r = await api('POST', '/api/dashboard/send-reminder', { session_ids: ids.slice(i, i + REMINDER_CHUNK), subject: subj, message: msg }, 300000);
          sent += r.sent || 0; failed += r.failed || 0; noEmail += r.no_email || 0;
        }
        toast(`${sent} email${sent === 1 ? '' : 's'} sent` + (failed ? `, ${failed} failed` : '') + (noEmail ? `, ${noEmail} without an email skipped` : ''), sent ? 'success' : 'error');
        m.close(); if (onSent) onSent(sent);
      } catch (err) { toast(err.message, 'error'); b.disabled = false; b.textContent = 'Send emails'; }
    });
  };

  /* Placeholder until js/dashboard-report-pdf.js (an ES module) loads and
     replaces it. If that module or one it imports fails to load, the PDF
     button explains why instead of throwing a script error. */
  if (typeof window.downloadStudentReportPDF !== 'function') {
    window.downloadStudentReportPDF = () => toast('The report PDF could not load. Reload the page; if this keeps happening, the js/pdf and js/engine folders are missing from the server.', 'error');
  }

  /* ── bulk report download ───────────────────────────────────────── */
  NM.downloadReports = function (ids, label) {
    if (typeof window.nmDownloadReportsZip !== 'function') return toast('The report renderer has not loaded yet. Please try again in a moment.', 'error');
    const box = document.createElement('div'); box.className = 'nm-prog';
    box.innerHTML = `<b style="color:var(--ink)">Preparing reports</b><div style="font-size:12px;color:var(--ink4);margin-top:2px">${esc(label)} · ${ids.length} student${ids.length === 1 ? '' : 's'}</div><div class="bar"><i style="width:0"></i></div><div data-f="t" style="font-size:12px;color:var(--ink3)">Starting…</div><div style="text-align:right;margin-top:8px"><button class="nm-btn sm" data-f="c">Cancel</button></div>`;
    document.body.appendChild(box);
    const ctl = { cancelled: false };
    box.querySelector('[data-f="c"]').onclick = () => { ctl.cancelled = true; box.querySelector('[data-f="t"]').textContent = 'Cancelling…'; };
    window.nmDownloadReportsZip(ids, {
      label, signal: ctl,
      onProgress: (p) => {
        box.querySelector('.bar i').style.width = pct(p.done, p.total) + '%';
        box.querySelector('[data-f="t"]').textContent = `${p.done} of ${p.total} processed` + (p.skipped ? ` · ${p.skipped} without a report skipped` : '') + (p.part ? ` · file ${p.part}` : '');
      },
    }).then((r) => {
      box.querySelector('[data-f="t"]').textContent = r.cancelled ? 'Cancelled — files already prepared were downloaded.'
        : `Done: ${r.added} report${r.added === 1 ? '' : 's'} in ${r.parts} ZIP file${r.parts === 1 ? '' : 's'}` + (r.skipped ? `; ${r.skipped} student${r.skipped === 1 ? '' : 's'} had no report yet.` : '.');
      box.querySelector('[data-f="c"]').textContent = 'Close'; box.querySelector('[data-f="c"]').onclick = () => box.remove();
    }).catch((e) => { box.querySelector('[data-f="t"]').textContent = 'Failed: ' + e.message; box.querySelector('[data-f="c"]').textContent = 'Close'; box.querySelector('[data-f="c"]').onclick = () => box.remove(); });
  };

  /* ── class selects populated from real data ─────────────────────── */
  NM.fillClassSelect = async function (sel, { school, allLabel } = {}) {
    if (!sel) return;
    try {
      const r = await api('GET', '/api/dashboard/classes?' + qs({ school }));
      const cur = sel.value;
      sel.innerHTML = `<option value="">${esc(allLabel || 'All classes')}</option>` + r.classes.map(c => `<option value="${esc(c.key)}">${esc(c.label)} (${c.students})</option>`).join('');
      if (r.classes.some(c => c.key === cur)) sel.value = cur;
    } catch (_) { /* leave as is */ }
  };

  /* ── class-wise explorer ────────────────────────────────────────── */
  const EXPLORER_GROUPS = [
    ['Progress', ['completion', 'attention', 'parameters']],
    ['Career', ['career_area', 'stream', 'fit_tier']],
    ['Personality', ['personality_level', 'personality_top']],
    ['Aptitude', ['aptitude_level', 'aptitude_top']],
    ['Wellbeing', ['wellbeing_level', 'wellbeing_need', 'seaa_concern']],
    ['Year-on-year', ['journey_direction', 'journey_interest']],
  ];
  NM.mountExplorer = async function (el, { dimension, school } = {}) {
    if (!el) return;
    await NM.ready();
    const state = { dim: dimension || store.get('explorer-dim', 'completion'), view: 'count' };
    const short = (id) => NM.dim(id).label.replace(/^(Personality|Aptitude|Wellbeing) — /, '');
    el.innerHTML = `<div class="nm-bar"><label class="nm-field"><span>Show</span><select class="nm-sel" data-f="dim" aria-label="What to break down by class">${EXPLORER_GROUPS.map(([g, ids]) => `<optgroup label="${esc(g)}">${ids.map(id => `<option value="${esc(id)}">${esc(g === 'Progress' || g === 'Career' || g === 'Year-on-year' ? NM.dim(id).label : g + ': ' + short(id))}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <span data-f="q" class="nm-q"></span></div>
      <div data-f="grid"><div class="nm-empty"><span class="nm-spin"></span></div></div>`;
    const sel = el.querySelector('[data-f="dim"]');
    if ([...sel.options].some(o => o.value === state.dim)) sel.value = state.dim; else state.dim = sel.value;
    async function render() {
      const grid = el.querySelector('[data-f="grid"]');
      grid.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
      try {
        const b = await api('GET', '/api/dashboard/breakdown?' + qs({ dimension: state.dim, school }));
        el.querySelector('[data-f="q"]').innerHTML = `${esc(b.dimension.question)} Based on ${b.totals.population.toLocaleString('en-IN')} ${esc(b.dimension.population_label)}.`
          + (b.dimension.multi ? ' A student can appear in more than one column.' : '') + ' Click any number for the students behind it.';
        if (!b.totals.population) { grid.innerHTML = `<div class="nm-empty">No ${esc(b.dimension.population_label)} yet.${state.dim.startsWith('journey') ? ' A journey appears when a student is assessed again in a higher class.' : ''}</div>`; return; }
        const groups = b.groups;
        const cell = (n, of, g, cls) => {
          const p = pct(n, of);
          const shade = `background:color-mix(in srgb, var(--brand2) ${Math.round(5 + p * 0.35)}%, transparent)`;
          return `<td class="nm-heat" style="${n ? shade : ''}" data-nm="drill" data-o="${attr({ dimension: state.dim, groups: g ? [g.key] : [], classKey: cls ? cls.key : '', school, title: (g ? g.label : NM.dim(state.dim).label) + (cls ? ' · ' + cls.label : '') })}"><div class="n">${n.toLocaleString('en-IN')}</div><div class="p">${p}%</div></td>`;
        };
        grid.innerHTML = `<div style="overflow-x:auto"><table class="nm-tbl"><thead><tr><th>Class</th><th style="text-align:center">Students</th>`
          + groups.map(g => `<th style="text-align:center;white-space:normal;min-width:90px" title="${esc(g.description)}">${esc(g.label)}<button type="button" class="nm-help" data-nm="help" data-term="${esc(g.label)}" data-text="${esc(g.description)}">?</button></th>`).join('')
          + `</tr></thead><tbody>`
          + b.classes.map(c => `<tr><td><button class="nm-link" data-nm="drill" data-o="${attr({ dimension: state.dim, classKey: c.key, school, title: NM.dim(state.dim).label + ' · ' + c.label })}">${esc(c.label)}</button></td><td style="text-align:center;font-weight:700">${c.population.toLocaleString('en-IN')}</td>`
            + groups.map(g => cell(c.counts[g.key] || 0, c.population, g, c)).join('') + '</tr>').join('')
          + `<tr style="border-top:2px solid var(--border2)"><td style="font-weight:800;color:var(--ink)">All classes</td><td style="text-align:center;font-weight:800">${b.totals.population.toLocaleString('en-IN')}</td>`
          + groups.map(g => cell(g.total, b.totals.population, g, null)).join('') + '</tr></tbody></table></div>'
          + '<div class="nm-foot">Percentages are of the students in that class (row). Darker cells hold a larger share. Press ? on a column for what it means.</div>';
      } catch (e) { grid.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
    }
    sel.addEventListener('change', () => { state.dim = sel.value; store.set('explorer-dim', state.dim); render(); });
    el._nmRender = render;
    render();
  };
  NM.openExplorer = function (dimension, school) {
    const sc = school === undefined ? NM.scope.school : school;
    const m = modal({ title: 'Class-wise breakdown' + (sc ? ' — ' + sc : ''), sub: 'Every result broken down by class. Click any number to see the students behind it.' });
    NM.mountExplorer(m.body, { dimension, school: sc });
  };

  /* ── What needs attention (live alerts, grouped) ───────────────── */
  // One row per issue; a row opens to its detail. Schools below their target
  // are one row with a table inside, so thirty small schools never become
  // thirty cards.
  NM.mountAlerts = async function (el, { school } = {}) {
    if (!el) return;
    await NM.ready();
    el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span> Checking for issues…</div>';
    const ROWS_SHOWN = UI.ALERT_ROWS;
    const sev = { critical: 'bad', warning: 'warn', info: 'info', good: 'ok' };
    try {
      const r = await api('GET', '/api/dashboard/alerts?' + qs({ school }));
      const st = r.settings || {};
      const below = r.alerts.filter(a => a.type === 'below_target'), rest = r.alerts.filter(a => a.type !== 'below_target');
      const rows = [];
      if (below.length > 1) {
        // Most missing completions first; schools with only a few students are
        // folded into one line so a long tail of tiny names stays out of the way.
        const students = below.reduce((n, a) => n + a.count, 0);
        const worst = below.some(a => a.severity === 'critical') ? 'critical' : 'warning';
        const big = below.filter(a => a.total >= NM.SMALL_SCHOOL).sort((a, b) => b.needed - a.needed || a.pct - b.pct);
        const small = below.filter(a => a.total < NM.SMALL_SCHOOL);
        const SHOW = UI.TABLE_ROWS;
        const line = (a) => `<tr><td><button class="nm-link" data-nm="school" data-school="${esc(a.school)}">${esc(a.school)}</button></td>
                <td class="r"><b class="${a.severity === 'critical' ? 'bad' : 'warn'}">${a.pct}%</b> <small>${a.done}/${a.total}</small></td><td class="r">${a.target}%</td><td class="r">${a.needed.toLocaleString('en-IN')}</td>
                <td class="r"><button class="nm-btn sm" data-nm="drill" data-o="${attr(Object.assign({ title: a.school + ': not finished' }, a.drill))}">See ${a.count.toLocaleString('en-IN')}</button></td></tr>`;
        const smallNeeded = small.reduce((n, a) => n + a.needed, 0), smallCount = small.reduce((n, a) => n + a.count, 0);
        rows.push({ severity: worst, title: `${below.length} schools are below their completion target`, count: students,
          body: `<div class="ov-tblwrap"><table class="nm-tbl ov-mini"><thead><tr><th>School</th><th class="r">Completed</th><th class="r">Target</th><th class="r">Still needed</th><th></th></tr></thead><tbody>`
            + big.slice(0, SHOW).map(line).join('')
            + (big.length > SHOW ? `<tr class="ov-moretr ov-hide"><td colspan="5"><button class="nm-link" data-f="more-schools">Show all ${big.length} schools</button></td></tr>` + big.slice(SHOW).map(a => line(a).replace('<tr>', '<tr class="ov-hidden" hidden>')).join('') : '')
            + (small.length ? `<tr class="ov-smallhead"><td colspan="3"><button class="nm-link" data-f="small-schools" aria-expanded="false"><i class="chev"></i>${small.length} school${small.length === 1 ? '' : 's'} with fewer than ${NM.SMALL_SCHOOL} students</button>${NM.me.role === 'admin' ? ` <button class="nm-link" data-f="to-merge" title="Often one school typed differently">Merge duplicate names</button>` : ''}</td><td class="r">${smallNeeded}</td><td class="r"><small>${smallCount} student${smallCount === 1 ? '' : 's'}</small></td></tr>` + small.map(a => line(a).replace('<tr>', '<tr class="ov-hidden" hidden>')).join('') : '')
            + `</tbody></table></div><div class="ov-why"><b>Why it matters:</b> ${esc(below[0].why)} <b>What to do:</b> ${esc(below[0].action)}</div>` });
      } else if (below.length === 1) rows.push(Object.assign({}, below[0], { body: null }));
      for (const a of rest) rows.push(Object.assign({}, a, { body: null }));
      const detail = (a) => a.body || (a.area_by_class ? `<div class="ov-row" style="margin:0 0 8px">${(a.by_area || []).map(x => `<span class="nm-chip bad click" data-nm="drill" data-o="${attr({ dimension: 'wellbeing_need', groups: [x.key], school, title: x.label + ' support' })}">${esc(x.label)}: ${x.count.toLocaleString('en-IN')}</span>`).join('')}</div>`
          + NM.wbTable(a.area_by_class, null, { school }) + `<div class="nm-foot">A student who needs support in two areas is counted in both.</div>` : `<div class="ov-why">${esc(a.detail)}</div>`)
        + (a.why ? `<div class="ov-why"><b>Why it matters:</b> ${esc(a.why)}</div>` : '') + (a.action ? `<div class="ov-why"><b>What to do:</b> ${esc(a.action)}</div>` : '')
        + (a.drill ? `<div class="ov-row"><button class="nm-btn sm pri" data-nm="drill" data-o="${attr(Object.assign({ title: a.title }, a.drill, { school: a.drill.school || school }))}">See ${a.count.toLocaleString('en-IN')} student${a.count === 1 ? '' : 's'}</button>`
          + (a.area_by_class ? [] : (a.by_class || [])).slice(0, UI.CLASS_CHIPS).map(c => `<span class="nm-chip mute click" data-nm="drill" data-o="${attr(Object.assign({ title: a.title + ' · ' + c.label }, a.drill, { classKey: c.class_key, school: a.drill.school || school }))}">${esc(c.label)}: ${c.count}</span>`).join('') + '</div>' : '');
      const row = (a, i) => `<div class="ov-alert ${esc(a.severity)}${i >= ROWS_SHOWN ? ' more' : ''}"><button type="button" class="ov-alert-h" aria-expanded="false">
          <i class="dot ${sev[a.severity] || 'info'}"></i><span class="t">${esc(a.title)}</span><span class="nm-chip mute">${a.count.toLocaleString('en-IN')}</span><i class="chev"></i></button>
          <div class="ov-alert-b" hidden>${detail(a)}</div></div>`;
      el.innerHTML = `<div class="ov-settings"><span>${r.settings_scope === 'default' ? 'Defaults: completion' : 'Completion'} target <b>${st.completion_target_pct}%</b>, follow up after <b>${st.follow_up_after_days} day${st.follow_up_after_days === 1 ? '' : 's'}</b></span>${NM.cat.can_edit_settings ? '<button class="nm-link" data-nm="settings">Change</button>' : ''}</div>`
        + (rows.length ? rows.map(row).join('') + (rows.length > ROWS_SHOWN ? `<button type="button" class="nm-link ov-more" data-f="more">Show ${rows.length - ROWS_SHOWN} more</button>` : '')
          : '<div class="ov-clear"><b>All clear.</b> Every school is on target and no student needs follow-up right now.</div>');
      el.querySelectorAll('.ov-alert-h').forEach(h => h.addEventListener('click', () => { const b = h.nextElementSibling; const open = b.hidden; b.hidden = !open; h.setAttribute('aria-expanded', String(open)); h.parentElement.classList.toggle('open', open); }));
      const more = el.querySelector('[data-f="more"]');
      if (more) more.onclick = () => { el.querySelectorAll('.ov-alert.more').forEach(x => x.classList.remove('more')); more.remove(); };
      const ms = el.querySelector('[data-f="more-schools"]');
      if (ms) ms.onclick = () => { let r = ms.closest('tr').nextElementSibling; while (r && r.classList.contains('ov-hidden') && !r.classList.contains('ov-smallhead')) { r.hidden = false; r = r.nextElementSibling; } ms.closest('tr').remove(); };
      const tm = el.querySelector('[data-f="to-merge"]');
      if (tm && typeof window.show === 'function') tm.onclick = () => window.show('schools-reg');
      const ss = el.querySelector('[data-f="small-schools"]');
      if (ss) ss.onclick = () => { const open = ss.getAttribute('aria-expanded') !== 'true'; ss.setAttribute('aria-expanded', String(open)); ss.querySelector('.chev').classList.toggle('open', open); let r = ss.closest('tr').nextElementSibling; while (r) { r.hidden = !open; r = r.nextElementSibling; } };
      // The first row opens by itself: the most urgent thing is visible without a click.
      const first = el.querySelector('.ov-alert-h'); if (first && rows.length) first.click();
    } catch (e) { el.innerHTML = `<div class="nm-empty">Could not load alerts: ${esc(e.message)}</div>`; }
  };

  /* ── AI analysis card ──────────────────────────────────────────── */
  NM.mountAnalysis = async function (el, { school } = {}) {
    if (!el) return;
    await NM.ready();
    const metrics = NM.cat.insight_metrics || [];
    let chosen = store.get('insight-metrics', metrics.filter(m => m.default).map(m => m.id)).filter(id => metrics.some(m => m.id === id));
    el.innerHTML = `<div class="ov-aibar"><button class="nm-btn pri" data-f="run">Analyse</button>
        <button class="nm-btn" data-f="pick" aria-expanded="false">Metrics <b data-f="n"></b></button>
        <span class="ov-aits" data-f="ts"></span></div>
      <div class="nm-metrics" data-f="metrics" hidden></div>
      <div data-f="out"></div>
      <div class="nm-foot">Reads only the numbers for your schools. No student names or messages are sent.</div>`;
    const mEl = el.querySelector('[data-f="metrics"]'), out = el.querySelector('[data-f="out"]'), ts = el.querySelector('[data-f="ts"]');
    const drawChips = () => { el.querySelector('[data-f="n"]').textContent = chosen.length; mEl.innerHTML = metrics.map(m => `<button class="nm-mchip${chosen.includes(m.id) ? ' on' : ''}" data-mid="${esc(m.id)}" title="${esc(m.description)}">${esc(m.label)}</button>`).join('') + '<button class="nm-btn sm" data-f="force" title="Write a fresh analysis even if the numbers have not changed">Rewrite from scratch</button>'; };
    drawChips();
    el.querySelector('[data-f="pick"]').onclick = (e) => { const open = mEl.hidden; mEl.hidden = !open; e.currentTarget.setAttribute('aria-expanded', String(open)); };
    mEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-f="force"]')) return run('force');
      const c = e.target.closest('[data-mid]'); if (!c) return;
      const id = c.dataset.mid;
      chosen = chosen.includes(id) ? chosen.filter(x => x !== id) : chosen.concat(id).slice(-limit('insight_metrics'));
      store.set('insight-metrics', chosen); drawChips(); run('cached');
    });
    const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    // how: 'cached' (on load, never calls the model), 'run' (new only if the
    // numbers changed), 'force' (always new).
    async function run(how) {
      if (!NM.cat.ai_enabled) { out.innerHTML = '<div class="nm-note">AI analysis is not switched on for this server (no OpenAI key). The alerts still work.</div>'; return; }
      if (!chosen.length) { out.innerHTML = '<div class="nm-note">Choose at least one metric.</div>'; return; }
      const wait = (secs) => { ts.textContent = ''; out.innerHTML = `<div class="nm-empty"><span class="nm-spin"></span> Analysing ${chosen.length} metric${chosen.length === 1 ? '' : 's'}…${secs > 20 ? ' This can take up to a minute.' : ''}</div>`; };
      if (how !== 'cached') wait(0);
      try {
        const r = await NM.fetchInsights({ metrics: chosen, school }, { how, onWait: wait });
        if (r.empty) { ts.textContent = ''; out.innerHTML = '<div class="ov-clear">No analysis yet for these metrics. Press <b>Analyse</b> to write one from the current numbers.</div>'; return; }
        ts.innerHTML = r.stale ? `Written ${esc(when(r.generated_at))} · <b class="warn">numbers changed since</b>` : `Up to date · ${esc(when(r.generated_at))}`;
        out.innerHTML = (r.headline ? `<p class="ov-aihead">${esc(r.headline)}</p>` : '')
          + r.insights.map((i, k) => {
            const d = i.drill ? Object.assign({ title: i.title }, i.drill, { classKey: NM.classKeyFor(i.drill.class_label), school }) : null;
            return `<div class="ov-alert ${esc(i.severity)}${k === 0 ? ' open' : ''}"><button type="button" class="ov-alert-h" aria-expanded="${k === 0}"><i class="dot ${({ critical: 'bad', warning: 'warn', positive: 'ok' })[i.severity] || 'info'}"></i><span class="t">${esc(i.title)}</span><i class="chev"></i></button>
              <div class="ov-alert-b"${k === 0 ? '' : ' hidden'}><div class="ov-why">${esc(i.what_we_see)}</div><div class="ov-why"><b>Why it matters:</b> ${esc(i.why_it_matters)}</div><div class="ov-why"><b>What to do:</b> ${esc(i.what_to_do)}</div>`
              + (d ? `<div class="ov-row"><button class="nm-btn sm" data-nm="drill" data-o="${attr(d)}">See these students</button></div>` : '') + '</div></div>';
          }).join('')
          + (r.data_gaps ? `<div class="nm-foot">Note: ${esc(r.data_gaps)}</div>` : '');
        out.querySelectorAll('.ov-alert-h').forEach(h => h.addEventListener('click', () => { const b = h.nextElementSibling; const open = b.hidden; b.hidden = !open; h.setAttribute('aria-expanded', String(open)); h.parentElement.classList.toggle('open', open); }));
      } catch (e) { ts.textContent = ''; out.innerHTML = `<div class="nm-note" style="color:var(--danger)">AI analysis unavailable: ${esc(e.message)} <button class="nm-link" data-f="retry">Try again</button></div>`; out.querySelector('[data-f="retry"]').onclick = () => run('run'); }
    }
    el.querySelector('[data-f="run"]').onclick = () => run('run');
    el._nmRefresh = () => run('cached');
    run('cached');
  };

  NM.openSettings = async function () {
    await NM.ready();
    const r = await api('GET', '/api/dashboard/settings');
    const m = modal({ title: 'Programme settings', sub: 'These decide when the dashboard flags a school, class or student. Changes apply immediately to alerts, lists and the AI analysis.', small: true, footer: true });
    const sch = r.schema;
    const isAdmin = NM.me.role === 'admin';
    const opts = (isAdmin ? ['<option value="">All schools (network-wide default)</option>'] : []).concat(r.schools.map(s => `<option value="${esc(s.school)}">${esc(s.school)}</option>`));
    m.body.innerHTML = `<label style="font-size:12px;font-weight:700;color:var(--ink3)">Apply to</label><select class="nm-in" data-f="school" style="width:100%;margin:4px 0 14px">${opts.join('')}</select>`
      + Object.entries(sch).map(([k, d]) => `<label style="font-size:12px;font-weight:700;color:var(--ink3)">${esc(d.label)}</label><input class="nm-in" type="number" data-k="${esc(k)}" min="${d.min}" max="${d.max}" style="width:120px;margin:4px 0 2px;display:block"><div style="font-size:11.5px;color:var(--ink4);margin-bottom:14px">${esc(d.description)}</div>`).join('');
    const fill = () => {
      const sel = m.el.querySelector('[data-f="school"]').value;
      const cur = sel ? (r.schools.find(s => s.school === sel) || {}).settings : r.global;
      m.el.querySelectorAll('[data-k]').forEach(i => { i.value = (cur || {})[i.dataset.k]; });
    };
    m.el.querySelector('[data-f="school"]').onchange = fill; fill();
    m.foot.innerHTML = '<button class="nm-btn" data-f="c">Cancel</button><button class="nm-btn pri" data-f="s">Save</button>';
    m.foot.querySelector('[data-f="c"]').onclick = m.close;
    m.foot.querySelector('[data-f="s"]').onclick = async () => {
      const values = {}; m.el.querySelectorAll('[data-k]').forEach(i => { values[i.dataset.k] = Number(i.value); });
      try { await api('PUT', '/api/dashboard/settings', { school: m.el.querySelector('[data-f="school"]').value, values }); toast('Settings saved.', 'success'); m.close(); NM.refreshAll(); }
      catch (e) { toast(e.message, 'error'); }
    };
  };

  /* ── trend anchored to the programme start ──────────────────────── */
  // Date ranges for the trend; the default keeps the chart readable on a long-running programme.
  const TREND_RANGES = [{ key: '12w', label: 'Last 12 weeks', days: 84 }, { key: '6m', label: 'Last 6 months', days: 182 }, { key: 'all', label: 'Whole programme', days: null }];
  NM.mountTrend = async function (el, { school } = {}) {
    if (!el) return;
    const state = { g: store.get('trend-g', 'week'), range: store.get('trend-range', '12w'), from: '', to: '' };
    const applyRange = () => {
      const r = TREND_RANGES.find(x => x.key === state.range) || TREND_RANGES[0];
      state.range = r.key;
      state.from = r.days ? new Date(Date.now() - r.days * 86400000).toISOString().slice(0, 10) : '';
    };
    applyRange();
    el.innerHTML = `<div class="nm-bar"><div class="nm-tabs" style="margin:0">${TREND_RANGES.map(r => `<button class="nm-tab" data-r="${r.key}">${esc(r.label)}</button>`).join('')}</div>
      <div class="nm-tabs" style="margin:0 0 0 auto"><button class="nm-tab" data-g="week">Weekly</button><button class="nm-tab" data-g="day">Daily</button></div></div>
      <div data-f="sum" style="font-size:12.5px;color:var(--ink3);margin-bottom:8px"></div><div class="nm-chart-wrap"><canvas></canvas></div>`;
    async function render() {
      el.querySelectorAll('[data-g]').forEach(b => b.classList.toggle('on', b.dataset.g === state.g));
      el.querySelectorAll('[data-r]').forEach(b => b.classList.toggle('on', b.dataset.r === state.range));
      try {
        const { trend: t } = await api('GET', '/api/dashboard/trend?' + qs({ granularity: state.g, from: state.from, to: state.to, school }));
        const sum = el.querySelector('[data-f="sum"]');
        if (!t.buckets.length) { sum.textContent = t.programme_start ? 'No activity in the chosen dates.' : 'No activity yet. The trend starts from the first registration.'; if (el._chart) { el._chart.destroy(); el._chart = null; } return; }
        const last = t.buckets[t.buckets.length - 1];
        sum.innerHTML = `<b>${last.cumulative_completed.toLocaleString('en-IN')}</b> of ${last.cumulative_registered.toLocaleString('en-IN')} registered students have completed (<b>${last.completion_rate_pct}%</b>). `
          + `Bars are registrations, starts and completions each ${t.granularity}; the line is the completion rate so far. ${t.granularity === 'week' ? 'Week' : 'Day'} 1 is ${fmtDate(t.programme_start)}, when the first student registered.`;
        const ctx = el.querySelector('canvas');
        if (typeof Chart === 'undefined') return;
        if (el._chart) el._chart.destroy();
        el._chart = new Chart(ctx, {
          data: {
            labels: t.buckets.map(b => b.label),
            datasets: [
              { type: 'bar', label: 'Registered', data: t.buckets.map(b => b.registered), backgroundColor: tokenAlpha('--brand2', .28), borderRadius: 3, yAxisID: 'y' },
              { type: 'bar', label: 'Started', data: t.buckets.map(b => b.started), backgroundColor: tokenAlpha('--warn', .45), borderRadius: 3, yAxisID: 'y' },
              { type: 'bar', label: 'Completed', data: t.buckets.map(b => b.completed), backgroundColor: tokenAlpha('--ok', .7), borderRadius: 3, yAxisID: 'y' },
              { type: 'line', label: 'Completion rate (running %)', data: t.buckets.map(b => b.completion_rate_pct), borderColor: tokenAlpha('--brand2', 1), backgroundColor: 'transparent', tension: .3, pointRadius: 2, yAxisID: 'y2' },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { font: { size: 10 }, boxWidth: 12 } },
              tooltip: { callbacks: { title: (items) => { const b = t.buckets[items[0].dataIndex]; return b.label + ' · ' + fmtDate(b.start) + (b.end !== b.start ? ' – ' + fmtDate(b.end) : ''); } } } },
            scales: { x: { ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true }, grid: { display: false } },
              y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 }, title: { display: true, text: 'Students', font: { size: 10 } } },
              y2: { beginAtZero: true, max: 100, position: 'right', grid: { display: false }, ticks: { font: { size: 10 }, callback: (v) => v + '%' } } },
          },
        });
      } catch (e) { el.querySelector('[data-f="sum"]').textContent = 'Could not load the trend: ' + e.message; }
    }
    el.addEventListener('click', (e) => {
      const g = e.target.closest('[data-g]'); if (g) { state.g = g.dataset.g; store.set('trend-g', state.g); render(); }
      const r = e.target.closest('[data-r]'); if (r) { state.range = r.dataset.r; store.set('trend-range', state.range); applyRange(); render(); }
    });
    el._nmRender = render;
    render();
  };

  /* ── career interest / subject stream distribution ──────────────── */
  NM.mountCareerDistribution = async function (el, { school } = {}) {
    if (!el) return;
    await NM.ready();
    const state = { by: store.get('career-by', 'career_area') };
    el.innerHTML = `<div class="nm-tabs"><button class="nm-tab" data-by="career_area">Career interest area ${NM.help('Career interest area')}</button><button class="nm-tab" data-by="stream">Subject stream ${NM.help('Subject stream')}</button></div><div data-f="body"><div class="nm-empty"><span class="nm-spin"></span></div></div>`;
    async function render() {
      el.querySelectorAll('[data-by]').forEach(b => b.classList.toggle('on', b.dataset.by === state.by));
      const body = el.querySelector('[data-f="body"]');
      try {
        const r = await api('GET', '/api/dashboard/career-distribution?' + qs({ by: state.by, school }));
        if (!r.total) { body.innerHTML = '<div class="nm-empty">No completed students yet.</div>'; return; }
        const max = Math.max(...r.distribution.map(d => d.count), 1);
        body.innerHTML = `<div style="font-size:12px;color:var(--ink4);margin-bottom:8px">${esc(r.question)} All <b>${r.total}</b> completed students are counted once. Click a bar to see the students, or open the class-wise view.</div>`
          + r.distribution.map((d, i) => `<div class="nm-dist-row${i >= UI.DIST_ROWS ? ' nm-rest' : ''}"${i >= UI.DIST_ROWS ? ' hidden' : ''} title="${esc(d.description)}" data-nm="drill" data-o="${attr({ dimension: r.by, groups: [d.key], school, title: r.label + ': ' + d.career })}">
              <div class="nm-dist-l">${esc(d.career)}</div><div class="nm-dist-bar"><i style="width:${(d.count / max * 100).toFixed(1)}%"></i></div><div class="nm-dist-n">${d.count}</div><div class="nm-dist-p">${d.pct}%</div></div>`).join('')
          + `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:11.5px;color:var(--ink4)"><span>Total: ${r.distribution.reduce((a, d) => a + d.count, 0)} of ${r.total} completed students</span><button class="nm-btn sm" data-nm="explorer" data-dim="${esc(r.by)}">By class</button></div>`;
        if (r.distribution.length > UI.DIST_ROWS) {
          const rest = body.querySelectorAll('.nm-rest');
          const b = document.createElement('button'); b.type = 'button'; b.className = 'nm-link'; b.style.cssText = 'display:block;margin:6px 0 2px;font-size:12.5px;color:var(--brand2)';
          b.textContent = `Show ${rest.length} more`;
          b.onclick = () => { rest.forEach(x => { x.hidden = false; }); b.remove(); };
          rest[0].before(b);
        }
      } catch (e) { body.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
    }
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-by]'); if (b && !e.target.closest('.nm-help')) { state.by = b.dataset.by; store.set('career-by', state.by); render(); } });
    el._nmRender = render;
    render();
  };

  /* ── results at a glance: four level breakdowns ─────────────────── */
  const TONES = ['ok', 'warn', 'bad'];
  const TONE_COLOR = { ok: 'var(--ok,#059669)', warn: 'var(--warn,#d97706)', bad: 'var(--danger,#dc2626)', mute: 'var(--ink5,#99a)' };
  NM.mountLevels = async function (el, { school, dims } = {}) {
    if (!el) return;
    await NM.ready();
    const ids = dims || ['personality_level', 'aptitude_level', 'wellbeing_level', 'fit_tier'];
    const HELP = { personality_level: 'NMAP (Personality)', aptitude_level: 'DAAB / NAAB (Aptitude)', wellbeing_level: 'SEAA / NSEAA (Wellbeing)', fit_tier: 'Integrated Fit Score' };
    el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
    try {
      const rs = await Promise.all(ids.map(d => api('GET', '/api/dashboard/breakdown?' + qs({ dimension: d, school }))));
      // The wellbeing column also shows which of the three areas need support.
      const wbNeed = ids.includes('wellbeing_level') ? await api('GET', '/api/dashboard/breakdown?' + qs({ dimension: 'wellbeing_need', school })) : null;
      const wbAreas = wbNeed ? Object.fromEntries(wbNeed.groups.map(g => [g.key, g.total])) : null;
      const n = rs[0].totals.population;
      if (!n) { el.innerHTML = '<div class="nm-note">No completed students yet. These results appear as soon as the first student finishes all four parts.</div>'; return; }
      el.innerHTML = `<div style="font-size:12px;color:var(--ink4);margin-bottom:10px">Based on <b>${n}</b> completed student${n === 1 ? '' : 's'}. Each student is counted once per column. Click a row to see the students.</div>`
        + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">'
        + rs.map(b => {
          let ti = 0;
          const rows = b.groups.map(g => {
            const tone = g.key === 'not_available' ? 'mute' : (TONES[ti++] || 'mute');
            const p = pct(g.total, b.totals.population);
            return `<div class="nm-dist-row" style="grid-template-columns:minmax(90px,1fr) 1fr 34px 34px" title="${esc(g.description)}" data-nm="drill" data-o="${attr({ dimension: b.dimension.id, groups: [g.key], school, title: b.dimension.label + ': ' + g.label })}">
              <div class="nm-dist-l">${esc(g.label)}</div><div class="nm-dist-bar"><i style="width:${p}%;background:${TONE_COLOR[tone]}"></i></div><div class="nm-dist-n">${g.total}</div><div class="nm-dist-p">${p}%</div></div>`;
          }).join('');
          return `<div style="border:1px solid var(--border);border-radius:12px;padding:12px 12px 8px;background:var(--surface)">
            <div style="font:700 13px var(--font);color:var(--ink);display:flex;align-items:center">${esc(b.dimension.label)}${NM.help(HELP[b.dimension.id] || b.dimension.label)}</div>
            <div style="font-size:11.5px;color:var(--ink4);margin:3px 0 8px;line-height:1.45">${esc(b.dimension.question)}</div>${rows}
            ${b.dimension.id === 'wellbeing_level' && wbAreas ? `<div class="nm-wbline"><span>Needs support by area</span><span class="nm-wbs">${NM.wbCells(wbAreas, { school, title: 'Wellbeing' })}</span></div>` : ''}
            <div style="text-align:right;margin-top:6px"><button class="nm-btn sm" data-nm="explorer" data-dim="${esc(b.dimension.id)}">By class</button></div></div>`;
        }).join('') + '</div>';
    } catch (e) { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  };

  /* ── students needing wellbeing support (preview + view all) ──────── */

  /* ── time spent per part ─────────────────────────────────────────── */
  NM.mountTiming = async function (el, { school } = {}) {
    if (!el) return;
    el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
    try {
      const { timing } = await api('GET', '/api/dashboard/module-timing?' + qs({ school }));
      const t = (timing || []).filter(r => r.completion_count);
      if (!t.length) { el.innerHTML = '<div class="nm-empty">No timing data yet. It appears once students finish a part.</div>'; return; }
      const max = Math.max(...t.map(r => Math.max(r.avg_minutes || 0, r.median_minutes || 0)), 1);
      el.innerHTML = '<div style="overflow-x:auto"><table class="nm-tbl"><thead><tr><th>Part</th><th>Typical time (median)</th><th>Average</th><th style="text-align:right">Students timed</th></tr></thead><tbody>'
        + t.map(r => `<tr><td style="font-weight:600;color:var(--ink)">${esc(r.module)}</td>
            <td><div style="display:flex;align-items:center;gap:8px"><div class="nm-dist-bar" style="flex:1;min-width:60px"><i style="width:${(r.median_minutes / max * 100).toFixed(1)}%"></i></div><b>${r.median_minutes}</b> min</div></td>
            <td>${r.avg_minutes} min</td><td style="text-align:right">${r.completion_count}</td></tr>`).join('')
        + '</tbody></table></div><div style="font-size:11.5px;color:var(--ink4);margin-top:8px;line-height:1.5"><b>Median</b> is the time the middle student took — half were quicker, half slower — so a few students who left a tab open do not distort it. <b>Average</b> is pulled up by those long sessions. A part where the median is far below the others may mean students are rushing; far above may mean they are stuck.</div>';
    } catch (e) { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  };

  /* ── year-on-year summary (overview) ────────────────────────────── */
  NM.mountJourneySummary = async function (el, { school } = {}) {
    if (!el) return;
    try {
      const [d, i] = await Promise.all([
        api('GET', '/api/dashboard/breakdown?' + qs({ dimension: 'journey_direction', school })),
        api('GET', '/api/dashboard/breakdown?' + qs({ dimension: 'journey_interest', school })),
      ]);
      const n = d.totals.population;
      if (!n) {
        el.innerHTML = `<div class="nm-note">No student has been assessed in two different classes yet. When a student takes the assessment again in a higher class (for example Class 9, then Class 10), both attempts are linked here automatically, by email and name or by school and Unique School ID, so you can see how their career-fit and interests changed. ${NM.help('Journey')}</div>`;
        return;
      }
      const chip = (dim, g, cls) => `<button class="nm-btn sm" data-nm="drill" data-o="${attr({ dimension: dim, groups: [g.key], school, title: g.label })}"><span class="nm-chip ${cls}">${g.total}</span> ${esc(g.label)}</button>`;
      const tone = { improved: 'ok', steady: 'mute', declined: 'bad', changed: 'warn', same: 'mute' };
      el.innerHTML = `<div style="font-size:12.5px;color:var(--ink3);margin-bottom:10px"><b>${n}</b> student${n === 1 ? ' has' : 's have'} been assessed in more than one class. ${NM.help('Journey')}</div>`
        + `<div class="nm-sec">Overall career-fit since their first assessment</div><div class="nm-bar">${d.groups.map(g => chip('journey_direction', g, tone[g.key] || 'mute')).join('')}</div>`
        + `<div class="nm-sec">Strongest career interest</div><div class="nm-bar">${i.groups.map(g => chip('journey_interest', g, tone[g.key] || 'mute')).join('')}</div>`
        + `<button class="nm-btn sm" data-nm="explorer" data-dim="journey_direction">Year-on-year by class</button>`;
    } catch (e) { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  };

  /* ── journey strip for a student's profile ──────────────────────── */
  NM.renderJourneyStrip = async function (sid, el) {
    if (!el) return;
    el.innerHTML = '';
    try {
      const { journey: j } = await api('GET', '/api/dashboard/students/' + encodeURIComponent(sid) + '/journey');
      const A = (j && j.attempts) || [];
      if (!A.length) { el.innerHTML = ''; return; }
      const tier = (t) => /Strong/.test(t || '') ? 'ok' : /Emerging/.test(t || '') ? 'warn' : 'mute';
      const steps = A.map((a, idx) => {
        const top = (a.interests && a.interests[0] && a.interests[0].label) || a.recommended_primary || '—';
        let arrow = '';
        if (idx > 0) {
          const p = A[idx - 1], d = (typeof a.fit_score === 'number' && typeof p.fit_score === 'number') ? a.fit_score - p.fit_score : null;
          const col = d == null ? 'var(--ink4)' : d > 0 ? 'var(--ok)' : d < 0 ? 'var(--danger)' : 'var(--ink4)';
          arrow = `<div class="nm-jarrow" style="color:${col}"><span style="font-size:18px">→</span>${d == null ? '' : (d > 0 ? '+' : '') + d + ' fit'}</div>`;
        }
        return arrow + `<div class="nm-jstep${idx === A.length - 1 ? ' last' : ''}"><div style="font:650 11.5px var(--font);color:var(--ink4)">Class ${esc(String(a.class || '—').replace(/^class\s*/i, ''))} · ${fmtDate(a.generated_at)}</div>
          <div style="font-size:20px;font-weight:900;color:var(--ink);margin:3px 0">${a.fit_score != null ? a.fit_score + '%' : '—'}</div><span class="nm-chip ${tier(a.fit_tier)}">${esc(a.fit_tier || '—')}</span>
          <div style="font-size:11.5px;color:var(--ink4);margin-top:6px">Top interest: <b style="color:var(--ink2)">${esc(top)}</b></div></div>`;
      }).join('');
      el.innerHTML = `<div class="nm-jbox"><div class="nm-sec" style="margin-bottom:6px">Journey across classes ${NM.help('Journey')}<span style="flex:1"></span><span style="text-transform:none;letter-spacing:0;font-weight:600">${A.length} assessment${A.length === 1 ? '' : 's'}</span></div>`
        + (j.overall ? `<div style="font-size:12.5px;color:var(--ink2);margin-bottom:8px;line-height:1.5">${esc(j.overall.narrative || '')}</div>` : (A.length === 1 ? '<div style="font-size:12px;color:var(--ink4);margin-bottom:8px">One assessment so far. When this student is assessed again in a higher class, the change appears here.</div>' : ''))
        + `<div class="nm-jstrip">${steps}</div>`
        + (A.length > 1 ? `<div style="font-size:11px;color:var(--ink5);margin-top:4px">Assessments are linked by email and name, or by school and Unique School ID. Not the same student? <button class="nm-link" style="font-size:11px;color:var(--brand2)" data-nm="unlink" data-sid="${esc(sid)}">Unlink this assessment</button></div>` : '')
        + '</div>';
    } catch (_) { el.innerHTML = ''; }
  };

  /* ── a student's progress through the 4 parts (profile drawer) ─────── */
  const PARTS = [
    ['nmap', 'Personality (NMAP)', 'How the student tends to think and behave'],
    ['daab', 'Aptitude (DAAB) — all 8 short tests', 'Which kinds of thinking come most easily'],
    ['cpi', 'Career interests (CPI)', 'Which career areas the student enjoys'],
    ['sea', 'Wellbeing (SEAA)', 'How settled the student is socially, emotionally and with schoolwork'],
  ];
  NM.partsHtml = function (stu) {
    const pd = (stu && stu.parts_done) || {};
    const n = PARTS.filter(([k]) => pd[k]).length;
    const pending = stu && stu.status !== 'completed' && n === PARTS.length;
    return `<div style="padding:4px 0 12px"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
        <div style="font:700 14px var(--font);color:var(--ink)">Assessment progress</div><div style="font:900 20px var(--font);color:var(--ink)">${n} of ${PARTS.length} parts</div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${PARTS.map(([k, label, what]) => `<div style="border:1px solid var(--border);border-radius:9px;padding:9px 11px;background:${pd[k] ? 'color-mix(in srgb,var(--ok) 7%,transparent)' : 'var(--surface2,#f6f8f9)'}">
        <div style="font-weight:700;font-size:12.5px;color:${pd[k] ? 'var(--ok)' : 'var(--ink3)'}">${pd[k] ? '✓ ' : '○ '}${esc(label)}</div><div style="font-size:11px;color:var(--ink5);margin-top:2px">${esc(what)}</div></div>`).join('')}</div>
      <div class="nm-note" style="margin-top:12px">${pending
        ? 'All four parts are answered but the report was not generated — usually a dropped connection at the very end. Ask the student to reopen the assessment on the same device; the report is created from their saved answers.'
        : stu && stu.last_activity ? `Last progress saved ${NM.sinceText(stu.last_activity)}. Progress is saved after every part, so the student continues where they stopped.` : 'The student has not answered anything yet. Check they have their access code or login, then send a reminder.'}</div></div>`;
  };

  /* ── KPI cards → students ───────────────────────────────────────── */

  /* ── refresh everything mounted ─────────────────────────────────── */
  NM.refreshAll = function (force) {
    _groupCache.clear();
    // Classes can change (imports, class moves): reload them for the filters.
    api('GET', '/api/dashboard/classes').then(r => { NM.classes = r.classes || []; }).catch(() => {});
    document.querySelectorAll('[data-nm-mounted]').forEach(el => { if (el._nmWaiting) return; if (el._nmRefresh) el._nmRefresh(force); else if (el._nmRender) el._nmRender(); });
  };
  /* Mounted panels remember how they were built, so a change of school in
     the top bar rebuilds them for that school. */
  NM.mountAll = async function (map) {
    await NM.ready();
    for (const [id, fn, opts] of map) {
      const el = typeof id === 'string' ? document.getElementById(id) : id;
      if (!el) continue;
      el.setAttribute('data-nm-mounted', '1');
      el._nmMount = { fn, opts: opts || {} };
      fn(el, Object.assign({ school: NM.scope.school }, opts || {}));
    }
  };

  /* ── School scope (top bar) ─────────────────────────────────────── */
  function remount(el) {
    const fresh = el.cloneNode(false);              // drops the old listeners
    fresh._nmMount = el._nmMount;
    el.replaceWith(fresh);
    fresh._nmMount.fn(fresh, Object.assign({}, fresh._nmMount.opts, { school: NM.scope.school }));
  }
  function remountWhenShown(el) {
    if (el._nmWaiting || typeof IntersectionObserver === 'undefined') return el._nmWaiting || remount(el);
    el._nmWaiting = true;
    el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';   // never show the old school's numbers
    const io = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting || e.target.getClientRects().length)) return;
      io.disconnect(); el._nmWaiting = false;
      if (document.body.contains(el)) remount(el);
    });
    io.observe(el);
  }
  NM.scope = { school: '' };
  NM.setScope = function (school) {
    NM.scope.school = school || '';
    store.set('scope', NM.scope.school);
    _groupCache.clear();
    document.querySelectorAll('[data-nm-mounted]').forEach(el => {
      if (!el._nmMount || el._nmMount.opts.fixedScope) return;
      // Panels on hidden pages or tabs reload when they are next shown, so a
      // school change only fetches what is on screen.
      if (!el.getClientRects().length) return remountWhenShown(el);
      remount(el);
    });
    document.querySelectorAll('.nm-multi-only').forEach(x => { x.style.display = NM.scope.school ? 'none' : ''; });
    document.querySelectorAll('.nm-scope').forEach(x => { if (x.value !== NM.scope.school) x.value = NM.scope.school; });
    if (typeof window.nmOnScope === 'function') { try { window.nmOnScope(NM.scope.school); } catch (e) { console.warn('[scope]', e); } }
    document.dispatchEvent(new CustomEvent('nm:scope', { detail: { school: NM.scope.school } }));
  };
  // A school picker for users with more than one school. Hidden otherwise.
  let _scopeHost = null;
  NM.mountScopeSwitch = async function (host) {
    if (!host) return;
    _scopeHost = host;
    await NM.ready();
    const schools = (NM.cat.schools || []).slice().sort((a, b) => a.localeCompare(b));
    const saved = store.get('scope', '');
    NM.scope.school = schools.includes(saved) ? saved : '';
    if (schools.length < 2) { NM.scope.school = ''; host.innerHTML = ''; return; }
    host.innerHTML = `<label class="nm-scope-wrap"><span>Showing</span><select class="nm-scope" aria-label="Choose a school">
      <option value="">All ${schools.length} schools</option>${schools.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label>`;
    const sel = host.querySelector('select');
    sel.value = NM.scope.school;
    sel.addEventListener('change', () => NM.setScope(sel.value));
    document.querySelectorAll('.nm-multi-only').forEach(x => { x.style.display = NM.scope.school ? 'none' : ''; });
  };

  /* After school names change (Merge schools): reload the catalogue, rebuild
     the school picker, and reload every panel for the school still chosen. */
  NM.reloadContext = async function () {
    _ctxPromise = null;
    await NM.ready();
    if (_scopeHost) await NM.mountScopeSwitch(_scopeHost);
    NM.setScope(NM.scope.school);
  };

  /* ── Pace and momentum (GET /pulse) ─────────────────────────────── */
  // Panels that load together (headline numbers, pace, parts, wellbeing)
  // share one request; it is forgotten once answered, so a refresh refetches.
  const _pulseInFlight = new Map();
  NM.pulse = function (school) {
    const url = '/api/dashboard/pulse?' + qs({ school });
    if (!_pulseInFlight.has(url)) _pulseInFlight.set(url, api('GET', url).finally(() => _pulseInFlight.delete(url)));
    return _pulseInFlight.get(url);
  };

  // "Stalled, overdue to start or wellbeing support": labels as one phrase.
  const listText = (labels) => labels.map((l, i) => i ? l.charAt(0).toLowerCase() + l.slice(1) : l)
    .reduce((out, l, i, all) => out + (i === 0 ? '' : i === all.length - 1 ? ' or ' : ', ') + l, '');

  /* ── Headline numbers ───────────────────────────────────────────── */
  NM.mountKpis = async function (el, { school } = {}) {
    if (!el) return;
    el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
    try {
      const [pulse, attn] = await Promise.all([NM.pulse(school), api('GET', '/api/dashboard/breakdown?' + qs({ dimension: 'attention', school }))]);
      const t = pulse.target, at = (k) => (pulse.funnel.find(x => x.key === k) || {}).students || 0;
      const total = t.registered, done = t.completed, started = at('started');
      const prog = started - done, none = total - started, target = t.target_pct, gap = t.completions_needed;
      const followGroups = attn.groups.filter(g => g.key !== 'on_track');
      const follow = followGroups.reduce((a, g) => a + g.total, 0);
      const p = pct(done, total), pp = pct(prog, total);
      const tile = (label, value, sub, drill, tone) => `<button type="button" class="nm-kpi ${tone || ''}" data-nm="drill" data-o="${attr(Object.assign({ school }, drill))}">
          <span class="nm-kpi-l">${esc(label)}</span><span class="nm-kpi-v">${value.toLocaleString('en-IN')}</span><span class="nm-kpi-s">${sub}</span></button>`;
      el.innerHTML = `<div class="nm-kpis">
        <div class="nm-kpi wide" role="group" aria-label="Completion">
          <span class="nm-kpi-l">Completion rate ${NM.help('Completed')}</span>
          <span class="nm-kpi-v">${p}%<small> of ${total.toLocaleString('en-IN')} registered</small></span>
          ${target != null ? `<div class="nm-stack" aria-hidden="true"><i class="c" style="width:${p}%"></i><i class="p" style="width:${pp}%"></i><b style="left:${Math.min(target, 100)}%" title="Target ${target}%"></b></div>` : ''}
          <span class="nm-kpi-s">${target == null ? 'No students yet'
            : t.per_school
              ? (gap ? `<b>${gap.toLocaleString('en-IN')}</b> more completions needed, each school measured against its own target (${target}% on average)` : 'Every school has reached its target')
              : (gap ? `<b>${gap.toLocaleString('en-IN')}</b> more completions to reach the ${target}% target` : `Target of ${target}% reached`)}</span>
        </div>
        ${tile('Completed', done, 'All 4 parts done, report ready', { dimension: 'completion', groups: ['completed'], title: 'Completed students' }, 'ok')}
        ${tile('In progress', prog, 'Started, not finished yet', { dimension: 'completion', groups: ['in_progress'], title: 'Students in progress' }, 'warn')}
        ${tile('Not started', none, 'Registered, nothing answered', { dimension: 'completion', groups: ['not_started'], title: 'Students who have not started' })}
        ${tile('Need follow-up', follow, esc(listText(followGroups.filter(g => g.total).map(g => g.label))) || 'Nobody right now', { dimension: 'attention', groups: followGroups.map(g => g.key), title: 'Students who need follow-up' }, 'bad')}
      </div>`;
    } catch (e) { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  };

  /* ── AI analysis: run in the background, read back by polling ──────── */
  // The server starts the analysis and answers at once; this keeps asking for
  // the cached result every few seconds until it is written, so a slow model
  // call never depends on one long request surviving the network.
  //   how: 'cached' (never calls the model), 'run' (new analysis only if the
  //        numbers changed) or 'force' (always a new one).
  //   onWait(seconds, previous) is called while waiting.
  NM.fetchInsights = async function (body, { how = 'cached', onWait } = {}) {
    const req = Object.assign({}, body);
    if (how === 'cached') req.mode = 'cached';
    if (how === 'force') req.force = true;
    let r = (await api('POST', '/api/dashboard/insights', req, 30000)).insights;
    const started = Date.now(), poll = Object.assign({}, body, { mode: 'cached' });
    while (r.pending && Date.now() - started < UI.INSIGHT_WAIT_MS) {
      if (onWait) onWait(Math.round((Date.now() - started) / 1000), r.empty ? null : r);
      await new Promise(res => setTimeout(res, UI.INSIGHT_POLL_MS));
      r = (await api('POST', '/api/dashboard/insights', poll, 30000)).insights;
    }
    if (r.pending) throw new Error('The analysis is taking longer than usual. It will be ready in a minute; press Analyse again then.');
    if (r.error && (how !== 'cached' || r.empty)) throw new Error(r.error);
    return r;
  };

  /* ── AI summary for one section of the page ─────────────────────── */
  // Places a "Summarise with AI" button in `head` and the summary in `panel`.
  NM.sectionSummary = function (head, panel, { metrics, label, school } = {}) {
    if (!head || !panel) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'nm-ai-btn'; btn.innerHTML = '<i aria-hidden="true"></i>Summarise with AI';
    head.appendChild(btn);
    let open = false;
    const draw = async (how) => {
      if (!NM.cat || !NM.cat.ai_enabled) { panel.innerHTML = '<div class="nm-sum"><p class="nm-sum-note">AI is not configured on this server.</p></div>'; return; }
      panel.innerHTML = '<div class="nm-sum"><div class="nm-empty"><span class="nm-spin"></span> Reading the numbers…</div></div>';
      try {
        const sc = school !== undefined ? school : NM.scope.school;
        const r = await NM.fetchInsights({ metrics, school: sc }, { how, onWait: (secs) => {
          const sp = panel.querySelector('.nm-empty'); if (sp) sp.innerHTML = `<span class="nm-spin"></span> Writing the summary… ${secs > 20 ? 'this can take up to a minute.' : ''}`; } });
        if (r.empty) return draw('run');
        const when = new Date(r.generated_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        panel.innerHTML = `<div class="nm-sum">
          <div class="nm-sum-top"><b>${esc(label || 'AI summary')}${sc ? ' for ' + esc(sc) : ''}</b><span>${r.stale ? 'Written ' + esc(when) + ', numbers have changed since' : 'Up to date, written ' + esc(when)}</span>
            <button type="button" class="nm-btn sm" data-f="sum-run">${r.stale ? 'Update' : 'Rewrite'}</button></div>
          ${r.headline ? `<p class="nm-sum-head">${esc(r.headline)}</p>` : ''}
          <ul class="nm-sum-list">${r.insights.map(i => {
            const d = i.drill ? Object.assign({ title: i.title }, i.drill, { classKey: NM.classKeyFor(i.drill.class_label), school: sc }) : null;
            return `<li class="${esc(i.severity)}"><b>${esc(i.title)}.</b> ${esc(i.what_we_see)} <span class="nm-sum-do">${esc(i.what_to_do)}</span>${d ? ` <button class="nm-link" data-nm="drill" data-o="${attr(d)}">See these students</button>` : ''}</li>`;
          }).join('')}</ul></div>`;
        panel.querySelector('[data-f="sum-run"]').onclick = () => draw(r.stale ? 'run' : 'force');
      } catch (e) { panel.innerHTML = `<div class="nm-sum"><p class="nm-sum-note">AI summary unavailable: ${esc(e.message)}</p></div>`; }
    };
    btn.addEventListener('click', () => {
      open = !open; btn.classList.toggle('on', open);
      if (!open) { panel.innerHTML = ''; return; }
      draw('cached');
    });
  };

  /* ── Schools ───────────────────────────────────────────────────── */
  // Below this many students a school is folded into one line in the alerts
  // (server setting), so a long tail of tiny school names does not bury the rest.
  Object.defineProperty(NM, 'SMALL_SCHOOL', { get: () => limit('small_school_students') });
  // A school name anywhere → that school's page, when the dashboard has one.
  NM.openSchool = function (name) {
    if (typeof window.nmOpenSchool === 'function') return window.nmOpenSchool(name);
    NM.openDrill({ school: name, title: name });
  };

  /* ── Schools & classes ──────────────────────────────────────────── */
  NM.mountSchoolBreakdown = async function (el, opts = {}) {
    if (!el) return;
    await NM.ready();
    el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
    let list;
    let G;
    try { const r = await api('GET', '/api/dashboard/school-summary'); list = r.schools; G = r.groups; }
    catch (e) { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; return; }
    // The school chosen in the top bar narrows the page to that school.
    if (NM.scope.school) list = list.filter(x => x.school === NM.scope.school);
    if (!list.length) { el.innerHTML = '<div class="nm-empty">No schools are assigned to your account yet.</div>'; return; }
    let cur = list.find(x => x.school === (opts.school || NM.scope.school)) || list[0];
    const tone = (x) => x.completion_pct >= x.target_pct ? 'ok' : x.completion_pct >= x.target_pct * .75 ? 'warn' : 'bad';
    const one = list.length === 1;
    el.innerHTML = `<div class="sb-wrap${one ? ' one' : ''}">${one ? '' : `<aside class="sb-list" aria-label="Schools">
        <input class="nm-in" type="search" data-f="sq" placeholder="Find a school" aria-label="Find a school">
        <div data-f="sl"></div></aside>`}<div class="sb-detail" data-f="sd"></div></div>`;
    const drawList = () => {
      const host = el.querySelector('[data-f="sl"]'); if (!host) return;
      const q = (el.querySelector('[data-f="sq"]').value || '').toLowerCase();
      host.innerHTML = list.filter(x => !q || x.school.toLowerCase().includes(q)).map(x => `<button type="button" class="sb-item${x === cur ? ' on' : ''}" data-school="${esc(x.school)}">
          <span class="sb-name">${esc(x.school)}</span>
          <span class="sb-meta"><span class="nm-bar-mini"><i class="${tone(x)}" style="width:${x.completion_pct}%"></i><b style="left:${Math.min(x.target_pct, 100)}%"></b></span><span>${x.completion_pct}%</span></span>
          <span class="sb-sub">${x.total.toLocaleString('en-IN')} student${x.total === 1 ? '' : 's'}, target ${x.target_pct}%</span></button>`).join('') || '<div class="nm-empty">No match.</div>';
    };
    const cell = (n, of, drill, t) => n ? `<button type="button" class="sb-cell ${t || ''}" data-nm="drill" data-o="${attr(drill)}">${n.toLocaleString('en-IN')}${of != null ? ` <small>${pct(n, of)}%</small>` : ''}</button>` : '<span class="sb-zero">0</span>';
    const drawDetail = () => {
      const x = cur, S = x.school, host = el.querySelector('[data-f="sd"]');
      const d = (extra, title) => Object.assign({ school: S, title: S + ' – ' + title }, extra);
      host.innerHTML = `<div class="sb-head"><div><h3>${esc(S)}</h3>
          <p>${x.total.toLocaleString('en-IN')} registered students. Completion target ${x.target_pct}%, follow-up after ${x.follow_up_after_days} day${x.follow_up_after_days === 1 ? '' : 's'}.</p></div>
          <div class="sb-actions" data-f="sact"><button class="nm-btn" data-nm="drill" data-o="${attr({ school: S, title: S })}">All students</button>
          <button class="nm-btn" data-nm="explorer" data-dim="completion" data-school="${esc(S)}">Class-wise results</button></div></div>
        <div class="sb-progress"><div class="nm-stack lg"><i class="c" style="width:${x.completion_pct}%"></i><i class="p" style="width:${pct(x.in_progress, x.total)}%"></i><b style="left:${Math.min(x.target_pct, 100)}%" title="Target ${x.target_pct}%"></b></div>
          <div class="sb-legend"><span><i class="c"></i>Completed ${x.completed.toLocaleString('en-IN')} (${x.completion_pct}%)</span><span><i class="p"></i>In progress ${x.in_progress.toLocaleString('en-IN')}</span><span><i class="n"></i>Not started ${x.not_started.toLocaleString('en-IN')}</span><span><i class="t"></i>Target ${x.target_pct}%</span></div></div>
        <div data-f="ssum"></div>
        <h4 class="sb-h4">By class</h4>
        <div class="sb-tablewrap"><table class="nm-tbl sb-tbl"><thead><tr><th>Class</th><th class="r">Students</th><th class="r">Completed</th><th class="r">In progress</th><th class="r">Not started</th><th class="r">Follow-up</th>${NM.wbAreas().map(a => `<th class="r" title="Completed students whose ${esc(a.label.toLowerCase())} adjustment needs support">${esc(a.label)}</th>`).join('')}<th>Top career interest</th></tr></thead><tbody>
        ${x.classes.map(c => `<tr><th scope="row"><button class="nm-link" data-nm="drill" data-o="${attr(d({ classKey: c.key }, c.label))}">${esc(c.label)}</button></th>
          <td class="r">${c.total.toLocaleString('en-IN')}</td>
          <td class="r">${cell(c.completed, c.total, d({ classKey: c.key, dimension: 'completion', groups: ['completed'] }, c.label + ' completed'), 'ok')}</td>
          <td class="r">${cell(c.in_progress, c.total, d({ classKey: c.key, dimension: 'completion', groups: ['in_progress'] }, c.label + ' in progress'))}</td>
          <td class="r">${cell(c.not_started, c.total, d({ classKey: c.key, dimension: 'completion', groups: ['not_started'] }, c.label + ' not started'))}</td>
          <td class="r">${cell(c.follow_up, null, d({ classKey: c.key, dimension: 'attention', groups: G.follow_up }, c.label + ' need follow-up'), 'warn')}</td>
          ${NM.wbAreas().map(a => `<td class="r">${cell((c.support_areas || {})[a.key] || 0, null, d({ classKey: c.key, dimension: 'wellbeing_need', groups: [a.key] }, c.label + ' ' + a.label.toLowerCase() + ' support'), 'bad')}</td>`).join('')}
          <td class="sb-top">${c.top_career ? `<button class="nm-link" data-nm="drill" data-o="${attr(d({ classKey: c.key, dimension: 'career_area', groups: [c.top_career.area] }, c.label + ' ' + c.top_career.area))}">${esc(c.top_career.area)}</button> <span class="sb-zero">${c.top_career.students}</span>` : '<span class="sb-zero">No results yet</span>'}</td></tr>`).join('')}
        </tbody><tfoot><tr><th scope="row">All classes</th><td class="r">${x.total.toLocaleString('en-IN')}</td>
          <td class="r">${cell(x.completed, x.total, d({ dimension: 'completion', groups: ['completed'] }, 'completed'), 'ok')}</td>
          <td class="r">${cell(x.in_progress, x.total, d({ dimension: 'completion', groups: ['in_progress'] }, 'in progress'))}</td>
          <td class="r">${cell(x.not_started, x.total, d({ dimension: 'completion', groups: ['not_started'] }, 'not started'))}</td>
          <td class="r">${cell(x.follow_up, null, d({ dimension: 'attention', groups: G.follow_up }, 'need follow-up'), 'warn')}</td>
          ${NM.wbAreas().map(a => `<td class="r">${cell((x.support_areas || {})[a.key] || 0, null, d({ dimension: 'wellbeing_need', groups: [a.key] }, a.label.toLowerCase() + ' support'), 'bad')}</td>`).join('')}
          <td class="sb-top">${x.top_career ? esc(x.top_career.area) : ''}</td></tr></tfoot></table></div>
        <p class="sb-foot">Each number opens the students behind it, where you can send a reminder or download their reports. Percentages are of the students in that class. Follow-up counts students who need a nudge. Social, Emotional and Academic count completed students whose adjustment in that area needs support; a student can be in more than one.</p>`;
      NM.sectionSummary(host.querySelector('[data-f="sact"]'), host.querySelector('[data-f="ssum"]'),
        { metrics: ['completion', 'follow_up', 'career_area', 'wellbeing_level', 'fit_tier'], label: 'AI summary', school: S });
    };
    el.addEventListener('click', (e) => { const b = e.target.closest('.sb-item'); if (!b) return; cur = list.find(x => x.school === b.dataset.school) || cur; drawList(); drawDetail(); });
    const sq = el.querySelector('[data-f="sq"]'); if (sq) sq.addEventListener('input', drawList);
    drawList(); drawDetail();
  };



  const closePop = () => { if (_pop) { _pop.remove(); _pop = null; } };
  window.addEventListener('scroll', closePop, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

  /* ── one delegated click handler for everything above ───────────── */
  document.addEventListener('click', async (e) => {
    if (_pop && !e.target.closest('.nm-pop') && !e.target.closest('[data-nm="help"]')) { _pop.remove(); _pop = null; }
    const t = e.target.closest('[data-nm]');
    if (!t) return;
    const kind = t.getAttribute('data-nm');
    if (kind === 'help') { e.preventDefault(); e.stopPropagation(); await NM.ready().catch(() => {}); showHelp(t); return; }
    if (kind === 'drill') {
      e.preventDefault();
      // Lists opened from page markup follow the school chosen in the top bar.
      try { const o = JSON.parse(t.getAttribute('data-o')); if (o.school === undefined && NM.scope.school) o.school = NM.scope.school; NM.openDrill(o); } catch (_) {}
      return;
    }
    if (kind === 'student') { e.preventDefault(); NM.openStudent(t.getAttribute('data-sid')); return; }
    if (kind === 'explorer') { e.preventDefault(); NM.openExplorer(t.getAttribute('data-dim'), t.hasAttribute('data-school') ? t.getAttribute('data-school') : undefined); return; }
    if (kind === 'settings') { e.preventDefault(); NM.openSettings().catch(err => toast(err.message, 'error')); return; }
    if (kind === 'glossary') { e.preventDefault(); NM.openGlossary(); return; }
    if (kind === 'school') { e.preventDefault(); NM.openSchool(t.getAttribute('data-school')); return; }
    if (kind === 'unlink') {
      e.preventDefault();
      if (!confirm('Unlink this assessment from the journey?\n\nUse this only if two different students with the same name were linked by mistake. The assessment itself is kept.')) return;
      try {
        const r = await api('POST', '/api/dashboard/students/' + encodeURIComponent(t.dataset.sid) + '/journey/unlink', {});
        toast(r.unlinked ? 'Unlinked. This assessment now stands on its own.' : 'Nothing to unlink — this assessment is not linked to another.', r.unlinked ? 'success' : 'error'); const box = t.closest('.nm-jbox'); if (box && box.parentElement) NM.renderJourneyStrip(t.dataset.sid, box.parentElement); }
      catch (err) { toast(err.message, 'error'); }
    }
  });

  /* ════════════════════════════════════════════════════════════════
     DASHBOARD ASSISTANT (chatbot)
     ════════════════════════════════════════════════════════════════ */
  const SUGGEST = {
    admin: ['What is going on across all schools this week?', 'Which schools are furthest behind their target, and which classes?', 'Add a new student to Delhi Public School, Class 9', 'Upload a roster of students', 'Schedule a weekly reminder to students who have not finished', 'Add a counsellor account'],
    management: ['How are my schools doing, class by class?', 'Add a new student in Class 10', 'Upload a roster of students', 'Set our completion target to 85%', 'Remind Class 10 students who have not started', 'Has anyone improved since their last assessment?'],
    counsellor: ['Who should I follow up with first today?', 'Add a follow-up task to call a parent tomorrow', 'List students in Class 12 who need wellbeing support', 'What do my students ask Aria about?', 'What does "Emerging Fit" mean?'],
  };
  // Small, safe markdown: text is escaped first, then **bold**, `code`,
  // ### headings, - bullets, 1. lists and | tables | (first row = header).
  // Names of students the reply mentions become links to their profiles.
  function md(s, students) {
    // Student names become profile links. They are swapped for placeholders in
    // the raw text first (longest name first, whole words only) and turned into
    // buttons after everything else is built, so a name can never land inside
    // markup or another name's link.
    const links = [];
    let src = String(s == null ? '' : s).replace(/[\u0001\u0002]/g, '');
    for (const st of [...(students || [])].filter(x => x && x.name).sort((a, b) => b.name.length - a.name.length)) {
      const re = new RegExp('(?<![\\p{L}\\p{N}])' + st.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'gu');
      src = src.replace(re, () => '\u0001' + (links.push(st) - 1) + '\u0002');
    }
    const lines = esc(src).split('\n');
    let html = '', list = null, table = null;
    const inline = (x) => x.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const close = () => { if (list) { html += `</${list}>`; list = null; } if (table) { html += '</tbody></table>'; table = null; } };
    let first = true;
    for (const raw of lines) {
      const l = raw.trim();
      if (/^\|.*\|$/.test(l)) {
        if (/^\|[\s:|-]+\|$/.test(l)) continue;
        const cells = l.slice(1, -1).split('|').map(c => inline(c.trim()));
        if (!table) { close(); table = 1; html += '<table><thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'; continue; }
        html += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>'; continue;
      }
      if (table) { html += '</tbody></table>'; table = null; }
      const ul = /^[-*•]\s+/.test(l), ol = /^\d+[.)]\s+/.test(l);
      if (ul || ol) {
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { close(); list = want; html += `<${want}>`; }
        html += '<li>' + inline(l.replace(/^([-*•]|\d+[.)])\s+/, '')) + '</li>'; continue;
      }
      if (list) { html += `</${list}>`; list = null; }
      if (/^#{1,4}\s/.test(l)) { html += '<h4>' + inline(l.replace(/^#+\s/, '')) + '</h4>'; first = false; continue; }
      // A short opening sentence is the answer's headline; a long one is just a paragraph.
      if (l) { html += `<p${first && l.length <= 140 ? ' class="lead"' : ''}>` + inline(l) + '</p>'; first = false; }
    }
    close();
    return html.replace(/\u0001(\d+)\u0002/g, (_, i) => { const st = links[+i]; return `<button class="nm-link" data-nm="student" data-sid="${esc(st.session_id)}">${esc(st.name)}</button>`; });
  }
  const chat = { el: null, conv: null, busy: false };
  /* ── Action cards ────────────────────────────────────────────────
     The assistant prepares an action; the card shows it, lets the user edit
     every field, and runs it only when they press the button. Each type calls
     the same API route as the dashboard's own buttons, so the server checks
     permissions again. Nothing here deletes or resets. */
  const ACTION_BTN = { open_list: 'Open this list', open_student: 'Open profile', open_page: 'Go there', send_reminder: 'Review and send…', download_reports: 'Confirm and download',
    add_student: 'Add student', bulk_import: 'Import students', edit_student: 'Save changes', new_access_code: 'Issue new code', add_note: 'Add note',
    add_followup: 'Add task', set_target: 'Save settings', create_schedule: 'Create schedule', add_school: 'Add school', add_user: 'Create account' };
  function fieldHtml(f) {
    const id = 'nmf-' + Math.random().toString(36).slice(2, 9);
    const lab = `<label for="${id}">${esc(f.label)}${f.required ? ' <i>*</i>' : ''}</label>`;
    const val = f.value == null ? '' : f.value;
    const opt = (o) => { const v = String(o), t = f.labels && f.labels[o] != null ? f.labels[o] : (o === '' ? '—' : o); return `<option value="${esc(v)}"${String(val) === v ? ' selected' : ''}>${esc(t)}</option>`; };
    let input;
    if (f.type === 'select' && f.options) input = `<select id="${id}" data-k="${esc(f.k)}">${f.options.map(opt).join('')}</select>`;
    else if (f.type === 'select' && f.free) input = `<input id="${id}" data-k="${esc(f.k)}" value="${esc(val)}" list="${id}-l"><datalist id="${id}-l">${(NM.cat.schools || []).map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
    else if (f.type === 'multiselect') input = `<div class="nm-ms" data-k="${esc(f.k)}" data-multi="1">${(f.options || []).map(o => `<label><input type="checkbox" value="${esc(o)}"${(val || []).includes(o) ? ' checked' : ''}> ${esc(o)}</label>`).join('') || '<span class="nm-foot">No schools yet.</span>'}</div>`;
    else if (f.type === 'textarea') input = `<textarea id="${id}" data-k="${esc(f.k)}" rows="4">${esc(val)}</textarea>`;
    else if (f.type === 'file') input = `<input id="${id}" data-k="${esc(f.k)}" type="file" accept=".csv,text/csv"><div class="nm-filesum" data-f="filesum"></div>`;
    else input = `<input id="${id}" data-k="${esc(f.k)}" type="${esc(f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'password' ? 'password' : 'text')}" value="${esc(val)}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''} autocomplete="off">`;
    return `<div class="nm-fld">${lab}${input}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</div>`;
  }
  function actionHtml(a) {
    let body = `<div class="nm-act-t">${esc(a.title)}</div>`;
    if (a.student_name) body += `<div class="nm-act-s"><b>${esc(a.student_name)}</b>${a.student_meta ? ' · ' + esc(a.student_meta) : ''}</div>`;
    if (a.type === 'send_reminder') body += `<div class="nm-act-s">${a.count} student${a.count === 1 ? '' : 's'} · ${a.with_email} with an email (only they will receive it)</div><div class="nm-fld"><label>Subject</label><input data-f="subj" value="${esc(a.subject || '')}"></div><div class="nm-fld"><label>Message</label><textarea data-f="msg" rows="4">${esc(a.message || '')}</textarea></div>`;
    if (a.type === 'download_reports') body += `<div class="nm-act-s">${a.count} student${a.count === 1 ? '' : 's'} · ${a.with_report} have a report to download</div>`;
    if (a.type === 'open_list') body += `<div class="nm-act-s">${a.count} student${a.count === 1 ? '' : 's'}</div>`;
    if (a.type === 'open_page') body += `<div class="nm-act-s">${esc(a.page_label)}</div>`;
    if (a.type === 'new_access_code') body += `<div class="nm-act-s">The student’s current code stops working; give them the new one.</div>`;
    if (a.form) body += `<div class="nm-form">${a.form.map(fieldHtml).join('')}</div>`;
    return `<div class="nm-act" data-act="${attr(a)}">${body}<div class="nm-act-f"><button class="nm-btn sm pri" data-f="go">${ACTION_BTN[a.type] || 'Confirm'}</button><span class="nm-act-r" data-f="res" role="status"></span></div></div>`;
  }
  function addMsg(role, text, actions, students) {
    const b = chat.el.querySelector('.nm-chat-b');
    const d = document.createElement('div'); d.className = 'nm-msg ' + (role === 'user' ? 'u' : 'a');
    // One link per distinct name (two students can share a name; the first wins).
    const seen = new Set(); const st = (students || []).filter(x => !seen.has(x.name) && seen.add(x.name));
    d.innerHTML = role === 'user' ? esc(text) : md(text, st) + (actions || []).map(actionHtml).join('');
    b.appendChild(d); b.scrollTop = b.scrollHeight;
    d.querySelectorAll('.nm-act input[type="file"]').forEach(inp => inp.addEventListener('change', () => previewRoster(inp)));
    return d;
  }
  // Reads the card's fields back into an object.
  const formValues = (box) => {
    const v = {};
    box.querySelectorAll('[data-k]').forEach(el => {
      if (el.dataset.multi) v[el.dataset.k] = [...el.querySelectorAll('input:checked')].map(x => x.value);
      else if (el.type === 'file') v[el.dataset.k] = el.files && el.files[0];
      else v[el.dataset.k] = el.value.trim();
    });
    return v;
  };
  /* CSV roster: quoted fields, commas and new lines inside quotes, a BOM. The
     header names are normalised ("First Name" → first_name) the same way the
     server's import reads them. */
  NM.parseCsv = parseCsv;
  function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    text = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
      if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some(x => x.trim())) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()]).filter(([h]) => h)));
  }
  async function previewRoster(inp) {
    const out = inp.parentElement.querySelector('[data-f="filesum"]');
    const f = inp.files && inp.files[0];
    if (!f) { out.textContent = ''; return; }
    const max = limit('import_bytes'), maxRows = limit('import_rows');
    if (f.size > max) { out.innerHTML = `<span class="bad">The file is larger than ${Math.round(max / 1048576)} MB. Split it into smaller files.</span>`; return; }
    const rows = parseCsv(await f.text());
    if (rows.length > maxRows) { out.innerHTML = `<span class="bad">The file has ${rows.length} rows; a roster can have at most ${maxRows}. Split it into smaller files.</span>`; return; }
    const named = rows.filter(r => r.first_name || r.full_name || r.name);
    const cols = rows.length ? Object.keys(rows[0]) : [];
    out.innerHTML = rows.length ? `<b>${rows.length}</b> row${rows.length === 1 ? '' : 's'} read${named.length < rows.length ? `, <span class="bad">${rows.length - named.length} without a name will be skipped</span>` : ''}. Columns: ${esc(cols.join(', '))}.` : '<span class="bad">No rows found. The first line must be the column names.</span>';
  }
  async function runAction(box) {
    const a = JSON.parse(box.getAttribute('data-act'));
    const btn = box.querySelector('[data-f="go"]'), res = box.querySelector('[data-f="res"]');
    const done = (msg, recordText) => {
      res.className = 'nm-act-r ok'; res.textContent = msg; btn.disabled = true; btn.textContent = 'Done';
      box.querySelectorAll('input,select,textarea').forEach(x => { x.disabled = true; });
      if (recordText && chat.conv) api('POST', '/api/dashboard/assistant/note', { conversation_id: chat.conv, text: recordText }).catch(() => {});
    };
    const fail = (e) => { res.className = 'nm-act-r bad'; res.textContent = e.message || String(e); btn.disabled = false; };
    const v = formValues(box);
    const missing = (a.form || []).filter(f => f.required && (f.type === 'file' ? !v[f.k] : !String(v[f.k] || '').trim())).map(f => f.label);
    if (missing.length) return fail(new Error('Fill in: ' + missing.join(', ')));
    const f = a.filter || {};
    const drill = { dimension: f.dimension, groups: f.groups || [], classKey: f.class_key || '', status: f.status || '', school: f.school || '', title: a.title };
    btn.disabled = true; res.className = 'nm-act-r'; res.textContent = 'Working…';
    try {
      switch (a.type) {
        case 'open_student': res.textContent = ''; btn.disabled = false; return NM.openStudent(a.session_id);
        case 'open_list': res.textContent = ''; btn.disabled = false; return NM.openDrill(drill);
        case 'open_page':
          res.textContent = ''; btn.disabled = false;
          if (typeof window.show === 'function' && document.getElementById('section-' + a.page)) return window.show(a.page);
          throw new Error('That page is not on this dashboard.');
        case 'send_reminder': case 'download_reports': {
          const ids = (await api('GET', '/api/dashboard/drill?' + qs({ dimension: drill.dimension, groups: drill.groups, class: drill.classKey, status: drill.status, school: drill.school, ids_only: 1 }))).ids;
          res.textContent = ''; btn.disabled = false;
          if (!ids.length) throw new Error('That list is now empty.');
          if (a.type === 'download_reports') return NM.downloadReports(ids, a.title);
          // The compose window is the confirmation step: nothing is sent until "Send emails" is pressed there.
          return NM.composeReminder({ ids, label: a.title, subject: box.querySelector('[data-f="subj"]').value, message: box.querySelector('[data-f="msg"]').value,
            onSent: () => done('Sent.', `Sent a reminder to "${a.title}".`) });
        }
        case 'add_student': {
          const r = await api('POST', '/api/dashboard/students', { first_name: v.first_name, last_name: v.last_name, school: v.school, class: v.class, section: v.section, gender: v.gender, email: v.email, student_uid: v.student_uid });
          const nm = (v.first_name + ' ' + (v.last_name || '')).trim();
          done('Added.', `Added ${nm} to ${v.school}, Class ${v.class}${v.section ? '-' + v.section : ''}.`);
          res.insertAdjacentHTML('beforeend', ` <button class="nm-link" data-nm="student" data-sid="${esc(r.session_id)}">Open profile</button>`);
          if (typeof window.loadStudents === 'function') window.loadStudents();
          return;
        }
        case 'bulk_import': {
          let rows = parseCsv(await v.file.text());
          if (!rows.length) throw new Error('No rows found in the file.');
          if (v.school) rows = rows.map(r => (r.school ? r : Object.assign({}, r, { school: v.school })));
          const r = await api('POST', '/api/dashboard/students/import', { rows }, 120000);
          const errs = (r.errors || []).slice(0, 5).map(e => `Row ${e.row}: ${e.reason}`).join(' · ');
          done(`Imported ${r.imported}, updated ${r.updated}, skipped ${r.skipped}${r.scopeRejected ? `, ${r.scopeRejected} outside your schools` : ''}.${errs ? ' ' + errs : ''}`,
            `Imported a roster: ${r.imported} new, ${r.updated} updated, ${r.skipped} skipped.`);
          if (typeof window.loadStudents === 'function') window.loadStudents();
          return;
        }
        case 'edit_student': {
          await api('PUT', '/api/dashboard/students/' + encodeURIComponent(a.session_id), { school: v.school, class: v.class, section: v.section, student_uid: v.student_uid });
          done('Saved.', `Updated ${a.student_name}: ${v.school}, Class ${v.class}${v.section ? '-' + v.section : ''}.`);
          return;
        }
        case 'new_access_code': {
          const r = await api('POST', '/api/dashboard/students/' + encodeURIComponent(a.session_id) + '/access-code', {});
          done('New code: ', `Issued a new access code to ${a.student_name}.`);
          res.insertAdjacentHTML('beforeend', `<b class="nm-code">${esc(r.access_code)}</b>`);
          return;
        }
        case 'add_note':
          await api('POST', '/api/dashboard/students/' + encodeURIComponent(a.session_id) + '/notes', { note: v.note });
          return done('Note added.', `Added a note to ${a.student_name}'s profile.`);
        case 'add_followup':
          await api('POST', '/api/dashboard/followups', { session_id: a.session_id || null, student: v.student, type: v.type, notes: v.notes, due: v.due });
          if (typeof window.loadFollowUps === 'function') window.loadFollowUps();
          return done('Task added.', `Added a follow-up task${a.student_name ? ' for ' + a.student_name : ''}${v.due ? ', due ' + v.due : ''}.`);
        case 'set_target':
          await api('PUT', '/api/dashboard/settings', { school: v.school, values: { completion_target_pct: +v.completion_target_pct, follow_up_after_days: +v.follow_up_after_days } });
          NM.refreshAll();
          return done('Saved.', `Set ${v.school || 'the network default'} to a ${v.completion_target_pct}% target, follow up after ${v.follow_up_after_days} days.`);
        case 'create_schedule':
          await api('POST', '/api/dashboard/schedules', { target_group: v.target_group, school: v.school, frequency_days: +v.frequency_days, send_hour: +v.send_hour, subject: v.subject, message: v.message });
          return done('Schedule created.', `Created a scheduled reminder (${v.target_group}, every ${v.frequency_days} day(s)${v.school ? ', ' + v.school : ''}).`);
        case 'add_school':
          await api('POST', '/api/dashboard/schools-registry', { name: v.name, city: v.city, state: v.state });
          return done('School added.', `Added ${v.name} to the school registry.`);
        case 'add_user':
          if (String(v.password || '').length < 8) throw new Error('The password needs at least 8 characters.');
          await api('POST', '/api/dashboard/users', { name: v.name, email: v.email, role: v.role, schools: v.schools || [], password: v.password });
          return done('Account created.', `Created a ${v.role} account${(v.schools || []).length ? ' for ' + v.schools.join(', ') : ''}.`);
        default: throw new Error('This action is not available here.');
      }
    } catch (e) { fail(e); }
  }
  async function send(text) {
    if (chat.busy || !text.trim()) return;
    chat.busy = true;
    addMsg('user', text);
    const wait = addMsg('assistant', '…'); wait.innerHTML = '<span class="nm-spin"></span> Looking at your data…';
    try {
      const page = (document.getElementById('topbar-title') || {}).textContent || '';
      const r = await api('POST', '/api/dashboard/assistant', { message: text, conversation_id: chat.conv, page }, 120000);
      chat.conv = r.conversation_id; store.set('chat-conv', chat.conv);
      wait.remove(); addMsg('assistant', r.reply, r.actions, r.students);
    } catch (e) { wait.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>'; }
    chat.busy = false;
  }
  async function showHistoryList() {
    const b = chat.el.querySelector('.nm-chat-b');
    b.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>';
    try {
      const { conversations } = await api('GET', '/api/dashboard/assistant/conversations');
      b.innerHTML = '<div class="nm-sec">Earlier conversations</div>' + (conversations.length ? conversations.map(c => `<div class="nm-msg a" style="cursor:pointer;max-width:100%" data-conv="${esc(c.conversation_id)}"><b>${esc((c.title || 'Conversation').slice(0, 80))}</b><div style="font-size:11px;color:var(--ink5)">${fmtDate(c.updated_at)} · ${c.messages} messages <button class="nm-link" style="font-size:11px;color:var(--danger);float:right" data-del="${esc(c.conversation_id)}">Delete</button></div></div>`).join('') : '<div class="nm-empty">No earlier conversations.</div>');
    } catch (e) { b.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  }
  async function openConversation(id) {
    const b = chat.el.querySelector('.nm-chat-b'); b.innerHTML = '';
    chat.conv = id; store.set('chat-conv', id);
    try {
      const { messages } = await api('GET', '/api/dashboard/assistant/history?' + qs({ conversation_id: id }));
      messages.forEach(m => addMsg(m.role, m.content, m.meta && m.meta.actions, m.meta && m.meta.students));
    } catch (e) { b.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; }
  }
  function welcome() {
    const b = chat.el.querySelector('.nm-chat-b');
    const role = (NM.me && NM.me.role) || 'admin';
    b.innerHTML = '';
    const d = addMsg('assistant', `Hi ${((NM.me && NM.me.name) || '').split(' ')[0]}! I can tell you what is going on across your schools and classes, explain any term, and find the students behind a number. I can also prepare things for you to check and confirm: add a student or upload a roster, change a class or section, issue an access code, add a note or follow-up task, set targets, schedule reminders, send reminders and download reports.\n\nAsk me anything, for example:`);
    d.insertAdjacentHTML('beforeend', '<div class="nm-sugg">' + (SUGGEST[role] || SUGGEST.admin).map(s => `<button data-sugg="${esc(s)}">${esc(s)}</button>`).join('') + '</div>');
  }
  NM.mountAssistant = async function () {
    if (document.querySelector('.nm-fab')) return;
    await NM.ready();
    const fab = document.createElement('button'); fab.className = 'nm-fab'; fab.type = 'button';
    fab.innerHTML = '<i aria-hidden="true"></i>Ask NuMind'; fab.setAttribute('aria-label', 'Open the NuMind assistant'); document.body.appendChild(fab);
    fab.onclick = () => {
      fab.style.display = 'none';
      if (!chat.el) {
        chat.el = document.createElement('div'); chat.el.className = 'nm-chat';
        chat.el.innerHTML = `<div class="nm-chat-h"><div class="nm-chat-t"><b>NuMind assistant</b><small>${NM.cat.ai_enabled ? 'Answers from your schools only. Student names never leave NuMind.' : 'AI is not configured on this server'}</small></div>
          <div class="nm-chat-win"><button data-f="wide" class="nm-chat-x" title="Expand" aria-label="Expand the assistant" aria-pressed="false">Expand</button><button data-f="min" class="nm-chat-x" title="Close" aria-label="Close the assistant">✕</button></div>
          <div class="nm-chat-tools"><button data-f="new" title="Start a new conversation">New conversation</button><button data-f="hist" title="Earlier conversations">History</button><button data-f="gl" title="What terms mean">Glossary</button></div></div>
          <div class="nm-chat-b"></div><div class="nm-chat-f"><textarea placeholder="Ask about your students, a class, a term…" aria-label="Message"></textarea><button class="nm-btn pri" data-f="send">Send</button></div>`;
        document.body.appendChild(chat.el);
        const setWide = (on) => {
          chat.el.classList.toggle('wide', on); store.set('chat-wide', on);
          const w = chat.el.querySelector('[data-f="wide"]'); w.textContent = on ? 'Shrink' : 'Expand'; w.setAttribute('aria-pressed', String(on)); w.title = on ? 'Shrink' : 'Expand';
        };
        setWide(!!store.get('chat-wide', false));
        const ta = chat.el.querySelector('textarea');
        const go = () => { const v = ta.value; ta.value = ''; send(v); };
        chat.el.querySelector('[data-f="send"]').onclick = go;
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
        chat.el.addEventListener('click', async (e) => {
          const s = e.target.closest('[data-sugg]'); if (s) return send(s.dataset.sugg);
          const del = e.target.closest('[data-del]');
          if (del) { e.stopPropagation(); await api('DELETE', '/api/dashboard/assistant/conversations/' + del.dataset.del).catch(err => toast(err.message, 'error')); if (chat.conv === del.dataset.del) chat.conv = null; return showHistoryList(); }
          const c = e.target.closest('[data-conv]'); if (c) return openConversation(c.dataset.conv);
          const go2 = e.target.closest('[data-f="go"]'); if (go2) return runAction(go2.closest('[data-act]')).catch(err => toast(err.message, 'error'));
          const f = e.target.closest('.nm-chat-h [data-f]'); if (!f) return;
          if (f.dataset.f === 'min') { chat.el.style.display = 'none'; fab.style.display = ''; }
          if (f.dataset.f === 'wide') setWide(!chat.el.classList.contains('wide'));
          if (f.dataset.f === 'new') { chat.conv = null; store.set('chat-conv', null); welcome(); }
          if (f.dataset.f === 'hist') showHistoryList();
          if (f.dataset.f === 'gl') NM.openGlossary();
        });
        const prev = store.get('chat-conv', null);
        if (prev) openConversation(prev); else welcome();
      }
      chat.el.style.display = '';
      setTimeout(() => chat.el.querySelector('textarea').focus(), 50);
    };
  };
})();
