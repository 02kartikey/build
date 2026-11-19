/* ════════════════════════════════════════════════════════════════════
   js/dashboard-flow.js — the drill-down Dashboard (all three dashboards)
   --------------------------------------------------------------------
   One clickable path through the existing analytics:

     All schools  →  School (→ Branch, for a school with branches)  →
     Parameter (Personality, Aptitude, Career interest, SEAA)  →  Class  →
     Category  →  Students

   It follows the school chosen in the top bar ("Showing"), which is the one
   school filter on every page; the academic year is chosen here. Every
   number comes from the same server endpoints as the rest of the dashboards
   (/flow, /breakdown, /drill), scoped by school (org), branch and academic
   year, so a count always equals the list behind it.
   Loaded after dashboard-common.js; uses its NM helpers.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const NM = window.NM;
  if (!NM || NM.mountFlow) return;
  const { esc, attr, api, qs, store } = NM;

  // Presentation only: rows per page in the student list, slices before "Other".
  const UI = Object.freeze({ LIST_ROWS: 25, DONUT_SLICES: 8, STATUS_ROWS: 10 });

  const CSS = `
.nf{display:flex;flex-direction:column;gap:16px}
.nf-busy{position:relative}.nf-busy .nf{opacity:.5;pointer-events:none;transition:opacity .15s}
.nf-busy::after{content:'Updating…';position:absolute;top:8px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:5px 12px;font:600 12px var(--font,sans-serif);color:var(--ink3);box-shadow:0 4px 14px rgba(0,0,0,.08)}
.nf-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.nf-crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:13px;margin-right:auto;min-width:0}
.nf-crumbs button{background:none;border:none;padding:4px 6px;border-radius:7px;font:600 13px var(--font,sans-serif);color:var(--brand2);cursor:pointer}
.nf-crumbs button:hover{background:var(--brand4)}
.nf-crumbs span.cur{padding:4px 6px;font-weight:700;color:var(--ink)}
.nf-crumbs i{color:var(--ink5,#99a);font-style:normal}
.nf-pick{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink4)}
.nf-head h2{margin:0;font:750 20px/1.25 var(--font,sans-serif);color:var(--ink);letter-spacing:-.01em}
.nf-head p{margin:4px 0 0;font-size:13px;color:var(--ink4);line-height:1.5;max-width:75ch}
.nf-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.nf-kpi{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;text-align:left;font:inherit;color:inherit;cursor:pointer;display:flex;flex-direction:column;gap:4px;min-width:0}
.nf-kpi:hover{border-color:var(--brand2)}
.nf-kpi .l{font-size:12px;font-weight:650;color:var(--ink4)}
.nf-kpi .n{font:800 26px/1.1 var(--font,sans-serif);color:var(--ink);font-variant-numeric:tabular-nums}
.nf-kpi .s{font-size:11.5px;color:var(--ink4)}
.nf-kpi.ok .n{color:var(--ok)}.nf-kpi.warn .n{color:var(--warn)}.nf-kpi.mute .n{color:var(--ink3)}
.nf-meter{position:relative;height:8px;border-radius:999px;background:var(--bg2,#eef);margin-top:6px}
.nf-meter>i{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--brand2)}
.nf-meter>b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);border-radius:1px}
.nf-meter.ok>i{background:var(--ok)}.nf-meter.warn>i{background:var(--warn)}
.nf-grid{display:grid;gap:16px;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)}
.nf-grid.even{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.nf-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;min-width:0}
.nf-card h3{margin:0 0 4px;font:700 14.5px/1.3 var(--font,sans-serif);color:var(--ink)}
.nf-card .sub{margin:0 0 12px;font-size:12px;color:var(--ink4);line-height:1.5}
.nf-donut{position:relative;height:220px}
.nf-donut .c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.nf-donut .c b{font:800 26px/1 var(--font,sans-serif);color:var(--ink)}.nf-donut .c small{font-size:11.5px;color:var(--ink4);margin-top:4px}
.nf-legend{display:flex;flex-direction:column;gap:2px;margin-top:12px}
.nf-leg{display:grid;grid-template-columns:12px minmax(0,1fr) auto 44px;gap:8px;align-items:center;padding:6px 6px;border-radius:8px;border:none;background:none;font:12.5px var(--font,sans-serif);color:var(--ink2);text-align:left;cursor:pointer;width:100%}
.nf-leg:hover{background:var(--surface2)}.nf-leg[disabled]{cursor:default;background:none}
.nf-leg i{width:12px;height:12px;border-radius:3px}.nf-leg .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nf-leg b{font-variant-numeric:tabular-nums;color:var(--ink)}.nf-leg small{color:var(--ink4);text-align:right;font-variant-numeric:tabular-nums}
.nf-tbl{width:100%;border-collapse:collapse;font:13px var(--font,sans-serif)}
.nf-tbl th{text-align:left;padding:9px 10px;font-size:12px;font-weight:650;color:var(--ink4);border-bottom:1px solid var(--border);white-space:nowrap}
.nf-tbl td{padding:10px 10px;border-bottom:1px solid var(--border);color:var(--ink3);vertical-align:middle;font-variant-numeric:tabular-nums}
.nf-tbl tr.go{cursor:pointer}.nf-tbl tr.go:hover td{background:var(--surface2)}
.nf-tbl tr.on td{background:var(--brand4)}
.nf-tbl td.num,.nf-tbl th.num{text-align:right}
.nf-tbl tfoot td{font-weight:700;color:var(--ink);border-bottom:none}
.nf-rate{display:flex;align-items:center;gap:8px;min-width:120px}.nf-rate .nf-meter{flex:1;margin:0;min-width:48px}.nf-rate span{min-width:50px;text-align:right;font-weight:700;color:var(--ink);white-space:nowrap}
.nf-tbl td:first-child{white-space:nowrap}
.nf-pie{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);gap:20px;align-items:center}.nf-pie .nf-legend{margin-top:0}
@media(max-width:1300px){.nf-pie{grid-template-columns:minmax(0,1fr)}.nf-pie .nf-legend{margin-top:4px}}
.nf-params{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.nf-param{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;text-align:left;font:inherit;cursor:pointer;display:flex;flex-direction:column;gap:6px}
.nf-param:hover{border-color:var(--brand2)}
.nf-param .t{font:700 14px var(--font,sans-serif);color:var(--ink)}.nf-param .d{font-size:11.5px;color:var(--ink4);line-height:1.45}
.nf-param .n{font:800 24px/1.1 var(--font,sans-serif);color:var(--ink);font-variant-numeric:tabular-nums}.nf-param .n small{font-size:12px;font-weight:600;color:var(--ink4);margin-left:6px}
.nf-param .go{font-size:12px;font-weight:650;color:var(--brand2);margin-top:auto}
.nf-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);overflow-x:auto}
.nf-tab{padding:10px 14px;border:none;background:none;font:650 13.5px var(--font,sans-serif);color:var(--ink4);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.nf-tab:hover{color:var(--ink)}.nf-tab.on{color:var(--brand);border-bottom-color:var(--brand2)}
.nf-seg{display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden;margin-bottom:10px}
.nf-seg button{padding:6px 11px;border:none;background:var(--surface);font:600 12px var(--font,sans-serif);color:var(--ink3);cursor:pointer}
.nf-seg button+button{border-left:1px solid var(--border)}.nf-seg button.on{background:var(--brand4);color:var(--brand)}
.nf-concern{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.nf-cc{border:1px solid var(--border);border-radius:14px;padding:16px 18px;background:var(--surface);text-align:left;font:inherit;cursor:pointer;display:flex;flex-direction:column;gap:4px;border-top:4px solid var(--ink5,#aab)}
.nf-cc:hover{border-color:var(--brand2)}
.nf-cc.warn{border-top-color:var(--warn)}.nf-cc.bad{border-top-color:var(--danger)}.nf-cc.ok{border-top-color:var(--ok)}
.nf-cc .t{font:700 14px var(--font,sans-serif);color:var(--ink)}.nf-cc .d{font-size:12px;color:var(--ink4);line-height:1.45}
.nf-cc .n{font:800 28px/1.1 var(--font,sans-serif);color:var(--ink);font-variant-numeric:tabular-nums}.nf-cc .n small{font-size:14px;font-weight:650;color:var(--ink4);margin-left:6px}
.nf-big{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.nf-big .n{font:800 44px/1 var(--font,sans-serif);color:var(--ink);font-variant-numeric:tabular-nums}
.nf-big.bad .n{color:var(--danger)}.nf-big.warn .n{color:var(--warn)}.nf-big.ok .n{color:var(--ok)}
.nf-big .d{font-size:13px;color:var(--ink3);line-height:1.55;max-width:60ch}
.nf-heat td.h{text-align:center;cursor:pointer;min-width:70px}.nf-heat th.h{text-align:center;white-space:normal;min-width:80px}.nf-heat td.h:hover{outline:2px solid var(--brand2);outline-offset:-2px}
.nf-heat td.h b{display:block;color:var(--ink)}.nf-heat td.h small{font-size:10.5px;color:var(--ink4)}
.nf-scroll{overflow-x:auto}
.nf-areas{display:flex;gap:4px;flex-wrap:wrap}
.nf-score{display:flex;gap:10px;font-size:12px;white-space:nowrap}.nf-score span b{color:var(--ink)}.nf-score span.bad b{color:var(--danger)}
.nf-empty{padding:28px 12px;text-align:center;color:var(--ink4);font-size:13px}
.nf-small{font-size:11px;color:var(--ink5)}.nf-strong{color:var(--ink)}.nf-after{margin:10px 0 0}
.nf-listh{margin:0 auto 0 0}.nf-listh span{font-weight:500;color:var(--ink4);font-size:13px}
.nf-card [data-f="search"]{min-width:220px}
.nf-pager{justify-content:space-between;margin:12px 0 0}.nf-pager>span:first-child{font-size:12px;color:var(--ink4)}
.nf-chart{position:relative;height:260px}
@media(max-width:1100px){.nf-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.nf-params{grid-template-columns:repeat(2,minmax(0,1fr))}.nf-grid,.nf-grid.even{grid-template-columns:minmax(0,1fr)}}
@media(max-width:620px){.nf-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.nf-concern{grid-template-columns:minmax(0,1fr)}.nf-params{grid-template-columns:minmax(0,1fr)}.nf-kpi .n{font-size:22px}.nf-big .n{font-size:36px}}
`;
  const styleEl = document.createElement('style'); styleEl.textContent = CSS; document.head.appendChild(styleEl);

  /* ── colours, read from the page's tokens so charts follow the theme ── */
  const css = (v, d) => NM.cssVar(v) || d;
  const tone = () => ({ ok: css('--ok', '#15835A'), warn: css('--warn', '#B15E0A'), bad: css('--danger', '#C42B3C'),
    brand: css('--brand2', '#3B4FD8'), mute: css('--border2', '#CBD2E1'), ink: css('--ink4', '#5B6478') });
  // Categorical palette for profiles (strongest trait, career area …).
  const PALETTE = ['#3B4FD8', '#0E9F8E', '#D9822B', '#8B5CF6', '#2F80ED', '#C2410C', '#16A34A', '#DB2777', '#64748B'];
  // SEAA concern groups: one area light amber, two areas deep amber, all three red.
  const CONCERN_AMBER = Object.freeze({ one: '#F2B661', two: '#D9822B' });
  const concernColour = (g) => {
    const t = tone();
    if (g.key === 'none') return t.ok;
    if (g.key === 'other') return t.mute;
    if (g.key.length >= 3) return t.bad;
    return g.key.length === 2 ? CONCERN_AMBER.two : CONCERN_AMBER.one;
  };

  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const pctOf = (n, d) => (d ? Math.round(n / d * 1000) / 10 : 0);
  const pctTxt = (n, d) => pctOf(n, d) + '%';
  const meter = (p, target) => {
    const cls = target == null ? '' : p >= target ? 'ok' : 'warn';
    return `<div class="nf-meter ${cls}"><i style="width:${Math.min(100, p)}%"></i>${target != null ? `<b style="left:calc(${Math.min(100, target)}% - 1px)" title="Target ${target}%"></b>` : ''}</div>`;
  };
  const params = () => (NM.cat && NM.cat.parameters) || [];
  const param = (k) => params().find(p => p.key === k) || null;
  const levels = () => (NM.cat && NM.cat.seaa_levels) || {};
  const concernsOf = (level) => ((NM.cat && NM.cat.seaa_concerns) || []).filter(c => c.level === level).map(c => c.key);
  const areas = () => NM.wbAreas();
  const classLabel = (k) => ((NM.classes || []).find(c => c.key === k) || { label: k }).label;

  NM.mountFlow = async function (el) {
    if (!el) return;
    await NM.ready();
    const saved = store.get('flow', {});
    const st = { org: saved.org || '', branch: saved.branch || '', param: saved.param || '', view: saved.view || '',
      cls: '', cat: null, year: saved.year, page: 0, search: '' };
    let structure = null, charts = [], cache = new Map(), token = 0;

    const scopeQ = () => ({ school: NM.scope.school, org: st.org, branch: st.branch, year: st.year });
    const get = (path, extra) => {
      const url = path + '?' + qs(Object.assign(scopeQ(), extra || {}));
      if (!cache.has(url)) cache.set(url, api('GET', url).catch(e => { cache.delete(url); throw e; }));
      return cache.get(url);
    };
    const breakdown = (dim) => get('/api/dashboard/breakdown', { dimension: dim });
    const save = () => store.set('flow', { org: st.org, branch: st.branch, param: st.param, view: st.view, year: st.year });
    const killCharts = () => { charts.forEach(c => { try { c.destroy(); } catch (_) {} }); charts = []; };
    const drillOpts = (o) => Object.assign({ school: NM.scope.school, org: st.org, branch: st.branch, year: st.year }, o);

    // One request: schools and branches with counts for the chosen year, and
    // every year on record. A second only when the remembered year is gone.
    async function loadStructure(isCurrent) {
      const fetchFlow = () => api('GET', '/api/dashboard/flow?' + qs({ school: NM.scope.school, year: st.year }));
      let s = await fetchFlow();
      const yrs = s.years.map(y => y.year);
      if (st.year === undefined || (st.year !== '' && !yrs.includes(Number(st.year)))) {
        const want = yrs.includes(s.current_year) ? s.current_year : '';
        const had = st.year;
        st.year = want;
        if (String(want) !== String(had === undefined ? '' : had)) s = await fetchFlow();
      }
      if (!isCurrent()) return;
      structure = s;
      const orgs = structure.orgs;
      if (!orgs.some(o => o.org === st.org)) { st.org = orgs.length === 1 ? orgs[0].org : ''; st.branch = ''; st.param = ''; }
      const o = orgs.find(x => x.org === st.org);
      if (o && st.branch && !o.branches.some(b => b.branch === st.branch)) { st.branch = ''; st.param = ''; }
    }
    const curOrg = () => structure.orgs.find(o => o.org === st.org) || null;
    const curBranch = () => { const o = curOrg(); return o ? o.branches.find(b => b.branch === st.branch) || null : null; };
    // A school with one branch skips the branch table.
    const singleBranch = () => { const o = curOrg(); return !!o && o.branches.length === 1; };
    // What the current screen covers: a branch, a school, or every school in view.
    const scopeName = () => (st.branch && !singleBranch() ? st.branch : st.org) || (structure.orgs.length === 1 ? structure.orgs[0].org : 'all schools');
    const yearLabel = () => { const y = structure.years.find(x => String(x.year) === String(st.year)); return y ? 'Academic year ' + y.label : 'All academic years'; };

    /* ── navigation ─────────────────────────────────────────────── */
    function go(patch) {
      Object.assign(st, patch);
      if (!('page' in patch)) st.page = 0;
      if ('org' in patch || 'branch' in patch) st.allRows = false;
      save(); render();
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    function crumbs() {
      const out = [];
      if (structure.orgs.length > 1) out.push(['All schools', { org: '', branch: '', param: '', cat: null, cls: '' }]);
      if (st.org) out.push([st.org, { branch: singleBranch() ? st.branch : '', param: '', cat: null, cls: '' }]);
      if (st.branch && !singleBranch()) out.push([st.branch, { param: '', cat: null, cls: '' }]);
      if (st.param) out.push([(param(st.param) || {}).label || st.param, { cat: null }]);
      if (st.cat) out.push([st.cat.title, null]);
      return out.map(([label, patch], i) => i === out.length - 1
        ? `<span class="cur" aria-current="page">${esc(label)}</span>`
        : `<button type="button" data-go="${attr(patch)}">${esc(label)}</button><i aria-hidden="true">›</i>`).join('');
    }
    function topBar() {
      return `<div class="nf-top"><nav class="nf-crumbs" aria-label="Where you are">${crumbs()}</nav>
        <label class="nf-pick">Academic year <select class="nm-in" data-f="year"><option value="">All years</option>${structure.years.map(y => `<option value="${y.year}"${String(y.year) === String(st.year) ? ' selected' : ''}>${esc(y.label)}</option>`).join('')}</select></label></div>`;
    }

    /* ── shared pieces ──────────────────────────────────────────── */
    function kpis(x, scopeText) {
      const card = (cls, label, n, sub, drill) => `<button type="button" class="nf-kpi ${cls}" data-drill="${attr(drillOpts(drill))}"><span class="l">${label}</span><span class="n">${n}</span><span class="s">${sub}</span></button>`;
      return `<div class="nf-kpis">
        ${card('', 'Registered', fmt(x.registered), esc(scopeText), { title: 'Registered students' })}
        ${card('ok', 'Completed', fmt(x.completed), pctTxt(x.completed, x.registered) + ' of registered', { status: 'completed', title: 'Completed' })}
        ${card('warn', 'In progress', fmt(x.in_progress), pctTxt(x.in_progress, x.registered) + ' of registered', { status: 'in_progress', title: 'In progress' })}
        ${card('mute', 'Not started', fmt(x.not_started), pctTxt(x.not_started, x.registered) + ' of registered', { status: 'not_started', title: 'Not started' })}
        <button type="button" class="nf-kpi" data-drill="${attr(drillOpts({ status: 'completed', title: 'Completed' }))}"><span class="l">Completion rate</span><span class="n">${x.completion_pct}%</span>${meter(x.completion_pct, x.target_pct)}<span class="s">Target ${x.target_pct}%${x.completion_pct >= x.target_pct ? ', reached' : ', ' + Math.max(0, Math.ceil(x.registered * x.target_pct / 100) - x.completed) + ' more to go'}</span></button>
      </div>`;
    }
    function donut(canvas, items, centre, onPick) {
      if (typeof Chart === 'undefined' || !canvas) return;
      const shown = items.filter(i => i.n > 0);
      const c = new Chart(canvas, {
        type: 'doughnut',
        data: { labels: shown.map(i => i.label), datasets: [{ data: shown.map(i => i.n), backgroundColor: shown.map(i => i.colour), borderWidth: 2, borderColor: css('--surface', '#fff') }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${fmt(ctx.raw)} (${pctTxt(ctx.raw, centre.total)})` } } },
          onClick: (_, els) => { if (els.length && onPick) onPick(shown[els[0].index]); },
          onHover: (e, els) => { e.native.target.style.cursor = els.length && onPick ? 'pointer' : 'default'; } },
      });
      charts.push(c);
    }
    const donutHtml = (centreN, centreLabel) => `<div class="nf-donut"><canvas aria-hidden="true"></canvas><div class="c"><b>${centreN}</b><small>${esc(centreLabel)}</small></div></div>`;
    const legend = (items, total) => `<div class="nf-legend">${items.map(i => `<button type="button" class="nf-leg" ${i.pick ? `data-pick="${attr(i.pick)}"` : 'disabled'}><i style="background:${i.colour}"></i><span class="t" title="${esc(i.label)}">${esc(i.label)}</span><b>${fmt(i.n)}</b><small>${pctTxt(i.n, total)}</small></button>`).join('')}</div>`;

    function statusTable(all, keyName, colName) {
      // Rows with nobody registered in the chosen year are folded away, and long lists start collapsed.
      const live = all.filter(r => r.registered > 0), idle = all.length - live.length;
      const rows = st.allRows ? live : live.slice(0, UI.STATUS_ROWS);
      const more = live.length - rows.length;
      const tot = live.reduce((a, r) => { a.registered += r.registered; a.completed += r.completed; return a; }, { registered: 0, completed: 0 });
      return `<div class="nf-scroll"><table class="nf-tbl"><thead><tr><th>${colName}</th><th class="num">Registered</th><th class="num">Completed</th><th class="num">Pending</th><th>Completion rate</th></tr></thead><tbody>
        ${rows.map(r => `<tr class="go" tabindex="0" data-go="${attr(Object.assign({ [keyName]: r[keyName], param: '', cat: null, cls: '' }, keyName === 'org' ? { branch: '' } : {}))}"><td><button type="button" class="nm-link" tabindex="-1">${esc(r[keyName])}</button>${keyName === 'org' && r.branches.length > 1 ? ` <span class="nf-small">${r.branches.length} branches</span>` : ''}</td>
          <td class="num">${fmt(r.registered)}</td><td class="num">${fmt(r.completed)}</td><td class="num">${fmt(r.pending)}</td>
          <td><div class="nf-rate">${meter(r.completion_pct, r.target_pct)}<span>${r.completion_pct}%</span></div></td></tr>`).join('')}
        </tbody>${live.length > 1 ? `<tfoot><tr><td>Total</td><td class="num">${fmt(tot.registered)}</td><td class="num">${fmt(tot.completed)}</td><td class="num">${fmt(tot.registered - tot.completed)}</td><td><div class="nf-rate">${meter(pctOf(tot.completed, tot.registered))}<span>${pctOf(tot.completed, tot.registered)}%</span></div></td></tr></tfoot>` : ''}</table></div>
        ${more > 0 || st.allRows && live.length > UI.STATUS_ROWS ? `<div class="nm-bar nf-after"><button type="button" class="nm-btn sm" data-f="allrows">${more > 0 ? `Show all ${live.length}` : 'Show fewer'}</button></div>` : ''}
        ${idle ? `<p class="sub nf-after">${idle} ${colName.toLowerCase()}${idle === 1 ? ' has' : 's have'} no students registered in this period.</p>` : ''}`;
    }
    function statusDonut(host, x) {
      const t = tone();
      const items = [
        { label: 'Completed', n: x.completed, colour: t.ok, pick: drillOpts({ status: 'completed', title: 'Completed' }) },
        { label: 'In progress', n: x.in_progress, colour: t.warn, pick: drillOpts({ status: 'in_progress', title: 'In progress' }) },
        { label: 'Not started', n: x.not_started, colour: t.mute, pick: drillOpts({ status: 'not_started', title: 'Not started' }) },
      ];
      host.innerHTML = donutHtml(x.completion_pct + '%', 'completed') + legend(items, x.registered);
      donut(host.querySelector('canvas'), items, { total: x.registered }, (i) => NM.openDrill(i.pick));
    }
    // The four parameters as cards; counts filled in once the breakdown loads.
    const paramCards = () => `<div class="nf-params" data-f="params">${params().map(p => `<button type="button" class="nf-param" data-go="${attr({ param: p.key, view: '', cat: null, cls: '' })}"><span class="t">${esc(p.label)}</span><span class="n">…</span><span class="d">${esc(p.description)}</span><span class="go">Open analysis</span></button>`).join('')}</div>`;
    async function fillParamCards(body, my, registered) {
      const par = await breakdown('parameters');
      if (my !== token) return;
      body.querySelectorAll('[data-f="params"] .nf-param').forEach((btn, i) => {
        const n = par.totals.counts[params()[i].key] || 0;
        btn.querySelector('.n').innerHTML = `${fmt(n)}<small>of ${fmt(registered)} completed (${pctTxt(n, registered)})</small>`;
      });
    }

    /* ── screen: all schools / one school ───────────────────────── */
    async function screenOverview(body, my) {
      const o = curOrg();
      const x = o || structure.orgs.reduce((a, r) => { ['registered', 'completed', 'in_progress', 'not_started', 'pending'].forEach(k => { a[k] += r[k]; }); a.tw += r.target_pct * r.registered; return a; },
        { registered: 0, completed: 0, in_progress: 0, not_started: 0, pending: 0, tw: 0 });
      if (!o) { x.completion_pct = pctOf(x.completed, x.registered); x.target_pct = x.registered ? Math.round(x.tw / x.registered) : 0; }
      const rows = o ? o.branches : structure.orgs;
      body.innerHTML = `<div class="nf-head"><h2>${esc(o ? o.org : 'All schools')}</h2><p>${esc(yearLabel())}. ${o ? `${o.branches.length} branches. Choose a parameter for results across all of them, or a branch below.` : `${rows.filter(r => r.registered).length} schools with students. Choose a parameter for results across every school, or a school below.`}</p></div>
        ${kpis(x, o ? o.org : 'All schools')}
        ${x.registered ? paramCards() : ''}
        <div class="nf-grid"><div class="nf-card"><h3>Overall completion</h3><p class="sub">Click a slice for the students in it.</p><div data-f="donut"></div></div>
          <div class="nf-card"><h3>${o ? 'Branch-wise status' : 'School-wise status'}</h3><p class="sub">The marker on each bar is the completion target. Click a row to open it.</p>${rows.some(r => r.registered) ? statusTable(rows, o ? 'branch' : 'org', o ? 'Branch' : 'School') : '<div class="nf-empty">No students registered in this period yet.</div>'}</div></div>`;
      statusDonut(body.querySelector('[data-f="donut"]'), x);
      if (x.registered) await fillParamCards(body, my, x.registered);
    }

    /* ── screen: one branch ─────────────────────────────────────── */
    async function screenBranch(body, my) {
      const o = curOrg(), b = curBranch();
      body.innerHTML = `<div class="nf-head"><h2>${esc(singleBranch() ? o.org : st.branch)}</h2><p>${esc(singleBranch() ? yearLabel() : o.org + '. ' + yearLabel())}. Choose a parameter for its class-wise analysis and students.</p></div>
        ${kpis(b, singleBranch() ? o.org : st.branch + ' branch')}
        ${paramCards()}
        <div class="nf-grid"><div class="nf-card"><h3>Overall completion</h3><p class="sub">Click a slice for the students in it.</p><div data-f="donut"></div></div>
          <div class="nf-card"><h3>Completion by class</h3><p class="sub">Click a bar for the students in that class and status.</p><div class="nf-chart"><canvas aria-label="Completion by class"></canvas></div></div></div>`;
      statusDonut(body.querySelector('[data-f="donut"]'), b);
      const [comp] = await Promise.all([breakdown('completion'), fillParamCards(body, my, b.registered)]);
      if (my !== token) return;
      const t = tone(), cls = comp.classes;
      if (!cls.length) { body.querySelector('.nf-chart').outerHTML = '<div class="nf-empty">No students yet.</div>'; return; }
      if (typeof Chart === 'undefined') return;
      const sets = [['completed', 'Completed', t.ok], ['in_progress', 'In progress', t.warn], ['not_started', 'Not started', t.mute]];
      const chart = new Chart(body.querySelector('.nf-chart canvas'), {
        type: 'bar',
        data: { labels: cls.map(c => c.label), datasets: sets.map(([k, l, col]) => ({ label: l, data: cls.map(c => c.counts[k] || 0), backgroundColor: col, borderRadius: 4, stack: 's' })) },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: { callbacks: { footer: (items) => { const c = cls[items[0].dataIndex]; return `Registered ${fmt(c.population)}, ${pctTxt(c.counts.completed || 0, c.population)} completed`; } } } },
          scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
          onClick: (_, els) => { if (!els.length) return; const e = els[0]; const c = cls[e.index], k = sets[e.datasetIndex][0];
            NM.openDrill(drillOpts({ classKey: c.key, status: k, title: `${c.label}: ${sets[e.datasetIndex][1].toLowerCase()}` })); },
          onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; } },
      });
      charts.push(chart);
    }

    /* ── screen: one parameter ──────────────────────────────────── */
    async function screenParam(body, my) {
      const p = param(st.param);
      const views = (p.views || []).filter(v => NM.dim(v).label !== v);
      const view = views.includes(st.view) ? st.view : views[0];
      body.innerHTML = `<div class="nf-tabs" role="tablist">${params().map(x => `<button type="button" role="tab" class="nf-tab${x.key === p.key ? ' on' : ''}" aria-selected="${x.key === p.key}" data-go="${attr({ param: x.key, view: '', cat: null, cls: '' })}">${esc(x.label)}</button>`).join('')}</div>
        <div class="nf-head"><h2>${esc(p.label)}: ${esc(scopeName())}</h2><p>${esc(p.description)} ${esc(yearLabel())}${st.cls ? '. Showing ' + esc(classLabel(st.cls)) + ' only' : ''}.</p></div>
        <div data-f="main"><div class="nf-empty"><span class="nm-spin"></span></div></div>`;
      const [comp, par, dist] = await Promise.all([breakdown('completion'), breakdown('parameters'), view ? breakdown(view) : null]);
      if (my !== token) return;
      const main = body.querySelector('[data-f="main"]');
      const classes = comp.classes;
      const done = new Map(par.classes.map(c => [c.key, c.counts[p.key] || 0]));
      const totDone = par.totals.counts[p.key] || 0;
      const clsTable = `<div class="nf-card"><h3>Class-wise completion</h3><p class="sub">Students who finished the ${esc(p.label)} part. Click a class to focus the analysis on it.</p>
        <div class="nf-scroll"><table class="nf-tbl"><thead><tr><th>Class</th><th class="num">Registered</th><th class="num">Completed</th><th>Completion rate</th></tr></thead><tbody>
        ${classes.map(c => { const d = done.get(c.key) || 0; return `<tr class="go${st.cls === c.key ? ' on' : ''}" tabindex="0" data-go="${attr({ cls: st.cls === c.key ? '' : c.key, cat: null })}"><td><button type="button" class="nm-link" tabindex="-1">${esc(c.label)}</button></td><td class="num">${fmt(c.population)}</td><td class="num">${fmt(d)}</td><td><div class="nf-rate">${meter(pctOf(d, c.population))}<span>${pctOf(d, c.population)}%</span></div></td></tr>`; }).join('')}
        </tbody><tfoot><tr><td>All classes</td><td class="num">${fmt(comp.totals.population)}</td><td class="num">${fmt(totDone)}</td><td><div class="nf-rate">${meter(pctOf(totDone, comp.totals.population))}<span>${pctOf(totDone, comp.totals.population)}%</span></div></td></tr></tfoot></table></div></div>`;
      if (!dist) { main.innerHTML = clsTable; return; }
      const clsRow = st.cls ? dist.classes.find(c => c.key === st.cls) : null;
      const counts = st.cls ? (clsRow ? clsRow.counts : {}) : dist.totals.counts;
      const pop = st.cls ? (clsRow ? clsRow.population : 0) : dist.totals.population;
      const isConcern = view === 'seaa_concern';
      const groups = dist.groups.map(g => Object.assign({}, g, { n: counts[g.key] || 0 }));
      const seg = views.length > 1 ? `<div class="nf-seg" role="group" aria-label="View">${views.map(v => `<button type="button" class="${v === view ? 'on' : ''}" data-go="${attr({ view: v, cat: null })}">${esc(NM.dim(v).label)}</button>`).join('')}</div>` : '';
      // Donut: biggest groups first, the rest folded into "Other" (still clickable as one list).
      let items;
      if (isConcern) {
        items = groups.map(g => ({ label: g.label + (g.key === 'SEA' ? ' (critical)' : ''), n: g.n, colour: concernColour(g), pick: { dimension: view, groups: [g.key], title: g.label, description: g.description } }));
      } else {
        const sorted = groups.filter(g => g.n > 0).sort((a, b) => b.n - a.n);
        const head = sorted.slice(0, UI.DONUT_SLICES), rest = sorted.slice(UI.DONUT_SLICES);
        items = head.map((g, i) => ({ label: g.label, n: g.n, colour: PALETTE[i % PALETTE.length], pick: { dimension: view, groups: [g.key], title: g.label, description: g.description } }));
        if (rest.length) items.push({ label: `Other (${rest.length})`, n: rest.reduce((a, g) => a + g.n, 0), colour: tone().mute, pick: { dimension: view, groups: rest.map(g => g.key), title: 'Other groups', description: rest.map(g => g.label).join(', ') } });
      }
      const dimInfo = NM.dim(view);
      const multiNote = dist.dimension.multi ? ' A student can be in more than one group, so groups can add up to more than the total.' : '';
      const profile = `<div class="nf-card">${seg}<h3>${esc(dimInfo.label)}</h3><p class="sub">${esc(dimInfo.question || '')}${multiNote} Base: ${fmt(pop)} ${esc(dist.dimension.population_label || 'students')}. Click a group for its classes and students.</p>
        ${pop ? `<div class="nf-pie">${donutHtml(fmt(pop), 'students')}${legend(items, pop)}</div>` : '<div class="nf-empty">No results for this selection yet.</div>'}</div>`;
      let concern = '';
      if (isConcern) {
        const lv = levels(), tot = dist.totals.population;
        const sum = (keys) => keys.reduce((a, k) => a + (counts[k] || 0), 0);
        const inter = concernsOf('intervention'), crit = concernsOf('critical');
        const card = (cls, title, desc, keys, n) => `<button type="button" class="nf-cc ${cls}" data-cat="${attr({ dimension: view, groups: keys, title, description: desc, tone: cls })}"><span class="t">${esc(title)}</span><span class="n">${fmt(n)}<small>${pctTxt(n, st.cls ? pop : tot)}</small></span><span class="d">${esc(desc)}</span></button>`;
        concern = `<div class="nf-concern">
          ${card('warn', (lv.intervention || {}).label || 'Need intervention', (lv.intervention || {}).description || '', inter, sum(inter))}
          ${card('bad', (lv.critical || {}).label || 'Critical', (lv.critical || {}).description || '', crit, sum(crit))}
          ${card('ok', 'No significant concern', 'No area in the needs-support band.', ['none'], counts.none || 0)}
        </div>`;
      }
      // Class × group table (the existing class-wise explorer, scoped to this view).
      const byTotal = (a, b) => (dist.totals.counts[b.key] || 0) - (dist.totals.counts[a.key] || 0);
      const shownGroups = (isConcern ? groups : groups.slice().sort(byTotal)).filter(g => (dist.totals.counts[g.key] || 0) > 0);
      const heat = shownGroups.length ? `<div class="nf-card"><h3>${esc(dimInfo.label)} by class</h3><p class="sub">Each cell is the number of students and their share of the class. Click a cell for those students.</p>
        <div class="nf-scroll"><table class="nf-tbl nf-heat"><thead><tr><th>Class</th><th class="num">Base</th>${shownGroups.map(g => `<th class="h">${esc(g.label)}</th>`).join('')}</tr></thead><tbody>
        ${dist.classes.map(c => `<tr${st.cls === c.key ? ' class="on"' : ''}><td>${esc(c.label)}</td><td class="num">${fmt(c.population)}</td>${shownGroups.map(g => { const n = c.counts[g.key] || 0; return `<td class="h" tabindex="0" data-cat="${attr({ dimension: view, groups: [g.key], title: g.label, description: g.description, cls: c.key })}" style="background:${n ? `color-mix(in srgb, var(--brand2) ${Math.round(6 + 40 * n / Math.max(1, c.population))}%, transparent)` : 'transparent'}"><b>${fmt(n)}</b><small>${pctTxt(n, c.population)}</small></td>`; }).join('')}</tr>`).join('')}
        </tbody></table></div></div>` : '';
      main.innerHTML = `${concern}<div class="nf-grid">${clsTable}${profile}</div>${heat}`;
      const host = main.querySelector('.nf-donut canvas');
      if (host) donut(host, items, { total: pop }, (i) => openCat(i.pick));
    }

    /* ── screen: one category (students) ────────────────────────── */
    function openCat(c) { go({ cat: { dimension: c.dimension, groups: c.groups, title: c.title, description: c.description || '', tone: c.tone || '' }, cls: c.cls != null ? c.cls : st.cls, search: '' }); }
    async function screenCat(body, my) {
      const c = st.cat, p = param(st.param);
      const isSeaa = c.dimension === 'seaa_concern' || c.dimension === 'wellbeing_need';
      body.innerHTML = `<div class="nf-head"><h2>${esc(c.title)}</h2><p>${esc((p ? p.label + '. ' : '') + yearLabel())}.</p></div>
        <div class="nf-grid"><div class="nf-card" data-f="big"><div class="nf-empty"><span class="nm-spin"></span></div></div><div class="nf-card" data-f="grades"></div></div>
        <div class="nf-card" data-f="list"></div>`;
      const dist = await breakdown(c.dimension);
      if (my !== token) return;
      // The list endpoint counts each student once (even in a multi-group
      // dimension) and gives the same count per class, so the table equals the list.
      const all = await get('/api/dashboard/drill', { dimension: c.dimension, groups: c.groups, ids_only: 1 });
      if (my !== token) return;
      const total = all.total, base = dist.totals.population;
      const nBy = new Map((all.by_class || []).map(k => [k.key, k.n]));
      body.querySelector('[data-f="big"]').innerHTML = `<div class="nf-big ${esc(c.tone)}"><span class="n">${fmt(total)}</span><span class="d"><b>${pctTxt(total, base)}</b> of ${fmt(base)} ${esc(dist.dimension.population_label || 'students')}.<br>${esc(c.description)}</span></div>`;
      const rows = dist.classes.map(k => ({ key: k.key, label: k.label, n: nBy.get(k.key) || 0, pop: k.population })).filter(r => r.pop);
      body.querySelector('[data-f="grades"]').innerHTML = `<h3>Grade-wise distribution</h3><p class="sub">Click a class to list only its students.</p>
        <div class="nf-scroll"><table class="nf-tbl"><thead><tr><th>Class</th><th class="num">Students</th><th>Share of class</th></tr></thead><tbody>
        ${rows.map(r => `<tr class="go${st.cls === r.key ? ' on' : ''}" tabindex="0" data-go="${attr({ cls: st.cls === r.key ? '' : r.key, page: 0 })}"><td><button type="button" class="nm-link" tabindex="-1">${esc(r.label)}</button></td><td class="num">${fmt(r.n)}</td><td><div class="nf-rate">${meter(pctOf(r.n, r.pop))}<span>${pctOf(r.n, r.pop)}%</span></div></td></tr>`).join('')}
        </tbody></table></div>`;
      await renderList(body.querySelector('[data-f="list"]'), my, isSeaa);
    }
    async function renderList(host, my, isSeaa) {
      const c = st.cat;
      const r = await get('/api/dashboard/drill', { dimension: c.dimension, groups: c.groups, class: st.cls, search: st.search, limit: UI.LIST_ROWS, offset: st.page * UI.LIST_ROWS });
      if (my !== token) return;
      const ar = areas(), lab = new Map(((await breakdown(c.dimension)).groups || []).map(g => [g.key, g.label]));
      if (my !== token) return;
      const scoreCell = (s) => {
        const sc = s.seaa_scores || {}, need = new Set((s.seaa_concern || '').split(''));
        return `<div class="nf-score">${ar.map(a => sc[a.key] == null ? '' : `<span class="${need.has(a.key) ? 'bad' : ''}" title="${esc(a.label)}">${esc(a.label[0])} <b>${sc[a.key]}</b>${a.max_score ? '/' + a.max_score : ''}</span>`).join('')}</div>`;
      };
      const areasCell = (s) => { const need = (s.seaa_concern || '').split('').filter(k => ar.some(a => a.key === k)); return need.length ? `<div class="nf-areas">${need.map(k => `<span class="nm-chip ${need.length >= ar.length ? 'bad' : 'warn'}">${esc((ar.find(a => a.key === k) || {}).label)}</span>`).join('')}</div>` : '<span class="nm-chip ok">None</span>'; };
      const clsTxt = st.cls ? ` in ${esc(classLabel(st.cls))}` : '';
      host.innerHTML = `<div class="nm-bar"><h3 class="nf-listh">Students${clsTxt} <span>${fmt(r.total)}</span></h3>
          <input class="nm-in" type="search" data-f="search" placeholder="Search name, email or Unique School ID" value="${esc(st.search)}" aria-label="Search students">
          <button type="button" class="nm-btn" data-f="tools" title="Export, send reminders or download reports">Export or act on list</button></div>
        ${r.students.length ? `<div class="nf-scroll"><table class="nf-tbl"><thead><tr><th class="num">Sr no</th><th>Student name</th><th>Student ID</th><th>Class</th>${isSeaa ? '<th>Adjustment areas</th><th>SEAA score</th>' : '<th>Group</th><th>Career fit</th>'}<th></th></tr></thead><tbody>
          ${r.students.map((s, i) => `<tr><td class="num">${st.page * UI.LIST_ROWS + i + 1}</td><td><button type="button" class="nm-link" data-nm="student" data-sid="${esc(s.session_id)}">${esc(s.full_name || s.first_name || '—')}</button><div class="nf-small">${esc(s.school || '')}</div></td>
            <td>${s.student_uid ? `<span class="nm-uid">${esc(s.student_uid)}</span>` : '<span class="nf-small">—</span>'}</td><td class="nowrap">${esc(s.class_label)}${s.section ? ' – ' + esc(s.section) : ''}</td>
            ${isSeaa ? `<td>${areasCell(s)}</td><td>${scoreCell(s)}</td>` : `<td>${(s.matched || []).map(k => `<span class="nm-chip mute">${esc(lab.get(k) || k)}</span>`).join(' ')}</td><td>${esc(s.fit_tier || '—')}</td>`}
            <td><button type="button" class="nm-btn sm" data-nm="student" data-sid="${esc(s.session_id)}">View report</button></td></tr>`).join('')}
          </tbody></table></div>` : `<div class="nf-empty">${st.search ? 'No students match the search.' : 'No students in this group.'}</div>`}
        ${r.total > UI.LIST_ROWS ? `<div class="nm-bar nf-pager"><span>Showing ${st.page * UI.LIST_ROWS + 1}–${Math.min((st.page + 1) * UI.LIST_ROWS, r.total)} of ${fmt(r.total)}</span><span><button type="button" class="nm-btn sm" data-go="${attr({ page: st.page - 1 })}"${st.page ? '' : ' disabled'}>Previous</button> <button type="button" class="nm-btn sm" data-go="${attr({ page: st.page + 1 })}"${(st.page + 1) * UI.LIST_ROWS >= r.total ? ' disabled' : ''}>Next</button></span></div>` : ''}`;
    }

    /* ── render ─────────────────────────────────────────────────── */
    async function render() {
      const my = ++token;
      killCharts();
      if (!structure) { el.innerHTML = '<div class="nf-empty"><span class="nm-spin"></span></div>'; return; }
      if (!structure.orgs.length) { el.innerHTML = '<div class="nf-card"><div class="nf-empty">No schools to show yet. Students appear here once they register.</div></div>'; return; }
      if (st.org && singleBranch() && !st.branch) st.branch = curOrg().branches[0].branch;
      if (st.param && !param(st.param)) st.param = '';
      el.innerHTML = `<div class="nf">${topBar()}<div data-f="screen" class="nf"></div></div>`;
      const body = el.querySelector('[data-f="screen"]');
      try {
        if (st.cat && st.param) await screenCat(body, my);
        else if (st.param) await screenParam(body, my);
        else if (st.branch && curBranch()) await screenBranch(body, my);
        else await screenOverview(body, my);
      } catch (e) {
        if (my === token) body.innerHTML = `<div class="nf-card"><div class="nf-empty">Could not load this view: ${esc(e.message)} <button type="button" class="nm-btn sm" data-f="retry">Try again</button></div></div>`;
      }
    }

    /* ── events (one delegated set per mount) ───────────────────── */
    el.addEventListener('click', (e) => {
      const g = e.target.closest('[data-go]');
      if (g && el.contains(g)) { e.preventDefault(); return go(JSON.parse(g.dataset.go)); }
      const d = e.target.closest('[data-drill]');
      if (d) return NM.openDrill(JSON.parse(d.dataset.drill));
      const pk = e.target.closest('[data-pick]');
      if (pk) { const o = JSON.parse(pk.dataset.pick); return o.dimension ? openCat(o) : NM.openDrill(o); }
      const c = e.target.closest('[data-cat]');
      if (c) return openCat(JSON.parse(c.dataset.cat));
      const f = e.target.closest('[data-f]');
      if (!f) return;
      if (f.dataset.f === 'retry') { cache.clear(); render(); }
      if (f.dataset.f === 'reload') reload();
      if (f.dataset.f === 'allrows') { st.allRows = !st.allRows; render(); }
      if (f.dataset.f === 'tools' && st.cat) NM.openDrill(drillOpts({ dimension: st.cat.dimension, groups: st.cat.groups, classKey: st.cls, search: st.search, title: st.cat.title, subtitle: st.cat.description }));
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('tr[data-go],td[data-cat]');
      if (row) { e.preventDefault(); row.click(); }
    });
    el.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (f === 'year') {
        st.year = e.target.value === '' ? '' : Number(e.target.value);
        save();
        reload();
      }
    });
    let searchT;
    el.addEventListener('input', (e) => {
      if (e.target.dataset.f !== 'search') return;
      clearTimeout(searchT);
      const v = e.target.value;
      searchT = setTimeout(async () => {
        st.search = v.trim(); st.page = 0;
        const host = el.querySelector('[data-f="list"]');
        if (host && st.cat) { const my = ++token; await renderList(host, my, st.cat.dimension === 'seaa_concern' || st.cat.dimension === 'wellbeing_need'); const box = host.querySelector('[data-f="search"]'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }
      }, 350);
    });

    // Fresh numbers. The current view stays on screen, dimmed, until they
    // arrive; a newer reload (e.g. a quick second school change) wins.
    let loadSeq = 0;
    async function reload() {
      const mine = ++loadSeq;
      cache.clear();
      if (!structure) render(); else el.classList.add('nf-busy');
      try {
        await loadStructure(() => mine === loadSeq);
      } catch (e) {
        if (mine !== loadSeq) return;
        el.classList.remove('nf-busy');
        el.innerHTML = `<div class="nf-card"><div class="nf-empty">Could not load the dashboard: ${esc(e.message)} <button type="button" class="nm-btn sm" data-f="reload">Try again</button></div></div>`;
        return;
      }
      if (mine !== loadSeq) return;
      el.classList.remove('nf-busy');
      render();
    }
    el._nmRender = reload;
    el.setAttribute('data-nm-flow', '1');
    if (!el._nmScopeBound) { el._nmScopeBound = true; document.addEventListener('nm:scope', () => { if (document.body.contains(el)) reload(); }); }
    await reload();
  };

  // Opens the Dashboard section: mounts it the first time, reloads when asked.
  NM.showFlow = function (force) {
    const el = document.getElementById('nm-flow');
    if (!el) return;
    if (!el.hasAttribute('data-nm-flow')) { el.setAttribute('data-nm-flow', '1'); NM.mountFlow(el).catch(e => console.warn('[flow]', e)); }
    else if (force && el._nmRender) el._nmRender();
  };
})();
