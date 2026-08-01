# Fix: Class dropdown can now match imported students (5 files, build R3)

## Root cause of "can't select Your Name"
Your dashboard screenshot shows the student's class is "10-B". The entry form's Class
dropdown was hardcoded to Grade 9 / 10 / 11 / 12. The names lookup requires an EXACT
class match — so any student imported with a free-text class ("10-B", "Class 10 DS")
was permanently unreachable from the access-code form. Not a loading bug this time;
a design mismatch between free-text import and a fixed dropdown.

## The fix — Class options now come from the server
- dashboard-db.js  — new listAccessClasses(school): distinct classes for that school
  that have code-holding students (same case/whitespace-tolerant matching as names).
- dashboard-api.js — /api/student-access/names with NO class param now returns
  { classes:[...] } (same public rate limit); with class it returns names as before.
- router.js        — new loadAccessClasses(): typing/leaving the School field fetches
  that school's real classes and rebuilds the dropdown; picking one loads names.
  Clear error if the school has no code-holding students ("check the spelling").
- index.html       — school field triggers loadAccessClasses; hardcoded Grade options
  removed; the function added to the pre-module shim (same protection as the others).
- main.js          — import + _m_ registration + window export for the shim.

## Verified live against real PostgreSQL (your exact scenario)
Imported "Nu Mind" class "10-B" and "Second Kid" class "Class 10 DS" under school
"july", then:
  classes for july            -> ["10-B","Class 10 DS"]
  classes for "  JULY  "      -> same (case/space tolerant)
  names for july + 10-B       -> ["Nu Mind"]
  redeem Nu Mind + real code  -> 200, session issued
Zero server errors.

## Deploy (build stamp bumped to R3 so you can verify)
Copy: index.html -> web root; main.js + router.js -> the js/ folder (wherever the
current ones live); dashboard-api.js + dashboard-db.js -> server folder.
Then: pm2 restart (or re-run node server.js) -> Ctrl+Shift+R.
Console must print BOTH:  [NuMind] ... build: NM-BUILD-2026-08-01-R3  (index + main).
R2 or nothing = stale file — same diagnosis method as before.
