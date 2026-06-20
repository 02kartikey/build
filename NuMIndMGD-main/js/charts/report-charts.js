/* ════════════════════════════════════════════════════════════════════
   charts/report-charts.js
   Builds the duplicated chart canvases inside the AI report slot.
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { CPI_AREAS } from '../engine/cpi.js';
import { NMAP_DIMS } from '../engine/nmap.js';
import { DAAB_SUBS } from '../engine/daab.js';
import { SEA_DOMAINS } from '../engine/sea.js';
import { CHARTS, destroyChart, CHART_ALPHA, stanineColor, SEL_CAT_COLOR, SEL_DOM_INFO } from './core.js';

function buildReportCharts() {
  /* Builds each inline report chart directly from S data — no cloning,
     avoids JSON.stringify breaking function references in Chart.js options. */

  /* ─── shared helpers ─── */
  const subLabels = { va:'Verbal', pa:'Perceptual', na:'Numerical', lsa:'Legal',
                      hma:'Health', ar:'Abstract', ma:'Mechanical', sa:'Spatial' };
  // SEL colour maps come from core.js (SEL_CAT_COLOR, SEL_DOM_INFO) — single source of truth.

  /* ═══ 1. DAAB bar ═══ */
  destroyChart('daab-bar-rpt');
  const daabBarEl = document.getElementById('chart-daab-bar-rpt');
  if (daabBarEl) {
    const avail   = ['va','pa','na','lsa','hma','ar','ma','sa'].filter(k => S.daab[k].scores);
    if (avail.length) {
      const labels   = avail.map(k => subLabels[k]);
      const stanines = avail.map(k => S.daab[k].scores.stanine);
      const colors   = stanines.map(stanineColor);
      CHARTS['daab-bar-rpt'] = new Chart(daabBarEl, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label:'Stanine', data:stanines,
              backgroundColor: colors.map(c => CHART_ALPHA(c, 0.8)), borderColor:colors,
              borderWidth:2, borderRadius:8, borderSkipped:false },
            { type:'line', label:'Average (5)', data:Array(avail.length).fill(5),
              borderColor:'rgba(107,114,128,0.55)', borderDash:[6,4],
              borderWidth:2, pointRadius:0, fill:false }
          ]
        },
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins: {
            legend:{ position:'bottom', labels:{ font:{ family:'Inter', size:11 }, boxWidth:12, generateLabels: (chart) => [
              ...Chart.defaults.plugins.legend.labels.generateLabels(chart),
              { text:'🔴 1–3 Needs Attention · 🟡 4–6 Developing · 🟢 7–9 Strength', fillStyle:'transparent', strokeStyle:'transparent', fontColor:'#6b7280' }
            ]}},
            tooltip:{ callbacks:{ label: ctx => ctx.datasetIndex===0
              ? ` Stanine ${ctx.raw} (${S.daab[avail[ctx.dataIndex]].scores.label}) — ${ctx.raw<=3?'🔴 Needs Attention':ctx.raw<=6?'🟡 Developing':'🟢 Strength'}` : ' Average' } }
          },
          scales: {
            y:{ min:0, max:9, ticks:{ stepSize:1 }, grid:{ color:'rgba(0,0,0,0.05)' } },
            x:{ grid:{ display:false }, ticks:{ font:{ family:'Poppins', size:11, weight:'600' } } }
          }
        }
      });
    }
  }

  /* ═══ 2. DAAB radar ═══ */
  destroyChart('daab-radar-rpt');
  const daabRadEl = document.getElementById('chart-daab-radar-rpt');
  if (daabRadEl) {
    const avail   = ['va','pa','na','lsa','hma','ar','ma','sa'].filter(k => S.daab[k].scores);
    if (avail.length) {
      const labels   = avail.map(k => subLabels[k]);
      const stanines = avail.map(k => S.daab[k].scores.stanine);
      const colors   = stanines.map(stanineColor);
      const avgStn   = Math.round(stanines.reduce((a,b)=>a+b,0)/stanines.length);
      CHARTS['daab-radar-rpt'] = new Chart(daabRadEl, {
        type:'radar',
        data: {
          labels,
          datasets:[{ label:'Stanine', data:stanines,
            backgroundColor: stanineColor(avgStn, 0.12),
            borderColor:     stanineColor(avgStn),
            pointBackgroundColor:colors, pointBorderColor:'#fff',
            pointRadius:6, borderWidth:2.5, fill:true }]
        },
        options:{
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ display:false } },
          scales:{ r:{ min:0, max:9,
            ticks:{ stepSize:3, font:{size:10}, callback: v => v===3?'🔴Low':v===6?'🟡Avg':v===9?'🟢High':'' },
            pointLabels:{ font:{ family:'Poppins', size:10, weight:'700' }, color:'#2d3348' },
            grid:{ color:'rgba(0,0,0,0.06)' }, angleLines:{ color:'rgba(0,0,0,0.07)' }
          }}
        }
      });
    }
  }

  /* ═══ 3. CPI horizontal bar ═══ */
  destroyChart('cpi-hbar-rpt');
  const cpiHbarEl = document.getElementById('chart-cpi-hbar-rpt');
  if (cpiHbarEl && S.cpi.scores) {
    const ranked = S.cpi.scores.ranked;
    CHARTS['cpi-hbar-rpt'] = new Chart(cpiHbarEl, {
      type:'bar',
      data:{
        labels: ranked.map(a => a.abbr),
        datasets:[{ label:'Score', data:ranked.map(a=>a.score),
          backgroundColor: ranked.map(a => CHART_ALPHA(a.color, 0.85)),
          borderColor: ranked.map(a => a.color),
          borderWidth:2, borderRadius:8, borderSkipped:false }]
      },
      options:{
        indexAxis:'y', responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false },
          tooltip:{ callbacks:{ label: ctx => ` Score: ${ctx.raw}/20 (${ranked[ctx.dataIndex].level})` } } },
        scales:{
          x:{ max:20, beginAtZero:true, grid:{ color:'rgba(0,0,0,0.05)' }, ticks:{ font:{ family:'Inter', size:11 } } },
          y:{ grid:{ display:false }, ticks:{ font:{ family:'Poppins', size:11, weight:'600' } } }
        }
      }
    });
  }

  /* ═══ 4. CPI donut ═══ */
  destroyChart('cpi-donut-rpt');
  const cpiDonutEl = document.getElementById('chart-cpi-donut-rpt');
  if (cpiDonutEl && S.cpi.scores) {
    const nonZero = S.cpi.scores.ranked.filter(a => a.score > 0);
    CHARTS['cpi-donut-rpt'] = new Chart(cpiDonutEl, {
      type:'doughnut',
      data:{
        labels: nonZero.map(a => a.abbr),
        datasets:[{ data:nonZero.map(a=>a.score),
          backgroundColor: nonZero.map(a => CHART_ALPHA(a.color, 0.82)),
          borderColor: nonZero.map(a => a.color),
          borderWidth:2, hoverOffset:10 }]
      },
      options:{
        responsive:true, maintainAspectRatio:false, cutout:'62%',
        plugins:{ legend:{ display:false },
          tooltip:{ callbacks:{ label: ctx => ` ${nonZero[ctx.dataIndex]?.label||ctx.label}: ${ctx.raw}` } } }
      }
    });
    const legEl = document.getElementById('chart-cpi-legend-rpt');
    if (legEl) legEl.innerHTML = nonZero.map(a =>
      `<div class="chart-legend-item"><div class="chart-legend-dot" style="background:${a.color}"></div><span>${a.abbr}</span></div>`
    ).join('');
  }

  /* ═══ 5. NMAP radar ═══ */
  destroyChart('nmap-radar-rpt');
  const nmapRadEl = document.getElementById('chart-nmap-radar-rpt');
  if (nmapRadEl && S.nmap.scores) {
    const dims     = S.nmap.scores.dims;
    const stanines = dims.map(d => d.stanine);
    const colors   = stanines.map(stanineColor);
    const avgStn   = Math.round(stanines.reduce((a,b)=>a+b,0)/stanines.length);
    CHARTS['nmap-radar-rpt'] = new Chart(nmapRadEl, {
      type:'radar',
      data:{
        labels: dims.map(d => d.abbr),
        datasets:[{ label:'Stanine', data:stanines,
          backgroundColor: stanineColor(avgStn, 0.12),
          borderColor:     stanineColor(avgStn),
          pointBackgroundColor:colors, pointBorderColor:'#fff',
          pointRadius:7, borderWidth:2.5, fill:true }]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{ r:{ min:0, max:9,
          ticks:{ stepSize:3, font:{size:10}, callback: v => v===3?'🔴Low':v===6?'🟡Avg':v===9?'🟢High':'' },
          pointLabels:{ font:{ family:'Poppins', size:10, weight:'700' }, color:'#2d3348' },
          grid:{ color:'rgba(0,0,0,0.06)' }, angleLines:{ color:'rgba(0,0,0,0.07)' }
        }}
      }
    });
  }

  /* ═══ 6. NMAP bar ═══ */
  destroyChart('nmap-bar-rpt');
  const nmapBarEl = document.getElementById('chart-nmap-bar-rpt');
  if (nmapBarEl && S.nmap.scores) {
    const dims     = S.nmap.scores.dims;
    const stanines = dims.map(d => d.stanine);
    const colors   = stanines.map(stanineColor);
    CHARTS['nmap-bar-rpt'] = new Chart(nmapBarEl, {
      type:'bar',
      data:{
        labels: dims.map(d => d.abbr),
        datasets:[
          { label:'Stanine', data:stanines,
            backgroundColor:colors.map(c=>CHART_ALPHA(c,0.73)), borderColor:colors,
            borderWidth:2, borderRadius:8, borderSkipped:false },
          { type:'line', label:'Average (5)', data:Array(dims.length).fill(5),
            borderColor:'rgba(107,114,128,0.5)', borderDash:[5,5],
            borderWidth:2, pointRadius:0, fill:false }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{ position:'bottom', labels:{ font:{ family:'Inter', size:11 }, boxWidth:12, generateLabels: (chart) => [
            ...Chart.defaults.plugins.legend.labels.generateLabels(chart),
            { text:'🔴 1–3 Needs Attention · 🟡 4–6 Developing · 🟢 7–9 Strength', fillStyle:'transparent', strokeStyle:'transparent', fontColor:'#6b7280' }
          ]}},
          tooltip:{ callbacks:{ label: ctx => ctx.datasetIndex===0
            ? ` Stanine ${ctx.raw}: ${dims[ctx.dataIndex].label} — ${ctx.raw<=3?'🔴 Needs Attention':ctx.raw<=6?'🟡 Developing':'🟢 Strength'}` : ' Average band' } }
        },
        scales:{
          y:{ min:0, max:9, grid:{ color:'rgba(0,0,0,0.05)' }, ticks:{ font:{ size:11 } } },
          x:{ grid:{ display:false }, ticks:{ font:{ family:'Poppins', size:10, weight:'600' } } }
        }
      }
    });
  }

  /* ═══ 7. SEL bar ═══ */
  destroyChart('sel-bar-rpt');
  const selBarEl = document.getElementById('chart-sel-bar-rpt');
  if (selBarEl && S.sea.scores) {
    const sea     = S.sea.scores;
    const doms    = ['E','S','A'];
    const barCols = doms.map(d => SEL_CAT_COLOR[sea.cls[d].cat] || '#6b7280');
    CHARTS['sel-bar-rpt'] = new Chart(selBarEl, {
      type:'bar',
      data:{
        labels: doms.map(d => SEL_DOM_INFO[d].label),
        datasets:[
          { label:'⚠ Problem Score (Higher = More Concern)',
            data:doms.map(d=>sea.domScores[d]),
            backgroundColor:barCols.map(c=>c+'cc'),
            borderColor:barCols,
            borderWidth:2.5, borderRadius:10, borderSkipped:false }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{ position:'bottom', labels:{ font:{ family:'Inter', size:11 },
            generateLabels: () => doms.map(d => {
              const cl  = sea.cls[d];
              const col = SEL_CAT_COLOR[cl.cat] || '#6b7280';
              return { text:`${SEL_DOM_INFO[d].label}: Cat ${cl.cat} — ${cl.level}`,
                fillStyle:col+'cc', strokeStyle:col, fontColor:'#374151', lineWidth:1.5 };
            }),
          }},
          tooltip:{ callbacks:{
            label: ctx => ` Score: ${ctx.raw}/20`,
            afterLabel: ctx => {
              const d = doms[ctx.dataIndex]; const cl = sea.cls[d];
              return [` Category ${cl.cat}: ${cl.level}`, ` ↑ Higher = more difficulty`];
            }
          }}
        },
        scales:{
          y:{ max:20, beginAtZero:true, grid:{ color:'rgba(0,0,0,0.05)' },
            title:{ display:true, text:'← Lower is better', font:{size:10}, color:'#6b7280' } },
          x:{ grid:{ display:false }, ticks:{ font:{ family:'Poppins', size:12, weight:'600' } } }
        }
      }
    });
  }

  /* ═══ 8. SEL gauges — build fresh in report slot ═══ */
  const gaugesDst = document.getElementById('chart-sel-gauges-report');
  if (gaugesDst && S.sea.scores) {
    const sea  = S.sea.scores;
    const doms = ['E','S','A'];
    gaugesDst.innerHTML = doms.map(d => {
      const sc = sea.domScores[d], cl = sea.cls[d], di = SEL_DOM_INFO[d];
      const pct = Math.round(sc / 20 * 100);
      const cc  = SEL_CAT_COLOR[cl.cat] || '#6b7280';
      return `<div class="sel-gauge-item">
        <div class="sel-gauge-label">${di.label}</div>
        <div class="sel-gauge-track">
          <div class="sel-gauge-fill" style="width:0%;background:${cc};transition:width 1.2s cubic-bezier(.22,1,.36,1)" data-target="${pct}"></div>
        </div>
        <div class="sel-gauge-score">${sc}<span style="font-size:11px;color:var(--ink4)">/20</span></div>
      </div>`;
    }).join('');
    setTimeout(() => {
      gaugesDst.querySelectorAll('.sel-gauge-fill').forEach(el => {
        el.style.width = el.dataset.target + '%';
      });
    }, 400);
  }
}

export { buildReportCharts };
