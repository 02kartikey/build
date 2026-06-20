/* ════════════════════════════════════════════════════════════════════
   charts/core.js
   Chart.js registry + colour helpers. NO chart-builder imports here — buildCharts is in ui/results.js. This avoids cyclic imports.
════════════════════════════════════════════════════════════════════ */

const CHARTS = {};

function destroyChart(id) {
  if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
}

// Tab switching
function switchChartTab(tab) {
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.chart-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.chart-tab').forEach(t => {
    if (t.getAttribute('onclick') === `switchChartTab('${tab}')`) t.classList.add('active');
  });
  const panel = document.getElementById('chart-panel-' + tab);
  if (panel) panel.classList.add('active');
}

// Called from buildResults() after scores are ready


/* ── Colour helpers ── */

/**
 * Convert a #RRGGBB hex colour to rgba(r,g,b,a).
 * Guards against non-hex strings so a stray rgba() value won't break parseInt.
 */
const CHART_ALPHA = (hex, a) => {
  if (!hex || hex[0] !== '#') return hex; // already rgba or invalid — return as-is
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
};

/**
 * Returns a solid hex colour for a stanine score (1–9).
 * Pass alpha (0–1) to get an rgba string instead.
 * Zone: 1–3 = Red, 4–6 = Amber, 7–9 = Green.
 */
function stanineColor(s, alpha) {
  const hex = s <= 3 ? '#ef4444' : s <= 6 ? '#f59e0b' : '#10b981';
  if (alpha == null) return hex;
  return CHART_ALPHA(hex, alpha);
}

function stanineZoneLabel(s) {
  return s <= 3 ? '🔴 Needs Attention' : s <= 6 ? '🟡 Developing' : '🟢 Strength';
}

/* ── Shared SEL/SEA colour maps (single source of truth) ──────────────────
   Import these in sea-charts.js AND report-charts.js so both stay in sync.  */

/** Cat A (best adjustment) → green … Cat E (most concern) → red */
const SEL_CAT_COLOR = {
  A: '#10b981',   // green
  B: '#34d399',   // light green
  C: '#f59e0b',   // amber
  D: '#f97316',   // orange
  E: '#ef4444',   // red
};

/** Domain meta for E / S / A */
const SEL_DOM_INFO = {
  E: { label: 'Emotional', color: '#1e3a5f', light: '#e4eef8' },
  S: { label: 'Social',    color: '#0f766e', light: '#ccfbf1' },
  A: { label: 'Academic',  color: '#b45309', light: '#fef3c7' },
};

/* ═══════════════════════════════════════
   CPI CHARTS
═══════════════════════════════════════ */

export { CHARTS, destroyChart, switchChartTab, CHART_ALPHA, stanineColor, stanineZoneLabel, SEL_CAT_COLOR, SEL_DOM_INFO };
