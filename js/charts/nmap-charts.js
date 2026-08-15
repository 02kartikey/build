/* ════════════════════════════════════════════════════════════════════
   charts/nmap-charts.js
   NMAP bar.
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { NMAP_DIMS } from '../engine/nmap.js';
import { CHARTS, destroyChart, stanineColor, CHART_ALPHA } from './core.js';

function buildNMAPCharts() {
  const nmap = S.nmap.scores;
  if (!nmap) return;

  const dims = nmap.dims;
  const labels = dims.map(d => d.abbr);
  const stanines = dims.map(d => d.stanine);
  const pcts = dims.map(d => d.pct);
  const colors = dims.map(d => stanineColor(d.stanine));

  // ── 2. Vertical bar ──
  destroyChart('nmap-bar');
  const barCtx = document.getElementById('chart-nmap-bar');
  if (barCtx) {
    CHARTS['nmap-bar'] = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Trait strength',
          data: stanines,
          backgroundColor: colors.map(c => CHART_ALPHA(c, 0.73)),
          borderColor: colors,
          borderWidth: 2, borderRadius: 8, borderSkipped: false,
        }, {
          type: 'line',
          label: 'Average (5)',
          data: Array(dims.length).fill(5),
          borderColor: 'rgba(107,114,128,0.5)',
          borderDash: [5,5],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: 'Inter', size: 11 }, boxWidth: 12, generateLabels: (chart) => [
            ...Chart.defaults.plugins.legend.labels.generateLabels(chart),
            { text: '🔴 Focus Area · 🟡 Developing Area · 🟢 Strength Area', fillStyle: 'transparent', strokeStyle: 'transparent', fontColor: '#6b7280', textDecoration: 'none' }
          ]}},
          tooltip: {
            callbacks: {
              label: ctx => ctx.datasetIndex === 0
                ? ` ${dims[ctx.dataIndex].label} — ${ctx.raw<=3?'🔴 Focus Area':ctx.raw<=6?'🟡 Developing Area':'🟢 Strength Area'}`
                : ` Average band`
            }
          }
        },
        scales: {
          y: { min: 0, max: 9, grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { stepSize: 3, callback: v => ({3:'Focus',6:'Developing',9:'Strength'}[v] || ''), font: { family:'Poppins', size:10, weight:'600' } } },
          x: { grid: { display: false }, ticks: { font: { family: 'Poppins', size: 10, weight: '600' } } }
        }
      }
    });
  }

  // ── 3. Bubble chart ──
  destroyChart('nmap-bubble');
  const bubCtx = document.getElementById('chart-nmap-bubble');
  if (bubCtx) {
    CHARTS['nmap-bubble'] = new Chart(bubCtx, {
      type: 'bubble',
      data: {
        datasets: dims.map((d, i) => ({
          label: d.abbr,
          data: [{ x: i + 1, y: d.pct, r: Math.max(6, d.stanine * 4) }],
          backgroundColor: CHART_ALPHA(colors[i], 0.75),
          borderColor: colors[i],
          borderWidth: 2,
        }))
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${dims[ctx.datasetIndex].label}`
            }
          }
        },
        scales: {
          x: { display: false, min: 0, max: 10 },
          y: {
            min: 0, max: 100,
            title: { display: true, text: 'Trait strength', font: { size: 11 } },
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { callback: v => v + '%', font: { size: 10 } }
          }
        }
      }
    });
  }
}

/* ═══════════════════════════════════════
   DAAB CHARTS
═══════════════════════════════════════ */

export { buildNMAPCharts };
