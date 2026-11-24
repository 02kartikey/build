/* ════════════════════════════════════════════════════════════════════
   js/dashboard-insights.js — the Insights page (all three dashboards)
   --------------------------------------------------------------------
   One page, built the same way for Admin, Management and Counsellor; each
   role sees only its own schools and students because every panel reads the
   same scoped endpoints. Top to bottom it answers:

     1. Where do we stand?        headline numbers against the target
     2. Are we moving?            the last 7 days against the 7 before,
                                  weekly completions, and when the target
                                  will be reached at the recent pace
     3. What should we do next?   What needs attention + AI analysis
     4. Where do students stop,   how far students get through the four
        and how are they?         parts; the wellbeing (SEAA) picture
     5. The detail                tabs: Progress, Schools, Classes,
                                  Results, Wellbeing, Year on year,
                                  Participation (each built when opened)

   It follows the school chosen in the top bar. Loaded after
   dashboard-common.js; uses its NM helpers and panels.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const NM = window.NM;
  if (!NM || NM.mountInsights) return;
  const { esc, api, qs, store, attr } = NM;

  const CSS = `
.ins-top{display:flex;justify-content:flex-end;margin:-6px 0 10px}
.ins-sec{display:flex;align-items:baseline;gap:10px;margin:22px 0 10px}
.ins-sec h2{margin:0;font:700 15px var(--font,sans-serif);color:var(--ink);letter-spacing:-.005em}
.ins-sec p{margin:0;font-size:12.5px;color:var(--ink4)}
.ins-pace{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.ins-pc{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;min-width:0}
.ins-pc .l{font-size:12.5px;font-weight:600;color:var(--ink3)}
.ins-pc .v{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:26px;font-weight:750;color:var(--ink);letter-spacing:-.02em;line-height:1.1;font-variant-numeric:tabular-nums}
.ins-pc .s{font-size:12px;color:var(--ink4);line-height:1.45}.ins-pc .s b{color:var(--ink2)}
.ins-pc.fc .v{font-size:22px}
.ins-delta{font-size:12px;font-weight:650;letter-spacing:0;padding:2px 7px;border-radius:999px;background:var(--surface3);color:var(--ink3)}
.ins-delta.up{background:var(--ok2);color:var(--ok)}.ins-delta.down{background:var(--danger2);color:var(--danger)}
.ins-spark{display:block;width:100%;height:38px;margin-top:2px}
.ins-spark rect{fill:var(--brand2);opacity:.28}.ins-spark rect.now{opacity:1}
.ins-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}
.ins-fn{display:flex;flex-direction:column;gap:6px}
.ins-fr{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr) auto;grid-template-areas:'lab bar num';gap:12px;align-items:center}
.ins-fr .lab{grid-area:lab}.ins-fr .bar{grid-area:bar}.ins-fr .num{grid-area:num}
.ins-fr .lab{font-size:13px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ins-fr .bar{position:relative;height:22px;border-radius:6px;background:var(--surface3);overflow:hidden}
.ins-fr .bar i{position:absolute;inset:0 auto 0 0;background:var(--brand2);opacity:.85;border-radius:6px}
.ins-fr .bar i.ok{background:var(--ok)}
.ins-fr .num{font-size:12.5px;color:var(--ink4);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.ins-fr .num b{color:var(--ink);font-size:13px}
.ins-fr button.nm-link{justify-self:start;text-align:left}
.ins-note{font-size:12px;color:var(--ink4);margin:12px 0 0;line-height:1.5}
.ins-wb{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px}
.ins-wbt{border:1px solid var(--border);border-radius:12px;padding:10px 12px;text-align:left;background:var(--surface);font:inherit;cursor:pointer;display:flex;flex-direction:column;gap:2px}
.ins-wbt:hover{border-color:var(--brand2)}.ins-wbt[disabled]{cursor:default}.ins-wbt[disabled]:hover{border-color:var(--border)}
.ins-wbt .l{font-size:12px;color:var(--ink3);font-weight:600}.ins-wbt .n{font-size:22px;font-weight:750;color:var(--ink);font-variant-numeric:tabular-nums}.ins-wbt .s{font-size:11.5px;color:var(--ink4)}
.ins-wbt.warn .n{color:var(--warn)}.ins-wbt.bad .n{color:var(--danger)}
.ins-wb.two{grid-template-columns:repeat(2,minmax(0,1fr));margin:0}
.ins-block+.ins-block{margin-top:22px;padding-top:18px;border-top:1px solid var(--border)}
.ins-block h3{margin:0 0 3px;font:700 14px var(--font,sans-serif);color:var(--ink)}
.ins-block>p{margin:0 0 12px;font-size:12.5px;color:var(--ink4);line-height:1.5;max-width:80ch}
.ins-g2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.ins-g2>.ins-block+.ins-block{margin-top:0;padding-top:0;border-top:none}
.ins-rate{display:flex;align-items:center;gap:8px;min-width:140px}.ins-rate .bar{flex:1;height:8px;border-radius:999px;background:var(--surface3);overflow:hidden}.ins-rate .bar i{display:block;height:100%;background:var(--brand2)}
.ins-list{border:1px solid var(--border);border-radius:10px;overflow:hidden}
.ins-li{display:flex;gap:10px;align-items:center;padding:9px 14px;border-bottom:1px solid var(--border)}
.ins-li .who{flex:1;min-width:0}.ins-li .who small{display:block;font-size:11.5px;color:var(--ink5);margin-top:1px}
.ins-li .meta{font-size:11.5px;color:var(--ink4);text-align:right;white-space:nowrap;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.ins-lf{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;background:var(--surface2)}
.ins-sch th,.ins-sch td{padding:9px 10px}.ins-sch .r{text-align:right}
.ins-sch .rate{display:grid;grid-template-columns:44px minmax(90px,1fr);gap:10px;align-items:center;min-width:180px}
.ins-sch .rate b.ok{color:var(--ok)}.ins-sch .rate b.warn{color:var(--warn)}.ins-sch .rate b.bad{color:var(--danger)}
.ins-meter{position:relative;display:block;height:8px;border-radius:999px;background:var(--surface3)}.ins-meter i{display:block;height:100%;border-radius:999px}
.ins-meter i.ok{background:var(--ok)}.ins-meter i.warn{background:var(--warn)}.ins-meter i.bad{background:var(--danger)}
.ins-meter b{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.6}
.ins-sch tr.fold td{background:var(--surface2)}
@media(max-width:1200px){.ins-pace{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:1000px){.ins-two,.ins-g2{grid-template-columns:minmax(0,1fr)}.ins-g2>.ins-block+.ins-block{margin-top:22px;padding-top:18px;border-top:1px solid var(--border)}}
@media(max-width:620px){.ins-pace,.ins-wb{grid-template-columns:minmax(0,1fr)}.ins-fr{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'lab num' 'bar bar';gap:4px 12px}}
`;
  const styleEl = document.createElement('style'); styleEl.textContent = CSS; document.head.appendChild(styleEl);

  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const pct = (n, d) => (d ? Math.round(n / d * 100) : 0);
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const spinner = (el) => { el.innerHTML = '<div class="nm-empty"><span class="nm-spin"></span></div>'; };
  const failed = (el, e) => { el.innerHTML = `<div class="nm-empty">${esc(e.message)}</div>`; };
  const drillBtn = (label, o, cls) => `<button type="button" class="${cls || 'nm-link'}" data-nm="drill" data-o="${attr(o)}">${label}</button>`;

  /* ── Pace: the last 7 days against the 7 before, and the forecast ── */
  function delta(now, before) {
    if (!now && !before) return '<span class="ins-delta">No change</span>';
    if (!before) return '<span class="ins-delta up">New this week</span>';
    const d = Math.round((now - before) / before * 100);
    if (d === 0) return '<span class="ins-delta">Same as the week before</span>';
    return `<span class="ins-delta ${d > 0 ? 'up' : 'down'}" title="Compared with the 7 days before">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%</span>`;
  }
  function spark(weeks) {
    const max = Math.max(1, ...weeks.map(w => w.completed)), W = 100 / weeks.length, H = 38;
    const label = 'Completions per week, oldest first: ' + weeks.map(w => w.completed).join(', ');
    return `<svg class="ins-spark" viewBox="0 0 100 ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${weeks.map((w, i) => {
      const h = Math.max(w.completed ? 2 : 0.5, w.completed / max * (H - 2));
      return `<rect x="${(i * W + W * 0.15).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(W * 0.7).toFixed(2)}" height="${h.toFixed(2)}" rx="0.8"${i === weeks.length - 1 ? ' class="now"' : ''}><title>Week from ${esc(NM.fmtDate(w.from))}: ${fmt(w.completed)}</title></rect>`;
    }).join('')}</svg>`;
  }
  const monthYear = (iso) => new Date(iso).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  NM.mountPace = async function (el, { school } = {}) {
    if (!el) return;
    spinner(el);
    try {
      const p = await NM.pulse(school), t = p.target, days = p.window_days;
      if (!t.registered) { el.innerHTML = '<div class="nm-empty">No students registered yet.</div>'; return; }
      const fc = t.completions_needed === 0
        ? { v: 'Target reached', s: t.per_school ? 'Every school has reached its own target.' : `${t.target_pct}% of registered students have completed.` }
        : t.weeks_to_target == null
          ? { v: 'Not at this pace', s: `No completions in the last ${t.pace_weeks} weeks; ${plural(t.completions_needed, 'completion is', 'completions are')} still needed.` }
          : { v: 'Around ' + monthYear(t.expected_by), s: `<b>${fmt(t.completions_needed)}</b> more completions needed. At about ${fmt(Math.round(t.pace_per_week))} a week (the last ${t.pace_weeks} weeks), that is ${plural(t.weeks_to_target, 'week', 'weeks')} away.` };
      el.innerHTML = `<div class="ins-pace">
        <div class="ins-pc"><span class="l">Completed in the last ${days} days</span><span class="v">${fmt(p.completions.this_week)}${delta(p.completions.this_week, p.completions.last_week)}</span>
          ${spark(p.weekly_completions)}<span class="s">Each bar is one week; the last ${p.weekly_completions.length} weeks.</span></div>
        <div class="ins-pc"><span class="l">New registrations in the last ${days} days</span><span class="v">${fmt(p.registrations.this_week)}${delta(p.registrations.this_week, p.registrations.last_week)}</span>
          <span class="s">${fmt(p.registrations.last_week)} in the ${days} days before.</span></div>
        <div class="ins-pc"><span class="l">Active in the last ${days} days</span><span class="v">${fmt(p.active_this_week)}<span class="ins-delta">${pct(p.active_this_week, t.registered)}% of registered</span></span>
          <span class="s">Students who answered or saved something.</span></div>
        <div class="ins-pc fc"><span class="l">When the target will be reached</span><span class="v">${esc(fc.v)}</span><span class="s">${fc.s}</span></div>
      </div>`;
    } catch (e) { failed(el, e); }
  };

  /* ── How far students get through the four parts ─────────────────── */
  NM.mountParts = async function (el, { school } = {}) {
    if (!el) return;
    spinner(el);
    try {
      const p = await NM.pulse(school), reg = p.target.registered;
      if (!reg) { el.innerHTML = '<div class="nm-empty">No students registered yet.</div>'; return; }
      const drillFor = (r) => r.key === 'registered' ? { school, title: 'Registered students' }
        : r.key === 'started' ? { school, dimension: 'completion', groups: ['in_progress', 'completed'], title: 'Students who have started' }
        : r.key === 'completed' ? { school, dimension: 'completion', groups: ['completed'], title: 'Completed students' }
        : { school, dimension: 'parameters', groups: [r.key], title: r.label };
      const weakest = p.funnel.filter(r => !['registered', 'started', 'completed'].includes(r.key)).sort((a, b) => a.students - b.students)[0];
      el.innerHTML = `<div class="ins-fn">${p.funnel.map(r => `<div class="ins-fr">${drillBtn(esc(r.label), drillFor(r), 'nm-link lab')}
          <span class="bar" aria-hidden="true"><i class="${r.key === 'completed' ? 'ok' : ''}" style="width:${pct(r.students, reg)}%"></i></span>
          <span class="num"><b>${fmt(r.students)}</b> · ${pct(r.students, reg)}%</span></div>`).join('')}</div>
        ${weakest ? `<p class="ins-note">Fewest students have finished <b>${esc(weakest.label.replace(/ done$/, ''))}</b> (${pct(weakest.students, reg)}% of registered). A report needs all four parts, so this part decides how many reports there are.</p>` : ''}`;
    } catch (e) { failed(el, e); }
  };

  /* ── Wellbeing (SEAA) at a glance ────────────────────────────────── */
  NM.mountSeaaSnapshot = async function (el, { school } = {}) {
    if (!el) return;
    spinner(el);
    try {
      const p = await NM.pulse(school), s = p.seaa;
      if (!s.assessed) { el.innerHTML = '<div class="nm-empty">No wellbeing results yet. They appear once students complete the assessment.</div>'; return; }
      const levels = (NM.cat && NM.cat.seaa_levels) || {};
      const concerns = (lvl) => ((NM.cat && NM.cat.seaa_concerns) || []).filter(c => c.level === lvl).map(c => c.key);
      const tile = (cls, label, n, sub, o) => `<button type="button" class="ins-wbt ${cls}" ${n ? `data-nm="drill" data-o="${attr(o)}"` : 'disabled'}><span class="l">${esc(label)}</span><span class="n">${fmt(n)}</span><span class="s">${esc(sub)}</span></button>`;
      const areas = NM.wbAreas();
      el.innerHTML = `<div class="ins-wb">
          ${tile('', 'Assessed', s.assessed, 'Completed students with wellbeing results', { school, dimension: 'completion', groups: ['completed'], title: 'Students with wellbeing results' })}
          ${Object.entries(levels).map(([k, v]) => tile(k === 'critical' ? 'bad' : 'warn', v.label, s.levels[k] || 0, `${pct(s.levels[k] || 0, s.assessed)}% · ${v.description}`, { school, dimension: 'seaa_concern', groups: concerns(k), title: v.label })).join('')}
        </div>
        <div class="ins-fn">${areas.map(a => `<div class="ins-fr">${drillBtn(esc(a.label) + ' adjustment', { school, dimension: 'wellbeing_need', groups: [a.key], title: a.label + ' adjustment needs support' }, 'nm-link lab')}
          <span class="bar" aria-hidden="true"><i style="width:${pct(s.by_area[a.key] || 0, s.assessed)}%"></i></span>
          <span class="num"><b>${fmt(s.by_area[a.key] || 0)}</b> · ${pct(s.by_area[a.key] || 0, s.assessed)}%</span></div>`).join('')}</div>
        <p class="ins-note">Bars show how many assessed students need support in each area; one student can need support in more than one. ${NM.help('SEAA / NSEAA (Wellbeing)')}</p>`;
    } catch (e) { failed(el, e); }
  };

  /* ── Every school against its own target (Schools tab) ────────────── */
  const SCHOOL_SORTS = {
    behind: { label: 'Furthest behind target', fn: (a, b) => (a.completion_pct - a.target_pct) - (b.completion_pct - b.target_pct) || b.total - a.total },
    ahead: { label: 'Highest completion', fn: (a, b) => b.completion_pct - a.completion_pct || b.total - a.total },
    recent: { label: 'Most completions this week', fn: (a, b) => b.completed_recent - a.completed_recent || b.total - a.total },
    size: { label: 'Most students', fn: (a, b) => b.total - a.total },
    name: { label: 'A to Z', fn: (a, b) => a.school.localeCompare(b.school) },
  };
  NM.mountSchoolsTable = async function (el, { school } = {}) {
    if (!el) return;
    await NM.ready();
    spinner(el);
    try {
      const { schools: all, groups } = await api('GET', '/api/dashboard/school-summary');
      const list = school ? all.filter(x => x.school === school) : all;
      if (!list.length) { el.innerHTML = '<div class="nm-empty">No schools yet.</div>'; return; }
      const state = { sort: SCHOOL_SORTS[store.get('schools-sort')] ? store.get('schools-sort') : 'behind', all: false, small: false };
      const SHOWN = NM.UI.TABLE_ROWS, days = list[0].recent_days;
      const tone = (x) => ({ met: 'ok', behind: 'warn', far_behind: 'bad' }[x.standing] || '');   // standing is decided by the server
      const gap = (x) => Math.max(0, Math.ceil(x.total * x.target_pct / 100) - x.completed);
      const tr = (x, fold) => `<tr${fold ? ' class="fold"' : ''}><td><button class="nm-link" data-nm="school" data-school="${esc(x.school)}">${esc(x.school)}</button></td>
          <td class="r">${fmt(x.total)}</td>
          <td><div class="rate"><b class="${tone(x)}">${x.completion_pct}%</b><span class="ins-meter"><i class="${tone(x)}" style="width:${x.completion_pct}%"></i><b style="left:${Math.min(x.target_pct, 100)}%" title="Target ${x.target_pct}%"></b></span></div></td>
          <td class="r">${x.target_pct}%</td>
          <td class="r">${gap(x) ? drillBtn(fmt(gap(x)), { school: x.school, dimension: 'completion', groups: ['in_progress', 'not_started'], title: x.school + ': not finished' }) : '<span class="nm-chip ok">Met</span>'}</td>
          <td class="r">${fmt(x.completed_recent)}</td>
          <td class="r">${x.follow_up ? drillBtn(fmt(x.follow_up), { school: x.school, dimension: 'attention', groups: groups.follow_up, title: x.school + ': need follow-up' }) : '0'}</td>
          <td class="r"><span class="nm-wbs">${NM.wbCells(x.support_areas, { school: x.school, title: x.school })}</span></td></tr>`;
      const draw = () => {
        const sorted = list.slice().sort(SCHOOL_SORTS[state.sort].fn);
        const main = sorted.filter(x => x.total >= NM.SMALL_SCHOOL), small = sorted.filter(x => x.total < NM.SMALL_SCHOOL);
        const shown = state.all ? main : main.slice(0, SHOWN);
        const smallStudents = small.reduce((n, x) => n + x.total, 0);
        el.innerHTML = `<div class="nm-bar"><label class="nm-field"><span>Sort by</span><select class="nm-sel" data-f="sort">${Object.entries(SCHOOL_SORTS).map(([k, v]) => `<option value="${k}"${k === state.sort ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
            <span class="nm-q">${plural(list.length, 'school', 'schools')}. The marker on each bar is that school’s target. Click a school for its classes.</span></div>
          <div class="ov-tblwrap"><table class="nm-tbl ins-sch"><thead><tr><th>School</th><th class="r">Students</th><th>Completed</th><th class="r">Target</th><th class="r">Still needed</th><th class="r" title="Reports completed in the last ${days} days">Last ${days} days</th><th class="r">Follow-up</th><th class="r" title="Completed students whose social (S), emotional (E) or academic (A) adjustment needs support">Wellbeing support</th></tr></thead><tbody>
          ${shown.map(x => tr(x)).join('')}
          ${main.length > SHOWN ? `<tr><td colspan="8"><button class="nm-link" data-f="all">${state.all ? 'Show fewer' : `Show all ${main.length} schools`}</button></td></tr>` : ''}
          ${small.length ? `<tr class="fold"><td colspan="8"><button class="nm-link" data-f="small" aria-expanded="${state.small}"><i class="chev${state.small ? ' open' : ''}"></i>${plural(small.length, 'school', 'schools')} with fewer than ${NM.SMALL_SCHOOL} students (${plural(smallStudents, 'student', 'students')})</button>${NM.me.role === 'admin' ? ' <button class="nm-link" data-f="to-merge">Merge duplicate names</button>' : ''}</td></tr>` + (state.small ? small.map(x => tr(x, true)).join('') : '') : ''}
          </tbody></table></div>`;
      };
      el.onchange = (e) => { if (e.target.dataset.f === 'sort') { state.sort = e.target.value; store.set('schools-sort', state.sort); draw(); } };
      el.onclick = (e) => {
        const f = e.target.closest('[data-f]'); if (!f) return;
        if (f.dataset.f === 'all') { state.all = !state.all; draw(); }
        if (f.dataset.f === 'small') { state.small = !state.small; draw(); }
        if (f.dataset.f === 'to-merge' && typeof window.show === 'function') window.show('schools-reg');
      };
      draw();
    } catch (e) { failed(el, e); }
  };

  /* ── A few students from any list, with "View all" ───────────────── */
  NM.mountStudentPreview = async function (el, { school, drill, empty, chips } = {}) {
    if (!el) return;
    spinner(el);
    try {
      // Groups may be a function, for lists that depend on the catalogue.
      const d = Object.assign({ school }, drill, { groups: typeof drill.groups === 'function' ? drill.groups() : drill.groups });
      const r = await api('GET', '/api/dashboard/drill?' + qs({ dimension: d.dimension, groups: d.groups, school, limit: NM.UI.ALERT_ROWS }));
      if (!r.total) { el.innerHTML = `<div class="ov-clear">${esc(empty)}</div>`; return; }
      el.innerHTML = `<div class="ins-list">${r.students.map(s => `<div class="ins-li"><div class="who"><button class="nm-link" data-nm="student" data-sid="${esc(s.session_id)}">${esc(s.full_name || s.first_name || 'Unnamed student')}</button>
          <small>${esc(s.school || '')}${s.school ? ', ' : ''}${esc(s.class_label)}${s.section ? ' ' + esc(s.section) : ''}</small></div>
          <div class="meta">${chips ? chips(s) : s.last_activity ? 'Last active ' + esc(NM.fmtDate(s.last_activity)) : s.registered_at ? 'Registered ' + esc(NM.fmtDate(s.registered_at)) : ''}</div></div>`).join('')}
        <div class="ins-lf">${drillBtn(`View all ${fmt(r.total)}`, d, 'nm-btn sm pri')}</div></div>`;
    } catch (e) { failed(el, e); }
  };

  /* ── Registered and completed students by gender ──────────────────── */
  NM.mountGender = async function (el, { school } = {}) {
    if (!el) return;
    spinner(el);
    try {
      const b = await api('GET', '/api/dashboard/breakdown?' + qs({ dimension: 'gender', school }));
      const rows = b.groups.filter(g => g.total);
      if (!rows.length) { el.innerHTML = '<div class="nm-empty">No students yet.</div>'; return; }
      const done = (k) => b.totals.completed[k] || 0;
      el.innerHTML = `<div class="ov-tblwrap"><table class="nm-tbl"><thead><tr><th>Gender</th><th class="r">Registered</th><th class="r">Completed</th><th>Completion rate</th></tr></thead><tbody>
        ${rows.map(g => `<tr><td>${esc(g.label)}</td>
          <td class="r">${drillBtn(fmt(g.total), { school, dimension: 'gender', groups: [g.key], title: g.label + ' students' })}</td>
          <td class="r">${drillBtn(fmt(done(g.key)), { school, dimension: 'gender', groups: [g.key], status: 'completed', title: g.label + ' students who completed' })}</td>
          <td><div class="ins-rate"><span class="bar"><i style="width:${pct(done(g.key), g.total)}%"></i></span><b>${pct(done(g.key), g.total)}%</b></div></td></tr>`).join('')}
        </tbody></table></div>`;
    } catch (e) { failed(el, e); }
  };

  /* ── Reminders sent to these students ────────────────────────────── */
  NM.mountReminderReach = async function (el, { school } = {}) {
    if (!el) return;
    spinner(el);
    try {
      const p = await NM.pulse(school), r = p.reminders;
      el.innerHTML = `<div class="ins-wb two">
          <div class="ins-wbt" role="group"><span class="l">Reminders sent</span><span class="n">${fmt(r.sent)}</span><span class="s">In the last ${r.days} days</span></div>
          <div class="ins-wbt" role="group"><span class="l">Students reached</span><span class="n">${fmt(r.students)}</span><span class="s">${pct(r.students, p.target.registered)}% of registered students</span></div></div>`;
    } catch (e) { failed(el, e); }
  };

  const block = (title, text, mount) => `<div class="ins-block"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}<div id="nm-${mount}" data-mount="${mount}"></div></div>`;
  const wbChips = (s) => (s.matched || []).map(k => `<span class="nm-chip bad">${esc((NM.wbAreas().find(a => a.key === k) || { label: k }).label)}</span>`).join('');

  // Tabs of the detail card. `metrics` feed its "Summarise with AI".
  const TABS = [
    { id: 'progress', title: 'Progress', text: 'Registrations, starts and completions over time, and the students who have stopped.', metrics: ['completion', 'trend', 'follow_up'],
      body: () => block('Over time', '', 'trend')
        + `<div class="ins-g2">${block('Stalled part-way', 'Started but saved nothing for longer than the follow-up period.', 'stalled')}${block('Registered but not started', 'Registered longer ago than the follow-up period and have answered nothing.', 'notstarted')}</div>`,
      mounts: { trend: [NM.mountTrend],
        stalled: [NM.mountStudentPreview, { drill: { dimension: 'attention', groups: ['stalled'], title: 'Stalled part-way' }, empty: 'Nobody has stalled. Good.' }],
        notstarted: [NM.mountStudentPreview, { drill: { dimension: 'attention', groups: ['overdue_start'], title: 'Registered but not started' }, empty: 'Everyone registered has started.' }] } },
    { id: 'schools', title: 'Schools', text: 'Every school against its own target, with this week’s completions, follow-up and wellbeing support.', metrics: ['completion', 'follow_up'],
      body: () => block('By school', '', 'schools'), mounts: { schools: [NM.mountSchoolsTable] } },
    { id: 'classes', title: 'Classes', text: 'Any result split by class. Click a number for the students behind it.', metrics: ['completion', 'career_area', 'wellbeing_level', 'fit_tier'],
      body: () => block('By class', '', 'explorer'), mounts: { explorer: [NM.mountExplorer] } },
    { id: 'results', title: 'Results', text: 'What completed students’ personality, aptitude and career-interest results show.', metrics: ['personality_level', 'aptitude_level', 'career_area', 'stream'],
      body: () => block('Results at a glance', 'How completed students spread across levels for each part of the assessment.', 'levels')
        + block('Career interests and subject streams', 'Each completed student counted once, by their strongest career-interest area or subject stream.', 'careers'),
      mounts: { levels: [NM.mountLevels], careers: [NM.mountCareerDistribution] } },
    { id: 'wellbeing', title: 'Wellbeing', text: 'Completed students whose social, emotional or academic adjustment needs support.', metrics: ['wellbeing_level', 'wellbeing_need'],
      body: () => block('By class', 'A student can need support in more than one area. Click a number for the students.', 'wb')
        + block('Students who need support', 'Their counsellor should see these students first.', 'wblist'),
      mounts: { wb: [NM.mountWbByClass],
        wblist: [NM.mountStudentPreview, { drill: { dimension: 'wellbeing_need', groups: () => NM.wbAreas().map(a => a.key), title: 'Students who need wellbeing support' }, empty: 'No completed student needs wellbeing support right now.', chips: wbChips }] } },
    { id: 'journeys', title: 'Year on year', text: 'Students assessed in more than one class, and how they changed.', metrics: ['journey'],
      body: () => block('Year-on-year journeys', '', 'journeys'), mounts: { journeys: [NM.mountJourneySummary] } },
    { id: 'participation', title: 'Participation', text: 'Who is taking part, how long each part takes, and how many students staff have reminded.', metrics: ['completion', 'timing'],
      body: () => `<div class="ins-g2">${block('By gender', 'Registered students and how many of them completed.', 'gender')}${block('Time per part', 'Typical time students spend on each part.', 'timing')}</div>`
        + block('Reminders', 'Reminder emails sent to these students by staff or on a schedule.', 'reach'),
      mounts: { gender: [NM.mountGender], timing: [NM.mountTiming], reach: [NM.mountReminderReach] } },
  ];

  NM.mountInsights = async function (el, { aiIntro } = {}) {
    if (!el) return;
    await NM.ready();
    const multi = (NM.cat.schools || []).length > 1;
    const sec = (title, text) => `<div class="ins-sec"><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}</div>`;
    el.innerHTML = `${multi ? '<div class="ins-top"><button type="button" class="nm-btn sm" data-f="export">Download schools summary (CSV)</button></div>' : ''}
      <div class="ov-summary" id="nm-kpis" data-mount="kpis"></div>
      ${sec('This week', 'The last 7 days against the 7 before.')}
      <div id="nm-pace" data-mount="pace"></div>
      ${sec('What to do next')}
      <div class="ov-grid">
        <section class="ov-card" aria-labelledby="ins-att-h"><header class="ov-ch"><div><h2 id="ins-att-h">What needs attention</h2><p>Worked out from today’s data each time the page loads. Open an item for the students and what to do.</p></div><div class="ov-act"><button type="button" class="nm-link" data-nm="glossary">What the terms mean</button></div></header><div class="ov-cb" id="nm-alerts" data-mount="alerts"></div></section>
        <section class="ov-card ai" aria-labelledby="ins-ai-h"><header class="ov-ch"><div><h2 id="ins-ai-h"><i class="ai-dot" aria-hidden="true"></i>AI analysis</h2><p>${esc(aiIntro || 'Written on request from the numbers you choose, and kept until they change. No student names are sent.')}</p></div></header><div class="ov-cb" id="nm-analysis" data-mount="analysis"></div></section>
      </div>
      <div class="ins-two">
        <section class="ov-card" aria-labelledby="ins-parts-h"><header class="ov-ch"><div><h2 id="ins-parts-h">How far students get</h2><p>Registered students who have finished each part. Click a row for the students.</p></div></header><div class="ov-cb" id="nm-parts" data-mount="parts"></div></section>
        <section class="ov-card" aria-labelledby="ins-wb-h"><header class="ov-ch"><div><h2 id="ins-wb-h">Wellbeing at a glance</h2><p>From the social, emotional and academic adjustment (SEAA) results of completed students.</p></div></header><div class="ov-cb" id="nm-seaa" data-mount="seaa"></div></section>
      </div>
      ${sec('The detail')}
      <section class="ov-card" aria-label="The detail">
        <div class="ov-tabs" role="tablist">${TABS.map(t => `<button type="button" role="tab" class="ov-tab" data-tab="${t.id}" aria-selected="false">${esc(t.title)}</button>`).join('')}</div>
        ${TABS.map(t => `<div class="ov-panel" data-panel="${t.id}" role="tabpanel" hidden><header class="ov-ch"><div><h2>${esc(t.title)}</h2><p>${esc(t.text)}</p></div><div class="ov-act" data-act="${t.id}"></div></header><div class="ov-sum" data-sum="${t.id}"></div><div class="ov-cb">${t.body()}</div></div>`).join('')}
      </section>`;
    const node = (k) => el.querySelector(`[data-mount="${k}"]`);
    await NM.mountAll([[node('kpis'), NM.mountKpis], [node('pace'), NM.mountPace], [node('alerts'), NM.mountAlerts],
      [node('analysis'), NM.mountAnalysis], [node('parts'), NM.mountParts], [node('seaa'), NM.mountSeaaSnapshot]]);
    for (const t of TABS) NM.sectionSummary(el.querySelector(`[data-act="${t.id}"]`), el.querySelector(`[data-sum="${t.id}"]`), { metrics: t.metrics, label: 'AI summary of ' + t.title.toLowerCase() });
    const mounted = new Set();
    const open = async (id) => {
      const t = TABS.find(x => x.id === id) || TABS[0];
      el.querySelectorAll('.ov-tab').forEach(b => { const on = b.dataset.tab === t.id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      el.querySelectorAll('.ov-panel').forEach(p => { p.hidden = p.dataset.panel !== t.id; });
      store.set('ins-tab', t.id);
      if (mounted.has(t.id)) return;
      mounted.add(t.id);
      await NM.mountAll(Object.entries(t.mounts).map(([k, [fn, opts]]) => [node(k), fn, opts]));
    };
    el.querySelectorAll('.ov-tab').forEach(b => b.addEventListener('click', () => open(b.dataset.tab)));
    if (multi) el.querySelector('[data-f="export"]').addEventListener('click', () => NM.exportSchools());
    await open(store.get('ins-tab', TABS[0].id));
  };
})();
