/* ════════════════════════════════════════════════════════════════════
   pdf/download.js
   Master PDF report generator — 10-page A4 with template-faithful layout, AI prose integration, dynamic footers.
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { NMAP_DIMS } from '../engine/nmap.js';

async function downloadPDF(override) {
  /* ════════════════════════════════════════════════════════════════════
     NuMind MAPS — Template-faithful 10-page A4 report
     Mirrors numind_maps_jspdf_template-1.jsx, wired to live S + AI data
  ════════════════════════════════════════════════════════════════════ */
  const btn = document.getElementById('pdf-download-btn');
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }

  try {
    // ── Ensure jsPDF is loaded ─────────────────────────────────────
    if (!window.jspdf) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load jsPDF'));
        document.head.appendChild(s);
      });
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // ── Logo from file. Drop your real logo at  /assets/numind-logo.png
    // (web root -> assets folder) and every render picks it up — no code
    // changes, no embedded base64. If the file is missing or slow (>1.5s),
    // the vector wordmark below renders instead, so the PDF never blocks
    // or ships without branding.
    let _logo = null; // { dataUrl, w, h } in px
    try {
      const ctl = new AbortController();
      const tm  = setTimeout(() => ctl.abort(), 1500);
      const rsp = await fetch('/assets/numind-logo.png', { signal: ctl.signal });
      clearTimeout(tm);
      if (rsp.ok) {
        const blob = await rsp.blob();
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result); fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
        const dim = await new Promise((res) => {
          const im = new Image();
          im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
          im.onerror = () => res(null);
          im.src = dataUrl;
        });
        if (dim && dim.w && dim.h) _logo = { dataUrl, w: dim.w, h: dim.h };
      }
    } catch (_) { /* fall through to wordmark */ }

    // Right-aligned logo: rightX = right edge, hMM = target height in mm.
    const drawLogo = (rightX, midY, hMM, onDark) => {
      if (_logo) {
        const wMM = Math.min(46, hMM * (_logo.w / _logo.h));
        doc.addImage(_logo.dataUrl, 'PNG', rightX - wMM, midY - hMM / 2, wMM, hMM);
      } else {
        wordmark(rightX - 42, midY, hMM / 12, onDark);
      }
    };

    // ── Wordmark drawn in vectors (replaces the 47KB embedded base64 logo,
    // which made this file nearly uneditable). onDark = header/cover use.
    const wordmark = (x, y, sc, onDark) => {
      sc = sc || 1;
      const r = 3.2 * sc;
      doc.setFillColor(onDark ? '#F472B6' : '#EC4899');
      doc.circle(x + r, y, r, 'F');
      doc.setFillColor(onDark ? '#67E8F9' : '#157d8c');
      doc.circle(x + r * 1.7, y, r * 0.72, 'F');
      doc.setFillColor(onDark ? '#FFFFFF' : '#3B2A6D');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11 * sc);
      doc.setTextColor(onDark ? '#FFFFFF' : '#3B2A6D');
      doc.text('NuMind', x + r * 2.9, y + 1.4 * sc);
      doc.setFontSize(3.4 * sc);
      doc.setTextColor(onDark ? '#D8B4FE' : '#6B7280');
      doc.setFont('helvetica', 'normal');
      doc.text('NURTURING MINDS, ACHIEVING OUTCOMES', x + r * 2.9, y + 4.4 * sc);
    };

    // ── Palette (matches template) ────────────────────────────────
    const PURPLE       = '#5B2D8E';
    const PURPLE_LIGHT = '#7B4BC4';
    const PURPLE_DARK  = '#3D1F63';
    const TEAL         = '#00B8D9';
    const YELLOW       = '#F5A623';
    const GREEN        = '#2ECC71';
    const PINK         = '#FF6B9D';
    const GRAY         = '#6B7280';
    const LIGHT_GRAY   = '#F3F4F6';
    const WHITE        = '#FFFFFF';
    const W = 210, H = 297;

    // ── Helpers (mirrors template) ────────────────────────────────
    const hex2rgb = (hex) => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
    const setFill = (hex) => doc.setFillColor.apply(doc, hex2rgb(hex));
    const setDraw = (hex) => doc.setDrawColor.apply(doc, hex2rgb(hex));
    const setTxtColor = (hex) => doc.setTextColor.apply(doc, hex2rgb(hex));

    const rect = (x, y, w, h, fill, draw, r) => {
      r = r || 0;
      if (fill) setFill(fill);
      if (draw) setDraw(draw);
      if (r > 0) doc.roundedRect(x, y, w, h, r, r, fill && draw ? 'FD' : fill ? 'F' : 'D');
      else doc.rect(x, y, w, h, fill && draw ? 'FD' : fill ? 'F' : 'D');
    };

    const txt = (text, x, y, opts) => {
      opts = opts || {};
      const size = opts.size || 10;
      const color = opts.color || '#1F2937';
      const bold = !!opts.bold;
      const align = opts.align || 'left';
      doc.setFontSize(size);
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      setTxtColor(color);
      const drawOpts = { align: align };
      if (opts.maxWidth) drawOpts.maxWidth = opts.maxWidth;
      doc.text(String(text == null ? '' : text), x, y, drawOpts);
    };

    const line = (x1, y1, x2, y2, color, lw) => {
      doc.setLineWidth(lw || 0.3);
      setDraw(color || '#E5E7EB');
      doc.line(x1, y1, x2, y2);
    };

    const pill = (label, x, y, bgColor, textColor, w, h) => {
      bgColor = bgColor || PURPLE; textColor = textColor || WHITE;
      w = w || 28; h = h || 6;
      setFill(bgColor);
      doc.roundedRect(x, y - 4, w, h, 3, 3, 'F');
      txt(label, x + w / 2, y, { size: 7, color: textColor, bold: true, align: 'center' });
    };

    /**
     * Draw a box whose height is computed from the actual wrapped text it contains.
     * Returns the new cy after the box (cy + boxH + gap).
     *
     * opts: {
     *   fill, draw, radius,          — box style
     *   titleText, titleSize, titleColor, titleBold,  — optional bold heading inside box
     *   bodyText, bodySize, bodyColor,                — main prose body
     *   lineH,                       — line height for body (default 4.5)
     *   paddingTop, paddingBottom,   — inner vertical padding (default 5, 5)
     *   paddingLeft,                 — left indent for body (default 4)
     *   maxWidth,                    — max text width (default box width - 2*paddingLeft)
     *   gap,                         — space added AFTER the box (default 4)
     *   pageBreakPad,                — extra space to reserve before breaking (default 0)
     *   onNewPage,                   — callback called when a page break is inserted
     *   newPageCy,                   — cy to use after a page break (default 32)
     *   x, w,                        — box x and width (default 10, W-20)
     * }
     */
    const drawBox = (cy, opts) => {
      opts = opts || {};
      const bx         = opts.x    !== undefined ? opts.x    : 10;
      const bw         = opts.w    !== undefined ? opts.w    : W - 20;
      const fill       = opts.fill  || null;
      const draw       = opts.draw  || null;
      const radius     = opts.radius !== undefined ? opts.radius : 2;
      const pTop       = opts.paddingTop    !== undefined ? opts.paddingTop    : 5;
      const pBot       = opts.paddingBottom !== undefined ? opts.paddingBottom : 5;
      const pLeft      = opts.paddingLeft   !== undefined ? opts.paddingLeft   : 4;
      const gap        = opts.gap  !== undefined ? opts.gap  : 4;
      const lineH      = opts.lineH !== undefined ? opts.lineH : 4.5;
      const newPageCy  = opts.newPageCy !== undefined ? opts.newPageCy : 32;
      const onNewPage  = opts.onNewPage || function () {};
      const maxW       = opts.maxWidth !== undefined ? opts.maxWidth : bw - pLeft * 2;

      // Pre-compute heights
      let innerH = pTop;
      let titleLines = [];
      if (opts.titleText) {
        doc.setFontSize(opts.titleSize || 9);
        doc.setFont('helvetica', (opts.titleBold !== false) ? 'bold' : 'normal');
        titleLines = doc.splitTextToSize(String(opts.titleText), maxW);
        innerH += titleLines.length * (opts.titleSize || 9) * 0.4 + 2;
      }
      let bodyLines = [];
      if (opts.bodyText) {
        doc.setFontSize(opts.bodySize || 7.5);
        doc.setFont('helvetica', 'normal');
        bodyLines = doc.splitTextToSize(String(opts.bodyText), maxW);
        innerH += bodyLines.length * lineH;
      }
      innerH += pBot;

      // Page break if needed
      if (cy + innerH + (opts.pageBreakPad || 0) > H - 14) {
        doc.addPage();
        onNewPage();
        cy = newPageCy;
      }

      // Draw box
      rect(bx, cy, bw, innerH, fill, draw, radius);

      // Draw title
      let textY = cy + pTop + (opts.titleSize || 9) * 0.35;
      if (opts.titleText) {
        doc.setFontSize(opts.titleSize || 9);
        doc.setFont('helvetica', (opts.titleBold !== false) ? 'bold' : 'normal');
        setTxtColor(opts.titleColor || '#1F2937');
        titleLines.forEach((line) => { doc.text(line, bx + pLeft, textY); textY += (opts.titleSize || 9) * 0.4; });
        textY += 2;
      }

      // Draw body
      if (opts.bodyText) {
        doc.setFontSize(opts.bodySize || 7.5);
        doc.setFont('helvetica', 'normal');
        setTxtColor(opts.bodyColor || '#374151');
        bodyLines.forEach((line) => { doc.text(line, bx + pLeft, textY); textY += lineH; });
      }

      return cy + innerH + gap;
    };

    // ── Pull live data ────────────────────────────────────────────
    // When `override` is supplied (dashboard "Download report" — the student's
    // saved data fetched from the DB), use it. Otherwise read live browser
    // state `S` / window._lastAIReport (student's own end-of-test download).
    // Either way the SAME renderer runs, so the PDF is byte-for-byte identical.
    const safe = (v) => (v == null ? '' : String(v));
    const _ov = (override && typeof override === 'object') ? override : null;
    const st  = _ov && _ov.student ? _ov.student
              : ((typeof S !== 'undefined' && S && S.student) ? S.student : {});
    const nmap = _ov && _ov.nmap ? _ov.nmap
              : ((typeof S !== 'undefined' && S && S.nmap && S.nmap.scores) ? S.nmap.scores : { dims: [], sorted: [] });
    const daab = _ov && _ov.daab ? _ov.daab
              : ((typeof S !== 'undefined' && S && S.daab) ? S.daab : null);
    const cpi  = _ov && _ov.cpi ? _ov.cpi
              : ((typeof S !== 'undefined' && S && S.cpi && S.cpi.scores) ? S.cpi.scores : { ranked: [], top3: [] });
    const sea  = _ov && _ov.sea ? _ov.sea
              : ((typeof S !== 'undefined' && S && S.sea && S.sea.scores) ? S.sea.scores : { domScores: { E:0, S:0, A:0 }, cls: {} });
    // Snapshot the AI report once so every subsequent read in this render
    // is guaranteed to be consistent — avoids race conditions where
    // window._lastAIReport changes mid-generation.
    const ai   = _ov && _ov.ai && typeof _ov.ai === 'object'
                 ? Object.assign({}, _ov.ai)
                 : ((window._lastAIReport && typeof window._lastAIReport === 'object')
                    ? Object.assign({}, window._lastAIReport) : {});

    // ── PDF text sanitiser ────────────────────────────────────────
    // jsPDF's built-in helvetica is a WinAnsi (cp1252) font: it CANNOT
    // render emoji or most non-Latin-1 glyphs, which come out as garbled
    // bytes (e.g. a stray 🟢 became "Ø=ßâ" in an earlier report). We strip
    // emoji / pictographs / arrows / variation-selectors, keep the handful
    // of cp1252 typographic punctuation the template relies on, drop any
    // other non-Latin-1 codepoint, and tidy the whitespace/punctuation the
    // removals leave behind. Applied once to the whole AI object so prose,
    // career-table rationales and every rendered string are clean.
    const CP1252_PUNCT = '‚ƒ„…†‡ˆ‰Š‹ŒŽ\u2018\u2019\u201C\u201D\u2013\u2014•˜™š›œžŸ€·';
    const sanitizePDFText = (v) => {
      if (typeof v !== 'string') return v;
      return v
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\uFE0F\u200D\u20E3]/gu, '')
        .replace(/[^\x00-\xFF]/g, (ch) => CP1252_PUNCT.indexOf(ch) >= 0 ? ch : '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\(\s*[,;]\s*/g, '(')
        .replace(/\s+([,.;:)])/g, '$1')
        .replace(/,\s*\)/g, ')')
        .replace(/ ,/g, ',');
    };
    const deepSanitizePDF = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach((k) => {
        const val = obj[k];
        if (typeof val === 'string') obj[k] = sanitizePDFText(val);
        else if (Array.isArray(val)) val.forEach((el) => deepSanitizePDF(el));
        else if (val && typeof val === 'object') deepSanitizePDF(val);
      });
    };
    deepSanitizePDF(ai);

    // ── AI prose helpers ──────────────────────────────────────────
    // The AI generator produces 8 fields. These helpers safely consume
    // them: aiText() returns the field with a fallback when missing,
    // aiHas() tells us whether AI prose is available at all (so we can
    // adjust headings), and drawProse() lays out a paragraph block with
    // automatic page breaks if the text overflows.
    const aiText = (key, fallback) => {
      const v = ai && typeof ai[key] === 'string' ? ai[key].trim() : '';
      return v || fallback || '';
    };
    const aiHas = (key) => !!(ai && typeof ai[key] === 'string' && ai[key].trim().length);

    /**
     * Draw a multi-paragraph prose block, breaking pages as needed.
     * Returns the new cy after drawing. Caller passes a redraw callback
     * to render the page header/student-bar each time a new page starts.
     */
    // The ideal template's purple callout ("Scores are indicative...") that
    // appears on the Personality, Aptitude and Interest pages. Was missing
    // from the generated report entirely.
    const indicativeCallout = (cy) => {
      const msg = 'Scores are indicative and should not be considered final. They reflect the current state at the time of assessment and may change over time.';
      doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
      const ls = doc.splitTextToSize(msg, W - 36);
      const h = 6 + ls.length * 4;
      rect(10, cy, W - 20, h, '#F5F3FF', null, 1);
      rect(10, cy, 1.6, h, PURPLE, null, 0);
      txt(ls.join('\n'), 15, cy + 5, { size: 7.5, color: '#4C1D95' });
      return cy + h + 4;
    };

    const drawProse = (text, cy, opts) => {
      opts = opts || {};
      const size      = opts.size      || 8.5;
      const color     = opts.color     || '#374151';
      const lineH     = opts.lineH     || 5;
      const paraGap   = opts.paraGap   || 4;
      const maxW      = opts.maxW      || (W - 28);
      const x         = opts.x         || 14;
      const bottom    = opts.bottom    || (H - 14);
      const pageStart = opts.pageStart || 32;
      const onNewPage = opts.onNewPage || function () {};
      const paras = String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
      paras.forEach((para) => {
        // Measure with the SAME font/size the text will be drawn in. Without
        // this, splitTextToSize uses whatever size the previous draw left
        // active (often smaller), so lines wrap too late and overflow the
        // right margin — exactly what happened on the Welcome page.
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(size);
        const lines = doc.splitTextToSize(para, maxW);
        lines.forEach((ln) => {
          if (cy + lineH > bottom) {
            doc.addPage();
            onNewPage();
            cy = pageStart;
          }
          txt(ln, x, cy, { size: size, color: color });
          cy += lineH;
        });
        cy += paraGap;
      });
      return cy;
    };

    const studentName = safe(st.fullName) || 'Student';
    const grade       = safe(st.class) + (st.section ? ' ' + safe(st.section) : '');
    const schoolName  = safe(st.school);
    const dateStr     = new Date().toLocaleDateString('en-IN', { year:'numeric', month:'long', day:'numeric' });

    const stanineColor = (s) => s >= 7 ? PURPLE : s >= 4 ? PURPLE_LIGHT : PINK;
    // Band names shown in the PDF. Supportive wording; the stanine itself is
    // used only to choose the band and is never printed.
    const stanineBand  = (s) => s >= 7 ? 'Strength Area' : s >= 4 ? 'Developing Area' : 'Focus Area';

    // ── 9 personality dims (live) ─────────────────────────────────
    // NOTE: scoreNMAP returns each dim as { ...NMAP_DIMS[i], name: d.label,
    // stanine, label: <band>, cls }. So `name` holds the trait title
    // ('Leadership & Motivation') and `label` holds the stanine band ('High').
    // We read `d.name` first; if a future scorer omits it we recover the trait
    // title positionally via NMAP_DIMS[i].label (module-level constant), with a
    // hardcoded title table as a final fallback.
    const NMAP_TITLES_FALLBACK = [
      'Leadership & Motivation','Assertiveness','Cautiousness','Adaptability & Flexibility',
      'Ethical Awareness','Creativity & Innovation','Curiosity & Learning','Discipline & Sincerity',
      'Patience & Resilience',
    ];
    const nmapTitleAt = (i) => {
      try {
        if (typeof NMAP_DIMS !== 'undefined' && NMAP_DIMS[i] && NMAP_DIMS[i].label) return NMAP_DIMS[i].label;
      } catch (e) {}
      return NMAP_TITLES_FALLBACK[i] || ('Dimension ' + (i + 1));
    };
    // Detect actual number of dims from live data (supports 9 or 10).
    const NMAP_DIM_COUNT = (nmap.dims && nmap.dims.length >= 10) ? 10 : 9;
    const personalityAll = (nmap.dims && nmap.dims.length ? nmap.dims : new Array(NMAP_DIM_COUNT).fill({}))
      .slice(0, NMAP_DIM_COUNT).map((d, i) => {
        const stn = d.stanine || 5;
        const title = d.name || nmapTitleAt(i);
        return { name: title, stanine: stn, label: stanineBand(stn) };
      });
    while (personalityAll.length < NMAP_DIM_COUNT) {
      const i = personalityAll.length;
      personalityAll.push({ name: nmapTitleAt(i), stanine: 5, label: stanineBand(5) });
    }
    // Keep backward-compat alias used elsewhere in the file.
    const personality9 = personalityAll;

    const topPersonality = personalityAll.slice().sort((a,b) => b.stanine - a.stanine).slice(0, 3);

    // ── 8 aptitude domains (live) ─────────────────────────────────
    // Real shape: S.daab is an object keyed by sub-test code (va, pa, na,
    // lsa, hma, ar, ma, sa); each S.daab[key].scores = { raw, max, stanine, label }.
    // Display order matches DAAB_SUBS (defined elsewhere in app.js).
    const DAAB_KEY_ORDER = ['va', 'pa', 'na', 'lsa', 'hma', 'ar', 'ma', 'sa'];
    const DAAB_TEMPLATE_LABELS = {
      va:  'Verbal Ability',
      pa:  'Perceptual Speed',
      na:  'Numerical Ability',
      lsa: 'Legal Studies Ability',
      hma: 'Health & Medical Apt.',
      ar:  'Abstract Reasoning',
      ma:  'Mechanical Ability',
      sa:  'Spatial Ability',
    };
    let aptitude8 = DAAB_KEY_ORDER.map((key) => {
      const sub = daab && daab[key];
      const sc = sub && sub.scores;
      const stanine = (sc && typeof sc.stanine === 'number' && sc.stanine > 0) ? sc.stanine : 5;
      return { name: DAAB_TEMPLATE_LABELS[key], stanine, label: (sc && sc.label) || stanineBand(stanine), key };
    });
    // Re-order to match the template's natural visual order: Verbal, Perceptual,
    // Numerical, Spatial, Mechanical, Abstract, Legal, Health/Medical
    const APT_DISPLAY_ORDER = ['va', 'pa', 'na', 'sa', 'ma', 'ar', 'lsa', 'hma'];
    aptitude8 = APT_DISPLAY_ORDER.map(k => aptitude8.find(a => a.key === k) || { name: DAAB_TEMPLATE_LABELS[k] || k, stanine: 5, label: stanineBand(5), key: k });

    const aptStrong   = aptitude8.filter(a => a.stanine >= 7).map(a => a.name);
    const aptEmerging = aptitude8.filter(a => a.stanine >= 4 && a.stanine <= 6).map(a => a.name);

    // ── Career interest (all 10) ─────────────────────────────────
    // Template display order for career interest bars (matches CPI_AREAS in cpi.js)
    const CPI_DISPLAY_ORDER = [
      'Science & Technology',
      'Health & Medical Science',
      'Language & Communication',
      'Creative Design & Perf. Arts',
      'Legal & Judiciary',
      'Administration & Governance',
      'Education & Research',
      'Business & Entrepreneurship',
      'People & Service',
      'Sports & Physical Perf.',
    ];
    const cpiAll = (cpi.ranked && cpi.ranked.length ? cpi.ranked : []).map(r => ({
      label: r.label || r.name || '',
      score: typeof r.score === 'number' ? r.score : 0,
      level: r.level || (r.score >= 15 ? 'Strong' : r.score >= 8 ? 'Moderate' : 'Low'),
    }));
    // Build display list in template order, filling missing with 0
    const cpiByLabel = {};
    cpiAll.forEach(r => { cpiByLabel[r.label] = r; });
    const careers8 = CPI_DISPLAY_ORDER.map(lbl => cpiByLabel[lbl] || { label: lbl, score: 0, level: 'Low' });
    const cpiColor = (lvl) => lvl === 'Strong' ? PURPLE : lvl === 'Moderate' ? PURPLE_LIGHT : PINK;
    // top3 — always derive from live cpiAll so labels always match CPI_AREAS.
    // S.cpi.top3 may be stale (8-area data) so we ignore it and sort fresh.
    const top3 = cpiAll.slice().sort((a, b) => b.score - a.score).slice(0, 3);

    // ── SEAA cards (live) ────────────────────────────────────────
    const seaCat = (cat) => {
      if (cat === 'A' || cat === 'B') return { catLabel: 'Strong Readiness',     color: PURPLE };
      if (cat === 'C')                 return { catLabel: 'Developing Readiness', color: PURPLE_LIGHT };
      return                                  { catLabel: 'Support Needed',       color: PINK };
    };
    const seaCards = [
      Object.assign({ key:'S', title:'Social Adjustment',    score: sea.domScores.S || 0 }, seaCat((sea.cls.S||{}).cat)),
      Object.assign({ key:'E', title:'Emotional Adjustment', score: sea.domScores.E || 0 }, seaCat((sea.cls.E||{}).cat)),
      Object.assign({ key:'A', title:'Academic Adjustment',  score: sea.domScores.A || 0 }, seaCat((sea.cls.A||{}).cat)),
    ];
    seaCards.forEach(c => { c.label = c.catLabel; });
    // Display-only labels for SEAA cards. Internal `label` stays as the readiness
    // key ('Strong Readiness' etc.) so fit-score logic, arc colours, per-label copy
    // lookups and the persisted *_status axis all keep matching; only the visible
    // text uses the supportive student/parent-facing wording.
    const SEAA_DISPLAY = { 'Strong Readiness': 'Well-Established', 'Developing Readiness': 'Developing', 'Support Needed': 'Needs Support' };
    const seaaShow = (lbl) => SEAA_DISPLAY[lbl] || lbl;
    seaCards.forEach(c => { c.displayLabel = seaaShow(c.label); });

    // ── Integrated Fit Score ─────────────────────────────────────
    const avgPers = personality9.reduce((s,d) => s + d.stanine, 0) / personality9.length;
    const avgApt  = aptitude8.reduce((s,d) => s + d.stanine, 0) / aptitude8.length;
    const topInterestScore = (top3[0] && top3[0].score) || 0;
    const stanineToPct = (s) => ((s - 1) / 8) * 100;
    let fitRaw = (stanineToPct(avgPers) * 0.30) + (stanineToPct(avgApt) * 0.30) + ((topInterestScore / 20) * 100 * 0.40);
    seaCards.forEach(c => {
      if (c.label === 'Support Needed') fitRaw -= 7;
      else if (c.label === 'Developing Readiness') fitRaw -= 3;
    });
    const fitScore = Math.max(0, Math.min(100, Math.round(fitRaw)));
    const fitTier  = fitScore >= 75 ? 'Strong Fit' : fitScore >= 55 ? 'Emerging Fit' : 'Exploratory Fit';

    // ── Layout helpers ───────────────────────────────────────────
    // Note: page total isn't known up front because AI prose blocks may
    // overflow and add pages dynamically. We track which pages need a footer
    // here, then stamp all footers in one pass at the end using the doc's
    // actual page indices — this guarantees footer numbers always match
    // the physical page they sit on, even after AI overflow inserts pages.
    const footer = function () { /* no-op: footers are stamped at save time */ };

    const sectionHeader = (title, subtitle) => {
      rect(0, 0, W, 18, PURPLE);
      // Accent bars — purely decorative, drawn over the header band. The left
      // teal bar and the thin bottom accent give each page a designed, lively
      // edge without shifting any text (content starts at x=14 / y>=20).
      rect(0, 0, 3, 18, TEAL);
      rect(0, 18, W, 0.9, YELLOW);
      txt(title, 14, 11, { size: 14, color: WHITE, bold: true, maxWidth: W - 52 });
      if (subtitle) {
        doc.setFont('helvetica','normal'); doc.setFontSize(7); // measure at draw size
        const subLines = doc.splitTextToSize(subtitle, W - 28);
        txt(subLines[0], 14, 16, { size: 7, color: '#D8B4FE' });
      }
      // NuMind wordmark — top-right of every section header
      drawLogo(W - 8, 8, 11, true);
    };

    const studentBar = (y) => {
      y = y || 22;
      rect(10, y, W - 20, 8, LIGHT_GRAY, null, 1);
      doc.setFontSize(8); doc.setFont('helvetica', 'bold'); setTxtColor(PURPLE);
      doc.text(studentName, 14, y + 5.5);
      const nameW = doc.getTextWidth(studentName);
      const meta = '  |  ' + (grade || '—') + ' · ' + (schoolName || '—') + ' · ' + dateStr;
      txt(meta, 14 + nameW, y + 5.5, { size: 8, color: GRAY });
    };

    const stanineBar = (label, value, y, colorHex) => {
      txt(label, 67, y, { size: 7, color: '#1F2937', align: 'right' });
      const barX = 70, barW = W - barX - 20;
      rect(barX, y - 3.5, barW, 5, '#E5E7EB', null, 1);
      rect(barX, y - 3.5, (value / 9) * barW, 5, colorHex, null, 1);
      txt(String(value), barX + barW + 2, y, { size: 7, color: GRAY, bold: true });
    };

    /* ═══════════════════════════════════════════════
       PAGE 1 — COVER
    ═══════════════════════════════════════════════ */
    rect(0, 0, W, H, PURPLE_DARK);
    rect(0, 0, W, 80, PURPLE);
    // NuMind wordmark — top-right of cover
    drawLogo(W - 8, 12, 15, true);
    txt('NURTURING MINDS, ACHIEVING OUTCOMES', 14, 16, { size: 5, color: '#D8B4FE' });
    txt('Comprehensive Multidimensional Assessment Report', 14, 50, { size: 9, color: '#D8B4FE' });
    txt('NuMind MAPS', 14, 68, { size: 28, color: WHITE, bold: true });
    txt('Multidimensional Assessment', 14, 80, { size: 14, color: '#C4B5FD' });
    txt('Personalized Success', 14, 88, { size: 14, color: '#C4B5FD' });
    line(14, 94, 80, 94, WHITE, 0.8);

    rect(14, 104, W - 28, 56, WHITE, null, 3);
    txt('Prepared For', 22, 114, { size: 8, color: GRAY });
    txt(studentName, 22, 126, { size: 18, color: '#1F2937', bold: true, maxWidth: W - 44 });
    line(22, 130, W - 22, 130, '#E5E7EB', 0.3);
    txt('Grade:', 22, 140, { size: 9, color: '#1F2937', bold: true });
    txt(grade || '—', 38, 140, { size: 9, color: '#1F2937' });
    txt('School:', 22, 148, { size: 9, color: '#1F2937', bold: true });
    txt(schoolName || '—', 38, 148, { size: 9, color: '#1F2937', maxWidth: W - 60 });
    txt('Date:', 22, 156, { size: 9, color: '#1F2937', bold: true });
    txt(dateStr, 35, 156, { size: 9, color: '#1F2937' });

    // Tagline panel — fills the previously empty mid-cover area.
    rect(14, 168, W - 28, 22, PURPLE_LIGHT, null, 3);
    txt('Your Personalised Career Development Report', W / 2, 178, { size: 11, color: WHITE, bold: true, align: 'center' });
    txt('Built from 4 evidence-based assessments and AI-powered insights', W / 2, 185, { size: 8, color: '#E9D5FF', align: 'center' });

    txt('The Four Dimensions Shaping Your Profile', 14, 200, { size: 9, color: '#D8B4FE' });
    ['NMAP', 'NAAB', 'NCPI', 'NSEAA'].forEach((p, i) => {
      const px = 14 + i * 47;
      setFill(WHITE); doc.roundedRect(px, 205, 43, 18, 3, 3, 'F');
      txt(p, px + 21, 216, { size: 10, color: PURPLE, bold: true, align: 'center' });
    });
    footer(1);

    /* ═══════════════════════════════════════════════
       PAGE 2 — WELCOME & 4 PILLARS
    ═══════════════════════════════════════════════ */
    doc.addPage();
    rect(0, 0, W, 18, PURPLE);
    txt('Welcome', 14, 9, { size: 8, color: '#D8B4FE' });
    txt(studentName, 14, 15, { size: 14, color: WHITE, bold: true, maxWidth: W - 52 });
    // NuMind wordmark — welcome page header top-right
    drawLogo(W - 8, 8, 11, true);

    let cy = 28;
    // Use AI holistic_summary when present — this is the personalised
    // mentor narrative weaving all four modules into the student's story.
    // Falls back to the generic welcome blurb when no AI report is available.
    const welcomeFallback =
      'Welcome to your NuMind Integrated Career Development Report. This report is based on a multidimensional assessment designed to help you better understand your strengths, preferences, abilities, and readiness factors that influence academic and career decisions.\n\n' +
      'The purpose of this report is not merely to suggest careers, but to support informed decision-making by helping you understand your strengths, growth areas, and pathways that may align well with your profile.';
    const welcomeProse = aiText('holistic_summary', welcomeFallback);
    cy = drawProse(welcomeProse, cy, {
      size: 8.5, color: '#374151', lineH: 5, paraGap: 4,
      maxW: W - 28, x: 14, bottom: cy + 70,
      onNewPage: function () {
        rect(0, 0, W, 18, PURPLE);
        txt('Welcome (continued)', 14, 9, { size: 8, color: '#D8B4FE' });
        txt(studentName, 14, 15, { size: 14, color: WHITE, bold: true });
      },
    });
    cy += 2;

    rect(10, cy, W - 20, 8, PURPLE, null, 2);
    txt('* The Four Pillars of NuMind MAP *', W / 2, cy + 5.5, { size: 9, color: WHITE, bold: true, align: 'center' });
    cy += 12;

    const infoTxt = 'Each assessment plays a distinct role in shaping your Integrated Career Development Profile, helping you make informed and confident decisions about your future.';
    cy = drawBox(cy, {
      fill: '#F5F3FF', draw: '#E9D5FF', radius: 2,
      bodyText: infoTxt, bodySize: 8, bodyColor: '#374151', lineH: 4.5,
      paddingTop: 5, paddingBottom: 5, gap: 6,
    });

    const pillarData = [
      { code:'NMAP',  title:'NuMind Multidimensional Assessment of Personality', sub:'Understanding who you are at your core', body:'Evaluates ' + NMAP_DIM_COUNT + ' key personality dimensions that influence how you think, behave, and grow.', border:PURPLE },
      { code:'NAAB',  title:'NuMind Aptitude & Ability Battery',                 sub:'Discovering what you can do',            body:'Measures 8 essential cognitive abilities — verbal, numerical, spatial, abstract reasoning and more.', border:PURPLE_LIGHT },
      { code:'NCPI',  title:'NuMind Career Preference Inventory',                sub:'Identifying what you enjoy',             body:'Maps career interests across 10 domains to uncover environments and roles aligned with your preferences.', border:TEAL },
      { code:'NSEAA', title:'NuMind Social Emotional & Academic Adjustment',     sub:'Preparing you to thrive',                body:'Assesses emotional, social, and academic readiness ensuring long-term success and wellbeing.', border:YELLOW },
    ];
    pillarData.forEach((p, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const px = 10 + col * 97, py = cy + row * 36;
      rect(px, py, 93, 32, '#F9FAFB', p.border, 2);
      doc.setLineWidth(0.8); setDraw(p.border); doc.line(px, py, px, py + 32);
      txt(p.code,  px + 5, py + 7,  { size: 7,   color: p.border, bold: true });
      txt(p.title, px + 5, py + 12, { size: 7.5, color: '#1F2937', bold: true, maxWidth: 83 });
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); setTxtColor(p.border);
      const sub = doc.splitTextToSize(p.sub, 83); doc.text(sub, px + 5, py + 18);
      const body = doc.splitTextToSize(p.body, 83);
      txt(body.join('\n'), px + 5, py + 22, { size: 6.5, color: '#6B7280' });
    });
    cy += 76;

    txt('Know the Order of Your Report', 14, cy, { size: 9, color: '#1F2937', bold: true });
    cy += 5;
    const steps = [
      ['1', 'Profile Snapshot:',           'Quick overview of your overall profile across all four domains'],
      ['2', 'Assessment Insights:',        'Deep dive into Personality, Aptitude, Career Interest, and Wellbeing'],
      ['3', 'Career Alignment:',           'Integrated Career Fit Matrix combining all four domains'],
      ['4', 'Gap Analysis:',               'Comparison between your current profile and recommended pathway requirements'],
      ['5', 'Summary & Recommendations:',  'Final overview, suggested streams, next steps, and counsellor notes'],
    ];
    steps.forEach((row) => {
      rect(10, cy, W - 20, 8, LIGHT_GRAY, null, 1);
      setFill(PURPLE); doc.circle(16, cy + 4, 3, 'F');
      txt(row[0], 16, cy + 5.5, { size: 7, color: WHITE, bold: true, align: 'center' });
      txt(row[1], 22, cy + 5.5, { size: 8, color: PURPLE, bold: true });
      txt(row[2], 22 + doc.getTextWidth(row[1]) + 2, cy + 5.5, { size: 8, color: GRAY, maxWidth: W - 26 - doc.getTextWidth(row[1]) });
      cy += 10;
    });

    cy = drawBox(cy, {
      fill: '#F5F3FF', draw: PURPLE, radius: 2,
      titleText: 'Stronger Together', titleSize: 9, titleColor: PURPLE,
      bodyText: 'These four pillars come together to provide a holistic, evidence-based view of your potential — empowering you to make informed decisions today for a more confident tomorrow.',
      bodySize: 7.5, bodyColor: '#374151', lineH: 4.5, paddingTop: 6, paddingBottom: 6, gap: 0,
    });

    footer(2);

    /* ═══════════════════════════════════════════════
       PAGE 3 — PROFILE SNAPSHOT
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Profile Snapshot', 'A quick overview of your overall profile, key strengths and growth areas');
    studentBar(20);

    cy = 32;
    cy = drawBox(cy, {
      fill: '#F8FAFF', draw: '#C4B5FD', radius: 2,
      titleText: 'How to read this section:', titleSize: 8, titleColor: '#1F2937',
      bodyText: 'For Personality, Aptitude, and Career Interest, higher scores indicate stronger alignment. For SEAA Readiness, lower scores indicate stronger readiness; higher scores indicate greater support may be helpful.',
      bodySize: 7.5, bodyColor: '#374151', lineH: 4.5, paddingTop: 6, paddingBottom: 5, gap: 4,
    });

    const persStatus  = avgPers >= 6.5 ? 'Strength' : avgPers >= 4 ? 'Developing' : 'Support Needed';
    const aptStatus   = avgApt  >= 6.5 ? 'Strength' : avgApt  >= 4 ? 'Developing' : 'Support Needed';
    const cpiStatus   = topInterestScore >= 15 ? 'Strength' : topInterestScore >= 8 ? 'Developing' : 'Support Needed';
    const seaWorst    = seaCards.reduce((w, c) => {
      if (c.label === 'Support Needed') return 'Support Needed';
      if (c.label === 'Developing Readiness' && w !== 'Support Needed') return 'Developing';
      return w;
    }, 'Strength');
    const statusBg = (s) => s === 'Strength' ? '#F5F3FF' : s === 'Developing' ? '#EFF6FF' : '#FEFCE8';
    const statusBorder = (s) => s === 'Strength' ? PURPLE : s === 'Developing' ? TEAL : YELLOW;

    const snapCards = [
      { title:'Personality',     status: persStatus, note: topPersonality.length ? 'Dominant: ' + topPersonality.slice(0,2).map(t => t.name).join(', ') : 'Personality profile across ' + NMAP_DIM_COUNT + ' dimensions.' },
      { title:'Aptitude',        status: aptStatus,  note: aptStrong.length ? 'Strong areas: ' + aptStrong.slice(0,2).join(', ') : 'Aptitude profile across 8 ability domains.' },
      { title:'Career Interest', status: cpiStatus,  note: top3[0] ? 'Top interest: ' + top3[0].label + ' (' + top3[0].score + '/20)' : 'Career interest mapped across domains.' },
      { title:'SEAA Readiness',  status: seaWorst,   note: seaCards.map(c => c.title.split(' ')[0] + ': ' + c.score + '/20').join(' · ') },
    ];
    snapCards.forEach((c, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const px = 10 + col * 97;
      // compute height for this card
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      const nL = doc.splitTextToSize(c.note, 79);
      const cardH = 33 + nL.length * 4;
      // only advance cy at end of each row (use max of left/right card)
      if (col === 0) {
        // compute right card height too
        const rightCard = snapCards[i + 1];
        let rightH = 33;
        if (rightCard) {
          doc.setFont('helvetica','normal'); doc.setFontSize(7); // measure at draw size
          const rL = doc.splitTextToSize(rightCard.note, 79);
          rightH = 33 + rL.length * 4;
        }
        const rowH = Math.max(cardH, rightH);
        // store for use when col===1
        snapCards[i]._rowH = rowH;
        snapCards[i]._cardH = cardH;
      } else {
        snapCards[i]._cardH = cardH;
      }
    });
    // draw with computed heights
    // pre-compute both row heights so row-1 py is offset by row-0 height, not its own
    const _snapRow0H = snapCards[0]._rowH || 36;
    const _snapRow1H = (snapCards[2] && snapCards[2]._rowH) || 36;
    snapCards.forEach((c, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const px = 10 + col * 97;
      const py = cy + (row === 0 ? 0 : _snapRow0H + 8);
      const cardH = c._cardH;
      rect(px, py, 93, cardH, statusBg(c.status), statusBorder(c.status), 2);
      txt(c.title,  px + 7, py + 11, { size: 9, color: statusBorder(c.status), bold: true });
      txt(c.status, px + 7, py + 19, { size: 10, color: '#1F2937', bold: true });
      line(px + 7, py + 23, px + 86, py + 23, '#E5E7EB', 0.2);
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      const nL = doc.splitTextToSize(c.note, 79);
      txt(nL.join('\n'), px + 7, py + 29, { size: 7, color: GRAY });
    });
    // advance cy by total height of all rows
    cy += _snapRow0H + (_snapRow1H ? _snapRow1H + 8 : 0) + 12;

    txt('Integrated Fit Score', 14, cy, { size: 10, color: '#1F2937', bold: true });
    cy += 5;
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    const fitDesc = 'This index combines strength-based domains (personality, aptitude, interests) with readiness indicators (SEAA) to provide an integrated view of overall fit and developmental readiness.';
    const fitL = doc.splitTextToSize(fitDesc, 88);
    const fitBoxH = Math.max(40, 16 + fitL.length * 4.5);
    rect(10, cy, W - 20, fitBoxH, PURPLE_DARK, null, 3);
    txt('Alignment Score', 18, cy + 11, { size: 9, color: '#D8B4FE' });
    txt(fitScore + ' / 100', 18, cy + 23, { size: 15, color: WHITE, bold: true });
    txt(fitTier, 18, cy + 30, { size: 7, color: '#C4B5FD' });
    txt(fitL.join('\n'), 110, cy + 13, { size: 7.5, color: '#E9D5FF' });
    cy += fitBoxH + 10;

    rect(10, cy, W - 20, 10, LIGHT_GRAY, null, 2);
    txt('Note:', 14, cy + 6, { size: 8, color: '#1F2937', bold: true });
    txt('Results reflect both strengths and readiness indicators. Developing and support areas represent opportunities for growth, not limitations.', 24, cy + 6, { size: 7.5, color: GRAY, maxWidth: W - 36 });
    cy += 14;
    footer(3);

    /* ═══════════════════════════════════════════════
       PAGE 4 — PERSONALITY PROFILE
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Personality Profile', 'The Personality Graph highlights your strengths across ' + NMAP_DIM_COUNT + ' important personality traits and how they may relate to personal growth and career fit');
    studentBar(20);
    cy = 32;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill(PURPLE);       doc.circle(18, cy + 3.5, 2.5, 'F'); txt('Strength',        22, cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(PURPLE_LIGHT); doc.circle(52, cy + 3.5, 2.5, 'F'); txt('Developing',      56, cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(PINK);         doc.circle(92, cy + 3.5, 2.5, 'F'); txt('Needs Attention', 96, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 11;

    const persChartH = 8 + personality9.length * 5.5 + 4;
    rect(10, cy, W - 20, persChartH, '#FAFAFA', '#E5E7EB', 2);
    txt('Personality Profile — ' + personality9.length + ' Dimensions', 14, cy + 6, { size: 8, color: GRAY, bold: true });
    personality9.forEach((d, i) => stanineBar(d.name, d.stanine, cy + 14 + i * 5.5, stanineColor(d.stanine)));
    for (let i = 1; i <= 9; i++) {
      const bx = 70 + ((i - 1) / 8) * (W - 90);
      txt(String(i), bx, cy + persChartH + 2, { size: 6, color: GRAY, align: 'center' });
    }
    cy += persChartH + 6;

    txt('Bands:   Focus Area   ·   Developing Area   ·   Strength Area', 14, cy + 3, { size: 7, color: GRAY });
    cy += 8;

    txt('Top 3 Dominant Traits', 14, cy, { size: 9, color: '#1F2937', bold: true });
    cy += 5;
    [0, 1, 2].forEach((idx) => {
      const trait = topPersonality[idx]
        || personalityAll[idx]
        || { name: 'Profile developing', stanine: 5, label: 'Developing Area' };
      const px = 10 + idx * 63;
      rect(px, cy, 59, 12, LIGHT_GRAY, '#D1D5DB', 2);
      txt('0' + (idx + 1), px + 5, cy + 8, { size: 9, color: PURPLE, bold: true });
      txt(trait.name, px + 16, cy + 6, { size: 7.5, color: '#1F2937', bold: true, maxWidth: 42 });
      txt(trait.label, px + 16, cy + 11, { size: 7, color: GRAY });
    });
    cy += 18;

    cy = indicativeCallout(cy);
    // AI Personality Insight — uses personality_profile when available;
    // otherwise renders weakness-driven bullet suggestions.
    cy += 6;
    if (aiHas('personality_profile')) {
      // Only break page if not enough room for header + at least 2 lines
      if (cy + 22 > H - 16) {
        doc.addPage();
        sectionHeader('Personality Profile', 'The Personality Graph highlights your strengths across ' + NMAP_DIM_COUNT + ' important personality traits and how they may relate to personal growth and career fit');
        studentBar(20);
        cy = 32;
      }
      // Title bar - matches template's "Personality Insight (AI)" style
      txt('Personality Insight (AI)', 14, cy, { size: 9, color: '#1F2937', bold: true });
      cy += 7;
      // Prose body — paginates if long
      cy = drawProse(aiText('personality_profile', ''), cy, {
        size: 8, color: '#374151', lineH: 4.8, paraGap: 4,
        maxW: W - 28, x: 14, bottom: H - 16, pageStart: 32,
        onNewPage: function () {
          sectionHeader('Personality Profile', 'The Personality Graph highlights your strengths across ' + NMAP_DIM_COUNT + ' important personality traits and how they may relate to personal growth and career fit');
          studentBar(20);
        },
      });
      cy += 8;
      // Development suggestions box — always rendered to match template
      const persWeak2 = personality9.slice().sort((a,b) => a.stanine - b.stanine).slice(0, 3);
      if (persWeak2.length) {
        if (cy + 32 > H - 16) {
          doc.addPage();
          sectionHeader('Personality Profile', 'The Personality Graph highlights your strengths across ' + NMAP_DIM_COUNT + ' important personality traits and how they may relate to personal growth and career fit');
          studentBar(20);
          cy = 32;
        }
        const suggMap2 = {
          'Leadership & Motivation':    'Take initiative on small group projects to build leadership confidence.',
          'Assertiveness':              'Practice expressing opinions in low-pressure settings such as class discussions.',
          'Cautiousness':               'Develop a habit of pausing to weigh options before deciding.',
          'Adaptability & Flexibility': 'Try new activities or routines weekly to build comfort with change.',
          'Ethical Awareness':          'Reflect on real situations and discuss right-vs-wrong reasoning with a mentor.',
          'Creativity & Innovation':    'Explore creative outlets — writing, design, problem-solving puzzles — regularly.',
          'Curiosity & Learning':       'Read across diverse topics and ask questions about how things work.',
          'Discipline & Sincerity':     'Use a planner and set small daily goals to build consistency.',
          'Patience & Resilience':      'Practice mindfulness and journaling to build emotional steadiness.',
          'Emotional Intelligence':     'Practice active listening, empathy exercises, and reflective journaling to strengthen emotional awareness.',
        };
        const suggH = 15 + persWeak2.length * 6;
        rect(10, cy, W - 20, suggH, '#EFF6FF', '#BFDBFE', 2);
        txt('Development Suggestions', 14, cy + 8, { size: 9, color: '#1D4ED8', bold: true });
        persWeak2.forEach((d, i) => {
          const sug = suggMap2[d.name] || ('Strengthen ' + d.name + ' through targeted practice and reflection.');
          txt('• ' + sug, 14, cy + 15 + i * 6, { size: 7.5, color: '#374151', maxWidth: W - 28 });
        });
        cy += suggH;
      }
    } else {
      const persWeak = personality9.slice().sort((a,b) => a.stanine - b.stanine).slice(0, 3);
      const suggMap = {
        'Leadership & Motivation':    'Take initiative on small group projects to build leadership confidence.',
        'Assertiveness':              'Practice expressing opinions in low-pressure settings such as class discussions.',
        'Cautiousness':               'Develop a habit of pausing to weigh options before deciding.',
        'Adaptability & Flexibility': 'Try new activities or routines weekly to build comfort with change.',
        'Ethical Awareness':          'Reflect on real situations and discuss right-vs-wrong reasoning with a mentor.',
        'Creativity & Innovation':    'Explore creative outlets — writing, design, problem-solving puzzles — regularly.',
        'Curiosity & Learning':       'Read across diverse topics and ask questions about how things work.',
        'Discipline & Sincerity':     'Use a planner and set small daily goals to build consistency.',
        'Patience & Resilience':      'Practice mindfulness and journaling to build emotional steadiness.',
        'Emotional Intelligence':     'Practice active listening, empathy exercises, and reflective journaling to strengthen emotional awareness.',
      };
      // compute actual height
      doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
      const suggLines = persWeak.map(d => {
        const sug = '• ' + (suggMap[d.name] || 'Strengthen ' + d.name + ' through targeted practice.');
        return doc.splitTextToSize(sug, W - 28);
      });
      const suggBoxH = 10 + suggLines.reduce((h, ls) => h + ls.length * 4.5, 0);
      rect(10, cy, W - 20, suggBoxH, '#EFF6FF', '#BFDBFE', 2);
      txt('Development Suggestions', 14, cy + 7, { size: 9, color: '#1D4ED8', bold: true });
      let sy = cy + 13;
      suggLines.forEach((ls) => { txt(ls.join('\n'), 14, sy, { size: 7.5, color: '#374151' }); sy += ls.length * 4.5; });
    }

    // Trait reference descriptions move to their own page so the analysis
    // (chart, top traits, insight) sits together on the previous page.
    doc.addPage();
    sectionHeader('Personality Profile', 'Trait descriptions and personalised insight');
    studentBar(20);
    cy = 32;

    txt('Description of Personality Parameters', 14, cy, { size: 9, color: '#1F2937', bold: true });
    cy += 5;
    const traitDescs = {
      'Leadership & Motivation':    'Shows initiative, drive and willingness to take responsibility. Shapes how a student approaches goals and engagement.',
      'Assertiveness':              "Ability to express views confidently. Influences comfort with healthy competition and standing by one's ideas.",
      'Cautiousness':               'Alertness, careful thinking and consideration of risks. Shapes how thoughtfully a student approaches decisions.',
      'Adaptability & Flexibility': 'Openness to change and adjusting to new situations. Influences how well a student responds to transitions and feedback.',
      'Ethical Awareness':          'Sensitivity toward values and responsibility. Shapes integrity, accountability and ethical decision making.',
      'Creativity & Innovation':    'Originality, imagination and openness to new ideas. Supports problem solving and innovative thinking.',
      'Curiosity & Learning':       'Interest in exploring and engaging with new knowledge. Influences motivation for learning and growth.',
      'Discipline & Sincerity':     'Consistency, responsibility and commitment to tasks. Supports organisation and follow-through.',
      'Patience & Resilience':      'Emotional steadiness and ability to cope with setbacks. Influences how a student manages challenges over time.',
    };
    // Group the trait cards into rows, then distribute the leftover vertical
    // space as even gaps so the cards fill the page instead of clustering at
    // the top. Card height carries extra padding so the trait name and its
    // description aren't cramped together.
    const cardH = personality9.map((d, i) => {
      const isLastAlone = (personality9.length % 2 === 1) && (i === personality9.length - 1);
      const desc = traitDescs[d.name] || (d.name + ' — ' + stanineBand(d.stanine) + '.');
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
      const dL = doc.splitTextToSize(desc, isLastAlone ? W - 24 : 83);
      return 13 + dL.length * 4;
    });
    const descRows = [];
    for (let i = 0; i < personality9.length; i += 2) descRows.push([i, i + 1 < personality9.length ? i + 1 : null]);
    const descRowH = descRows.map(r => Math.max(...r.filter(x => x != null).map(x => cardH[x])));
    const descTotalH = descRowH.reduce((a, b) => a + b, 0);
    const descBottom = H - 16;
    // Even gap = leftover space shared as top pad + inter-row gaps + bottom pad.
    let descGap = (descBottom - cy - descTotalH) / (descRows.length + 1);
    descGap = Math.max(6, Math.min(descGap, 11));
    let traitCy = cy + descGap;
    descRows.forEach((row, ri) => {
      row.forEach((idx, col) => {
        if (idx == null) return;
        const d = personality9[idx];
        const isLastAlone = (personality9.length % 2 === 1) && (idx === personality9.length - 1);
        const desc = traitDescs[d.name] || (d.name + ' — ' + stanineBand(d.stanine) + '.');
        doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
        const dL = doc.splitTextToSize(desc, isLastAlone ? W - 24 : 83);
        const px = 10 + col * 97;
        const cardW = isLastAlone ? W - 20 : 93;
        rect(px, traitCy, cardW, descRowH[ri], '#F0F9FF', '#BAE6FD', 2);
        txt((idx + 1) < 10 ? '0' + (idx + 1) : String(idx + 1), px + 5, traitCy + 7, { size: 8, color: PURPLE_LIGHT, bold: true });
        txt(d.name, px + 14, traitCy + 7, { size: 8, color: '#1F2937', bold: true, maxWidth: isLastAlone ? W - 34 : 75 });
        txt(dL.join('\n'), px + 5, traitCy + 12, { size: 6.5, color: GRAY });
      });
      traitCy += descRowH[ri] + descGap;
    });
    cy = traitCy;

    footer(4);

    /* ═══════════════════════════════════════════════
       PAGE 5 — APTITUDE & ABILITY
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Aptitude & Ability Profile', 'Understand your strengths across different ability areas and emerging areas for development. Indicators of how abilities may align with future learning and career options.');
    studentBar(20);
    cy = 32;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill(PURPLE);       doc.circle(18,  cy + 3.5, 2.5, 'F'); txt('Strong Aptitude Area',  22,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(PURPLE_LIGHT); doc.circle(62,  cy + 3.5, 2.5, 'F'); txt('Emerging Area',         66,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(PINK);         doc.circle(96,  cy + 3.5, 2.5, 'F'); txt('Area for Development', 100, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 11;

    rect(10, cy, W - 20, 48, '#FAFAFA', '#E5E7EB', 2);
    txt('Aptitude Profile — 8 Domains', 14, cy + 6, { size: 8, color: GRAY, bold: true });
    aptitude8.forEach((d, i) => stanineBar(d.name, d.stanine, cy + 12 + i * 4.7, stanineColor(d.stanine)));
    for (let i = 1; i <= 9; i++) {
      const bx = 70 + ((i - 1) / 8) * (W - 90);
      txt(String(i), bx, cy + 49, { size: 6, color: GRAY, align: 'center' });
    }
    cy += 53;

    txt('Bands:   Focus Area   ·   Developing Area   ·   Strength Area', 14, cy + 3, { size: 7, color: GRAY });
    cy += 8;

    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    // Every box must carry real content. If no area reached the Strength band,
    // surface the student's closest areas with a supportive framing rather than
    // an empty placeholder; mirror the same for the emerging box.
    const _closest = aptitude8.slice().sort((a,b) => b.stanine - a.stanine).slice(0,2).map(a => a.name);
    const strongContent = aptStrong.length ? aptStrong.join('\n')
      : 'Closest to strength:\n' + _closest.join('\n') + '\nWith practice these can become clear strengths.';
    const emergingContent = aptEmerging.length ? aptEmerging.join('\n')
      : 'All areas are currently either strengths or focus areas — see the profile above.';
    doc.setFont('helvetica','normal'); doc.setFontSize(7); // measure at draw size
    const sALines = doc.splitTextToSize(strongContent, 83);
    const eALines = doc.splitTextToSize(emergingContent, 83);
    const aptPairH = Math.max(9 + sALines.length * 4.6, 9 + eALines.length * 4.6, 22);
    rect(10,  cy, 93, aptPairH, '#F0FDF4', GREEN,     2);
    txt('Strong Aptitude Areas', 14, cy + 7, { size: 8, color: GREEN, bold: true });
    txt(sALines.join('\n'), 14, cy + 12, { size: 8, color: '#1F2937' });
    rect(107, cy, 93, aptPairH, '#EFF6FF', '#3B82F6', 2);
    txt('Emerging Areas', 111, cy + 7, { size: 8, color: '#3B82F6', bold: true });
    txt(eALines.join('\n'), 111, cy + 12, { size: 8, color: '#1F2937' });
    cy += aptPairH + 5;

    cy = indicativeCallout(cy);
    // AI Aptitude Insight — uses aptitude_profile when present;
    // otherwise renders the deterministic relevance line.
    const aptDomainMap = {
      'Verbal Ability':         ['Psychology', 'Law', 'Journalism'],
      'Perceptual Speed':       ['Data Analytics', 'Cybersecurity'],
      'Numerical Ability':      ['Finance', 'Data Science', 'AI/ML'],
      'Spatial Ability':        ['Architecture', 'UX/UI', 'Product Design'],
      'Mechanical Ability':     ['Engineering', 'Robotics'],
      'Abstract Reasoning':     ['Strategy', 'AI Research'],
      'Legal Studies Ability':  ['Law', 'Public Policy'],
      'Health & Medical Apt.':  ['Medicine', 'Biotechnology'],
    };
    if (aiHas('aptitude_profile')) {
      if (cy + 14 > H - 16) {
        doc.addPage();
        sectionHeader('Aptitude & Ability Profile', 'Understand your strengths across different ability areas and emerging areas for development.');
        studentBar(20);
        cy = 32;
      }
      // Title matches template: "Aptitude Insight (AI):" label then prose
      txt('Aptitude Insight (AI):', 14, cy, { size: 8, color: '#1F2937', bold: true });
      cy += 5;
      cy = drawProse(aiText('aptitude_profile', ''), cy, {
        size: 7.5, color: '#374151', lineH: 4.2, paraGap: 3,
        maxW: W - 28, x: 14, bottom: H - 14, pageStart: 32,
        onNewPage: function () {
          sectionHeader('Aptitude & Ability Profile', 'Understand your strengths across different ability areas and emerging areas for development.');
          studentBar(20);
        },
      });
      cy += 2;
    } else {
      const aptDomLine = aptStrong.slice(0,3).map(a => a.split(' ')[0] + ' → ' + (aptDomainMap[a] || []).slice(0,2).join('/')).join('  ·  ') ||
                         'Build strengths broadly across reasoning, language and quantitative skills.';
      cy = drawBox(cy, {
        fill: LIGHT_GRAY, radius: 2,
        titleText: 'Career Relevance Mapping:', titleSize: 8, titleColor: '#1F2937',
        bodyText: aptDomLine, bodySize: 7, bodyColor: GRAY, lineH: 4.5,
        paddingTop: 5, paddingBottom: 5, gap: 4,
      });
    }

    rect(10, cy, W - 20, 15, '#EDE9FE', null, 2);
    txt('Suggested Career Domains Based on Aptitude', 14, cy + 5, { size: 8, color: PURPLE, bold: true });
    const suggDoms = (() => {
      const set = new Set();
      aptStrong.forEach(a => (aptDomainMap[a] || []).forEach(d => set.add(d)));
      if (set.size < 4) aptEmerging.forEach(a => (aptDomainMap[a] || []).forEach(d => set.add(d)));
      const out = Array.from(set).slice(0, 4);
      while (out.length < 4) out.push('Multidisciplinary');
      return out;
    })();
    suggDoms.forEach((d, i) => pill(d, 14 + i * 47, cy + 11.5, PURPLE, WHITE, 40, 6));
    cy += 20;

    const tblHeaders = ['Aptitude Areas', 'Description', 'Potential Careers'];
    const tblColW = [40, 65, 85];
    const tblX    = [10, 50, 115];
    const aptDescriptions = {
      'Verbal Ability':         ['Language understanding, expression and communication.',           'Psychology · Law · Journalism · Content · Policy'],
      'Perceptual Speed':       ['Quick visual scanning, comparison and attention to detail.',       'Data Analytics · Cybersecurity · Forensics'],
      'Numerical Ability':      ['Comfort with numbers, data and quantitative reasoning.',           'Finance · Actuarial · Data Science · AI/ML'],
      'Spatial Ability':        ['Visualizing shapes, patterns and space-based relationships.',      'Architecture · UX/UI · Product Design'],
      'Mechanical Ability':     ['Understanding machines, tools and mechanical reasoning.',          'Engineering · Industrial Automation · Mechatronics'],
      'Abstract Reasoning':     ['Pattern recognition, logical thinking and problem solving.',       'Strategy Consulting · Cognitive Science · AI Research'],
      'Legal Studies Ability':  ['Reasoning, argument formation and rule-based thinking.',           'Law · International Relations · Public Policy'],
      'Health & Medical Apt.':  ['Readiness for health, biology and clinical reasoning.',            'Medicine · Biotechnology · Clinical Psychology'],
    };
    const aptRows = aptitude8.slice().sort((a,b) => b.stanine - a.stanine).map(d => {
      const md = aptDescriptions[d.name] || ['A distinct thinking skill measured by this assessment.', 'Multiple pathways — discuss with your counsellor.'];
      return [d.name, md[0], md[1]];
    });
    // Pre-compute row heights so the table can be kept together as one block.
    const aptRowH = aptRows.map((row) => {
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
      const cellLines = row.map((cell, ci) => doc.splitTextToSize(safe(cell), tblColW[ci] - 4));
      return Math.max(9, 4.5 + Math.max(...cellLines.map(l => l.length)) * 3.8);
    });
    const aptTableH = 11 + aptRowH.reduce((t, h) => t + h, 0) + 15; // title+header+rows+note
    if (cy + aptTableH > H - 14) {
      doc.addPage();
      sectionHeader('Aptitude & Ability Profile', 'Understand your strengths across different ability areas and emerging areas for development.');
      studentBar(20);
      cy = 32;
    }
    txt('Understanding Aptitude Areas and Related Career Pathways', 14, cy, { size: 9, color: '#1F2937', bold: true });
    cy += 5;
    rect(10, cy, W - 20, 7, PURPLE, null, 0);
    tblHeaders.forEach((h, i) => txt(h, tblX[i] + 2, cy + 5, { size: 8, color: WHITE, bold: true }));
    cy += 7;
    aptRows.forEach((row, ri) => {
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
      const cellLines = row.map((cell, ci) => doc.splitTextToSize(safe(cell), tblColW[ci] - 4));
      const rowH = aptRowH[ri];
      const rowBg = ri % 2 === 0 ? WHITE : LIGHT_GRAY;
      rect(10, cy, W - 20, rowH, rowBg, '#E5E7EB', 0);
      cellLines.forEach((cL, ci) => txt(cL.join('\n'), tblX[ci] + 2, cy + 5, { size: 6.5, color: '#374151' }));
      cy += rowH;
    });

    cy += 3;
    txt('Note: Career options are indicative, not exhaustive — explore pathways aligned with aptitude, interests and academics.', 14, cy, { size: 6.5, color: GRAY, maxWidth: W - 28 });
    cy += 6;

    footer(5);

    /* ═══════════════════════════════════════════════
       PAGE 6 — CAREER INTEREST
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Career Interest Profile', 'Career areas you may be most inclined toward. Primary and emerging interest clusters across career domains — helping explore pathways that connect with your preferences.');
    studentBar(20);
    cy = 32;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill(PURPLE);       doc.circle(18,  cy + 3.5, 2.5, 'F'); txt('Strong Interest',   22,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(PURPLE_LIGHT); doc.circle(56,  cy + 3.5, 2.5, 'F'); txt('Moderate Interest', 60,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(PINK);         doc.circle(100, cy + 3.5, 2.5, 'F'); txt('Low Interest',     104, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 11;

    rect(10, cy, W - 20, 76, '#FAFAFA', '#E5E7EB', 2);
    txt('Career Interest Ranking — strongest interests first', 14, cy + 6, { size: 8, color: GRAY, bold: true });
    const barX2 = 70, barW2 = W - barX2 - 20;
    careers8.forEach((c, i) => {
      const y2 = cy + 14 + i * 6;
      txt(c.label, 67, y2, { size: 7, color: '#1F2937', align: 'right', maxWidth: 55 });
      rect(barX2, y2 - 3.5, barW2, 5, '#E5E7EB', null, 1);
      rect(barX2, y2 - 3.5, (Math.max(0, c.score) / 20) * barW2, 5, cpiColor(c.level), null, 1);
      txt(String(c.score), barX2 + barW2 + 2, y2, { size: 7, color: GRAY, bold: true });
    });
    for (let i = 0; i <= 20; i += 2) {
      const bx = barX2 + (i / 20) * barW2;
      txt(String(i), bx, cy + 78, { size: 5.5, color: GRAY, align: 'center' });
    }
    cy += 83;

    const cpiGNote = "Bars in the Career Interest graph show the student's relative interest strength across the assessed career areas: shorter bars are Exploring Areas, mid-length bars are Secondary Interest Areas, and the longest bars are Key Interest Areas.";
    cy = drawBox(cy, {
      fill: '#F5F3FF', draw: '#C4B5FD', radius: 2,
      titleText: 'Career Interest Graph:', titleSize: 8, titleColor: '#1F2937',
      bodyText: cpiGNote, bodySize: 7, bodyColor: '#374151', lineH: 4.5,
      paddingTop: 6, paddingBottom: 5, gap: 4,
    });

    cy = indicativeCallout(cy);
    // Interest insight (AI) — sits above the cluster table when present.
    if (aiHas('interest_profile')) {
      if (cy + 14 > H - 16) {
        doc.addPage();
        sectionHeader('Interest Insight (AI)', '');
        studentBar(20);
        cy = 32;
      }
      txt('Interest Insight (AI)', 14, cy, { size: 9, color: '#1F2937', bold: true });
      cy += 5;
      cy = drawProse(aiText('interest_profile', ''), cy, {
        size: 7.5, color: '#374151', lineH: 4.2, paraGap: 3,
        maxW: W - 28, x: 14, bottom: H - 14, pageStart: 32,
        onNewPage: function () {
          sectionHeader('Career Interest (continued)', '');
          studentBar(20);
        },
      });
      cy += 3;
    }

    txt('Interest Cluster Summary', 14, cy, { size: 9, color: '#1F2937', bold: true });
    cy += 5;
    const clusterHeaders = ['Cluster', 'Top Domain', 'Interpretation', 'Sample Career Pathways'];
    const cColX = [10, 35, 70, 135];
    const cColW = [25, 35, 65, 65];
    rect(10, cy, W - 20, 7, PURPLE, null, 0);
    clusterHeaders.forEach((h, i) => txt(h, cColX[i] + 2, cy + 5, { size: 8, color: WHITE, bold: true }));
    cy += 7;

    // Keys MUST match CPI_AREAS labels exactly (defined elsewhere in app.js).
    const careerPathwayMap = {
      'Science & Technology':         'Engineering · CS · Research · AI/ML',
      'Health & Medical Science':     'Medicine · Allied Health · Public Health',
      'Language & Communication':     'Journalism · Content · Linguistics · PR',
      'Creative Design & Perf. Arts': 'UX/UI · Animation · Visual Arts · Performing Arts',
      'Legal & Judiciary':            'Law · Policy · Civil Services',
      'Administration & Governance':  'Public Admin · Management · Civil Services',
      'Education & Research':         'Teaching · Academia · Research · EdTech',
      'Business & Entrepreneurship':  'Business · Finance · Startups · Consulting',
      'People & Service':             'Counselling · Social Work · NGO · HR',
      'Sports & Physical Perf.':      'Sports Science · Coaching · Athletics',
    };
    const aiCareerTable = (ai && Array.isArray(ai.career_table)) ? ai.career_table : null;
    const clusters = ['Primary', 'Secondary', 'Exploratory'].map((tag, i) => {
      const item = top3[i] || { label: 'Still exploring — retake or discuss with your counsellor', score: 0 };
      let pathways = careerPathwayMap[item.label] || 'Multiple aligned pathways';
      // Pull from AI career_table when available — prefer matched cluster name,
      // else fall back to positional row.
      if (aiCareerTable) {
        const matched = aiCareerTable.find(r => (r.cluster || '').toLowerCase().includes((item.label || '').split(' ')[0].toLowerCase()))
                        || aiCareerTable[i];
        if (matched) {
          pathways = matched.career || matched.pathways || matched.careers || pathways;
        }
      }
      const interp = i === 0 ? 'Areas you may be most naturally drawn toward based on current interests'
                   : i === 1 ? 'Additional areas that may also align well and offer related pathways'
                             : 'Emerging areas worth exploring through exposure and learning';
      return [tag, item.label, interp, pathways];
    });
    clusters.forEach((row, ri) => {
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      const interpL = doc.splitTextToSize(row[2], cColW[2] - 4);
      const pathsL  = doc.splitTextToSize(row[3], cColW[3] - 4);
      const rowH = Math.max(14, 8 + Math.max(interpL.length, pathsL.length) * 4.5);
      const rowBg = ri % 2 === 0 ? WHITE : LIGHT_GRAY;
      rect(10, cy, W - 20, rowH, rowBg, '#E5E7EB', 0);
      pill(row[0], cColX[0] + 2, cy + rowH / 2 + 2, ri === 0 ? PURPLE : ri === 1 ? PURPLE_LIGHT : '#6B7280', WHITE, 20, 6);
      txt(row[1], cColX[1] + 2, cy + rowH / 2, { size: 8, color: '#1F2937', bold: true, maxWidth: cColW[1] - 4 });
      txt(interpL.join('\n'), cColX[2] + 2, cy + 6, { size: 7, color: GRAY });
      txt(pathsL.join('\n'),  cColX[3] + 2, cy + 6, { size: 7, color: '#374151' });
      cy += rowH;
    });

    // Internal motivators (AI) — short prose block below the cluster table.
    if (aiHas('internal_motivators')) {
      cy += 4;
      if (cy + 14 > H - 16) {
        doc.addPage();
        sectionHeader('What Drives You (AI)', '');
        studentBar(20);
        cy = 32;
      }
      txt('What Drives You (AI)', 14, cy, { size: 9, color: '#1F2937', bold: true });
      cy += 5;
      cy = drawProse(aiText('internal_motivators', ''), cy, {
        size: 7.5, color: '#374151', lineH: 4.2, paraGap: 3,
        maxW: W - 28, x: 14, bottom: H - 14, pageStart: 32,
        onNewPage: function () {
          sectionHeader('Career Interest (continued)', '');
          studentBar(20);
        },
      });
    }

    footer(6);

    /* ═══════════════════════════════════════════════
       PAGE 7 — SEAA PROFILE
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Social Emotional Academic Adjustment Profile', 'Adjustment and readiness indicators across social, emotional and academic functioning — identifying strengths, developing areas and support needs');
    studentBar(20);
    cy = 32;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill('#2ECC71'); doc.circle(18,  cy + 3.5, 2.5, 'F'); txt('Well-Established',   22,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill('#F5A623'); doc.circle(74,  cy + 3.5, 2.5, 'F'); txt('Developing', 78,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill('#FF6B9D'); doc.circle(134, cy + 3.5, 2.5, 'F'); txt('Needs Support',   138, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 10;

    txt('SEAA Readiness by Domain', 14, cy + 3, { size: 8, color: GRAY, bold: true });
    cy += 6;

    const seaDescs = [
      'Assesses peer relationships, social confidence, and ability to interact and collaborate effectively.',
      'Evaluates emotional awareness, regulation, resilience, and overall mental well-being.',
      'Measures study habits, focus, motivation, and the ability to manage academic responsibilities.',
    ];
    seaCards.forEach((c, i) => {
      const px = 10 + i * 66;
      doc.setFontSize(5.5); doc.setFont('helvetica', 'normal');
      const dl = doc.splitTextToSize(seaDescs[i], 54);
      // Arc colour follows the SAME readiness category as the status label
      // (gender-normed), so the card colour never contradicts its own text —
      // e.g. a "Developing Readiness" card is always orange, never green.
      const arcColor = c.label === 'Strong Readiness' ? '#2ECC71'
                     : c.label === 'Developing Readiness' ? '#F5A623'
                     : '#FF6B9D';
      const cardH = Math.max(52, 14 + dl.length * 3.8 + 28);
      rect(px, cy, 62, cardH, '#FAFAFA', arcColor, 2);
      txt(c.title, px + 4, cy + 7, { size: 7.5, color: arcColor, bold: true, maxWidth: 54 });
      txt(dl.join('\n'), px + 4, cy + 13, { size: 5.5, color: GRAY });
      // Arc gauge
      const cx2 = px + 31, arcY = cy + cardH - 16, r = 11;
      // Grey background arc (180° → 360°)
      doc.setDrawColor(220, 220, 220); doc.setLineWidth(2.5);
      for (let a = 180; a <= 360; a += 5) {
        const rad1 = (a * Math.PI) / 180, rad2 = ((a + 5) * Math.PI) / 180;
        doc.line(cx2 + r * Math.cos(rad1), arcY + r * Math.sin(rad1), cx2 + r * Math.cos(rad2), arcY + r * Math.sin(rad2));
      }
      // Coloured fill — proportional to score (high score = more filled = more concern)
      const fillDeg = Math.round((c.score / 20) * 180);
      const [fr, fg, fb] = hex2rgb(arcColor);
      doc.setDrawColor(fr, fg, fb); doc.setLineWidth(2.5);
      for (let a = 180; a <= 180 + fillDeg; a += 5) {
        const rad1 = (a * Math.PI) / 180, rad2 = ((a + 5) * Math.PI) / 180;
        doc.line(cx2 + r * Math.cos(rad1), arcY + r * Math.sin(rad1), cx2 + r * Math.cos(rad2), arcY + r * Math.sin(rad2));
      }
      doc.setLineWidth(0.3);
      txt(c.score + '/20', cx2, arcY + 3, { size: 7, color: arcColor, bold: true, align: 'center' });
      txt(c.displayLabel, cx2, arcY + 8, { size: 5, color: arcColor, align: 'center' });
      seaCards[i]._cardH = cardH;
    });
    cy += Math.max(...seaCards.map(c => c._cardH || 52)) + 3;

    // Legend explaining the arc gauge
    rect(10, cy, W - 20, 22, LIGHT_GRAY, null, 2);
    txt('How to read the arc:', 14, cy + 5, { size: 6.5, color: '#1F2937', bold: true });
    txt('The arc fills as support needs rise. Readiness bands are set against age- and gender-adjusted norms.', 14, cy + 10, { size: 6, color: GRAY, maxWidth: W - 28 });
    // Colour legend dots — categories match the status labels on each card.
    setFill('#2ECC71'); doc.circle(14, cy + 17, 2, 'F');
    txt('Well-Established', 18, cy + 18, { size: 6, color: '#1F2937' });
    setFill('#F5A623'); doc.circle(66, cy + 17, 2, 'F');
    txt('Developing', 70, cy + 18, { size: 6, color: '#1F2937' });
    setFill('#FF6B9D'); doc.circle(126, cy + 17, 2, 'F');
    txt('Needs Support', 130, cy + 18, { size: 6, color: '#1F2937' });
    cy += 26;

    cy = drawBox(cy, {
      fill: LIGHT_GRAY, radius: 2,
      bodyText: 'Scores are based on a 20-point scale per domain. Lower scores reflect stronger adjustment and readiness.',
      bodySize: 7.5, bodyColor: GRAY, lineH: 4.5, paddingTop: 5, paddingBottom: 5, gap: 6,
    });

    txt('Adjustment Snapshot', 14, cy, { size: 10, color: '#1F2937', bold: true });
    txt('A quick view of your current zone, key strengths and focus areas.', 14, cy + 5, { size: 8, color: GRAY });
    cy += 10;

    const seaSnapshot = [
      { strengthsByLabel: { 'Strong Readiness':['Builds positive peer relationships','Comfortable in group settings'], 'Developing Readiness':['Adapts well in peer settings','Maintains basic interactions'], 'Support Needed':['Shows readiness to engage','Open to building peer connections'] },
        focusByLabel:     { 'Strong Readiness':['Lead group activities','Mentor others'],                                   'Developing Readiness':['Build self-confidence','Manage peer influence'],            'Support Needed':['Build social confidence','Strengthen peer relationships'] } },
      { strengthsByLabel: { 'Strong Readiness':['Manages emotions effectively','Handles stress with composure'],            'Developing Readiness':['Demonstrates emotional awareness','Able to express feelings'], 'Support Needed':['Aware of emotional patterns','Open to emotional support'] },
        focusByLabel:     { 'Strong Readiness':['Sustain wellbeing routines','Help peers regulate'],                        'Developing Readiness':['Strengthen regulation','Reduce stress and worry'],          'Support Needed':['Build emotional regulation','Reduce stress and anxiety'] } },
      { strengthsByLabel: { 'Strong Readiness':['Strong study habits','Engaged learner'],                                   'Developing Readiness':['Willingness to learn','Engages in assigned tasks'],          'Support Needed':['Capable when supported','Open to learning strategies'] },
        focusByLabel:     { 'Strong Readiness':['Stretch learning goals','Take on independent projects'],                   'Developing Readiness':['Improve consistency','Time management'],                    'Support Needed':['Build study consistency','Develop focus & motivation'] } },
    ];
    seaSnapshot.forEach((s, i) => {
      const c = seaCards[i];
      const px = 10 + i * 66;
      const bgByLabel = c.label === 'Strong Readiness' ? '#F0FDF4' : c.label === 'Developing Readiness' ? '#F5F3FF' : '#FFF1F2';
      const strengths = s.strengthsByLabel[c.label] || [];
      const focuses   = s.focusByLabel[c.label] || [];
      // compute wrapped lines for each bullet
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
      const sLines = strengths.map(it => doc.splitTextToSize('• ' + it, 54));
      const fLines = focuses.map(it => doc.splitTextToSize('• ' + it, 54));
      const sH = sLines.reduce((t, l) => t + l.length * 3.8, 0);
      const fH = fLines.reduce((t, l) => t + l.length * 3.8, 0);
      const cardH = Math.max(38, 20 + sH + 8 + fH + 6);
      rect(px, cy, 62, cardH, bgByLabel, c.color, 2);
      txt(c.title, px + 4, cy + 7, { size: 7.5, color: c.color, bold: true });
      pill(c.displayLabel, px + 4, cy + 13, c.color, WHITE, 54, 6);
      txt('Strengths', px + 4, cy + 20, { size: 7, color: '#1F2937', bold: true });
      let by = cy + 24;
      sLines.forEach(ls => { txt(ls.join('\n'), px + 4, by, { size: 6.5, color: GRAY }); by += ls.length * 3.8; });
      line(px + 4, by + 1, px + 58, by + 1, '#E5E7EB', 0.2);
      by += 4;
      txt('Focus Areas', px + 4, by, { size: 7, color: '#1F2937', bold: true });
      by += 4;
      fLines.forEach(ls => { txt(ls.join('\n'), px + 4, by, { size: 6.5, color: GRAY }); by += ls.length * 3.8; });
      seaSnapshot[i]._cardH = cardH;
    });
    cy += Math.max(...seaSnapshot.map(s => s._cardH || 38)) + 5;

    // Dimension Summary + wellbeing guidance move to a fresh page so the SEAA
    // gauges page isn't overfull while the wellbeing tail sits near-empty.
    doc.addPage();
    sectionHeader('Social Emotional Academic Adjustment Profile', 'Dimension summary and personalised wellbeing guidance');
    studentBar(20);
    cy = 32;

    txt('Dimension Summary', 14, cy, { size: 9, color: '#1F2937', bold: true });
    cy += 7;
    const dimHeaders = ['Dimension', 'Status', 'Interpretation'];
    const dimColX = [10, 65, 110];
    rect(10, cy, W - 20, 8, PURPLE, null, 0);
    dimHeaders.forEach((h, i) => txt(h, dimColX[i] + 2, cy + 5.5, { size: 8, color: WHITE, bold: true }));
    cy += 8;
    const interpByLabel = {
      'Strong Readiness':     'Strong adjustment with consistent positive functioning. Continue practices that sustain wellbeing.',
      'Developing Readiness': 'Emerging readiness; targeted strategies and consistent practice will strengthen this area.',
      'Support Needed':       'Higher concern — structured support and guidance are recommended to build readiness.',
    };
    seaCards.forEach((c, ri) => {
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
      const interpL = doc.splitTextToSize(interpByLabel[c.label] || 'A snapshot of current readiness in this area — it can strengthen with support and practice.', 88);
      const rowH = Math.max(20, 11 + interpL.length * 4.5);
      rect(10, cy, W - 20, rowH, ri % 2 === 0 ? WHITE : LIGHT_GRAY, '#E5E7EB', 0);
      txt(c.title, dimColX[0] + 2, cy + rowH / 2 + 1, { size: 8, color: '#1F2937' });
      pill(c.displayLabel, dimColX[1] + 2, cy + rowH / 2 + 1, c.color, WHITE, 42, 6);
      txt(interpL.join('\n'), dimColX[2] + 2, cy + rowH / 2 - (interpL.length - 1) * 2 + 1, { size: 6.5, color: GRAY });
      cy += rowH;
    });
    cy += 12;

    if (aiHas('wellbeing_guidance')) {
      if (cy + 14 > H - 16) {
        doc.addPage();
        sectionHeader('Wellbeing Guidance (AI)', '');
        studentBar(20);
        cy = 32;
      }
      txt('Wellbeing Guidance (AI)', 14, cy, { size: 9, color: '#1F2937', bold: true });
      cy += 7;
      cy = drawProse(aiText('wellbeing_guidance', ''), cy, {
        size: 8, color: '#374151', lineH: 4.8, paraGap: 4,
        maxW: W - 28, x: 14, bottom: H - 16, pageStart: 32,
        onNewPage: function () {
          sectionHeader('SEAA Profile (continued)', '');
          studentBar(20);
        },
      });
      cy += 8;
    } else {
      txt('Growth Support Pathway', 14, cy, { size: 9, color: '#1F2937', bold: true });
      cy += 5;
      const gspItems = [
        { step: 'Awareness', desc: 'Develop understanding of current strengths and growth areas.' },
        { step: 'Action',    desc: 'Practice routines and strategies that support improvement.'   },
        { step: 'Support',   desc: 'Use guidance and resources to sustain progress.'              },
      ];
      gspItems.forEach((g, i) => {
        const px = 10 + i * 66;
        rect(px, cy, 62, 18, LIGHT_GRAY, '#D1D5DB', 2);
        txt(g.step, px + 4, cy + 7, { size: 8.5, color: PURPLE, bold: true });
        doc.setFont('helvetica','normal'); doc.setFontSize(7); // measure at draw size
        const dl = doc.splitTextToSize(g.desc, 54);
        txt(dl.join('\n'), px + 4, cy + 13, { size: 7, color: GRAY });
      });
      cy += 22;

      rect(10, cy, W - 20, 8, LIGHT_GRAY, null, 2);
      txt('Consistent support, positive reinforcement, and collaboration help students grow with confidence.', 14, cy + 5, { size: 7.5, color: GRAY });
      cy += 12;
    }

    // ── Growth Support Pathway (Awareness -> Action -> Support) ──
    // Present in the ideal template's SEAA page; was missing from the report.
    txt('Growth Support Pathway', 14, cy + 2, { size: 9, color: '#1F2937', bold: true });
    cy += 7;
    const gsp = [
      { t: 'Awareness', d: 'Develop understanding of current strengths and growth areas.' },
      { t: 'Action',    d: 'Practice routines and strategies that support improvement.' },
      { t: 'Support',   d: 'Use guidance and resources to sustain progress.' },
    ];
    gsp.forEach((g, i) => {
      const px = 10 + i * 64;
      rect(px, cy, 60, 22, WHITE, '#E5E7EB', 2);
      txt(g.t, px + 4, cy + 7, { size: 8, color: PURPLE, bold: true });
      doc.setFont('helvetica','normal'); doc.setFontSize(6.5);
      const dl = doc.splitTextToSize(g.d, 52);
      txt(dl.join('\n'), px + 4, cy + 12, { size: 6.5, color: GRAY });
    });
    cy += 26;
    rect(10, cy, W - 20, 9, LIGHT_GRAY, null, 1);
    txt('Consistent support, positive reinforcement, and collaboration help students grow with confidence.', 14, cy + 6, { size: 7.5, color: '#374151' });
    cy += 13;

    const seaIndText = 'These results provide a snapshot for guidance purposes only. They reflect the current state at the time of assessment and may evolve over time.';
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    const seaIndL = doc.splitTextToSize(seaIndText, W - 32);
    const seaIndH = 6 + seaIndL.length * 4.5;
    if (cy + seaIndH + 4 > H - 14) { doc.addPage(); sectionHeader('Social Emotional Academic Adjustment Profile', 'Adjustment and readiness indicators'); studentBar(20); cy = 32; }
    rect(10, cy, W - 20, seaIndH, '#F5F3FF', PURPLE, 2);
    doc.setLineWidth(1.5); setDraw(PURPLE); doc.line(10, cy, 10, cy + seaIndH);
    txt(seaIndL.join('\n'), 15, cy + 6, { size: 7.5, color: '#374151' });
    cy += seaIndH + 4;

    footer(7);

    /* ═══════════════════════════════════════════════
       PAGES 8–9 — GAP ANALYSIS
    ═══════════════════════════════════════════════ */
    const findApt  = (name) => aptitude8.find(a => a.name === name) || { name: name, stanine: 5 };
    const findPers = (name) => personality9.find(p => p.name === name) || { name: name, stanine: 5 };
    const seaToReadiness9 = (key) => {
      const ps = sea.domScores[key] || 10;
      return Math.max(1, Math.min(9, Math.round(9 - (ps / 20) * 8)));
    };

    // Maps canonical CPI cluster label → most relevant aptitude / personality
    // / SEAA dimension to highlight on the gap analysis chart.
    // Keys MUST match CPI_AREAS labels exactly.
    const pathwayMappings = {
      'Science & Technology':         { apt:'Numerical Ability',     pers:'Curiosity & Learning',    sea:'A' },
      'Health & Medical Science':     { apt:'Health & Medical Apt.', pers:'Patience & Resilience',   sea:'E' },
      'Language & Communication':     { apt:'Verbal Ability',        pers:'Curiosity & Learning',    sea:'S' },
      'Creative Design & Perf. Arts': { apt:'Spatial Ability',       pers:'Creativity & Innovation', sea:'E' },
      'Legal & Judiciary':            { apt:'Legal Studies Ability', pers:'Ethical Awareness',       sea:'A' },
      'Administration & Governance':  { apt:'Abstract Reasoning',    pers:'Leadership & Motivation', sea:'A' },
      'Education & Research':         { apt:'Verbal Ability',        pers:'Discipline & Sincerity',  sea:'A' },
      'Business & Entrepreneurship':  { apt:'Numerical Ability',     pers:'Leadership & Motivation', sea:'A' },
      'People & Service':             { apt:'Verbal Ability',        pers:'Ethical Awareness',       sea:'S' },
      'Sports & Physical Perf.':      { apt:'Mechanical Ability',    pers:'Discipline & Sincerity',  sea:'A' },
    };
    const pathwayDefaults = { apt:'Verbal Ability', pers:'Discipline & Sincerity', sea:'A' };

    const top4Pathways = cpiAll.slice().sort((a, b) => b.score - a.score).slice(0, 4);
    const pathwayGaps = top4Pathways.map((p, idx) => {
      const m = pathwayMappings[p.label] || pathwayDefaults;
      const aptD = findApt(m.apt); const persD = findPers(m.pers);
      const seaR = seaToReadiness9(m.sea);
      const seaName = m.sea === 'S' ? 'Social Readiness' : m.sea === 'E' ? 'Emotional Readiness' : 'Academic Readiness';
      return {
        title: 'Pathway ' + (idx + 1) + ' — ' + p.label,
        factors: [
          ['Aptitude Factor',    m.apt,   aptD.stanine,  7],
          ['Personality Factor', m.pers,  persD.stanine, 7],
          ['SEAA Factor',        seaName, seaR,          6],
        ],
      };
    });

    const drawPathwayGap = (pg, startY, fs) => {
      fs = fs || 28;
      rect(10, startY, W - 20, 8, PURPLE, null, 2);
      txt(pg.title, 14, startY + 6, { size: 9, color: WHITE, bold: true, maxWidth: W - 28 });
      let gy = startY + 14;
      pg.factors.forEach((f) => {
        const fType = f[0], fLabel = f[1], current = f[2], required = f[3];
        const barX3 = 14, barW3 = W - 28;
        txt(fType, 14, gy, { size: 7.5, color: GRAY, bold: true });
        txt(fLabel, 14, gy + 5, { size: 8, color: '#1F2937' });
        // Current — label left, value right-aligned on the same line, bar below
        txt('Your Current Level', barX3, gy + 11, { size: 6.5, color: PURPLE });
        txt(stanineBand(current), W - 14, gy + 11, { size: 7, color: PURPLE, bold: true, align: 'right' });
        rect(barX3, gy + 13, barW3, 4, '#E5E7EB', null, 1);
        rect(barX3, gy + 13, (current / 9) * barW3, 4, PURPLE, null, 1);
        // Required — label left, value right-aligned on the same line, bar below
        txt('Typically Required', barX3, gy + 22, { size: 6.5, color: GRAY });
        txt(stanineBand(required), W - 14, gy + 22, { size: 7, color: '#6B7280', bold: true, align: 'right' });
        rect(barX3, gy + 24, barW3, 4, '#E5E7EB', null, 1);
        rect(barX3, gy + 24, (required / 9) * barW3, 4, '#9CA3AF', null, 1);
        gy += fs;
      });
      return gy;
    };
    // Choose factor spacing so the two pathways on a page fill it evenly.
    const gapFactorSpacing = (startY, pgA, pgB) => {
      const nF = (pgA ? pgA.factors.length : 0) + (pgB ? pgB.factors.length : 0) || 6;
      const avail = (H - 16) - startY - 16 /*two title bars*/ - 8 /*inter-pathway gap*/;
      return Math.max(30, Math.min(avail / nF, 40));
    };

    doc.addPage();
    sectionHeader('Gap Analysis', 'Adjustment and readiness indicators across social, emotional and academic functioning — identifying strengths, developing areas and support needs');
    studentBar(20);
    cy = 32;
    const gapNote = 'For each recommended pathway, 3 key parameters are compared: 1 Aptitude factor, 1 Personality factor, and 1 SEAA readiness factor. Purple bars show your current level. Grey bars show the level typically required for that pathway.';
    doc.setFont('helvetica','normal'); doc.setFontSize(8); // measure at draw size
    const gnL = doc.splitTextToSize(gapNote, W - 28);
    txt(gnL.join('\n'), 14, cy + 4, { size: 8, color: '#374151' });
    cy += gnL.length * 5 + 6;
    {
      const fs1 = gapFactorSpacing(cy, pathwayGaps[0], pathwayGaps[1]);
      cy = drawPathwayGap(pathwayGaps[0] || { title:'Pathway 1', factors:[] }, cy, fs1);
      cy += 8;
      cy = drawPathwayGap(pathwayGaps[1] || { title:'Pathway 2', factors:[] }, cy, fs1);
    }
    footer(8);

    doc.addPage();
    sectionHeader('Gap Analysis', 'Adjustment and readiness indicators across social, emotional and academic functioning — identifying strengths, developing areas and support needs');
    studentBar(20);
    cy = 32;
    {
      const fs2 = gapFactorSpacing(cy, pathwayGaps[2], pathwayGaps[3]);
      cy = drawPathwayGap(pathwayGaps[2] || { title:'Pathway 3', factors:[] }, cy, fs2);
      cy += 8;
      cy = drawPathwayGap(pathwayGaps[3] || { title:'Pathway 4', factors:[] }, cy, fs2);
    }
    footer(9);

    /* ═══════════════════════════════════════════════
       PAGE 10 — INTEGRATED CAREER FIT MATRIX
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains');
    studentBar(20);
    cy = 30;

    const matrixNote = 'This matrix combines your Interest, Aptitude, Personality and Wellbeing readiness to calculate an overall alignment level for each career cluster. Strong = well aligned across all domains. Emerging = developing alignment. Exploratory = worth exploring with more exposure.';
    doc.setFont('helvetica','normal'); doc.setFontSize(8); // measure at draw size
    const mnL = doc.splitTextToSize(matrixNote, W - 28);
    txt(mnL.join('\n'), 14, cy + 4, { size: 8, color: '#374151' });
    cy += mnL.length * 5 + 4;

    const lvlFromStanine  = (s)  => s >= 7 ? 'High' : s >= 4 ? 'Moderate' : 'Low';
    const lvlFromInterest = (sc) => sc >= 15 ? 'High' : sc >= 8 ? 'Moderate' : 'Low';

    // Source 1: AI career_table (preferred — real career names, fit ratings,
    // and a numeric suitability_pct).
    // Source 2: score-driven cluster matrix (fallback when no AI report).
    const aiTable10 = (ai && Array.isArray(ai.career_table) && ai.career_table.length) ? ai.career_table.slice(0, 6) : null;

    let matrixRowsLive;
    if (aiTable10) {
      // AI rows already carry career, cluster, interest_fit, aptitude_fit,
      // personality_fit, suitability_pct, rationale.
      matrixRowsLive = aiTable10.map((r) => {
        const cap = (s) => {
          const v = String(s || '').trim();
          if (!v) return 'Moderate';
          const lower = v.toLowerCase();
          if (lower === 'high' || lower === 'h') return 'High';
          if (lower === 'low'  || lower === 'l') return 'Low';
          return 'Moderate';
        };
        const interest = cap(r.interest_fit);
        const aptL     = cap(r.aptitude_fit);
        const persL    = cap(r.personality_fit);
        // SEAA fit isn't in the AI schema — use the student's OVERALL SEAA
        // readiness (average across S/E/A) so every row reflects the actual
        // wellbeing profile, not an arbitrary single dimension.
        const seaR = Math.round((seaToReadiness9('S') + seaToReadiness9('E') + seaToReadiness9('A')) / 3);
        const seaL = lvlFromStanine(seaR);
        const pct  = (typeof r.suitability_pct === 'number') ? Math.round(r.suitability_pct)
                   : (parseFloat(r.suitability_pct) || 0);
        const align = pct >= 80 ? 'Strong Fit' : pct >= 65 ? 'Emerging Fit' : 'Exploratory';
        const careerName = r.career || r.cluster || '—';
        return [careerName, interest, aptL, persL, seaL, align, pct, r.cluster || '', r.rationale || ''];
      });
    } else {
      const top6 = cpiAll.slice().sort((a, b) => b.score - a.score).slice(0, 6);
      matrixRowsLive = top6.map((p) => {
        const m = pathwayMappings[p.label] || pathwayDefaults;
        const aptStn  = findApt(m.apt).stanine;
        const persStn = findPers(m.pers).stanine;
        // Same overall-SEAA approach for the score-driven fallback.
        const seaR    = Math.round((seaToReadiness9('S') + seaToReadiness9('E') + seaToReadiness9('A')) / 3);
        const interest = lvlFromInterest(p.score);
        const aptL     = lvlFromStanine(aptStn);
        const persL    = lvlFromStanine(persStn);
        const seaL     = lvlFromStanine(seaR);
        const sc = (interest === 'High' ? 3 : interest === 'Moderate' ? 2 : 1) +
                   (aptL     === 'High' ? 3 : aptL     === 'Moderate' ? 2 : 1) +
                   (persL    === 'High' ? 3 : persL    === 'Moderate' ? 2 : 1) +
                   (seaL     === 'High' ? 2 : seaL     === 'Moderate' ? 1 : 0);
        const align = sc >= 9 ? 'Strong Fit' : sc >= 6 ? 'Emerging Fit' : 'Exploratory';
        const pct = Math.round((sc / 11) * 100);
        return [p.label, interest, aptL, persL, seaL, align, pct, '', ''];
      });
    }

    const mHeaders = ['Career Cluster', 'Interest', 'Aptitude', 'Personality', 'SEAA', 'Alignment Level'];
    const mColX = [10, 62, 88, 114, 140, 158];
    const mColW = [52, 26, 26, 26, 18, 42];
    rect(10, cy, W - 20, 7, PURPLE, null, 0);
    mHeaders.forEach((h, i) => txt(h, mColX[i] + 2, cy + 5, { size: 7.5, color: WHITE, bold: true }));
    cy += 7;

    matrixRowsLive.forEach((row, ri) => {
      rect(10, cy, W - 20, 9, ri % 2 === 0 ? WHITE : LIGHT_GRAY, '#E5E7EB', 0);
      txt(row[0], mColX[0] + 2, cy + 6, { size: 7.5, color: '#1F2937', maxWidth: mColW[0] - 4 });
      const levelColors = { High: GREEN, Moderate: '#3B82F6', Low: PINK };
      [1, 2, 3, 4].forEach((ci) => pill(row[ci], mColX[ci] + 1, cy + 6, levelColors[row[ci]] || GRAY, WHITE, mColW[ci] - 4, 6));
      // Last column shows coloured dot + alignment label (matches template)
      const alignLabel = row[5]; // 'Strong Fit', 'Emerging Fit', 'Exploratory'
      const dotColor = alignLabel.indexOf('Strong') >= 0 ? PURPLE : alignLabel.indexOf('Emerging') >= 0 ? PURPLE_LIGHT : GRAY;
      const dotX = mColX[5] + 3, dotY = cy + 5.5;
      setFill(dotColor); doc.circle(dotX, dotY, 2, 'F');
      txt(alignLabel, dotX + 4, cy + 6, { size: 7, color: dotColor, bold: true, maxWidth: mColW[5] - 8 });
      cy += 9;
    });
    cy += 4;

    const strongFits   = matrixRowsLive.filter(r => r[5].indexOf('Strong') >= 0).map(r => r[0]);
    const emergingFits = matrixRowsLive.filter(r => r[5].indexOf('Emerging') >= 0).map(r => r[0]);
    const exploratory  = matrixRowsLive.filter(r => r[5].indexOf('Exploratory') >= 0).map(r => r[0]);

    // If no rows fell into Emerging (common in the score-driven fallback when
    // scores cluster at Strong or Exploratory), populate Emerging from rows
    // whose suitability_pct is nearest the 65–79 band, or fall back to the
    // next-best Strong/Exploratory rows so the box is never left empty.
    const emergingFitsDisplay = emergingFits.length
      ? emergingFits
      : (() => {
          // Sort by pct descending; pick rows that didn't make Strong
          const nonStrong = matrixRowsLive.filter(r => r[5].indexOf('Strong') < 0);
          if (nonStrong.length) return nonStrong.slice(0, 2).map(r => r[0]);
          // All are Strong — show the weakest strong rows as emerging candidates
          return matrixRowsLive.slice().sort((a, b) => a[6] - b[6]).slice(0, 2).map(r => r[0]);
        })();
    const fitBoxes = [
      { title:'Strong Fit Pathways',    color: PURPLE,       bg:'#F5F3FF',   items: strongFits          },
      { title:'Emerging Fit Pathways',  color: PURPLE_LIGHT, bg:'#EDE9FE',   items: emergingFitsDisplay },
      { title:'Exploratory Pathways',   color: GRAY,         bg: LIGHT_GRAY, items: exploratory         },
    ];
    fitBoxes.forEach((fb, i) => {
      const px = 10 + i * 66;
      doc.setFontSize(7); doc.setFont('helvetica', 'normal');
      // Guaranteed content per tier — never an empty dash. Strong empty means
      // the best current alignment is still developing; say that and point to
      // the top emerging pathway. Emerging/Exploratory get equivalent framing.
      const _fallbacks = {
        'Strong Fit Pathways':   emergingFitsDisplay.length
            ? ['None yet — closest: ' + emergingFitsDisplay[0], 'Alignment grows with exposure and practice.']
            : ['Alignment is still developing across pathways.'],
        'Emerging Fit Pathways': ['No pathway at this tier yet — see Exploratory options.'],
        'Exploratory Pathways':  ['Broad exploration recommended this year.'],
      };
      const items = fb.items.length ? fb.items : (_fallbacks[fb.title] || ['Developing — revisit after the next assessment.']);
      const itemLines = items.map(it => doc.splitTextToSize(it, 52));
      const boxH = Math.max(18, 11 + itemLines.reduce((t, ls) => t + ls.length * 4, 0) + 4);
      rect(px, cy, 62, boxH, fb.bg, fb.color, 2);
      // Draw dot + title
      setFill(fb.color); doc.circle(px + 5, cy + 6.5, 2, 'F');
      txt(fb.title, px + 9, cy + 7, { size: 8, color: fb.color, bold: true, maxWidth: 50 });
      let iy = cy + 12;
      itemLines.forEach(ls => { txt(ls.join('\n'), px + 4, iy, { size: 7, color: '#374151' }); iy += ls.length * 4; });
      fitBoxes[i]._boxH = boxH;
    });
    cy += Math.max(...fitBoxes.map(f => f._boxH || 18)) + 4;

    // Recommended Subject Pathways — the template's 01/02/03 chevron cards.
    {
      txt('RECOMMENDED SUBJECT PATHWAYS', 14, cy, { size: 9, color: '#1F2937', bold: true });
      cy += 6;
      const subjectMap = {
        'Science & Technology':         'PCM + Computer Science',
        'Health & Medical Science':     'PCB + Psychology',
        'Language & Communication':     'Languages + Media Studies',
        'Creative Design & Perf. Arts': 'Arts + Design + Performing Arts',
        'Legal & Judiciary':            'Humanities + Political Science',
        'Administration & Governance':  'Humanities + Economics + Pol. Science',
        'Education & Research':         'Humanities + Subject Specialisation',
        'Business & Entrepreneurship':  'Mathematics + Economics + Business',
        'People & Service':             'Humanities + Psychology + Sociology',
        'Sports & Physical Perf.':      'PE + Biology + Psychology',
      };
      const recPrimary = (strongFits[0] || emergingFitsDisplay[0] || (top3[0] && top3[0].label) || 'Multidisciplinary');
      const recAlt     = (strongFits[1] || emergingFitsDisplay[0] || (top3[1] && top3[1].label) || 'Multidisciplinary');
      const recExpl    = (exploratory[0] || (top3[2] && top3[2].label) || 'Multidisciplinary');
      const pathways = [
        { num:'01', fit:'Strong Fit',      type:'(Primary Pathway)',  subject: subjectMap[recPrimary] || 'Multidisciplinary stream', desc:'Highest alignment with your assessed strengths and top fit pathway.', color: PURPLE },
        { num:'02', fit:'Alternate Fit',   type:'(Related Pathway)',  subject: subjectMap[recAlt]     || 'Multidisciplinary stream', desc:'Supports closely related pathways while keeping multiple career options open.', color: PURPLE_LIGHT },
        { num:'03', fit:'Exploration Fit', type:'(Flexible Pathway)', subject: subjectMap[recExpl]    || 'Humanities + Psychology',   desc:'Maintains broader opportunities for exploration and evolving interests.', color: '#6B7280' },
      ];
      pathways.forEach((p) => {
        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
        const dL = doc.splitTextToSize(p.desc, W - 132);
        const pH = Math.max(22, 12 + dL.length * 4.5);
        if (cy + pH + 3 > H - 16) {
          doc.addPage();
          sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains');
          studentBar(20); cy = 32;
        }
        rect(10, cy, W - 20, pH, '#FAFAFA', p.color, 2);
        setFill(p.color); doc.roundedRect(10, cy, 18, pH, 2, 2, 'F');
        txt(p.num, 19, cy + pH / 2 + 2, { size: 12, color: WHITE, bold: true, align: 'center' });
        txt(p.fit, 32, cy + 8, { size: 9.5, color: p.color, bold: true });
        txt(p.type, 32, cy + 13, { size: 7, color: GRAY });
        txt(p.subject, 32, cy + 19, { size: 8.5, color: '#1F2937', bold: true, maxWidth: 82 });
        txt(dL.join('\n'), 120, cy + pH / 2 - (dL.length - 1) * 2, { size: 7.5, color: GRAY, maxWidth: W - 132 });
        cy += pH + 5;
      });
      if (cy + 12 < H - 16) {
        rect(10, cy, W - 20, 11, '#F3F4F6', null, 2);
        txt('PLEASE NOTE:', 14, cy + 5, { size: 7, color: '#1F2937', bold: true });
        txt('Subject pathways are indicative recommendations, not final. Explore options aligned with your aptitude, interests, academics and goals.', 40, cy + 5, { size: 6.5, color: GRAY, maxWidth: W - 54 });
        cy += 15;
      }
    }

    // Tips to Strengthen Aptitude — kept together as one block (never split)
    cy += 3;
    const tips = [
      'Solve reasoning, analytical, and aptitude based questions regularly to strengthen core thinking skills.',
      'Practice mental math, data interpretation, and problem solving for speed and accuracy.',
      'Read widely to improve comprehension, critical thinking, and verbal reasoning.',
      'Engage in strategy based activities such as chess, coding, debates, or Olympiad style challenges.',
      'Break down complex problems into smaller steps to improve structured thinking.',
      'Use timed practice to enhance decision making under pressure.',
      'Strengthen weak aptitude areas through consistent targeted practice and feedback.',
      'Apply aptitude skills in real contexts — projects, experiments, research, and case studies.',
      'Develop curiosity by asking why, how, and exploring multiple solutions.',
      'Build a growth mindset — aptitudes can improve significantly through effort and exposure.',
    ];
    if (cy + 7 + tips.length * 4.6 > H - 16) {
      doc.addPage();
      sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains');
      studentBar(20);
      cy = 32;
    }
    txt('Tips to Strengthen Aptitude', 14, cy, { size: 8.5, color: '#1F2937', bold: true });
    cy += 6;
    tips.forEach((tip, i) => {
      setFill(PURPLE); doc.circle(17, cy - 1.5, 3, 'F');
      txt(String(i + 1), 17, cy, { size: 6, color: WHITE, bold: true, align: 'center' });
      txt(tip, 23, cy, { size: 7, color: '#374151', maxWidth: W - 35 });
      cy += 4.6;
    });
    cy += 4;

    // Fostering Wellbeing — kept together as one block (never split)
    const wellbeingTips = [
      'Build self-awareness by reflecting on strengths, behaviours, and growth areas.',
      'Develop confidence through initiative-taking and ownership of responsibilities.',
      'Strengthen discipline through routines, time management, and goal setting.',
      'Practice adaptability by staying open to feedback, change, and new experiences.',
      'Develop emotional regulation by responding thoughtfully rather than reacting impulsively.',
      'Build resilience by learning from setbacks and persisting through challenges.',
      'Strengthen communication, empathy, and collaboration in relationships and teamwork.',
      'Cultivate healthy habits for stress management, balance, and overall wellbeing.',
      'Practice ethical decision making, responsibility, and integrity in everyday choices.',
      'Seek mentorship, support, and constructive guidance when navigating challenges.',
    ];
    if (cy + 7 + wellbeingTips.length * 5.5 > H - 16) {
      doc.addPage();
      sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains');
      studentBar(20);
      cy = 32;
    }
    txt('Fostering Healthy Personality Development & Emotional Wellbeing', 14, cy, { size: 8.5, color: '#1F2937', bold: true });
    cy += 8;
    wellbeingTips.forEach((tip, i) => {
      setFill(PURPLE); doc.circle(17, cy - 1.5, 3, 'F');
      txt(String(i + 1), 17, cy, { size: 6, color: WHITE, bold: true, align: 'center' });
      txt(tip, 23, cy, { size: 7, color: '#374151', maxWidth: W - 35 });
      cy += 5.5;
    });
    cy += 8;

    // NOTE box
    if (cy + 12 > H - 18) {
      doc.addPage();
      sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains');
      studentBar(20);
      cy = 32;
    }
    rect(10, cy, W - 20, 10, LIGHT_GRAY, null, 2);
    txt('NOTE:', 14, cy + 6, { size: 7.5, color: '#1F2937', bold: true });
    txt('These areas are developmental in nature and can be strengthened over time through consistent practice, support, and conscious effort.', 26, cy + 6, { size: 7, color: GRAY, maxWidth: W - 38 });
    cy += 18;

    // Counselor's Remarks — dynamic height based on wrapped lines
    const cr = 'Dear Students, Please note that final academic and career decisions should be made by considering aptitude, interests, and academic performance together. This report is intended to serve as a guidance tool and should be used alongside discussions with parents, teachers, and counselors to support well-informed decision making.';
    doc.setFontSize(7);
    const crL = doc.splitTextToSize(cr, W - 28);
    const crBoxH = 9 + crL.length * 4.5;
    if (cy + crBoxH + 4 > H - 14) {
      doc.addPage();
      sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains');
      studentBar(20);
      cy = 32;
    }
    rect(10, cy, W - 20, crBoxH, '#F5F3FF', '#C4B5FD', 2);
    txt("Counselor's Remarks", 14, cy + 6, { size: 8, color: PURPLE, bold: true });
    txt(crL.join('\n'), 14, cy + 11, { size: 7, color: '#374151' });
    cy += crBoxH + 10;

    // Disclaimer — dynamic height based on wrapped lines
    const disc = 'This NuMind MAPS Report presents indicative insights derived from standardized assessments to support self-awareness, exploration, and informed decision-making. Recommendations are illustrative, not prescriptive, and should be interpreted alongside academic performance, evolving interests, and guidance from parents, teachers, or qualified counselors. Final academic and career decisions should not be made solely on the basis of this report.';
    doc.setFontSize(6.5);
    const discL = doc.splitTextToSize(disc, W - 28);
    const discBoxH = 9 + discL.length * 4.2;
    if (cy + discBoxH + 4 > H - 14) {
      doc.addPage();
      sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains');
      studentBar(20);
      cy = 32;
    }
    rect(10, cy, W - 20, discBoxH, LIGHT_GRAY, null, 2);
    txt('Disclaimer', 14, cy + 6, { size: 8, color: '#1F2937', bold: true });
    txt(discL.join('\n'), 14, cy + 11, { size: 6.5, color: GRAY });

    footer(10);

    // ── Stamp footers on every page using actual page indices ──
    // Done once at the end so AI prose overflow can't desync page numbers.
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      const fy = H - 8;
      line(10, fy - 3, W - 10, fy - 3, '#E5E7EB', 0.2);
      txt('numind.co.in | Confidential — For personal guidance only', 14, fy, { size: 7, color: GRAY });
      txt('Page ' + p + ' of ' + totalPages, W - 14, fy, { size: 7, color: GRAY, align: 'right' });
    }

    // SAVE
    const fname = 'NuMind_MAPS_' + safe(studentName).replace(/\s+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.pdf';
    doc.save(fname);

  } catch (err) {
    console.error('[downloadPDF] failed:', err);
    alert('PDF generation failed: ' + (err.message || err));
  } finally {
    if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
  }
}


export { downloadPDF };
