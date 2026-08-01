/* ════════════════════════════════════════════════════════════════════
   charts/daab-charts.js
   DAAB bar.
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { DAAB_SUBS } from '../engine/daab.js';
import { CHARTS, destroyChart, stanineColor, CHART_ALPHA } from './core.js';

function buildDAAbCharts() {
  const daabSubs = ['va','pa','na','lsa','hma','ar','ma','sa'];
  const subLabels = { va:'Verbal', pa:'Perceptual', na:'Numerical', lsa:'Legal', hma:'Health', ar:'Abstract', ma:'Mechanical', sa:'Spatial' };
  const subEmoji  = { va:'📝', pa:'👁️', na:'🔢', lsa:'⚖️', hma:'🏥', ar:'🔷', ma:'⚙️', sa:'📐' };

  const available = daabSubs.filter(k => S.daab[k].scores);
  if (!available.length) return;

  const labels   = available.map(k => subLabels[k]);
  const stanines = available.map(k => S.daab[k].scores.stanine);
  const raws     = available.map(k => S.daab[k].scores.raw);
  const maxes    = available.map(k => S.daab[k].scores.max);
  const colors   = stanines.map(stanineColor);

  // ── 1. Bar with annotation line ──
  destroyChart('daab-bar');
  const barCtx = document.getElementById('chart-daab-bar');
  if (barCtx) {
    CHARTS['daab-bar'] = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Aptitude',
          data: stanines,
          backgroundColor: colors.map(c => CHART_ALPHA(c, 0.8)),
          borderColor: colors,
          borderWidth: 2, borderRadius: 8, borderSkipped: false,
        }, {
          type: 'line',
          label: 'Average (5)',
          data: Array(available.length).fill(5),
          borderColor: 'rgba(107,114,128,0.55)',
          borderDash: [6,4],
          borderWidth: 2,
          pointRadius: 0, fill: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family:'Inter', size:11 }, boxWidth:12, generateLabels: (chart) => [
            ...Chart.defaults.plugins.legend.labels.generateLabels(chart),
            { text: '🔴 1–3 Needs Attention · 🟡 4–6 Developing · 🟢 7–9 Strength', fillStyle: 'transparent', strokeStyle: 'transparent', fontColor: '#6b7280' }
          ]}},
          tooltip: {
            callbacks: {
              label: ctx => ctx.datasetIndex === 0
                ? ` ${S.daab[available[ctx.dataIndex]].scores.label} — ${ctx.raw<=3?'🔴 Focus Area':ctx.raw<=6?'🟡 Developing Area':'🟢 Strength Area'}`
                : ' Average'
            }
          }
        },
        scales: {
          y: { min: 0, max: 9, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { stepSize: 1 } },
          x: { grid: { display: false }, ticks: { font: { family:'Poppins', size:11, weight:'600' } } }
        }
      }
    });
  }

  // ── 3. Stacked bar: raw vs remaining ──
}


export { buildDAAbCharts };
