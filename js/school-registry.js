/* ════════════════════════════════════════════════════════════════════
   js/school-registry.js — School registry page (Admin console)
   --------------------------------------------------------------------
   One read (GET /api/dashboard/school-names) feeds the whole page:

     • Summary: registered schools, names students typed, likely
       duplicates, schools shown as branches of a larger school.
     • Merge school names: tick the names that are one school, choose the
       name to keep (and optionally the larger school it is a branch of),
       and merge. The server rewrites every student record to that name and
       files later registrations typed with a merged name under it.
       Likely duplicates are offered as one-click selections to review.
     • Registered schools: the official list used when assigning staff,
       with students per school. Add, edit and delete use the page's own
       school dialog (openSchoolRegModal / editSchoolReg / confirmDelSchReg).

   Loaded after dashboard-common.js; uses its NM helpers.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const NM = window.NM;
  if (!NM || NM.mountSchoolRegistry) return;
  const { esc, api } = NM;

  const CSS = `
.sr{display:flex;flex-direction:column;gap:16px}
.sr-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.sr-stat{padding:14px 18px;display:flex;flex-direction:column;gap:2px;min-width:0}
.sr-stat+.sr-stat{border-left:1px solid var(--border)}
.sr-stat .n{font-size:24px;font-weight:750;color:var(--ink);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.sr-stat .l{font-size:12.5px;color:var(--ink4)}
.sr-stat.warn .n{color:var(--warn)}
.sr-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);min-width:0}
.sr-ch{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px 12px;flex-wrap:wrap}
.sr-ch h2{margin:0;font-size:15.5px;font-weight:700;color:var(--ink)}
.sr-ch p{margin:3px 0 0;font-size:12.5px;color:var(--ink4);line-height:1.5;max-width:72ch}
.sr-cb{padding:0 20px 20px}
.sr-sugg{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.sr-sg{display:flex;align-items:center;gap:12px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);background:color-mix(in srgb,var(--warn) 6%,transparent);border-radius:10px}
.sr-sg .t{flex:1;min-width:0;font-size:13px;color:var(--ink2);line-height:1.45}.sr-sg .t b{color:var(--ink)}
.sr-sg .c{font-size:12px;color:var(--ink4);white-space:nowrap}
.sr-merge{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(300px,1fr);gap:16px;align-items:start}
.sr-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.sr-tools input[type=search]{flex:1;min-width:200px}
.sr-tools .nm-tabs{margin:0}
.sr-list{max-height:460px;overflow:auto;border:1px solid var(--border);border-radius:10px}
.sr-row{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer}
.sr-row:last-child{border-bottom:none}.sr-row:hover{background:var(--surface2)}
.sr-row.on{background:var(--brand4)}
.sr-row .nm{font-size:13px;font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.sr-row .alt{display:block;font-size:11.5px;font-weight:400;color:var(--ink4);margin-top:1px}
.sr-row .tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.sr-row .cnt{font-size:12.5px;color:var(--ink3);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.sr-panel{position:sticky;top:76px;border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--surface2);display:flex;flex-direction:column;gap:12px}
.sr-panel h3{margin:0;font-size:14px;font-weight:700;color:var(--ink)}
.sr-panel .hint{font-size:12.5px;color:var(--ink4);line-height:1.5;margin:0}
.sr-picked{display:flex;flex-wrap:wrap;gap:6px}
.sr-f{display:flex;flex-direction:column;gap:5px}
.sr-f>span{font-size:12px;font-weight:650;color:var(--ink3)}.sr-f>small{font-size:11.5px;color:var(--ink4);line-height:1.4}
.sr-f input{width:100%;box-sizing:border-box}
.sr-warn{font-size:12.5px;color:var(--ink2);background:color-mix(in srgb,var(--warn) 10%,transparent);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);border-radius:9px;padding:9px 11px;line-height:1.5}
.sr-acts{display:flex;gap:8px;flex-wrap:wrap}
.sr-reg td.r,.sr-reg th.r{text-align:right}
.sr-reg .nmn{font-weight:650;color:var(--ink)}
.sr-reg .acts{display:flex;gap:6px;justify-content:flex-end}
.sr-reg .del{color:var(--ink4)}.sr-reg .del:hover{color:var(--danger);border-color:var(--danger)}
.sr-regwrap{max-height:520px;overflow:auto;border:1px solid var(--border);border-radius:10px}
.sr-regwrap th{position:sticky;top:0;z-index:1}
.sr-empty{padding:24px;text-align:center;color:var(--ink4);font-size:13px}
@media(max-width:1100px){.sr-merge{grid-template-columns:minmax(0,1fr)}.sr-panel{position:static}}
@media(max-width:700px){.sr-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.sr-stat:nth-child(3){border-left:none}.sr-stat:nth-child(n+3){border-top:1px solid var(--border)}}
`;
  const styleEl = document.createElement('style'); styleEl.textContent = CSS; document.head.appendChild(styleEl);

  const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');   // as the server's normSchool
  const FILTERS = [
    { key: 'all', label: 'All', test: () => true },
    { key: 'unreg', label: 'Not registered', test: (r) => !r.registry },
    { key: 'empty', label: 'No students', test: (r) => !r.students },
  ];

  NM.mountSchoolRegistry = async function (el) {
    if (!el) return;
    if (el._srReload) return el._srReload();
    await NM.ready();
    const st = { data: null, sel: new Set(), q: '', filter: 'all', regQ: '', confirming: false, busy: false };
    el.innerHTML = `<div class="sr">
      <div class="sr-stats" data-f="stats"></div>
      <section class="sr-card" aria-labelledby="sr-m-h">
        <header class="sr-ch"><div><h2 id="sr-m-h">Merge school names</h2><p>Students type their school in different ways, so one school can appear several times. Tick every name that is the same school, choose the name to keep and merge. Their students move to that name, and anyone who types one of those names later is filed under it too.</p></div></header>
        <div class="sr-cb">
          <div class="sr-sugg" data-f="sugg"></div>
          <div class="sr-merge">
            <div>
              <div class="sr-tools"><input class="nm-in" type="search" data-f="q" placeholder="Search names, e.g. baga" aria-label="Search school names">
                <div class="nm-tabs" role="group" aria-label="Show">${FILTERS.map(f => `<button type="button" class="nm-tab" data-filter="${f.key}">${esc(f.label)}</button>`).join('')}</div></div>
              <div class="sr-list" data-f="list" role="listbox" aria-multiselectable="true" aria-label="School names"><div class="sr-empty"><span class="nm-spin"></span></div></div>
            </div>
            <aside class="sr-panel" data-f="panel" aria-live="polite"></aside>
          </div>
        </div>
      </section>
      <section class="sr-card" aria-labelledby="sr-r-h">
        <header class="sr-ch"><div><h2 id="sr-r-h">Registered schools</h2><p>The official list you choose from when giving counsellors and management access, including schools with no students yet.</p></div>
          <div class="sr-acts"><input class="nm-in" type="search" data-f="rq" placeholder="Search registered schools" aria-label="Search registered schools"><button type="button" class="nm-btn pri" data-f="add">Add school</button></div></header>
        <div class="sr-cb" data-f="reg"></div>
      </section>
      <datalist id="sr-names"></datalist><datalist id="sr-groups"></datalist></div>`;
    const $ = (k) => el.querySelector(`[data-f="${k}"]`);
    const rows = () => (st.data ? st.data.names : []);
    const picked = () => rows().filter(r => st.sel.has(r.key));

    function drawStats() {
      const d = st.data, reg = rows().filter(r => r.registry).length;
      const branches = rows().filter(r => r.group).length;
      const stat = (n, l, cls) => `<div class="sr-stat ${cls || ''}"><span class="n">${fmt(n)}</span><span class="l">${esc(l)}</span></div>`;
      $('stats').innerHTML = stat(reg, 'Registered schools')
        + stat(rows().length, 'School names on record')
        + stat(d.suggestions.length, d.suggestions.length === 1 ? 'Group of likely duplicates' : 'Groups of likely duplicates', d.suggestions.length ? 'warn' : '')
        + stat(branches, branches === 1 ? 'School shown as a branch' : 'Schools shown as branches');
    }
    function drawSuggestions() {
      const byKey = new Map(rows().map(r => [r.key, r]));
      const list = st.data.suggestions.map(keys => keys.map(k => byKey.get(k)).filter(Boolean)).filter(g => g.length > 1);
      $('sugg').innerHTML = list.length ? list.map((g, i) => `<div class="sr-sg"><div class="t">Likely the same school: <b>${g.map(r => esc(r.name)).join('</b>, <b>')}</b></div>
          <span class="c">${plural(g.reduce((n, r) => n + r.students, 0), 'student', 'students')}</span><button type="button" class="nm-btn sm" data-sugg="${i}">Review</button></div>`).join('') : '';
      $('sugg')._groups = list;
    }
    function drawList() {
      const q = st.q.toLowerCase(), f = FILTERS.find(x => x.key === st.filter) || FILTERS[0];
      el.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('on', b.dataset.filter === f.key));
      const shown = rows().filter(r => st.sel.has(r.key) || (f.test(r) && (!q || r.names.some(n => n.toLowerCase().includes(q)) || (r.group || '').toLowerCase().includes(q))))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
      $('list').innerHTML = shown.length ? shown.map(r => `<label class="sr-row${st.sel.has(r.key) ? ' on' : ''}" role="option" aria-selected="${st.sel.has(r.key)}">
          <input type="checkbox" data-key="${esc(r.key)}"${st.sel.has(r.key) ? ' checked' : ''}>
          <span><span class="nm">${esc(r.name)}</span>${r.names.length > 1 ? `<span class="alt">Also typed as ${r.names.filter(n => n !== r.name).map(esc).join(', ')}</span>` : ''}
            ${r.registry || r.group ? `<span class="tags">${r.registry ? '<span class="nm-chip ok">Registered</span>' : ''}${r.group ? `<span class="nm-chip mute">Part of ${esc(r.group)}</span>` : ''}</span>` : ''}</span>
          <span class="cnt">${plural(r.students, 'student', 'students')}</span></label>`).join('')
        : `<div class="sr-empty">${q ? `No school names match “${esc(st.q)}”.` : 'Nothing to show here.'}</div>`;
    }
    function drawPanel() {
      const sel = picked();
      if (!sel.length) {
        $('panel').innerHTML = `<h3>Nothing ticked yet</h3><p class="hint">Search for a school, then tick every name that is the same school. Or press Review on a likely duplicate above.</p>
          <p class="hint">To show a school as a branch of a larger one, tick just that school and fill in “Part of”.</p>`;
        return;
      }
      const name = st.name != null ? st.name : '', group = st.group != null ? st.group : '';
      const others = sel.filter(r => r.key !== keyOf(name));
      const moving = others.reduce((n, r) => n + r.students, 0);
      const merging = others.length > 0;
      const removed = others.filter(r => r.registry);
      $('panel').innerHTML = `<h3>${plural(sel.length, 'name', 'names')} ticked</h3>
        <div class="sr-picked">${sel.map(r => `<span class="nm-chip mute">${esc(r.name)} · ${fmt(r.students)}</span>`).join('')}</div>
        <label class="sr-f"><span>Keep this name</span><input class="nm-in" data-f="name" list="sr-names" maxlength="120" autocomplete="off" value="${esc(name)}"><small>One of the ticked names, a registered school, or a new name.</small></label>
        <label class="sr-f"><span>Part of (optional)</span><input class="nm-in" data-f="group" list="sr-groups" maxlength="120" autocomplete="off" value="${esc(group)}" placeholder="e.g. Aditya Birla Public School"><small>Only when this school is one branch of a larger school. The Dashboard then shows the larger school with its branches.</small></label>
        ${st.confirming ? `<div class="sr-warn">${plural(moving, 'student', 'students')} under ${others.map(r => `“${esc(r.name)}”`).join(', ')} will move to “${esc(name)}”.${removed.length ? ` ${removed.length === 1 ? 'That name leaves' : 'Those names leave'} the registered list.` : ''} This cannot be undone.</div>` : ''}
        <div class="sr-acts"><button type="button" class="nm-btn pri" data-f="go"${!name.trim() || st.busy ? ' disabled' : ''}>${!name.trim() ? 'Enter the name to keep' : st.confirming ? 'Yes, merge' : merging ? `Merge into “${esc(name.trim())}”` : 'Save'}</button>
          <button type="button" class="nm-btn" data-f="clear">${st.confirming ? 'Cancel' : 'Clear'}</button></div>`;
    }
    function drawRegistry() {
      const q = st.regQ.toLowerCase();
      const reg = rows().filter(r => r.registry && (!q || r.name.toLowerCase().includes(q) || (r.registry.city || '').toLowerCase().includes(q)));
      const total = rows().filter(r => r.registry).length;
      $('reg').innerHTML = !total ? '<div class="sr-empty">No schools registered yet. Add the schools you work with so staff can be given access before students register.</div>'
        : !reg.length ? `<div class="sr-empty">No registered school matches “${esc(st.regQ)}”.</div>`
        : `<div class="sr-regwrap"><table class="nm-tbl sr-reg"><thead><tr><th>School</th><th>City</th><th>State</th><th class="r">Students</th><th>Part of</th><th class="r" aria-label="Actions"></th></tr></thead><tbody>
          ${reg.map(r => `<tr><td><span class="nmn">${esc(r.name)}</span>${r.registry.active === false ? ' <span class="nm-chip mute">Inactive</span>' : ''}</td>
            <td>${esc(r.registry.city || '')}</td><td>${esc(r.registry.state || '')}</td>
            <td class="r">${r.students ? fmt(r.students) : '<span class="nm-chip mute">None yet</span>'}</td><td>${esc(r.group || '')}</td>
            <td><div class="acts"><button type="button" class="nm-btn sm" data-edit="${r.registry.id}" data-name="${esc(r.name)}" data-city="${esc(r.registry.city || '')}" data-state="${esc(r.registry.state || '')}">Edit</button>
              <button type="button" class="nm-btn sm del" data-del="${r.registry.id}" data-name="${esc(r.name)}" aria-label="Delete ${esc(r.name)}">Delete</button></div></td></tr>`).join('')}
          </tbody></table></div>`;
    }
    function drawAll() { drawStats(); drawSuggestions(); drawList(); drawPanel(); drawRegistry(); }

    // Ticking changes the selection; the kept name follows it until the admin types one.
    function select(keys, on) {
      keys.forEach(k => (on ? st.sel.add(k) : st.sel.delete(k)));
      st.confirming = false;
      const sel = picked();
      if (!sel.length) { st.name = st.group = null; }
      else if (!st.nameTyped || !sel.some(r => r.key === keyOf(st.name))) {
        // Suggest the registered name with the most students, else the name with the most students.
        const best = sel.slice().sort((a, b) => ((b.registry && b.students > 0) - (a.registry && a.students > 0)) || b.students - a.students)[0];
        st.name = best.name; st.group = best.group || ''; st.nameTyped = false;
      }
      el.querySelector('#sr-names').innerHTML = [...new Set([...sel.map(r => r.name), ...rows().filter(r => r.registry).map(r => r.name)])].map(n => `<option value="${esc(n)}">`).join('');
      el.querySelectorAll('[data-key]').forEach(b => { b.checked = st.sel.has(b.dataset.key); const row = b.closest('.sr-row'); row.classList.toggle('on', b.checked); row.setAttribute('aria-selected', String(b.checked)); });
      drawPanel();
    }

    async function load() {
      try {
        st.data = await api('GET', '/api/dashboard/school-names');
        const keys = new Set(rows().map(r => r.key));
        [...st.sel].forEach(k => { if (!keys.has(k)) st.sel.delete(k); });
        el.querySelector('#sr-groups').innerHTML = st.data.groups.map(g => `<option value="${esc(g)}">`).join('');
        drawAll();
      } catch (e) { $('list').innerHTML = `<div class="sr-empty">${esc(e.message)}</div>`; }
    }

    async function submit() {
      const sel = picked(), name = (st.name || '').trim(), group = (st.group || '').trim();
      if (!sel.length || !name) return;
      if (sel.some(r => r.key !== keyOf(name)) && !st.confirming) { st.confirming = true; return drawPanel(); }
      st.busy = true; drawPanel();
      try {
        const r = await api('POST', '/api/dashboard/schools/merge', { names: sel.flatMap(x => x.names), school: name, group });
        window.toast(r.names_merged
          ? `Merged into ${r.school}: ${plural(r.students_moved, 'student record', 'student records')} updated.`
          : `Saved ${r.school}${r.group ? ` as part of ${r.group}` : ''}.`, 'success');
        st.sel.clear(); st.name = st.group = null; st.nameTyped = false; st.confirming = false; st.q = ''; $('q').value = '';
        await load();
        if (typeof NM.reloadContext === 'function') NM.reloadContext();   // the school picker and every page
      } catch (e) {
        window.toast(e.message, 'error'); st.confirming = false;
      } finally { st.busy = false; drawPanel(); }
    }

    el.addEventListener('change', (e) => { const k = e.target.dataset.key; if (k) select([k], e.target.checked); });
    el.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (f === 'q') { st.q = e.target.value.trim(); drawList(); }
      if (f === 'rq') { st.regQ = e.target.value.trim(); drawRegistry(); }
      if (f === 'name' || f === 'group') {
        st[f] = e.target.value; if (f === 'name') st.nameTyped = true;
        if (st.confirming) { st.confirming = false; drawPanel(); el.querySelector(`[data-f="${f}"]`).focus(); return; }
        const go = $('go'), sel = picked(), name = (st.name || '').trim();
        go.disabled = !name; go.textContent = !name ? 'Enter the name to keep' : sel.some(r => r.key !== keyOf(name)) ? `Merge into “${name}”` : 'Save';
      }
    });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-f],[data-filter],[data-sugg],[data-edit],[data-del]'); if (!t) return;
      if (t.dataset.filter) { st.filter = t.dataset.filter; drawList(); return; }
      if (t.dataset.sugg != null) {
        const g = $('sugg')._groups[Number(t.dataset.sugg)] || [];
        st.sel.clear(); st.nameTyped = false; st.q = ''; $('q').value = ''; st.filter = 'all';
        drawList(); select(g.map(r => r.key), true);
        $('panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      if (t.dataset.edit && typeof window.editSchoolReg === 'function') return window.editSchoolReg(Number(t.dataset.edit), t);
      if (t.dataset.del && typeof window.confirmDelSchReg === 'function') return window.confirmDelSchReg(Number(t.dataset.del), t);
      const f = t.dataset.f;
      if (f === 'go') submit();
      if (f === 'clear') { if (st.confirming) { st.confirming = false; drawPanel(); } else { st.sel.clear(); drawList(); select([], false); } }
      if (f === 'add' && typeof window.openSchoolRegModal === 'function') window.openSchoolRegModal();
    });
    el._srReload = load;
    await load();
  };
})();
