/* ════════════════════════════════════════════════════════════════════
   charts/overview-charts.js
   Overview combined charts (bar).
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { CPI_AREAS } from '../engine/cpi.js';
import { NMAP_DIMS } from '../engine/nmap.js';
import { DAAB_SUBS } from '../engine/daab.js';
import { SEA_DOMAINS } from '../engine/sea.js';
import { CHARTS, destroyChart, stanineColor, CHART_ALPHA, SEL_CAT_LABEL } from './core.js';

function buildOverviewCharts() {
  const nmap = S.nmap.scores;
  // DAAB order + short labels from canonical DAAB_SUBS (was a hardcoded map
  // that used its own truncations, e.g. "Percept."/"Numer.").
  const SUB = Object.fromEntries(DAAB_SUBS.map(s => [s.key, s]));
  const daabSubs = DAAB_SUBS.map(s => s.key);
  const available = daabSubs.filter(k => S.daab[k].scores);

  // Build a combined array of all stanine dimensions
  const allLabels = [], allStanines = [], allColors = [], allGroups = [];

  if (nmap) {
    nmap.dims.forEach(d => {
      allLabels.push(d.abbr);
      allStanines.push(d.stanine);
      allColors.push(stanineColor(d.stanine));
      allGroups.push('Personality');
    });
  }
  available.forEach(k => {
    allLabels.push(SUB[k].short);
    allStanines.push(S.daab[k].scores.stanine);
    allColors.push(stanineColor(S.daab[k].scores.stanine));
    allGroups.push('Aptitude');
  });

  // ── 1. Big grouped bar ──
  destroyChart('overview-bar');
  const ovBarCtx = document.getElementById('chart-overview-bar');
  if (ovBarCtx && allLabels.length) {
    CHARTS['overview-bar'] = new Chart(ovBarCtx, {
      type: 'bar',
      data: {
        labels: allLabels,
        datasets: [{
          label: 'Score',
          data: allStanines,
          backgroundColor: allColors.map(c => CHART_ALPHA(c, 0.8)),
          borderColor: allColors,
          borderWidth: 2, borderRadius: 6, borderSkipped: false,
        }, {
          type: 'line',
          label: 'Average (5)',
          data: Array(allLabels.length).fill(5),
          borderColor: 'rgba(107,114,128,0.4)',
          borderDash: [6,4], borderWidth: 2,
          pointRadius: 0, fill: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family:'Inter', size:11 }, boxWidth:12, generateLabels: (chart) => [
            ...Chart.defaults.plugins.legend.labels.generateLabels(chart),
            { text: '🔴 Focus Area · 🟡 Developing Area · 🟢 Strength Area', fillStyle: 'transparent', strokeStyle: 'transparent', fontColor: '#6b7280' }
          ]}},
          tooltip: {
            callbacks: {
              title: ctx => `${ctx[0].label} (${allGroups[ctx[0].dataIndex]})`,
              label: ctx => ctx.datasetIndex === 0
                ? ` ${ctx.raw<=3?'🔴 Focus Area':ctx.raw<=6?'🟡 Developing Area':'🟢 Strength Area'}`
                : ' Average'
            }
          }
        },
        scales: {
          y: { min: 0, max: 9, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { stepSize: 3, callback: v => ({3:'Focus',6:'Developing',9:'Strength'}[v] || ''), font: { family:'Poppins', size:10, weight:'600' } } },
          x: { grid: { display: false }, ticks: { font: { family:'Poppins', size: 9, weight: '600' }, maxRotation: 45 } }
        }
      }
    });
  }

  // ── Summary stats ──
  const statsEl = document.getElementById('chart-overview-stats');
  if (statsEl) {
    const allStn = allStanines;
    const avg = allStn.length ? (allStn.reduce((a,b)=>a+b,0)/allStn.length).toFixed(1) : '-';
    const high = allStn.filter(s=>s>=7).length;
    const mid  = allStn.filter(s=>s>=4&&s<=6).length;
    const low  = allStn.filter(s=>s<=3).length;
    // SEL snapshot
    const sea = S.sea.scores;
    const cpi = S.cpi.scores;
    const seaSummary = sea
      ? `E: ${SEL_CAT_LABEL[sea.cls.E.cat]} · S: ${SEL_CAT_LABEL[sea.cls.S.cat]} · A: ${SEL_CAT_LABEL[sea.cls.A.cat]}`
      : '—';
    const cpiTop = cpi && cpi.top3.length ? cpi.top3.slice(0,2).map(a=>a.abbr).join(', ') : '—';
    statsEl.innerHTML = `
      <div class="chart-stat-pill" style="border-left:4px solid #10b981">
        <div class="chart-stat-num" style="color:#10b981">${high}</div>
        <div class="chart-stat-lbl">🟢 Strengths</div>
      </div>
      <div class="chart-stat-pill" style="border-left:4px solid #f59e0b">
        <div class="chart-stat-num" style="color:#f59e0b">${mid}</div>
        <div class="chart-stat-lbl">🟡 Developing Areas</div>
      </div>
      <div class="chart-stat-pill" style="border-left:4px solid #ef4444">
        <div class="chart-stat-num" style="color:#ef4444">${low}</div>
        <div class="chart-stat-lbl">🔴 Focus Areas</div>
      </div>
      <div class="chart-stat-pill" style="border-left:4px solid #1a7f8e">
        <!-- Band word only. The tile was renamed from "Avg Stanine" earlier but
             still printed the numeric average — a label/value mismatch. -->
        <div class="chart-stat-num" style="color:#1a7f8e;font-size:15px">${avg === '-' ? '—' : (parseFloat(avg) >= 6.5 ? 'Strength' : parseFloat(avg) >= 4 ? 'Developing' : 'Focus')}</div>
        <div class="chart-stat-lbl">Overall Band</div>
      </div>
      <div class="chart-stat-pill" style="border-left:4px solid #7c6fcd;min-width:200px">
        <div class="chart-stat-num" style="font-size:13px;color:#7c6fcd">${seaSummary}</div>
        <div class="chart-stat-lbl">SEAA Readiness</div>
      </div>
      <div class="chart-stat-pill" style="border-left:4px solid #4f46e5;min-width:140px">
        <div class="chart-stat-num" style="font-size:13px;color:#4f46e5">${cpiTop}</div>
        <div class="chart-stat-lbl">Top Interests</div>
      </div>`;
  }
}


// Generated once per page load — changes on every F5/reload.

export { buildOverviewCharts };
