/* ════════════════════════════════════════════════════════════════════
   charts/daab-charts.js
   DAAB bar.
════════════════════════════════════════════════════════════════════ */

import { S } from '../state.js';
import { DAAB_SUBS, getStanine, stanineLabel } from '../engine/daab.js';
import { CHARTS, destroyChart, stanineColor, CHART_ALPHA } from './core.js';

function buildDAAbCharts() {
  // Order, short labels and emoji all come from the canonical DAAB_SUBS —
  // no hardcoded per-chart maps (they had drifted: Spatial showed 📐 here but
  // 🧩 everywhere else in the app).
  const SUB = Object.fromEntries(DAAB_SUBS.map(s => [s.key, s]));
  const daabSubs = DAAB_SUBS.map(s => s.key);

  const available = daabSubs.filter(k => S.daab[k].scores);
  if (!available.length) return;

  // Self-heal stale stanines. A student scored under an older, gapped VA norm
  // table has a stored stanine of undefined — which plots as a MISSING bar
  // (the empty "Verbal" column). Re-derive it from the stored raw score (always
  // present) and heal the label too, so every subtest always shows a bar. Uses
  // the authoritative stored raw, never re-reads answers, so it can't corrupt.
  const gender = (S.student && S.student.gender) || 'M';
  const healed = available.map((k) => {
    const sc = S.daab[k].scores;
    const st = (typeof sc.stanine === 'number' && sc.stanine > 0)
      ? sc.stanine : getStanine(k, sc.raw || 0, gender);
    const lb = (sc.label && sc.label !== 'Not attempted') ? sc.label : stanineLabel(st);
    // Write the correction back so other surfaces reading S.daab agree.
    sc.stanine = st; sc.label = lb;
    return { st, lb, raw: sc.raw, max: sc.max };
  });

  const labels   = available.map(k => SUB[k].short);
  const stanines = healed.map(h => h.st);
  const raws     = healed.map(h => h.raw);
  const maxes    = healed.map(h => h.max);
  // Wrap in an arrow so .map doesn't pass (element, index, array) to stanineColor.
  // Its second arg is alpha — an index of 0 (Verbal, first in DAAB_SUBS) rendered
  // the bar fully transparent in both charts; higher indices got clamped to opaque.
  const colors   = stanines.map(s => stanineColor(s));

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
          label: 'Typical range',
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
            { text: '🔴 Focus Area · 🟡 Developing Area · 🟢 Strength Area', fillStyle: 'transparent', strokeStyle: 'transparent', fontColor: '#6b7280' }
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
          // Axis still driven by the stanine (the normative signal) but ticks
          // read as band words — students/parents never see a 1-9 number.
          y: { min: 0, max: 9, grid: { color: 'rgba(0,0,0,0.05)' },
               ticks: { stepSize: 3, callback: v => ({3:'Focus',6:'Developing',9:'Strength'}[v] || ''),
                        font: { family:'Poppins', size:10, weight:'600' } } },
          x: { grid: { display: false }, ticks: { font: { family:'Poppins', size:11, weight:'600' } } }
        }
      }
    });
  }

  // ── 2. "How much you got right" — replaces the removed Raw Score vs Maximum
  // stacked chart. Horizontal, sorted strongest-first, coloured by band. Answers
  // the question a parent actually asks without exposing a raw tally or stanine.
  destroyChart('daab-pct');
  const pctCtx = document.getElementById('chart-daab-pct');
  if (pctCtx) {
    const rows = available.map((k, i) => ({
      label: SUB[k].emoji + ' ' + SUB[k].short,
      pct: Math.round((raws[i] / (maxes[i] || 1)) * 100),
      band: S.daab[k].scores.label,
      color: colors[i],
    })).sort((a, b) => b.pct - a.pct);

    CHARTS['daab-pct'] = new Chart(pctCtx, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.label),
        datasets: [{
          label: 'Questions correct',
          data: rows.map(r => r.pct),
          backgroundColor: rows.map(r => CHART_ALPHA(r.color, 0.85)),
          borderColor: rows.map(r => r.color),
          borderWidth: 2, borderRadius: 8, borderSkipped: false,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: ctx => ` ${ctx.raw}% of questions correct`,
            afterLabel: ctx => ` ${rows[ctx.dataIndex].band}`,
          }}
        },
        scales: {
          x: { min: 0, max: 100, grid: { color: 'rgba(0,0,0,0.05)' },
               ticks: { callback: v => v + '%', font: { size: 10 } } },
          y: { grid: { display: false }, ticks: { font: { family:'Poppins', size:11, weight:'600' } } }
        }
      }
    });
  }
}


export { buildDAAbCharts };
