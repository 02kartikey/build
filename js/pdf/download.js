/* ════════════════════════════════════════════════════════════════════
   pdf/download.js
   Master PDF report generator — 10-page A4 with template-faithful layout, AI prose integration, dynamic footers.
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { NMAP_DIMS } from '../engine/nmap.js';
// getStanine re-derives a stanine from a stored raw score. daab.js is already
// in main.js's graph, so this import is free (same module instance). Used to
// self-heal a stale/undefined stanine (e.g. Verbal scored under an old table)
// so the report never prints "Not attempted" for a subtest that has a raw.
import { getStanine } from '../engine/daab.js';

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
    // Unified semantic status palette for ALL score bars (personality,
    // aptitude, career) and SEAA gauges. Sampled directly from the design
    // template so the report reads in the same colour language: deep purple =
    // top band, lavender = middle band, pink = lower band. Brand PURPLE stays
    // for headers, pills and the cover.
    const C_STRENGTH   = '#5B2DA6'; // deep purple — high band  (template)
    const C_DEVELOPING = '#9B7AE0'; // lavender    — mid band   (template)
    const C_FOCUS      = '#FF8FD2'; // pink        — low band   (template)
    // Two-palette system (matches the template):
    //  • DATA bands above (C_*) — bars, legend dots, gauge arcs, gap bars.
    //  • VERDICT accents below (A_*) — summary/outcome boxes and fit tiers only.
    //  • Cards use one neutral skin; status shows via a coloured pill/dot inside.
    const A_STRONG  = { t: '#16A34A', fill: '#ECFDF5', bd: '#A7F3D0' }; // green  — strong / well-established
    const A_DEV     = { t: '#B45309', fill: '#FFFBEB', bd: '#FDE68A' }; // amber  — developing / emerging
    const A_EXPLORE = { t: '#0E7490', fill: '#ECFEFF', bd: '#A5F3FC' }; // teal   — exploratory
    const A_FOCUS   = { t: '#BE185D', fill: '#FDF2F8', bd: '#FBCFE8' }; // pink   — needs support / attention
    const CARD_FILL = '#FBFAFF', CARD_BD = '#E9D5FF';                    // one neutral card skin
    // Spacing scale — one vertical rhythm used across the report instead of
    // sprinkled magic gaps. distribute() spreads N block-heights evenly through
    // an available band so a short page reads as designed whitespace, not a
    // cluster stuck at the top.
    const SP = { xs: 3, sm: 5, md: 8, lg: 12, xl: 18 };
    const distribute = (top, bottom, heights, opts) => {
      opts = opts || {};
      const minGap = opts.minGap != null ? opts.minGap : SP.sm;
      const maxGap = opts.maxGap != null ? opts.maxGap : SP.xl;
      const used = heights.reduce((a, b) => a + b, 0);
      let gap = (bottom - top - used) / (heights.length + 1);
      gap = Math.max(minGap, Math.min(gap, maxGap));
      const ys = []; let y = top + gap;
      for (const h of heights) { ys.push(y); y += h + gap; }
      return ys; // top-y of each block
    };
    const W = 210, H = 297;
    // Single source of truth for the content bottom limit (footer sits below
    // this). Previously a mix of H-14 and H-16 across pages.
    const BOTTOM = H - 16;

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
     *   newPageCy,                   — cy to use after a page break (default 40)
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
      const newPageCy  = opts.newPageCy !== undefined ? opts.newPageCy : 40;
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
      if (cy + innerH + (opts.pageBreakPad || 0) > BOTTOM) {
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
    //
    // studentFacing(): the report is read by Grade 8-12 students and parents
    // who don't know what a stanine is. The AI sometimes writes "(Stanine 6)"
    // or "scored 7/9"; every AI field is passed through this so raw scores
    // become the same band words used everywhere else in the report. Not
    // per-callsite — applied once inside aiText().
    const bandFromStanineWord = (n) => n >= 7 ? 'a Strength Area' : n >= 4 ? 'a Developing Area' : 'a Focus Area';
    const studentFacing = (s) => {
      if (!s) return s;
      let t = String(s);
      // "(Stanine 6)", "(stanine: 6)", "stanine of 6", "Stanine 6" → band words
      t = t.replace(/\(\s*stanine\s*(?:of|:|=)?\s*(\d)\s*\)/gi, (m, n) => '(' + bandFromStanineWord(+n) + ')');
      t = t.replace(/\bstanine\s*(?:of|:|=)?\s*(\d)\b/gi, (m, n) => bandFromStanineWord(+n));
      // "score of 7/9", "scored 7 out of 9", "7/9" adjacent to sten words
      t = t.replace(/\b(?:a\s+)?score[sd]?\s+(?:of\s+)?(\d)\s*(?:\/|out of)\s*9\b/gi, (m, n) => bandFromStanineWord(+n));
      t = t.replace(/\b(\d)\s*\/\s*9\b/g, (m, n) => bandFromStanineWord(+n));
      // Any leftover bare word "stanine(s)" → "level"
      t = t.replace(/\bstanines?\b/gi, 'level');
      // Tidy doubled spaces from removals
      return t.replace(/[ \t]{2,}/g, ' ');
    };
    const aiText = (key, fallback) => {
      const v = ai && typeof ai[key] === 'string' ? ai[key].trim() : '';
      return v ? studentFacing(v) : (fallback || '');
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
    // One consistent "instruction / how-to-read / note" style for every
    // guidance block in the report: soft lilac fill, purple left rule, a
    // small bold label and body text. Guidance blocks previously used a mix
    // of grey boxes, lilac boxes and bordered cards, so they didn't read as
    // instructions. Returns the y after the box.
    const instructionBox = (cy, label, body, opts) => {
      opts = opts || {};
      const bodySize = opts.bodySize || 8, lineH = opts.lineH || 4.6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(bodySize);
      const ls = doc.splitTextToSize(body, W - 40);
      const hasLabel = !!label;
      const h = 5 + (hasLabel ? 6 : 0) + ls.length * lineH + 4;
      rect(10, cy, W - 20, h, '#F5F3FF', '#E9D5FF', 1.5);
      rect(10, cy, 2.2, h, PURPLE, null, 0);
      let ty = cy + 6;
      if (hasLabel) { txt(label, 16, ty, { size: 7.5, color: PURPLE, bold: true }); ty += 6; }
      txt(ls.join('\n'), 16, ty, { size: bodySize, color: '#4C1D95' });
      return cy + h + (opts.gapAfter !== undefined ? opts.gapAfter : 5);
    };
    const indicativeCallout = (cy) => {
      return instructionBox(cy, null, 'Scores are indicative and should not be considered final. They reflect the current state at the time of assessment and may change over time.', { bodySize: 7.5, lineH: 4, gapAfter: 4 });
    };

    const drawProse = (text, cy, opts) => {
      opts = opts || {};
      const size      = opts.size      || 8.5;
      const color     = opts.color     || '#374151';
      const lineH     = opts.lineH     || 5;
      const paraGap   = opts.paraGap   || 4;
      const maxW      = opts.maxW      || (W - 28);
      const x         = opts.x         || 14;
      const bottom    = opts.bottom    || (BOTTOM);
      const pageStart = opts.pageStart || 36;
      const onNewPage = opts.onNewPage || function () {};
      // clip: when true, prose is trimmed to fit the space above `bottom`
      // instead of flowing onto a new page. The last visible line gets an
      // ellipsis. This is how AI narrative is folded strictly inline so the
      // report holds its designed page count instead of spawning continuation
      // pages. Overflow (paging) remains the default when clip is not set.
      const clip = !!opts.clip;
      const paras = String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
      let clipped = false;
      for (const para of paras) {
        if (clipped) break;
        // Measure with the SAME font/size the text will be drawn in. Without
        // this, splitTextToSize uses whatever size the previous draw left
        // active (often smaller), so lines wrap too late and overflow the
        // right margin — exactly what happened on the Welcome page.
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(size);
        const lines = doc.splitTextToSize(para, maxW);
        for (let li = 0; li < lines.length; li++) {
          let ln = lines[li];
          if (cy + lineH > bottom) {
            if (clip) { clipped = true; break; }
            doc.addPage();
            onNewPage();
            cy = pageStart;
          }
          // If another line will NOT fit but text still remains, mark this
          // (the last fitting) line with an ellipsis so the trim is visible.
          const moreInPara = li < lines.length - 1;
          const moreParas  = para !== paras[paras.length - 1];
          if (clip && cy + lineH * 2 > bottom && (moreInPara || moreParas)) {
            ln = String(ln).replace(/[\s.]+$/, '') + '…';
          }
          txt(ln, x, cy, { size: size, color: color });
          cy += lineH;
        }
        cy += paraGap;
      }
      return cy;
    };

    const studentName = safe(st.fullName) || 'Student';
    const grade       = safe(st.class) + (st.section ? ' ' + safe(st.section) : '');
    const schoolName  = safe(st.school);
    const dateStr     = new Date().toLocaleDateString('en-IN', { year:'numeric', month:'long', day:'numeric' });

    const stanineColor = (s) => s >= 7 ? C_STRENGTH : s >= 4 ? C_DEVELOPING : C_FOCUS;
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
    const firstName = (safe(st.fullName) || 'The student').trim().split(/\s+/)[0];
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
    // Gender for stanine re-derivation (VA/PA/NA/AR are gender-normed).
    const _daabGender = ((_ov && _ov.student && _ov.student.gender)
      || (typeof S !== 'undefined' && S && S.student && S.student.gender) || 'M');
    let aptitude8 = DAAB_KEY_ORDER.map((key) => {
      const sub = daab && daab[key];
      const sc = sub && sub.scores;
      // A subtest counts as attempted if it has a raw score. If the stored
      // stanine is missing/stale (undefined — e.g. Verbal scored under an old
      // gapped table), re-derive it from the raw so it still renders. "Not
      // attempted" is reserved for subtests with no raw data at all.
      const hasRaw = !!(sc && typeof sc.raw === 'number');
      const st = (sc && typeof sc.stanine === 'number' && sc.stanine > 0)
        ? sc.stanine
        : (hasRaw ? getStanine(key, sc.raw, _daabGender) : 0);
      const attempted = st > 0;
      return {
        name: DAAB_TEMPLATE_LABELS[key],
        stanine: st,
        label: attempted ? ((sc && sc.label && sc.label !== 'Not attempted') ? sc.label : stanineBand(st)) : 'Not attempted',
        attempted,
        key,
      };
    });
    // Re-order to match the template's natural visual order: Verbal, Perceptual,
    // Numerical, Spatial, Mechanical, Abstract, Legal, Health/Medical
    const APT_DISPLAY_ORDER = ['va', 'pa', 'na', 'sa', 'ma', 'ar', 'lsa', 'hma'];
    aptitude8 = APT_DISPLAY_ORDER.map(k => aptitude8.find(a => a.key === k)
      || { name: DAAB_TEMPLATE_LABELS[k] || k, stanine: 0, label: 'Not attempted', attempted: false, key: k });

    const aptStrong   = aptitude8.filter(a => a.attempted && a.stanine >= 7).map(a => a.name);
    const aptEmerging = aptitude8.filter(a => a.attempted && a.stanine >= 4 && a.stanine <= 6).map(a => a.name);

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
    // Build in template order, then sort strongest-first so the chart matches
    // its "strongest interests first" heading (previously rendered fixed-order,
    // which pushed the top interest to the bottom of the chart).
    // Counts derived from data, used wherever the report describes itself.
    const DAAB_DOMAIN_COUNT = DAAB_KEY_ORDER.length;
    const CPI_DOMAIN_COUNT  = CPI_DISPLAY_ORDER.length;
    const careers8 = CPI_DISPLAY_ORDER
      .map(lbl => cpiByLabel[lbl] || { label: lbl, score: 0, level: 'Low' })
      .sort((a, b) => b.score - a.score);
    const cpiColor = (lvl) => lvl === 'Strong' ? C_STRENGTH : lvl === 'Moderate' ? C_DEVELOPING : C_FOCUS;
    // top3 — always derive from live cpiAll so labels always match CPI_AREAS.
    // S.cpi.top3 may be stale (8-area data) so we ignore it and sort fresh.
    const top3 = cpiAll.slice().sort((a, b) => b.score - a.score).slice(0, 3);

    // ── SEAA cards (live) ────────────────────────────────────────
    const seaCat = (cat) => {
      if (cat === 'A' || cat === 'B') return { catLabel: 'Strong Readiness',     color: C_STRENGTH };
      if (cat === 'C')                 return { catLabel: 'Developing Readiness', color: C_DEVELOPING };
      return                                  { catLabel: 'Support Needed',       color: C_FOCUS };
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
    // Average across attempted sub-tests only — unattempted now carry stanine 0
    // and would otherwise drag the fit score (and aptStatus below) down. Falls
    // back to the neutral mid-point when nothing was attempted so the maths
    // stays defined.
    const _aptDone = aptitude8.filter(a => a.attempted);
    const avgApt  = _aptDone.length
      ? _aptDone.reduce((s,d) => s + d.stanine, 0) / _aptDone.length
      : 5;
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

    // Consistent sub-heading style used across all pages: a small purple
    // accent bar + 10pt bold title, so section titles read as headings rather
    // than body text. Returns the y where content should continue.
    const subHeading = (text, y) => {
      rect(10, y - 4.6, 2.2, 6, PURPLE, null, 0);
      txt(text, 15.5, y, { size: 10, color: '#111827', bold: true });
      return y + 8;
    };

    const sectionHeader = (title, subtitle, opts) => {
      opts = opts || {};
      // Template style: soft section-tinted band, dark title, muted subtitle,
      // a slim colour accent on the left. Section tint/accent are passed per
      // page; the defaults are a neutral light lavender. Kept at 24mm tall so
      // the studentBar (y=25) and content start (cy=40) are unchanged.
      const tint   = opts.tint   || '#F4F1FB';
      const accent = opts.accent || PURPLE;
      rect(0, 0, W, 24, tint, null, 0);
      rect(0, 0, 3, 24, accent, null, 0);
      rect(0, 24, W, 0.4, '#E6E1F1', null, 0);
      txt(title, 14, 11.5, { size: 14.5, color: '#1F2937', bold: true, maxWidth: W - 58 });
      // Dark wordmark on the light header.
      drawLogo(W - 8, 10, 10, false);
      if (subtitle) {
        // Wrap to at most two lines below the logo — no more mid-sentence
        // ellipsis clipping (the header now has the width for it).
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
        const sl = doc.splitTextToSize(subtitle, W - 28).slice(0, 2);
        let sy = 16.5;
        sl.forEach((ln) => { txt(ln, 14, sy, { size: 7, color: '#6B7280' }); sy += 3.5; });
      }
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
       ASSET / ICON SLOTS
       Drop PNGs at  /assets/icons/<name>.png  and they appear automatically.
       Until a file exists, a soft placeholder marks the slot, so the layout is
       final now and images can be added later with no code change. Names are
       derived from live data (pillar codes, trait/gauge keys) — no hardcoded
       master list to maintain.
    ═══════════════════════════════════════════════ */
    const _iconCache = {};
    const iconSlug = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const loadIcon = async (name) => {
      const key = iconSlug(name);
      if (key in _iconCache) return _iconCache[key];
      try {
        const ctl = new AbortController();
        const tm  = setTimeout(() => ctl.abort(), 1000);
        const rsp = await fetch('/assets/icons/' + key + '.png', { signal: ctl.signal });
        clearTimeout(tm);
        if (rsp && rsp.ok) {
          const blob = await rsp.blob();
          const dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
          });
          _iconCache[key] = dataUrl; return dataUrl;
        }
      } catch (_) { /* fall through to placeholder */ }
      _iconCache[key] = null; return null;
    };
    // Draw an icon into a square slot: the PNG when present, else a soft
    // placeholder box so the slot is visible.
    const drawIcon = async (name, x, y, size, opts) => {
      opts = opts || {};
      const d = await loadIcon(name);
      if (d) { try { doc.addImage(d, 'PNG', x, y, size, size); return; } catch (_) {} }
      if (opts.placeholder === false) return;
      rect(x, y, size, size, opts.fill || '#F1ECFB', opts.border || '#D9CBF2', Math.min(2, size / 6));
      // Slot label — the expected file name — so it is clear which asset goes
      // here. Shrinks to fit the box; hidden on very small slots.
      if (size >= 8) {
        const lbl = iconSlug(name);
        let fs = size >= 13 ? 3.2 : 2.7;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(fs);
        while (fs > 2 && doc.getTextWidth(lbl) > size - 1.4) { fs -= 0.15; doc.setFontSize(fs); }
        txt(lbl, x + size / 2, y + size / 2 + fs * 0.35, { size: fs, color: '#9B7AE0', align: 'center' });
      }
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

    txt('The Four Dimensions Shaping Your Profile', 14, 200, { size: 9.5, color: '#D8B4FE' });
    const coverPills = ['NMAP', 'NAAB', 'NCPI', 'NSEAA'];
    for (let i = 0; i < coverPills.length; i++) {
      const p = coverPills[i];
      const step = (W - 28) / 4, pw = 42;
      const px = 14 + i * step;
      setFill(WHITE); doc.roundedRect(px, 205, pw, 24, 3, 3, 'F');
      await drawIcon(p, px + 5, 210, 14, { fill: '#F1ECFB', border: '#D9CBF2' });
      txt(p, px + 22, 219, { size: 10, color: PURPLE, bold: true });
    }
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
    // The Welcome page carries fixed framework content below the intro
    // (pillars ~104mm, order steps ~70mm, closing box ~22mm ≈ 196mm). That
    // leaves a fixed budget for the intro. Measure the prose first: if it fits,
    // draw it here; if it does not, keep this page for the framework (with the
    // short welcome text) and give the full AI summary its own titled page.
    // Previously the intro pushed "Stronger Together" onto a lone page.
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    const _wParas = String(welcomeProse).split(/\n\s*\n/).filter(Boolean);
    const _wLines = _wParas.reduce((n, p) => n + doc.splitTextToSize(p, W - 28).length, 0);
    const _wNeed  = _wLines * 4.8 + (_wParas.length - 1) * 4;
    // Order steps + "Stronger Together" now live on their own page (page 3),
    // so page 2 has room for a fuller intro. Render the AI holistic summary
    // trimmed to this budget (clip) rather than swapping to the generic
    // fallback or spilling onto a dedicated page.
    const _wBudget = 58;
    void _wNeed;
    cy = drawProse(welcomeProse, cy, {
      size: 8, color: '#374151', lineH: 4.8, paraGap: 4,
      maxW: W - 28, x: 14, bottom: cy + _wBudget + 6, clip: true,
    });
    cy += 2;

    rect(10, cy, W - 20, 8, PURPLE, null, 2);
    // Diamond ornaments drawn as vectors — the template's ✦ glyph does not
    // exist in jsPDF's helvetica, which is how literal asterisks ended up in
    // the shipped report.
    txt('The Four Pillars of NuMind MAP', W / 2, cy + 5.5, { size: 9, color: WHITE, bold: true, align: 'center' });
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    const _pw = doc.getTextWidth('The Four Pillars of NuMind MAP');
    [ W/2 - _pw/2 - 6, W/2 + _pw/2 + 6 ].forEach((dx) => {
      doc.setFillColor('#FFFFFF');
      doc.triangle(dx, cy + 2.6, dx - 1.7, cy + 4.3, dx, cy + 6.0, 'F');
      doc.triangle(dx, cy + 2.6, dx + 1.7, cy + 4.3, dx, cy + 6.0, 'F');
    });
    cy += 12;

    const infoTxt = 'Each assessment plays a distinct role in shaping your Integrated Career Development Profile, helping you make informed and confident decisions about your future.';
    cy = drawBox(cy, {
      fill: '#F5F3FF', draw: '#E9D5FF', radius: 2,
      bodyText: infoTxt, bodySize: 8, bodyColor: '#374151', lineH: 4.5,
      paddingTop: 5, paddingBottom: 5, gap: 6,
    });

    const pillarData = [
      { code:'NMAP',  title:'NuMind Multidimensional Assessment of Personality', sub:'Understanding who you are at your core', body:'Evaluates ' + NMAP_DIM_COUNT + ' key personality dimensions that influence how you think, behave, and grow.', border:PURPLE },
      { code:'NAAB',  title:'NuMind Aptitude & Ability Battery',                 sub:'Discovering what you can do',            body:'Measures ' + DAAB_DOMAIN_COUNT + ' essential cognitive abilities — verbal, numerical, spatial, abstract reasoning and more.', border:PURPLE_LIGHT },
      { code:'NCPI',  title:'NuMind Career Preference Inventory',                sub:'Identifying what you enjoy',             body:'Maps career interests across ' + CPI_DOMAIN_COUNT + ' domains to uncover environments and roles aligned with your preferences.', border:TEAL },
      { code:'NSEAA', title:'NuMind Social Emotional & Academic Adjustment',     sub:'Preparing you to thrive',                body:'Assesses emotional, social, and academic readiness ensuring long-term success and wellbeing.', border:YELLOW },
    ];
    // 2x2 pillar cards, each with an icon slot on the left (template layout).
    for (let i = 0; i < pillarData.length; i++) {
      const p = pillarData[i];
      const col = i % 2, row = Math.floor(i / 2);
      const px = 10 + col * 97, py = cy + row * 44;
      rect(px, py, 93, 40, '#F9FAFB', p.border, 2);
      doc.setLineWidth(0.8); setDraw(p.border); doc.line(px, py, px, py + 40);
      await drawIcon(p.code, px + 5, py + 5, 14, { fill: '#FFFFFF', border: p.border });
      txt(p.code,  px + 23, py + 9,  { size: 7.5, color: p.border, bold: true });
      txt(p.title, px + 23, py + 14, { size: 7.3, color: '#1F2937', bold: true, maxWidth: 64 });
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); setTxtColor(p.border);
      const sub = doc.splitTextToSize(p.sub, 84); doc.text(sub, px + 5, py + 25);
      const body = doc.splitTextToSize(p.body, 84);
      txt(body.join('\n'), px + 5, py + 30, { size: 6.5, color: '#6B7280' });
    }
    cy += 92;

    footer(2);

    /* ═══════════════════════════════════════════════
       PAGE 3 — KNOW THE ORDER OF YOUR REPORT
    ═══════════════════════════════════════════════ */
    doc.addPage();
    cy = SP.xl;
    cy = subHeading('Know the Order of Your Report', cy) + SP.sm;
    const steps = [
      ['1', 'Profile Snapshot:',           'Quick overview of your overall profile across all four domains'],
      ['2', 'Assessment Insights:',        'Deep dive into Personality, Aptitude, Career Interest, and Wellbeing'],
      ['3', 'Career Alignment:',           'Integrated Career Fit Matrix combining all four domains'],
      ['4', 'Gap Analysis:',               'Comparison between your current profile and recommended pathway requirements'],
      ['5', 'Summary & Recommendations:',  'Final overview, suggested streams, next steps, and counsellor notes'],
    ];
    // Measure each step (label width + wrapped description) so rows size to
    // their own content and the whole set can be distributed evenly.
    const stepMeas = steps.map((row) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
      const lblW = doc.getTextWidth(row[1]);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8);
      const dLines = doc.splitTextToSize(row[2], W - 32 - lblW);
      return { lblW, dLines, h: Math.max(12, 6 + dLines.length * 4.2) };
    });
    // Stronger Together box (measured).
    const stBody = 'These four pillars come together to provide a holistic, evidence-based view of your potential — empowering you to make informed decisions today for a more confident tomorrow.';
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    const stLines = doc.splitTextToSize(stBody, W - 66);
    const stH = Math.max(30, 14 + stLines.length * 4.6);
    // Group the steps tightly at the top (template layout); the whitespace
    // then falls to the bottom of the page rather than being spread as large
    // gaps between rows.
    steps.forEach((row, i) => {
      const m = stepMeas[i], mid = cy + m.h / 2;
      rect(10, cy, W - 20, m.h, LIGHT_GRAY, null, 2);
      setFill(PURPLE); doc.circle(18, mid, 3.4, 'F');
      txt(row[0], 18, mid + 1.4, { size: 8, color: WHITE, bold: true, align: 'center' });
      txt(row[1], 26, mid - (m.dLines.length - 1) * 2 + 1, { size: 8.5, color: PURPLE, bold: true });
      txt(m.dLines.join('\n'), 26 + m.lblW + 3, mid - (m.dLines.length - 1) * 2 + 1, { size: 7.8, color: GRAY });
      cy += m.h + SP.sm;
    });
    cy += SP.md;
    const stY = cy;
    rect(10, stY, W - 20, stH, '#F5F3FF', PURPLE, 2);
    rect(10, stY, 2.5, stH, PURPLE, null, 0);
    await drawIcon('Stronger Together', 15, stY + (stH - 18) / 2, 18, { fill: '#FFFFFF', border: PURPLE });
    txt('Stronger Together', 38, stY + 9, { size: 9.5, color: PURPLE, bold: true });
    txt(stLines.join('\n'), 38, stY + 15, { size: 8, color: '#374151' });
    cy = stY + stH;

    footer(2);

    /* ═══════════════════════════════════════════════
       PAGE 4 — PERSONALITY PROFILE
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Personality Profile', 'The Personality Graph highlights your strengths across ' + NMAP_DIM_COUNT + ' important personality traits and how they may relate to personal growth and career fit', { tint: '#F4F8FF' });
    studentBar(25);
    cy = 40;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill(C_STRENGTH);   doc.circle(18, cy + 3.5, 2.5, 'F'); txt('Strength',        22, cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_DEVELOPING); doc.circle(52, cy + 3.5, 2.5, 'F'); txt('Developing',      56, cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_FOCUS);      doc.circle(92, cy + 3.5, 2.5, 'F'); txt('Needs Attention', 96, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 11;

    const persChartH = 8 + personality9.length * 7.5 + 4;
    rect(10, cy, W - 20, persChartH, '#FAFAFA', '#E5E7EB', 2);
    txt('Personality Profile — ' + personality9.length + ' Dimensions', 14, cy + 6, { size: 8, color: GRAY, bold: true });
    personality9.forEach((d, i) => stanineBar(d.name, d.stanine, cy + 15 + i * 7.5, stanineColor(d.stanine)));
    for (let i = 1; i <= 9; i++) {
      const bx = 70 + ((i - 1) / 8) * (W - 90);
      txt(String(i), bx, cy + persChartH + 2, { size: 6, color: GRAY, align: 'center' });
    }
    cy += persChartH + 6;

    txt('Bands:   Focus Area   ·   Developing Area   ·   Strength Area', 14, cy + 3, { size: 7, color: GRAY });
    cy += 13;

    cy = subHeading('Top 3 Dominant Traits', cy);
    [0, 1, 2].forEach((idx) => {
      const trait = topPersonality[idx]
        || personalityAll[idx]
        || { name: 'Profile developing', stanine: 5, label: 'Developing Area' };
      const px = 10 + idx * 63.3, cardW = 59, cardH = 20;
      rect(px, cy, cardW, cardH, CARD_FILL, CARD_BD, 2);
      rect(px, cy, 2.2, cardH, PURPLE, null, 0);
      txt('0' + (idx + 1), px + 5, cy + 14, { size: 17, color: PURPLE, bold: true });
      txt(trait.name, px + 21, cy + 8.5, { size: 8, color: '#1F2937', bold: true, maxWidth: cardW - 25 });
      const bandColor = trait.stanine >= 7 ? C_STRENGTH : trait.stanine >= 4 ? C_DEVELOPING : C_FOCUS;
      txt(trait.label, px + 21, cy + 14.5, { size: 7, color: bandColor, bold: true });
    });
    cy += 26;

    cy = indicativeCallout(cy);

    // Trait reference descriptions move to their own page so the analysis
    // (chart, top traits, insight) sits together on the previous page.
    doc.addPage();
    sectionHeader('Personality Profile', 'Understand what each of the nine personality parameters means for learning and growth', { tint: '#F4F8FF' });
    studentBar(25);
    cy = 40;

    cy = subHeading('Description of Personality Parameters', cy);
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
    // Development Suggestions box sits at the bottom of this page (template p5).
    // Compute it first so the parameter cards can reserve room for it.
    const persWeakP = personality9.slice().sort((a, b) => a.stanine - b.stanine).slice(0, 3);
    const suggMapP = {
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
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    const suggLinesP = persWeakP.map(d => doc.splitTextToSize('• ' + (suggMapP[d.name] || ('Strengthen ' + d.name + ' through targeted practice and reflection.')), W - 28));
    const suggBoxHP = persWeakP.length ? 12 + suggLinesP.reduce((h, ls) => h + ls.length * 4.6, 0) : 0;
    const suggReserveP = suggBoxHP ? suggBoxHP + 8 : 0;

    // Card = icon slot (top-left) + number/name + description. Sized to its own
    // text, with larger, more legible type than before.
    const descFont = 7, descLH = 4.3;
    const cardTextW = (isLast) => (isLast ? W - 20 : 93) - 10;
    const cardH = personality9.map((d, i) => {
      const isLastAlone = (personality9.length % 2 === 1) && (i === personality9.length - 1);
      const desc = traitDescs[d.name] || (d.name + ' — ' + stanineBand(d.stanine) + '.');
      doc.setFontSize(descFont); doc.setFont('helvetica', 'normal');
      const dL = doc.splitTextToSize(desc, cardTextW(isLastAlone));
      return 18 + dL.length * descLH + 3;
    });
    const descRows = [];
    for (let i = 0; i < personality9.length; i += 2) descRows.push([i, i + 1 < personality9.length ? i + 1 : null]);
    const descRowH = descRows.map(r => Math.max(...r.filter(x => x != null).map(x => cardH[x])));
    const descTotalH = descRowH.reduce((a, b) => a + b, 0);
    const descBottom = BOTTOM - suggReserveP;
    // Modest, even gaps — the cards group under the heading instead of
    // stretching to the footer, and the Development box follows right after.
    let descGap = (descBottom - cy - descTotalH) / (descRows.length + 1);
    descGap = Math.max(5, Math.min(descGap, 7));
    let traitCy = cy + descGap;
    for (let ri = 0; ri < descRows.length; ri++) {
      const row = descRows[ri];
      for (let col = 0; col < row.length; col++) {
        const idx = row[col];
        if (idx == null) continue;
        const d = personality9[idx];
        const isLastAlone = (personality9.length % 2 === 1) && (idx === personality9.length - 1);
        const desc = traitDescs[d.name] || (d.name + ' — ' + stanineBand(d.stanine) + '.');
        doc.setFontSize(descFont); doc.setFont('helvetica', 'normal');
        const dL = doc.splitTextToSize(desc, cardTextW(isLastAlone));
        const px = 10 + col * 97;
        const cardW = isLastAlone ? W - 20 : 93;
        rect(px, traitCy, cardW, descRowH[ri], CARD_FILL, CARD_BD, 2);
        await drawIcon(d.name, px + 5, traitCy + 5, 11, { fill: '#FFFFFF', border: CARD_BD });
        txt((idx + 1) < 10 ? '0' + (idx + 1) : String(idx + 1), px + 19, traitCy + 11, { size: 8, color: PURPLE_LIGHT, bold: true });
        txt(d.name, px + 27, traitCy + 11, { size: 8.5, color: '#1F2937', bold: true, maxWidth: cardW - 32 });
        txt(dL.join('\n'), px + 5, traitCy + 18, { size: descFont, color: GRAY });
      }
      traitCy += descRowH[ri] + descGap;
    }
    cy = traitCy;

    // Development Suggestions (weakest three traits) — pulled up directly beneath
    // the cards (template p5), not floated down to the footer.
    if (suggBoxHP) {
      const sby = (traitCy - descGap) + 6; // sit just below the last card row
      rect(10, sby, W - 20, suggBoxHP, '#F5F3FF', '#E9D5FF', 2);
      txt('Development Suggestions', 14, sby + 8, { size: 9, color: PURPLE, bold: true });
      let sy = sby + 15;
      suggLinesP.forEach(ls => { txt(ls.join('\n'), 14, sy, { size: 7.5, color: '#374151' }); sy += ls.length * 4.6; });
      cy = sby + suggBoxHP;
    }

    footer(4);

    /* ═══════════════════════════════════════════════
       PAGE 5 — APTITUDE & ABILITY
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Aptitude & Ability Profile', 'Understand your strengths across different ability areas and emerging areas for development. Indicators of how abilities may align with future learning and career options.', { tint: '#F4F8FF' });
    studentBar(25);
    cy = 40;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill(C_STRENGTH);   doc.circle(18,  cy + 3.5, 2.5, 'F'); txt('Strong Aptitude Area',  22,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_DEVELOPING); doc.circle(62,  cy + 3.5, 2.5, 'F'); txt('Emerging Area',         66,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_FOCUS);      doc.circle(96,  cy + 3.5, 2.5, 'F'); txt('Area for Development', 100, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 11;

    // Combined profile table — the bar chart and the reference table described
    // the SAME 8 aptitudes on two separate pages (one nearly empty). Merged
    // into a single table with the profile bar as a column: area, level bar,
    // what it means, and related careers all read on one line.
    const aptDescriptions = {
      'Verbal Ability':         ['Language understanding, expression and communication.',            'Psychology · Law · Journalism · Content · Policy'],
      'Perceptual Speed':       ['Quick visual scanning, comparison and attention to detail.',       'Data Analytics · Cybersecurity · Forensics'],
      'Numerical Ability':      ['Comfort with numbers, data and quantitative reasoning.',           'Finance · Actuarial · Data Science · AI/ML'],
      'Spatial Ability':        ['Visualizing shapes, patterns and space-based relationships.',      'Architecture · UX/UI · Product Design'],
      'Mechanical Ability':     ['Understanding machines, tools and mechanical reasoning.',          'Engineering · Industrial Automation · Mechatronics'],
      'Abstract Reasoning':     ['Pattern recognition, logical thinking and problem solving.',       'Strategy Consulting · Cognitive Science · AI Research'],
      'Legal Studies Ability':  ['Reasoning, argument formation and rule-based thinking.',           'Law · International Relations · Public Policy'],
      'Health & Medical Apt.':  ['Readiness for health, biology and clinical reasoning.',            'Medicine · Biotechnology · Clinical Psychology'],
    };
    const aptRowsC = aptitude8.slice().sort((a, b) => b.stanine - a.stanine).map((d) => {
      const md = aptDescriptions[d.name] || ['A distinct thinking skill measured by this assessment.', 'Multiple pathways — discuss with your counsellor.'];
      return { name: d.name, stanine: d.stanine, desc: md[0], careers: md[1] };
    });
    const acX = [10, 54, 102, 150];
    const acW = [44, 48, 48, 50];
    rect(10, cy, W - 20, 7, PURPLE, null, 0);
    ['Aptitude Area', 'Profile', 'Description', 'Potential Careers'].forEach((h, i) => txt(h, acX[i] + 2, cy + 5, { size: 7.5, color: WHITE, bold: true }));
    cy += 7;
    aptRowsC.forEach((r, ri) => {
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
      const dLn = doc.splitTextToSize(r.desc, acW[2] - 5);
      const cLn = doc.splitTextToSize(r.careers, acW[3] - 5);
      const rowH = Math.max(11, 4.5 + Math.max(dLn.length, cLn.length) * 3.9);
      const midY = cy + rowH / 2;
      rect(10, cy, W - 20, rowH, ri % 2 === 0 ? WHITE : LIGHT_GRAY, '#E5E7EB', 0);
      txt(r.name, acX[0] + 2, midY + 1, { size: 7.5, color: '#1F2937', bold: true, maxWidth: acW[0] - 4 });
      const abX = acX[1] + 2, abW = acW[1] - 8;
      rect(abX, midY - 2, abW, 4, '#E5E7EB', null, 1);
      // stanine 0 = never taken. Draw no fill and say so, rather than leaving an
      // unexplained empty bar that could read as a very low score.
      if (r.stanine > 0) {
        rect(abX, midY - 2, (r.stanine / 9) * abW, 4, stanineColor(r.stanine), null, 1);
      } else {
        txt('Not attempted', abX, midY + 4.6, { size: 5.6, color: GRAY });
      }
      txt(dLn.join('\n'), acX[2] + 2, midY - (dLn.length - 1) * 1.9 + 1, { size: 6.5, color: GRAY });
      txt(cLn.join('\n'), acX[3] + 2, midY - (cLn.length - 1) * 1.9 + 1, { size: 6.5, color: '#374151' });
      cy += rowH;
    });
    cy += 3;
    txt('Bar colours follow the bands above. Career options are indicative, not exhaustive — explore pathways aligned with aptitude, interests and academics.', 14, cy + 2, { size: 6.5, color: GRAY, maxWidth: W - 28 });
    cy += 7;

    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    // Every box must carry real content. If no area reached the Strength band,
    // surface the student's closest areas with a supportive framing rather than
    // an empty placeholder; mirror the same for the emerging box.
    // Only rated areas can be 'closest to strength'; an unattempted one has no level.
    const _closest = aptitude8.filter(a => a.attempted).sort((a,b) => b.stanine - a.stanine).slice(0,2).map(a => a.name);
    const strongContent = aptStrong.length ? aptStrong.join('\n')
      : 'Closest to strength:\n' + _closest.join('\n') + '\nWith practice these can become clear strengths.';
    const emergingContent = aptEmerging.length ? aptEmerging.join('\n')
      : 'All areas are currently either strengths or focus areas — see the profile above.';
    doc.setFont('helvetica','normal'); doc.setFontSize(7); // measure at draw size
    const sALines = doc.splitTextToSize(strongContent, 83);
    const eALines = doc.splitTextToSize(emergingContent, 83);
    const aptPairH = Math.max(9 + sALines.length * 4.6, 9 + eALines.length * 4.6, 22);
    rect(10,  cy, 93, aptPairH, A_STRONG.fill, A_STRONG.bd, 2);
    txt('Strong Aptitude Areas', 14, cy + 7, { size: 8.5, color: A_STRONG.t, bold: true });
    txt(sALines.join('\n'), 14, cy + 12, { size: 8, color: '#1F2937' });
    rect(107, cy, 93, aptPairH, A_DEV.fill, A_DEV.bd, 2);
    txt('Emerging Areas', 111, cy + 7, { size: 8.5, color: A_DEV.t, bold: true });
    txt(eALines.join('\n'), 111, cy + 12, { size: 8, color: '#1F2937' });
    cy += aptPairH + 6;

    cy = indicativeCallout(cy);
    cy += 4;
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

    // (page-guard removed: aptitude holds to its two designed pages)
    rect(10, cy, W - 20, 15, '#EDE9FE', null, 2);
    txt('Suggested Career Domains Based on Aptitude', 14, cy + 5, { size: 8.5, color: PURPLE, bold: true });
    // Real domains only — no placeholder padding. Pull from strong areas
    // first, then emerging, then the remaining aptitudes by level; render
    // however many exist (up to 4) with spacing computed from the count.
    const suggDoms = (() => {
      const set = new Set();
      aptStrong.forEach(a => (aptDomainMap[a] || []).forEach(d => set.add(d)));
      if (set.size < 4) aptEmerging.forEach(a => (aptDomainMap[a] || []).forEach(d => set.add(d)));
      if (set.size < 4) aptitude8.filter(a => a.attempted).slice().sort((a, b) => b.stanine - a.stanine)
        .forEach(a => (aptDomainMap[a.name] || []).forEach(d => set.add(d)));
      return Array.from(set).slice(0, 4);
    })();
    if (suggDoms.length) {
      const pillW = Math.min(44, (W - 28 - (suggDoms.length - 1) * 5) / suggDoms.length);
      suggDoms.forEach((d, i) => pill(d, 14 + i * (pillW + 5), cy + 11.5, PURPLE, WHITE, pillW, 6));
    }
    cy += 20;


    footer(5);

    /* ═══════════════════════════════════════════════
       PAGE 6 — CAREER INTEREST
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Career Interest Profile', 'Career areas you may be most inclined toward. Primary and emerging interest clusters across career domains — helping explore pathways that connect with your preferences.', { tint: '#FFFBE8' });
    studentBar(25);
    cy = 40;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill(C_STRENGTH);   doc.circle(18,  cy + 3.5, 2.5, 'F'); txt('Strong Interest',   22,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_DEVELOPING); doc.circle(56,  cy + 3.5, 2.5, 'F'); txt('Moderate Interest', 60,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_FOCUS);      doc.circle(100, cy + 3.5, 2.5, 'F'); txt('Low Interest',     104, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 11;

    // Chart sizing adapts to what shares the page: on the AI path the chart is
    // this page's sole content, so it grows into the space (taller bars, wider
    // spacing); on the no-AI path the cluster table sits below it, so the
    // compact metrics keep everything on one page.
    const cpiHasAI = aiHas('interest_profile') || aiHas('internal_motivators');
    const cSp = cpiHasAI ? 9.5 : 7.5, cBarH = cpiHasAI ? 6 : 5;
    const cpiChartH = (cpiHasAI ? 12 : 10) + careers8.length * cSp + 4;
    rect(10, cy, W - 20, cpiChartH, '#FAFAFA', '#E5E7EB', 2);
    txt('Career Interest Ranking — strongest interests first', 14, cy + 6, { size: 8, color: GRAY, bold: true });
    const barX2 = 70, barW2 = W - barX2 - 20;
    careers8.forEach((c, i) => {
      const y2 = cy + (cpiHasAI ? 17 : 15) + i * cSp;
      txt(c.label, 67, y2, { size: 7, color: '#1F2937', align: 'right', maxWidth: 55 });
      rect(barX2, y2 - cBarH / 2 - 1, barW2, cBarH, '#E5E7EB', null, 1);
      rect(barX2, y2 - cBarH / 2 - 1, (Math.max(0, c.score) / 20) * barW2, cBarH, cpiColor(c.level), null, 1);
      txt(String(c.score), barX2 + barW2 + 2, y2, { size: 7, color: GRAY, bold: true });
    });
    for (let i = 0; i <= 20; i += 2) {
      const bx = barX2 + (i / 20) * barW2;
      txt(String(i), bx, cy + cpiChartH + 1, { size: 5.5, color: GRAY, align: 'center' });
    }
    cy += cpiChartH + (cpiHasAI ? 10 : 7);

    const cpiGNote = "Bars in the Career Interest graph show the student's relative interest strength across the assessed career areas: shorter bars are Exploring Areas, mid-length bars are Secondary Interest Areas, and the longest bars are Key Interest Areas.";
    cy = instructionBox(cy, 'HOW TO READ THIS GRAPH', cpiGNote, { gapAfter: 6 });

    cy = indicativeCallout(cy);

    // Interest Cluster Summary sits on its own page (template p9).
    doc.addPage();
    sectionHeader('Career Interest Profile', 'Interest cluster summary and sample career pathways', { tint: '#FFFBE8' });
    studentBar(25);
    cy = 40;

    cy = subHeading('Interest Cluster Summary', cy);
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
      const rowH = Math.max(22, 12 + Math.max(interpL.length, pathsL.length) * 4.5);
      const rowBg = ri % 2 === 0 ? WHITE : LIGHT_GRAY;
      rect(10, cy, W - 20, rowH, rowBg, '#E5E7EB', 0);
      pill(row[0], cColX[0] + 2, cy + rowH / 2 + 2, ri === 0 ? PURPLE : ri === 1 ? PURPLE_LIGHT : '#6B7280', WHITE, 20, 6);
      txt(row[1], cColX[1] + 2, cy + rowH / 2, { size: 8, color: '#1F2937', bold: true, maxWidth: cColW[1] - 4 });
      txt(interpL.join('\n'), cColX[2] + 2, cy + rowH / 2 - (interpL.length - 1) * 2.2 + 1, { size: 7, color: GRAY });
      txt(pathsL.join('\n'),  cColX[3] + 2, cy + rowH / 2 - (pathsL.length - 1) * 2.2 + 1, { size: 7, color: '#374151' });
      cy += rowH;
    });


    footer(6);

    /* ═══════════════════════════════════════════════
       PAGE 7 — SEAA PROFILE
    ═══════════════════════════════════════════════ */
    doc.addPage();
    sectionHeader('Social Emotional Academic Adjustment Profile', 'Adjustment and readiness indicators across social, emotional and academic functioning — identifying strengths, developing areas and support needs', { tint: '#FFF4F2' });
    studentBar(25);
    cy = 40;

    rect(10, cy, W - 20, 7, LIGHT_GRAY, null, 1);
    setFill(C_STRENGTH); doc.circle(18,  cy + 3.5, 2.5, 'F'); txt('Well-Established',   22,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_DEVELOPING); doc.circle(74,  cy + 3.5, 2.5, 'F'); txt('Developing', 78,  cy + 5, { size: 7.5, color: '#1F2937' });
    setFill(C_FOCUS); doc.circle(134, cy + 3.5, 2.5, 'F'); txt('Needs Support',   138, cy + 5, { size: 7.5, color: '#1F2937' });
    cy += 10;

    cy = subHeading('SEAA Readiness by Domain', cy + 3) - 2;

    const seaDescs = [
      'Assesses peer relationships, social confidence, and ability to interact and collaborate effectively.',
      'Evaluates emotional awareness, regulation, resilience, and overall mental well-being.',
      'Measures study habits, focus, motivation, and the ability to manage academic responsibilities.',
    ];
    for (let i = 0; i < seaCards.length; i++) {
      const c = seaCards[i];
      const px = 10 + i * 66;
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
      const dl = doc.splitTextToSize(seaDescs[i], 54);
      // Arc colour follows the SAME readiness category as the status label
      // (gender-normed), so the card colour never contradicts its own text —
      // e.g. a "Developing Readiness" card is always orange, never green.
      const arcColor = c.label === 'Strong Readiness' ? C_STRENGTH
                     : c.label === 'Developing Readiness' ? C_DEVELOPING
                     : C_FOCUS;
      const cardH = Math.max(58, 15 + dl.length * 4.2 + 32);
      rect(px, cy, 62, cardH, CARD_FILL, CARD_BD, 2);
      await drawIcon(c.title, px + 4, cy + 4, 9, { fill: '#FFFFFF', border: CARD_BD });
      txt(c.title, px + 16, cy + 9.5, { size: 8, color: arcColor, bold: true, maxWidth: 42 });
      txt(dl.join('\n'), px + 4, cy + 17, { size: 6.5, color: GRAY });
      // Arc gauge
      const cx2 = px + 31, arcY = cy + cardH - 17, r = 13;
      // Grey background arc (180° → 360°)
      doc.setDrawColor(220, 220, 220); doc.setLineWidth(3);
      for (let a = 180; a <= 360; a += 5) {
        const rad1 = (a * Math.PI) / 180, rad2 = ((a + 5) * Math.PI) / 180;
        doc.line(cx2 + r * Math.cos(rad1), arcY + r * Math.sin(rad1), cx2 + r * Math.cos(rad2), arcY + r * Math.sin(rad2));
      }
      // Coloured fill — proportional to score (high score = more filled = more concern)
      const fillDeg = Math.round((c.score / 20) * 180);
      const [fr, fg, fb] = hex2rgb(arcColor);
      doc.setDrawColor(fr, fg, fb); doc.setLineWidth(3);
      for (let a = 180; a <= 180 + fillDeg; a += 5) {
        const rad1 = (a * Math.PI) / 180, rad2 = ((a + 5) * Math.PI) / 180;
        doc.line(cx2 + r * Math.cos(rad1), arcY + r * Math.sin(rad1), cx2 + r * Math.cos(rad2), arcY + r * Math.sin(rad2));
      }
      doc.setLineWidth(0.3);
      // Band word inside the arc (no raw score); the arc fill itself carries
      // the magnitude visually.
      txt(c.displayLabel, cx2, arcY + 4, { size: 7, color: arcColor, bold: true, align: 'center', maxWidth: 30 });
      seaCards[i]._cardH = cardH;
    }
    cy += Math.max(...seaCards.map(c => c._cardH || 52)) + 9;

    // Legend explaining the arc gauge — same instruction style as elsewhere.
    // Student-facing wording: bands, not raw scores.
    const _seaHowTo = 'Each arc shows one readiness area. A fuller, warmer arc means more support will help right now; a short deep-purple arc means the student is already well-established there. Bands are set against age- and gender-adjusted norms — they describe today, not a fixed limit.';
    cy = instructionBox(cy, 'HOW TO READ THESE GAUGES', _seaHowTo, { gapAfter: 3 });
    cy += 4;

    cy = subHeading('Adjustment Snapshot', cy) - 8;
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
    for (let i = 0; i < seaSnapshot.length; i++) {
      const s = seaSnapshot[i];
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
      const cardH = Math.max(42, 24 + sH + 8 + fH + 6);
      rect(px, cy, 62, cardH, CARD_FILL, CARD_BD, 2);
      await drawIcon(c.title, px + 4, cy + 3.5, 8, { fill: '#FFFFFF', border: CARD_BD });
      txt(c.title, px + 15, cy + 8.5, { size: 8, color: c.color, bold: true, maxWidth: 44 });
      pill(c.displayLabel, px + 4, cy + 18, c.color, WHITE, 54, 6);
      txt('Strengths', px + 4, cy + 24, { size: 7, color: '#1F2937', bold: true });
      let by = cy + 28;
      sLines.forEach(ls => { txt(ls.join('\n'), px + 4, by, { size: 6.5, color: GRAY }); by += ls.length * 3.8; });
      line(px + 4, by + 1, px + 58, by + 1, '#E5E7EB', 0.2);
      by += 4;
      txt('Focus Areas', px + 4, by, { size: 7, color: '#1F2937', bold: true });
      by += 4;
      fLines.forEach(ls => { txt(ls.join('\n'), px + 4, by, { size: 6.5, color: GRAY }); by += ls.length * 3.8; });
      seaSnapshot[i]._cardH = cardH;
    }
    cy += Math.max(...seaSnapshot.map(s => s._cardH || 38)) + 3;


    // Dimension Summary + wellbeing guidance move to a fresh page so the SEAA
    // gauges page isn't overfull while the wellbeing tail sits near-empty.
    doc.addPage();
    sectionHeader('Social Emotional Academic Adjustment Profile', 'Dimension summary and personalised wellbeing guidance', { tint: '#FFF4F2' });
    studentBar(25);
    cy = 40;

    cy = subHeading('Dimension Summary', cy);
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
      const rowH = Math.max(24, 13 + interpL.length * 4.5);
      rect(10, cy, W - 20, rowH, ri % 2 === 0 ? WHITE : LIGHT_GRAY, '#E5E7EB', 0);
      txt(c.title, dimColX[0] + 2, cy + rowH / 2 + 1, { size: 8, color: '#1F2937' });
      pill(c.displayLabel, dimColX[1] + 2, cy + rowH / 2 + 1, c.color, WHITE, 42, 6);
      txt(interpL.join('\n'), dimColX[2] + 2, cy + rowH / 2 - (interpL.length - 1) * 2 + 1, { size: 6.5, color: GRAY });
      cy += rowH;
    });
    cy += 20;


    // ── Growth Support Pathway (Awareness -> Action -> Support) ──
    // Present in the ideal template's SEAA page; was missing from the report.
    cy = subHeading('Growth Support Pathway', cy);
    const gsp = [
      { t: 'Awareness', d: 'Develop understanding of current strengths and growth areas.' },
      { t: 'Action',    d: 'Practice routines and strategies that support improvement.' },
      { t: 'Support',   d: 'Use guidance and resources to sustain progress.' },
    ];
    for (let i = 0; i < gsp.length; i++) {
      const g = gsp[i];
      const px = 10 + i * 64;
      rect(px, cy, 60, 30, WHITE, CARD_BD, 2);
      await drawIcon(g.t, px + 4, cy + 4, 11, { fill: '#FFFFFF', border: CARD_BD });
      txt(g.t, px + 18, cy + 10.5, { size: 8.5, color: PURPLE, bold: true });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5);
      const dl = doc.splitTextToSize(g.d, 52);
      txt(dl.join('\n'), px + 4, cy + 19, { size: 6.5, color: GRAY });
    }
    cy += 30 + SP.md;
    rect(10, cy, W - 20, 9, LIGHT_GRAY, null, 1);
    txt('Consistent support, positive reinforcement, and collaboration help students grow with confidence.', 14, cy + 6, { size: 7.5, color: '#374151' });
    cy += 18;

    const seaIndText = 'These results provide a snapshot for guidance purposes only. They reflect the current state at the time of assessment and may evolve over time.';
    doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    const seaIndL = doc.splitTextToSize(seaIndText, W - 32);
    const seaIndH = 6 + seaIndL.length * 4.5;
    // (page-guard removed: SEAA closing note stays inline on the growth page)
    rect(10, cy, W - 20, seaIndH, '#F5F3FF', PURPLE, 2);
    doc.setLineWidth(1.5); setDraw(PURPLE); doc.line(10, cy, 10, cy + seaIndH);
    txt(seaIndL.join('\n'), 15, cy + 6, { size: 7.5, color: '#374151' });
    cy += seaIndH + 4;

    footer(7);

    /* ═══════════════════════════════════════════════
       PAGES 8–9 — GAP ANALYSIS
    ═══════════════════════════════════════════════ */
    // No substitution: an unattempted (or unmapped) aptitude carries stanine 0
    // and the renderer prints "Not measured" with an empty bar, so the gap
    // tables never imply a level the student never demonstrated.
    const findApt  = (name) => {
      const hit = aptitude8.find(a => a.name === name);
      if (hit && hit.attempted) return hit;
      return { name: name, stanine: 0, attempted: false };
    };
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
      fs = fs || 30;
      rect(10, startY, W - 20, 8, PURPLE, null, 2);
      txt(pg.title, 14, startY + 6, { size: 9, color: WHITE, bold: true, maxWidth: W - 28 });
      let gy = startY + 15;
      pg.factors.forEach((f) => {
        const fType = f[0], fLabel = f[1], current = f[2], required = f[3];
        const barX3 = 14, barW3 = W - 28;
        // One-line factor heading ("Aptitude Factor — Mechanical Ability")
        // keeps the block compact and leaves clear air above the next block —
        // the previous two-line layout ran its last bar into the next heading.
        txt(fType + '  —  ' + fLabel, 14, gy, { size: 8, color: '#1F2937', bold: true });
        txt('Your Current Level', barX3, gy + 6.5, { size: 6.5, color: PURPLE });
        // stanine 0 = never taken. Say so and draw no fill — any fill would
        // imply a measured level, and a band word would invent one.
        txt(current > 0 ? stanineBand(current) : 'Not measured',
            W - 14, gy + 6.5, { size: 7, color: PURPLE, bold: true, align: 'right' });
        rect(barX3, gy + 8.5, barW3, 4, '#E5E7EB', null, 1);
        if (current > 0) rect(barX3, gy + 8.5, (current / 9) * barW3, 4, PURPLE, null, 1);
        txt('Typically Required', barX3, gy + 17.5, { size: 6.5, color: GRAY });
        txt(stanineBand(required), W - 14, gy + 17.5, { size: 7, color: '#6B7280', bold: true, align: 'right' });
        rect(barX3, gy + 19.5, barW3, 4, '#E5E7EB', null, 1);
        rect(barX3, gy + 19.5, (required / 9) * barW3, 4, '#9CA3AF', null, 1);
        gy += fs;
      });
      return gy;
    };
    // Keep factor spacing tight and capped — each factor block only needs
    // ~28mm, so allowing it to stretch to fill the page left large, messy gaps.
    const gapFactorSpacing = (startY, pgA, pgB) => {
      return 30;
    };

    doc.addPage();
    sectionHeader('Gap Analysis', 'Adjustment and readiness indicators across social, emotional and academic functioning — identifying strengths, developing areas and support needs', { tint: '#F3F9FE' });
    studentBar(25);
    cy = 40;
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
    sectionHeader('Gap Analysis', 'Adjustment and readiness indicators across social, emotional and academic functioning — identifying strengths, developing areas and support needs', { tint: '#F3F9FE' });
    studentBar(25);
    cy = 40;
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
    sectionHeader('Integrated Career Fit Matrix', 'A combined view of career pathways across all four domains', { tint: '#F3F9FE' });
    studentBar(25);
    cy = 40;

    const matrixNote = 'This matrix combines your Interest, Aptitude, Personality and Wellbeing readiness to calculate an overall alignment level for each career cluster. Strong = well aligned across all domains. Emerging = developing alignment. Exploratory = worth exploring with more exposure.';
    doc.setFont('helvetica','normal'); doc.setFontSize(8); // measure at draw size
    const mnL = doc.splitTextToSize(matrixNote, W - 28);
    txt(mnL.join('\n'), 14, cy + 4, { size: 8, color: '#374151' });
    cy += mnL.length * 5 + 4; // +mDense-aware extra below, once rows are known

    // Stanine 0 means "never measured", which is not the same as a low score —
    // labelling it 'Low' would invent a weakness the student never demonstrated.
    const lvlFromStanine  = (s)  => !s ? 'Not measured' : s >= 7 ? 'High' : s >= 4 ? 'Moderate' : 'Low';
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
        // 'Not measured' must not score as 'Low' — that would penalise a pathway
        // for missing data and push it toward Exploratory on absence rather than
        // evidence. Score it neutrally (same weight as Moderate).
        const lvlPts = (l, hi, mid, lo) => l === 'High' ? hi : (l === 'Moderate' || l === 'Not measured') ? mid : lo;
        const sc = lvlPts(interest, 3, 2, 1) +
                   lvlPts(aptL,     3, 2, 1) +
                   lvlPts(persL,    3, 2, 1) +
                   lvlPts(seaL,     2, 1, 0);
        const align = sc >= 9 ? 'Strong Fit' : sc >= 6 ? 'Emerging Fit' : 'Exploratory';
        const pct = Math.round((sc / 11) * 100);
        return [p.label, interest, aptL, persL, seaL, align, pct, '', ''];
      });
    }

    // Adaptive density: with few rows (AI path sends up to 3-6, score path 6)
    // the page can afford roomier rows and cards; with many rows everything
    // tightens so the whole section still fits one page including the note.
    const mDense = matrixRowsLive.length > 4;
    cy += mDense ? 1 : 5;
    const mHeaders = ['Career Cluster', 'Interest', 'Aptitude', 'Personality', 'SEAA', 'Alignment Level'];
    const mColX = [10, 62, 88, 114, 140, 158];
    const mColW = [52, 26, 26, 26, 18, 42];
    rect(10, cy, W - 20, 7, PURPLE, null, 0);
    mHeaders.forEach((h, i) => txt(h, mColX[i] + 2, cy + 5, { size: 7.5, color: WHITE, bold: true }));
    cy += 7;

    // Rows grow to fit a wrapped cluster name (long "A · B · C" strings) so
    // they never bleed into the next row; every cell is centred vertically.
    const levelColors = { High: C_STRENGTH, Moderate: C_DEVELOPING, Low: C_FOCUS };
    matrixRowsLive.forEach((row, ri) => {
      const nameLines = doc.splitTextToSize(String(row[0]), mColW[0] - 4);
      const rowH = Math.max(mDense ? 11 : 13, (mDense ? 5 : 6) + nameLines.length * 4.2);
      const midY = cy + rowH / 2;
      rect(10, cy, W - 20, rowH, ri % 2 === 0 ? WHITE : LIGHT_GRAY, '#E5E7EB', 0);
      txt(nameLines.join('\n'), mColX[0] + 2, midY - (nameLines.length - 1) * 2.1 + 1, { size: 7.5, color: '#1F2937' });
      [1, 2, 3, 4].forEach((ci) => pill(row[ci], mColX[ci] + 1, midY + 1, levelColors[row[ci]] || GRAY, WHITE, mColW[ci] - 4, 6));
      const alignLabel = row[5]; // 'Strong Fit', 'Emerging Fit', 'Exploratory'
      const dotColor = alignLabel.indexOf('Strong') >= 0 ? PURPLE : alignLabel.indexOf('Emerging') >= 0 ? PURPLE_LIGHT : GRAY;
      setFill(dotColor); doc.circle(mColX[5] + 3, midY, 2, 'F');
      txt(alignLabel, mColX[5] + 7, midY + 1, { size: 7, color: dotColor, bold: true, maxWidth: mColW[5] - 8 });
      cy += rowH;
    });
    cy += 4;

    // Pathway fit summary — one compact strip, strictly mirroring the table's
    // Alignment column. Each tier lists the SAME clusters as the table rows in
    // that tier (all of them — no cap), and an empty tier says so briefly
    // instead of borrowing rows from another tier. (The previous three-box
    // design fabricated "Emerging" content from exploratory rows, so two boxes
    // showed identical clusters while the table said Exploratory — cluttered
    // and contradictory.)
    const tierClusterOf = (r) => r[7] || r[0];
    // De-duplicated: the AI often sends several careers under one cluster
    // (e.g. Entrepreneur + Product Manager both in Business), which produced
    // "Business & Entrepreneurship · Business & Entrepreneurship" in the strip.
    const tierItems = (needle) => Array.from(new Set(matrixRowsLive.filter(r => r[5].indexOf(needle) >= 0).map(tierClusterOf).filter(Boolean)));
    const fitTiers = [
      { label: 'Strong Fit',  color: A_STRONG.t,  fill: A_STRONG.fill,  items: tierItems('Strong'),      empty: 'None yet — alignment grows with exposure and practice.' },
      { label: 'Emerging Fit', color: A_DEV.t,     fill: A_DEV.fill,     items: tierItems('Emerging'),   empty: 'None at this tier yet.' },
      { label: 'Exploratory', color: A_EXPLORE.t,  fill: A_EXPLORE.fill, items: tierItems('Exploratory'), empty: 'Broad exploration recommended this year.' },
    ];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    fitTiers.forEach((t) => {
      const text = t.items.length ? t.items.join('  ·  ') : t.empty;
      t._lines = doc.splitTextToSize(text, W - 78);
      t._h = Math.max(7.5, 3 + t._lines.length * 4.2);
    });
    // Section heading + one row per tier with a light tint in the tier's
    // colour family, so the summary reads as a designed block rather than a
    // bare box.
    cy += mDense ? 2 : 4;
    cy = subHeading('Pathway Fit Summary', cy);
    const tierTint = { 'Strong Fit': A_STRONG.fill, 'Emerging Fit': A_DEV.fill, 'Exploratory': A_EXPLORE.fill };
    fitTiers.forEach((t) => { t._h = Math.max(mDense ? 9.5 : 11, (mDense ? 4 : 5) + t._lines.length * 4.2); });
    const tierStripH = fitTiers.reduce((s, t) => s + t._h, 0);
    let tyy = cy;
    fitTiers.forEach((t) => {
      rect(10, tyy, W - 20, t._h, tierTint[t.label] || WHITE, '#E5E7EB', 0);
      const tMidY = tyy + t._h / 2;
      setFill(t.color); doc.circle(16, tMidY - 0.8, 1.8, 'F');
      txt(t.label, 21, tMidY + 0.6, { size: 7.5, color: t.color, bold: true });
      txt(t._lines.join('\n'), 54, tMidY - (t._lines.length - 1) * 2.1 + 0.6, { size: 7.5, color: t.items.length ? '#1F2937' : GRAY });
      tyy += t._h;
    });
    doc.setLineWidth(0.3); setDraw('#D1D5DB'); doc.roundedRect(10, cy, W - 20, tierStripH, 1.5, 1.5, 'S');
    cy += tierStripH + (mDense ? 8 : 12);

    // Recommended Subject Pathways — the template's 01/02/03 chevron cards.
    // The block (heading + 3 cards + note ≈ 90mm) moves to a fresh page AS A
    // UNIT when it will not fit below the tier strip — never a page break
    // mid-list, which left one card stranded and the heading orphaned above.
    {
      const _spNeed = 8 + 3 * ((mDense ? 17 : 21) + (mDense ? 4 : 6)) + 16;
      if (cy + _spNeed > BOTTOM) {
        doc.addPage();
        sectionHeader('Integrated Career Fit Matrix', 'Recommended subject pathways based on your fit matrix', { tint: '#F3F9FE' });
        studentBar(25); cy = 40;
      }
      cy = subHeading('RECOMMENDED SUBJECT PATHWAYS', cy);
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
      // Resolve each recommendation to a CLUSTER label (not the career-pathway
      // text) so subjectMap actually matches. row[7] carries the cluster for AI
      // rows; score-driven rows put the cluster in row[0]. Previously these
      // keyed off row[0] (the pathway description), so subjectMap always missed
      // and every slot printed the generic "Multidisciplinary stream" fallback.
      const rowCluster = (r) => r[7] || r[0];
      const clByTier   = (needle) => matrixRowsLive.filter(r => r[5].indexOf(needle) >= 0).map(rowCluster);
      // Distinct clusters in tier order (the AI often lists several careers per
      // cluster, which made Strong and Alternate print the same stream). Then
      // top up from the CPI top-3, still skipping clusters already used.
      const _seenCl = new Set();
      const orderedCl = [...clByTier('Strong'), ...clByTier('Emerging'), ...clByTier('Exploratory'),
                         ...top3.map(t => t.label)]
        .filter(c => c && !_seenCl.has(c) && _seenCl.add(c));
      const recPrimary = orderedCl[0] || '';
      const recAlt     = orderedCl[1] || recPrimary;
      const recExpl    = orderedCl[2] || recAlt;
      // Robust lookup: exact cluster match, else match on the leading keyword
      // (handles AI cluster names like "Sports" vs "Sports & Physical Perf.").
      const resolveSubject = (cluster) => {
        if (!cluster) return 'Flexible / multidisciplinary stream';
        if (subjectMap[cluster]) return subjectMap[cluster];
        const head = String(cluster).toLowerCase().split(/[ &·/]/)[0];
        const k = Object.keys(subjectMap).find(key => key.toLowerCase().startsWith(head));
        return k ? subjectMap[k] : 'Flexible / multidisciplinary stream';
      };
      const pathways = [
        { num:'01', fit:'Strong Fit',      type:'(Primary Pathway)',  subject: resolveSubject(recPrimary), desc:'Highest alignment with your assessed strengths and top fit pathway.' },
        { num:'02', fit:'Alternate Fit',   type:'(Related Pathway)',  subject: resolveSubject(recAlt),     desc:'Supports closely related pathways while keeping multiple career options open.' },
        { num:'03', fit:'Exploration Fit', type:'(Flexible Pathway)', subject: resolveSubject(recExpl),    desc:'Maintains broader opportunities for exploration and evolving interests.' },
      ];
      pathways.forEach((p) => {
        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
        const dL = doc.splitTextToSize(p.desc, W - 140);
        const pH = Math.max(mDense ? 20 : 24, (mDense ? 10 : 12) + dL.length * 4.5);
        rect(10, cy, W - 20, pH, CARD_FILL, CARD_BD, 2);
        // Pennant number block (consistent purple) with a downward chevron tip —
        // matches the template's ribbon marker.
        const blockH = pH - 5;
        setFill(PURPLE); doc.roundedRect(10, cy, 15, blockH, 2, 2, 'F');
        doc.triangle(10, cy + blockH - 1, 25, cy + blockH - 1, 17.5, cy + blockH + 4, 'F');
        txt(p.num, 17.5, cy + blockH / 2 + 2, { size: 11, color: WHITE, bold: true, align: 'center' });
        txt(p.fit, 30, cy + (mDense ? 7 : 9), { size: 9, color: PURPLE, bold: true });
        txt(p.type, 66, cy + (mDense ? 7 : 9), { size: 6.5, color: GRAY });
        txt(p.subject, 30, cy + (mDense ? 14 : 16.5), { size: 9, color: '#1F2937', bold: true, maxWidth: 88 });
        txt(dL.join('\n'), 124, cy + pH / 2 - (dL.length - 1) * 2 + 0.5, { size: 7.5, color: GRAY, maxWidth: W - 140 });
        cy += pH + (mDense ? 5 : 7);
      });
      if (cy + 16 < BOTTOM) {
        cy = instructionBox(cy, 'PLEASE NOTE', 'Subject pathways are indicative recommendations, not final. Explore options aligned with your aptitude, interests, academics and goals.', { bodySize: 7.5, lineH: 4.2, gapAfter: 4 });
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
    // Always starts on a fresh page: the block is tall (10 numbered items,
    // some wrapping to two lines) and the old fit-check under-measured wrapped
    // lines, letting the list collide with the footer on the matrix page.
    doc.addPage();
    sectionHeader('Summary & Recommendations', 'Practical steps, personality development guidance and counsellor notes', { tint: '#F4F1FB' });
    studentBar(25);
    cy = 40;
    await drawIcon('Tips to Strengthen Aptitude', 12, cy - 5.4, 7, { fill: '#FFFFFF', border: CARD_BD });
    txt('Tips to Strengthen Aptitude', 22, cy, { size: 10, color: '#111827', bold: true }); cy += 8;
    // Two-column grid of numbered cards: uses the page width, easier to scan
    // than a long single-column list, and reads as designed guidance.
    const tipsGrid = (items, y) => {
      const colW = (W - 20 - 5) / 2, gap = 5, rowGap = 3.5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      const lines = items.map(t => doc.splitTextToSize(t, colW - 15));
      let yy = y;
      for (let i = 0; i < items.length; i += 2) {
        const hL = lines[i].length, hR = lines[i + 1] ? lines[i + 1].length : 0;
        const rh = Math.max(11, 4 + Math.max(hL, hR) * 4.2);
        [0, 1].forEach(col => {
          const idx = i + col; if (idx >= items.length) return;
          const px = 10 + col * (colW + gap);
          rect(px, yy, colW, rh, '#FAFAFA', '#E5E7EB', 1.5);
          setFill(PURPLE); doc.circle(px + 6, yy + rh / 2, 3, 'F');
          txt(String(idx + 1), px + 6, yy + rh / 2 + 1.5, { size: 6.5, color: WHITE, bold: true, align: 'center' });
          txt(lines[idx].join('\n'), px + 12, yy + rh / 2 - (lines[idx].length - 1) * 2.1 + 1.2, { size: 7.5, color: '#374151' });
        });
        yy += rh + rowGap;
      }
      return yy + 3;
    };
    cy = tipsGrid(tips, cy);

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
    // Second list needs ~5 rows of ~14.5mm + heading; move it (as a unit) if
    // it will not fit.
    if (cy + 8 + Math.ceil(wellbeingTips.length / 2) * 14.5 > BOTTOM) {
      doc.addPage();
      sectionHeader('Summary & Recommendations', 'Practical steps, personality development guidance and counsellor notes', { tint: '#F4F1FB' });
      studentBar(25);
      cy = 40;
    }
    cy += 4;
    await drawIcon('Fostering Wellbeing', 12, cy - 5.4, 7, { fill: '#FFFFFF', border: CARD_BD });
    txt('Fostering Healthy Personality Development & Emotional Wellbeing', 22, cy, { size: 9.5, color: '#111827', bold: true }); cy += 8;
    cy = tipsGrid(wellbeingTips, cy);
    cy += 4;

    // Closing block — NOTE + Counsellor's Remarks + Disclaimer measured and
    // moved TOGETHER. If they don't fit under the tips, they open a properly
    // titled closing page (never a mislabeled near-empty orphan) which also
    // carries a data-driven "Your Next Steps" checklist so the page earns
    // its place.
    const cr = 'Dear Students, Please note that final academic and career decisions should be made by considering aptitude, interests, and academic performance together. This report is intended to serve as a guidance tool and should be used alongside discussions with parents, teachers, and counselors to support well-informed decision making.';
    const disc = 'This NuMind MAPS Report presents indicative insights derived from standardized assessments to support self-awareness, exploration, and informed decision-making. Recommendations are illustrative, not prescriptive, and should be interpreted alongside academic performance, evolving interests, and guidance from parents, teachers, or qualified counselors. Final academic and career decisions should not be made solely on the basis of this report.';
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);   const crL   = doc.splitTextToSize(cr, W - 28);
    doc.setFontSize(7.5); const discL = doc.splitTextToSize(disc, W - 28);
    const crBoxH   = 11 + crL.length * 4.6;
    const discBoxH = 11 + discL.length * 4.2;
    const closingNeed = 16 + 10 + crBoxH + 8 + discBoxH;
    const closingOnNewPage = cy + closingNeed > BOTTOM;
    if (closingOnNewPage) {
      doc.addPage();
      sectionHeader('Closing Notes', 'Your next steps, counsellor remarks and how to use this report', { tint: '#F4F1FB' });
      studentBar(25);
      cy = 40;

      // Your Next Steps — concrete, from this student's own data.
      const _nsInterest = top3[0] ? top3[0].label : null;
      // Rated only: otherwise the lowest 'score' is an unattempted sub-test and the
      // student is told to practise something they were never assessed on.
      const _nsRated    = aptitude8.filter(a => a.attempted);
      const _nsWeakApt  = _nsRated.slice().sort((a, b) => a.stanine - b.stanine)[0];
      const _nsStrongApt= _nsRated.slice().sort((a, b) => b.stanine - a.stanine)[0];
      const _nsSea      = seaCards.filter(c => c.label === 'Support Needed')[0] || seaCards.filter(c => c.label === 'Developing Readiness')[0];
      const _nsPers     = personality9.slice().sort((a, b) => a.stanine - b.stanine)[0];
      const nextSteps = [];
      if (_nsInterest) nextSteps.push(['Explore your top interest', 'Try one real activity in ' + _nsInterest + ' this term — a club, a project, a conversation with someone who works in it.']);
      if (_nsWeakApt)  nextSteps.push(['Ten minutes a day', 'Short, regular practice on ' + _nsWeakApt.name.replace(' Ability','').replace(' Apt.','') + ' beats an hour once a week — see the practice ideas on the aptitude page.']);
      if (_nsStrongApt && _nsStrongApt.stanine >= 7) nextSteps.push(['Use a strength', 'Lean on ' + _nsStrongApt.name.replace(' Ability','').replace(' Apt.','') + ' when learning something new — connect harder topics to what already comes naturally.']);
      if (_nsSea)      nextSteps.push(['A steady routine', 'For ' + _nsSea.title.replace(' Adjustment','').toLowerCase() + ' readiness: one predictable daily habit and a regular check-in with a trusted adult.']);
      if (_nsPers)     nextSteps.push(['One growth habit', 'Pick one small, repeatable action for ' + _nsPers.name + ' and do it for four weeks before adding another.']);
      nextSteps.push(['Talk it through', 'Share this report with a parent, teacher or counsellor and choose ONE thing to start this month.']);
      cy = subHeading('Your Next Steps', cy);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      nextSteps.forEach((st, i) => {
        const ls = doc.splitTextToSize(st[1], W - 74);
        const rh = Math.max(11, 4 + ls.length * 4.2);
        rect(10, cy, W - 20, rh, i % 2 === 0 ? WHITE : LIGHT_GRAY, '#E5E7EB', 0);
        setFill(PURPLE); doc.circle(16, cy + rh / 2, 2.6, 'F');
        txt(String(i + 1), 16, cy + rh / 2 + 1.3, { size: 6.5, color: WHITE, bold: true, align: 'center' });
        txt(st[0], 22, cy + rh / 2 + 1, { size: 7.5, color: '#1F2937', bold: true, maxWidth: 36 });
        txt(ls.join('\n'), 62, cy + rh / 2 - (ls.length - 1) * 2.1 + 1, { size: 7.5, color: '#374151' });
        cy += rh;
      });
      cy += 10;
    } else {
      cy += 4;
    }
    cy = instructionBox(cy, 'NOTE', 'These areas are developmental in nature and can be strengthened over time through consistent practice, support, and conscious effort.', { bodySize: 7.5, lineH: 4.2, gapAfter: 10 });

    rect(10, cy, W - 20, crBoxH, '#F5F3FF', '#C4B5FD', 2);
    txt("Counsellor's Remarks", 14, cy + 6.5, { size: 8.5, color: PURPLE, bold: true });
    txt(crL.join('\n'), 14, cy + 12.5, { size: 8, color: '#374151' });
    cy += crBoxH + 8;

    rect(10, cy, W - 20, discBoxH, LIGHT_GRAY, null, 2);
    txt('Disclaimer', 14, cy + 6.5, { size: 8.5, color: '#1F2937', bold: true });
    txt(discL.join('\n'), 14, cy + 12.5, { size: 7.5, color: GRAY });

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
