/* ════════════════════════════════════════════════════════════════════
   dom-patches.js
   Wraps answer-selection callbacks to call saveState() after each
   interaction. Also wires bootstrap event listeners.

   IMPORTANT: ES module imports are immutable bindings — you cannot
   reassign `seaAns` after `import { seaAns }` like the old monolith
   did. Instead, this file patches the `window.*` exposures (which
   inline onclick="..." attributes in index.html actually call) so
   each user-visible click triggers a saveState() afterward.

   Because main.js does `Object.assign(window, {...})` BEFORE importing
   this file, the originals are guaranteed present on `window` when
   we run.
════════════════════════════════════════════════════════════════════ */

import { saveState } from './state.js';

// Wraps a window-exposed function so it triggers saveState() after running.
function _wrapWithSave(name) {
  const orig = window[name];
  if (typeof orig !== 'function') {
    console.warn('[dom-patches] _wrapWithSave: window.' + name + ' is not a function — skipped.');
    return;
  }
  window[name] = function () {
    const r = orig.apply(this, arguments);
    try { saveState(); } catch (e) { /* swallow — saveState is best-effort */ }
    return r;
  };
}

/* ── installPatches() must be called AFTER Object.assign(window, {...}) in main.js.
   Static ES module imports are hoisted and execute before any module-body code,
   so running _wrapWithSave at module-load time (the old pattern) meant window.*
   functions were not yet set — every wrap silently no-op'd.
   Exporting an explicit init function and calling it after Object.assign fixes this. ── */
function installPatches() {
  [
    'seaAns', 'trySeaNextPage', 'seaPageNav',
    'nmapAns', 'tryNmapNextPage', 'nmapPageNav',
    'cpiSel', 'cpiNav', 'cpiJump',
    'renderDAABSub', 'advanceDAABSub',
    'doRegister',
    'buildResults',
  ].forEach(_wrapWithSave);
  console.log('[NuMind] dom-patches: save-state wrappers installed');
}

export { installPatches };
