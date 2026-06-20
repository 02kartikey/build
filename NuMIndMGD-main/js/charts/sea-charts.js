/* ════════════════════════════════════════════════════════════════════
   charts/sea-charts.js
   SEAA gauges + radar.
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { SEA_DOMAINS } from '../engine/sea.js';
import { CHARTS, destroyChart, SEL_CAT_COLOR, SEL_DOM_INFO } from './core.js';

function buildSELCharts() {
  const sea = S.sea.scores;
  if (!sea) return;

  const doms = ['E', 'S', 'A'];

  // Bar colours come from category severity (A=green … E=red).
  // Using shared constants so gauges, bar, radar, and report charts all stay in sync.
  const barColors = doms.map(d => SEL_CAT_COLOR[sea.cls[d].cat] || '#6b7280');

  // ── 1. Grouped bar — bar height = problem score, colour = category severity ──
  destroyChart('sel-bar');
  const barCtx = document.getElementById('chart-sel-bar');
  if (barCtx) {
    CHARTS['sel-bar'] = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: doms.map(d => SEL_DOM_INFO[d].label),
        datasets: [{
          label: '⚠ Problem Score (Higher = More Concern)',
          data: doms.map(d => sea.domScores[d]),
          backgroundColor: barColors.map(c => c + 'cc'),
          borderColor: barColors,
          borderWidth: 2.5, borderRadius: 10, borderSkipped: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              font: { family: 'Inter', size: 11 },
              // Dynamic legend: one entry per domain showing its actual category & colour
              generateLabels: () => doms.map(d => {
                const cl  = sea.cls[d];
                const col = SEL_CAT_COLOR[cl.cat] || '#6b7280';
                return {
                  text: `${SEL_DOM_INFO[d].label}: Cat ${cl.cat} — ${cl.level}`,
                  fillStyle: col + 'cc',
                  strokeStyle: col,
                  fontColor: '#374151',
                  lineWidth: 1.5,
                };
              }),
            },
          },
          tooltip: {
            callbacks: {
              label: ctx => ` Score: ${ctx.raw}/20`,
              afterLabel: ctx => {
                const d  = doms[ctx.dataIndex];
                const cl = sea.cls[d];
                return [` Category ${cl.cat}: ${cl.level}`, ` ↑ Higher bar = more difficulty`];
              },
            },
          },
        },
        scales: {
          y: {
            max: 20, beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.05)' },
            title: { display: true, text: '← Lower is better', font: { size: 10 }, color: '#6b7280' },
          },
          x: { grid: { display: false }, ticks: { font: { family: 'Poppins', size: 12, weight: '600' } } },
        },
      },
    });
  }

  // ── 2. Custom gauges ──
  const gaugesEl = document.getElementById('chart-sel-gauges');
  if (gaugesEl) {
    gaugesEl.innerHTML = doms.map(d => {
      const sc = sea.domScores[d], cl = sea.cls[d], di = SEL_DOM_INFO[d];
      const pct = Math.round(sc / 20 * 100);
      const cc  = SEL_CAT_COLOR[cl.cat] || '#6b7280';
      return `<div class="sel-gauge-item">
        <div class="sel-gauge-label">${di.label}</div>
        <div class="sel-gauge-track">
          <div class="sel-gauge-fill" data-label="${cl.level}"
            style="width:0%;background:${cc};transition:width 1.2s cubic-bezier(.22,1,.36,1)"
            data-target="${pct}">
          </div>
        </div>
        <div class="sel-gauge-score">${sc}<span style="font-size:11px;color:var(--ink4)">/20</span></div>
      </div>`;
    }).join('');
    // Animate after paint
    setTimeout(() => {
      document.querySelectorAll('.sel-gauge-fill').forEach(el => {
        el.style.width = el.dataset.target + '%';
      });
    }, 300);
  }

  // ── 3. Radar (inverted: higher on chart = BETTER adjustment) ──
  // Each point is coloured by the domain's actual category so it matches the bar + gauges.
  destroyChart('sel-radar');
  const radarCtx = document.getElementById('chart-sel-radar');
  if (radarCtx) {
    const invertedScores  = doms.map(d => 20 - sea.domScores[d]);
    const pointColors     = doms.map(d => SEL_CAT_COLOR[sea.cls[d].cat] || '#6b7280');
    // Average category colour for the fill/border
    const avgScore        = sea.domScores['E'] + sea.domScores['S'] + sea.domScores['A'];
    const avgCat          = avgScore <= 24 ? 'A' : avgScore <= 30 ? 'B' : avgScore <= 36 ? 'C' : avgScore <= 42 ? 'D' : 'E';
    const radarBorder     = SEL_CAT_COLOR[avgCat];
    const radarFill       = radarBorder + '26'; // ~15% opacity
    CHARTS['sel-radar'] = new Chart(radarCtx, {
      type: 'radar',
      data: {
        labels: ['Emotional\nAdjustment', 'Social\nAdjustment', 'Academic\nAdjustment'],
        datasets: [{
          label: 'Adjustment (↑ Higher = Better)',
          data: invertedScores,
          backgroundColor: radarFill,
          borderColor: radarBorder,
          pointBackgroundColor: pointColors,  // each point = that domain's category colour
          pointBorderColor: '#fff',
          pointRadius: 6,
          borderWidth: 2.5,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const d  = doms[ctx.dataIndex];
                const cl = sea.cls[d];
                const raw = sea.domScores[d];
                return [
                  ` Raw score: ${raw}/20 (lower = better)`,
                  ` Category ${cl.cat}: ${cl.level}`,
                ];
              },
            },
          },
        },
        scales: {
          r: {
            min: 0, max: 20,
            ticks: { stepSize: 5, font: { size: 10 } },
            pointLabels: { font: { family: 'Poppins', size: 11, weight: '600' }, color: '#2d3348' },
            grid: { color: 'rgba(0,0,0,0.07)' },
            angleLines: { color: 'rgba(0,0,0,0.08)' },
          },
        },
      },
    });
  }
}

/* ═══════════════════════════════════════
   NMAP CHARTS
═══════════════════════════════════════ */

export { buildSELCharts };
