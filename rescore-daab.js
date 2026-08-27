#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────
   rescore-daab.js  —  one-off backfill for stale DAAB stanines

   A student scored under the OLD gapped VA/PA/NA/AR norm tables stored a
   stanine of null/0. That plots as a MISSING bar (the empty "Verbal" column)
   and yields a wrong band everywhere the STORED value is read (report tables,
   the AI counsellor panel, Aria's context). The render surfaces now self-heal
   from the raw score, but this script corrects the DATA AT THE SOURCE so no
   read-time heal is needed:

     • assessments.daab_<key>_scores_json   (raw assessment snapshot)
     • report_aptitude.stanine / band        (report snapshot the counsellor reads)
     • report_summary.avg_aptitude_stanine   (recomputed from attempted subtests)

   It re-derives each subtest's stanine from its stored raw score using the
   CURRENT norm tables — it never re-reads answers, so it cannot corrupt data.

   Usage:
     node rescore-daab.js                      # DRY-RUN — list what would change
     node rescore-daab.js --commit             # apply the corrections
     node rescore-daab.js --commit --email a@b.com   # limit to one student
     node rescore-daab.js --commit --gender f        # limit to one gender

   Always run the dry-run first and eyeball the "X -> Y" lines before --commit.
   ──────────────────────────────────────────────────────────────────────── */
(async () => {
  const argv     = process.argv.slice(2);
  const commit   = argv.includes('--commit');

  // Read a flag's value, rejecting a missing value or another flag. Without this
  // a typo like `--commit --email` (address omitted) would leave email
  // undefined, which db.js treats as "no filter" — silently committing across
  // EVERY student instead of the one intended.
  function flagValue(name, example) {
    const i = argv.indexOf(name);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error('[rescore-daab] ERROR: ' + name + ' requires a value (e.g. ' + name + ' ' + example + ').');
      process.exit(2);
    }
    return v;
  }

  const email  = flagValue('--email', 'someone@example.com');
  const gender = flagValue('--gender', 'f');

  console.log('[rescore-daab] mode=' + (commit ? 'COMMIT' : 'DRY-RUN') +
    (email  ? ' email='  + email  : '') +
    (gender ? ' gender=' + gender : ''));

  // Required after argument validation so a bad flag fails fast without opening
  // a DB connection, and a module/driver problem reports cleanly.
  let db;
  try {
    db = require('./db.js');
  } catch (e) {
    console.error('[rescore-daab] Could not load db.js:', e && e.message ? e.message : e);
    console.error('[rescore-daab] Run this from the project root with dependencies installed.');
    process.exit(1);
  }

  try {
    const res = await db.rescoreDaabStanines({ commit, email, gender });
    console.log('[rescore-daab] summary:', JSON.stringify(res));
    if (!commit && res.subtestsChanged > 0) {
      console.log('[rescore-daab] Re-run with --commit to apply these ' +
        res.subtestsChanged + ' correction(s).');
    }
    try { await db.close(); } catch (_) {}
    process.exit(0);
  } catch (e) {
    console.error('[rescore-daab] FAILED:', e && e.message ? e.message : e);
    try { await db.close(); } catch (_) {}
    process.exit(1);
  }
})();
