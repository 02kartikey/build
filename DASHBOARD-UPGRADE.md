# Dashboard upgrade — deploy notes

This release adds the following to the Admin, Management and Counsellor dashboards:

- the assistant
- an AI analysis card and live "What needs attention" alerts
- drill-downs from every number
- class-wise breakdowns
- year-on-year journeys
- a programme trend that starts at Week 1
- bulk report ZIPs
- editable completion targets
- a Schools & classes page with a school switcher
- a refreshed design with the NuMind logo
- the Unique School ID across sign-in, registration, bulk import and the dashboards

## Files

**New**
- `dashboard-assistant.js` (server): the AI analysis and the assistant.
- `js/dashboard-common.js` (browser): shared panels, drill-down lists, glossary and the assistant widget. All three dashboards load it in `<head>`.
- `js/dashboard-flow.js` (browser): the drill-down Dashboard page. All three dashboards load it after `dashboard-common.js`.
- `js/dashboard-insights.js` (browser): the Insights page, built the same way on all three dashboards. Loaded after `dashboard-common.js`.
- `js/school-registry.js` (browser): the admin's School registry page (merge school names, likely duplicates, registered schools). Loaded by the Admin console only.
- `css/dashboard-theme.css` (browser): the shared dashboard design (type, colour, spacing, components). Linked by all three dashboards after their own styles.
- The dashboards no longer use emoji in headings, buttons or labels.
- `DASHBOARD-UPGRADE.md`: this file.

**Changed**
- `dashboard-db.js`, `dashboard-api.js`, `db.js`, `counsellor-db.js`, `access-login-handler.js`, `match-utils.js`, `pg-core.js`, `server.js`
- `js/engine/cpi.js`, `js/pdf/download.js`, `js/dashboard-report-pdf.js`, `js/router.js`, `js/state.js`, `js/ai-counsellor.js`
- `index.html`, `dashboard-admin.html`, `dashboard-management.html`, `dashboard-counsellor.html`
- `check-syntax.js` (now also loads every server module, and fails on a missing file), `package.json` (`npm test` runs it; scripts pointing at files that do not exist are removed; `dotenv` moved to dependencies because the server loads it at start), `package-lock.json`
- `ci.yml`: a working CI workflow (PostgreSQL 16 service, `npm ci`, `npm test`, start-up and smoke test). Save it as `.github/workflows/ci.yml` to enable it.
- `ecosystem.config.js`, `render.yaml`: comments only

Deploy all of these together. The HTML depends on the new API routes, and the routes depend on the new tables.

## Database

The new tables and indexes are created automatically on start by `pg-core.js`. They use `CREATE … IF NOT EXISTS`, so you don't need to run a migration by hand.

| Table | Purpose |
|---|---|
| `dashboard_settings` | Completion target and follow-up days. One network-wide row, plus optional per-school rows. |
| `ai_insights_cache` | AI analyses, keyed by a fingerprint of the data. Pruned after 30 days. |
| `dashboard_chat` | Assistant conversations, stored per staff user. |
| `reminder_schedules` | Scheduled reminder campaigns (who, which school, how often, what to say), with their last and next run. |
| `followup_tasks` | Each staff member's own follow-up tasks (was stored only in the counsellor's browser). |
| `school_merges` | Each school name an admin merged away (normalised: case, spaces and punctuation ignored) and the school it was merged into. A trigger on `students` (`trg_students_school_merge`) files any later registration, import or edit typed with that name under the merged school; access-code sign-in accepts the old name too. |
| `school_groups` | A school that is one branch of a larger school ("ABPS Baga" is part of "Aditya Birla Public School"). The Dashboard shows the larger school, then its branches. |

If the earlier `school_branch_map` table exists, its links are copied into `school_groups` on start and the table is dropped. Schema creation takes an advisory lock, so several workers starting together do not collide.

It also adds the column `students.student_uid` and a partial unique index `uq_students_school_uid_v2`, so a Unique School ID can be used once per school. For this rule, school names ignore case, spaces and punctuation, and IDs ignore case and spaces ("ADM 1024" and "adm1024" are the same ID; "/" and "-" count). Letters in other scripts are kept, so two Hindi-named schools never collide. The comparison uses `COLLATE "C"`, so it behaves the same whatever the database locale. The column is new and starts empty, so the index builds without conflicts on existing data.

On first start, worker 0 backfills journey history in the background.

**Unique School ID**
- Bulk import recognises any of these column names: `student_uid`, `unique_school_id`, `unique_id`, `uid`, `student_id`, `school_id`, `school_student_id`, `admission_no`, `admission_number`, `enrolment_no`, `enrollment_no`, `enrolment_number`, `enrollment_number`.
- An import row is matched to an existing student by Unique School ID first, then email, then school + class + name. Two students with the same name but different IDs stay separate. If a row matches by email or name but carries a different ID from the one stored, the stored ID is kept and the import reports a warning.
- An import row is refused, with a reason, when: its ID belongs to a student with a different name at that school (a typo, or an ID someone else registered with); the same ID is given to two different students in one file; or its email belongs to a student at another school. Nothing is overwritten in these cases. Each row is saved on its own, so one bad row never undoes the rest.
- Admins can enter the ID when adding a student and add or change it from the student's profile. Using an ID another student at that school already has, or moving a student to a school where their ID is taken, is refused (409).
- Students with an access code can sign in with school + access code + either class and name, or their Unique School ID. The school is matched as forgivingly as in the class-and-name sign-in. The access-code rate limits apply to both, counted per student whatever spelling of the school is typed.
- Self-registration has an optional Unique School ID field. If another student at the same school has already registered with it, registration is refused (409) with a message asking them to check with their school.
- Dashboard search, drill-down lists, CSV exports and the student profile show and search the ID. Report PDFs do not show it.

Pre-release test builds linked email-less students by school and name (`nat:` identities). On start, any such rows are turned into stand-alone attempts.

**How assessments are linked across years**
1. Email and name: an assessment is linked to earlier ones with the same email only when the student name also matches. A different name on the same email (for example siblings sharing a parent's email) is not linked by email.
2. Unique School ID: otherwise, if the student has an ID and that school already has a record with the ID, the assessment is linked to that record's history.
3. Otherwise the assessment stands on its own. Students are never linked by name alone.

Staff can also unlink a wrong match from the student's profile.

**Assistant privacy**
- Student names, emails, Unique School IDs and session IDs are never sent to OpenAI. The assistant replaces them with codes such as `S-4F9A2C01B7` before anything leaves the server, and puts the names back only in the reply shown to the staff member. School and class names are sent.
- What is filtered: full names in any case; a first name or surname typed on its own when it starts with a capital letter (it becomes an `N-` code the server searches with); any email address; Unique School IDs, with or without spaces (IDs shorter than 5 characters only after words like "ID" or "no."); long hex IDs. The filter also runs over every tool result and over earlier messages each time a conversation continues. Limits: a lower-case first name on its own, or a name of a student outside the user's schools, is not recognised as a name.
- The codes are signed with a key that is generated on first use and stored in `dashboard_settings` (scope `system:assistant_pii_key`). Keep that row; if it is deleted, a new key is made and older conversations show codes instead of names in the AI's own words (what the user saw is stored separately and is unaffected).
- Each staff member's assistant reads only the schools, classes and sections they are allowed to see, and only suggests actions; reminders and downloads happen only after they confirm in the dashboard.

## Environment variables

All are optional. The defaults are shown.

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_COMPLETION_TARGET_PCT` | `80` | Starting completion target until someone saves one on the dashboard. |
| `DEFAULT_FOLLOW_UP_DAYS` | `3` | Days without progress before a student counts as "stalled" or "overdue to start". |
| `APP_TIMEZONE` | `Asia/Kolkata` | Time zone for week and day buckets in the trend. |
| `JOURNEY_CHANGE_POINTS` | `5` | Change in Integrated Fit Score that counts as "improved" or "declined". |
| `DASHBOARD_INSIGHTS_MODEL` | `AI_MODEL` | OpenAI model for the AI analysis and section summaries. |
| `DASHBOARD_ASSISTANT_MODEL` | `AI_MODEL` | OpenAI model for the assistant. |
| `INSIGHTS_MAX_PER_HOUR` | `60` | AI analyses a user can request per hour. Loading the page never calls the AI. |
| `INSIGHTS_REGEN_MAX` | `30` | Forced regenerations per user per hour. |
| `ASSISTANT_MAX_PER_HOUR` | `120` | Assistant messages per user per hour. |
| `SCHEDULES_PER_USER_MAX` | `20` | Reminder schedules one user may have. |
| `SMALL_SCHOOL_MAX_STUDENTS` | `5` | Schools with fewer registered students than this are folded into one line in "What needs attention". |
| `ACADEMIC_YEAR_START_MONTH` | `4` | Month (1–12) the academic year starts, in `APP_TIMEZONE`. A student belongs to the year they registered in; 2026 means 2026–27. |
| `ACCESS_SCHOOLS_MAX` | `600` | School-name lookups per hour from one network on the student access-code form. |
| `ACCESS_NAMES_MAX` | `1200` | Student-name lookups per hour from one network on the access-code form. |
| `ACCESS_REDEEM_MAX` | `8` | Access-code sign-in attempts per hour for one student. |
| `ACCESS_REDEEM_IP_MAX` | `600` | Access-code sign-in attempts per hour from one network. |

Both AI features use the existing `OPENAI_API_KEY`.

**New API route:** `GET /api/dashboard/school-summary` returns, for each school the user can see, completion against that school's target and the same figures per class, plus the follow-up groups those counts use. It respects class and section limits. Without a key the AI parts say so. The alerts, lists and charts still work.

**Drill-down routes (all roles, scoped as usual):**
- `GET /api/dashboard/flow?year=` returns schools, their branches with registered, completed, in progress, not started and completion against target, and the academic years on record.
- `breakdown`, `drill`, `alerts` and `school-summary` also accept `org` and `branch` (a school or group, and one of its branches) and `year`. `drill` now returns `by_class` (the matching students per class), SEAA area scores and the parts each student has finished.
- `GET /api/dashboard/school-names` (admin only) lists every school name on record (student spellings and registered schools, one row per normalised name) with its students, its registry entry and its group, plus groups of names that look like one school (a typo apart, or equal once words like "branch" or "school" are dropped) for the admin to review.
- `GET /api/dashboard/pulse` (all roles, scoped as usual) returns the last 7 days against the 7 before (registrations, completions, active students), completions per week for 12 weeks, the completions still needed for each school's target and when they will be reached at the last 4 weeks' pace, how many students finished each part, the SEAA levels and areas, and reminders sent to these students in the last 30 days. A completion is dated by its report, as in the trend chart.
- `school-summary` also returns `completed_recent`: reports completed in the last 7 days per school.
- `POST /api/dashboard/schools/merge` (admin only; body `names`, `school`, optional `group`) merges up to 500 names into one school in a single transaction: student records, staff school access, the registry, scheduled reminders and per-school settings all move to the kept name. It is refused (409, naming the students) if two students would end up sharing a Unique School ID. Each merge is in the Audit log. It cannot be undone.
- New analytics dimension `gender`; every breakdown now also returns, per group, how many completed (`totals.completed`).
- New analytics dimensions: `parameters` (which of Personality, Aptitude, Career interest and SEAA each student has finished) and `seaa_concern` (Social only, Emotional only, Academic only, the three pairs, all three, or none). Need intervention is one or two areas; Critical is all three.

## Behaviour changes staff will notice

- **Roster imports over 2,000 rows are refused** with a message to split the file (they were cut at 2,000 without saying so). The page checks this before uploading.
- **The AI analysis no longer reports "numbers changed" when they have not.** Its fingerprint of the numbers is now independent of the order rows come back from the database, so an unchanged analysis is reused instead of being marked stale (and paid for again). After this deploy each view is fingerprinted once more, so the first Analyse writes a fresh one.
- **Long student lists page reliably.** Students with the same class, section and name are ordered by their record id, so no one appears on two pages or is skipped.
- **Saving a report no longer overwrites registration details.** A field the browser sends empty when the report is saved (school, class, name …) keeps the value from registration.

- **New Dashboard page (all three dashboards).** A step-by-step path: all schools (headline numbers, completion donut, school-wise status against target) → a school, or for a school with branches, its branch-wise status and then a branch (numbers, completion by class, one card per parameter) → a parameter (class-wise completion, the profile as a donut, the class-by-group table; for SEAA, Need intervention, Critical and No significant concern) → a group (count, grade-wise distribution, and the student list with Unique School ID, class, adjustment areas, SEAA scores out of 20 and View report). Breadcrumbs go back any number of steps. An academic-year picker sits at the top and defaults to the current year; the school comes from the top-bar picker. "Export or act on list" opens the usual list with CSV export, reminders and ZIP download.
- **Insights is one shared page** on all three dashboards, top to bottom: the headline numbers; **This week** (completions with a 12-week bar chart, new registrations and active students against the week before, and when the target will be reached at the current pace); "What needs attention" and "AI analysis"; **How far students get** (students who finished each part) and **Wellbeing at a glance** (Need intervention, Critical, and each area); then tabs for Progress (trend, stalled students, students not started), Schools (every school against its target, with this week's completions), Classes, Results, Wellbeing (by class and the students who need support), Year on year and Participation (gender, time per part, reminders sent). Each tab has "Summarise with AI". Staff with several schools can download a schools summary as CSV.
- **One school picker.** The "Showing" picker in the top bar is the only school filter, and every page follows it, including the Dashboard and Schools & classes. The Dashboard keeps only its academic-year picker.
- **Pages removed because they repeated others:** All schools and Analytics (Admin), School reports and School comparison (Management), My stats (Counsellor). Their numbers are on the Dashboard (school-wise status), Schools & classes, and Insights.
- **School registry** (Admin). A summary line; **Merge school names**, with likely duplicates offered for review in one click: tick the names that are one school, choose the name to keep and merge, optionally saying which larger school it is a branch of (a school with no group is simply its own school on the Dashboard); and **Registered schools** with students per school, search, edit and delete.
- **The registered list no longer fills itself.** Opening it used to add every name students had typed, misspellings included. Now it holds only the schools admins add or keep by merging; the names students typed are listed separately under Merge school names.
- **Dashboard parameter cards** (Personality, Aptitude, Career interest, SEAA) now appear for all schools and for a school, not only for one branch, and open that parameter's analysis across everything in view.
- **Student lists** show 50 students per page.
- **SEAA counts** use students with a generated report, as the SEAA classification is part of the report. The SEAA card on a branch counts students who finished the SEAA part, which can be more.
- **Assistant** has a new `get_branches` tool (branch progress and SEAA Need intervention / Critical per branch) and can open the Dashboard or Insights page.

- **AI analysis runs only on request, in the background.** Opening a dashboard shows the last analysis for the chosen metrics, marked when the numbers have changed since. Pressing Analyse starts the analysis on the server and the page checks back every few seconds until it is ready, so a slow model call can never fail the page's own request. If the AI fails, the card says so with a "Try again" link.
- **Insights layout.** Schools below their target are one row in "What needs attention" with a table inside, with schools of fewer than 5 students folded into one line; for admins that line links to Merge schools, since a tiny school is usually one typed differently.
- **Scheduled reminders are now real.** The admin page used to keep schedules in the browser only and never sent anything. Schedules are now stored on the server and run by it (checked every 5 minutes, sent at the chosen hour in `APP_TIMEZONE`). Each run uses the creator's own schools and class limits, skips students reminded within the schedule's interval, and logs every email to the Reminder Log. Without SMTP settings the page says so and nothing is sent.
- **The assistant can now do the work, not just answer.** It prepares any of these as a card the user checks, edits and confirms: open a list, profile or page; send reminders; download reports; add a student; upload a CSV roster; change a student's class, section, school or Unique School ID; issue a new access code; add a note or a follow-up task; set targets; create a scheduled reminder; and for admins, add a school or a staff account. It cannot delete, reset or remove anything. Each card calls the same API route as the dashboard's own buttons, so the same permissions apply. Names, emails, IDs and passwords are typed into the card, never sent to the AI; what a confirmed action did is remembered in the conversation (with names replaced by codes). New read tools let it summarise every school and class, recent reminders, schedules, follow-up tasks and (for admins) pending student queries and recent imports.
- **Wellbeing support is always split into its three areas** (Social, Emotional, Academic adjustment) and by class: the "What needs attention" row, the Wellbeing tab on Insights, Schools & classes, Needs follow-up, the student profile, the AI analysis and the assistant. Every number opens its students. A student who needs support in two areas is counted in both. Reports from an earlier version of the wellbeing test, which used other areas, are kept apart as "Earlier version" rather than guessed into one of the three. The student report PDF already showed the three areas and is unchanged.
- **Expand button** on the assistant opens it as a large panel; the choice is remembered.
- **Follow-up tasks are stored on the server.** Counsellors' existing tasks in the browser are moved over automatically the first time they open the page.
- **Test Email page removed** (admin). Email delivery is verified by the first reminder sent; failures are logged on the server.
- **Class and section limits apply everywhere.** A user limited to certain classes or sections sees only those students in every number, list, trend, timing figure, reminder and journey, and in the assistant, and can only add or edit students in those classes.
- **Emails stay with their school.** Adding or importing a student with an email already used at another school is refused instead of moving that student.

- **Alerts have moved.** The red and blue banners on the Management dashboard are now the "What needs attention" card on Insights. Each alert is broken down by class and opens its students.
- **Targets are settings.** "80%" and "3 days" are no longer fixed in the page code. Admins can set the network-wide default and per-school values. Management can set values for their own schools. Counsellors can see the values but not change them.
- **"At-Risk" is now "Needs follow-up".** It lists four reasons:
  - **Report not generated:** all four parts answered, but no report.
  - **Stalled:** started, but no progress saved for the follow-up period.
  - **Overdue to start:** registered, but nothing answered yet.
  - **Wellbeing support:** completed, with a wellbeing area that needs support.
- **The career chart counts every completed student.** You can switch it between career-interest area and subject stream. The old chart grouped students by free-text career names and kept only the top 20, which is why it added up to fewer than the number completed.
- **The trend counts from Week 1** (the week of the first registration) and shows every week, including quiet ones. It opens on the last 12 weeks; staff can switch to the last 6 months or the whole programme, and to a daily view.
- **Bulk download.** Any student list can be downloaded as a ZIP of the same PDF students receive. Students without a generated report are skipped and counted.
- **Smaller report PDFs.** Every report PDF, including the one students download themselves, is now compressed: about 0.5 MB instead of about 13 MB. Rendering takes about 2.5 seconds per report in the browser, so a 650-student ZIP takes roughly 25–30 minutes. The progress box shows where it is and can be cancelled.
- **Reminders to any list** resolve email addresses on the server (`session_ids`). Students without an email are reported as skipped. The old limit of 2,000 students is gone.
- **Forgot password** no longer returns the reset token to the browser. If SMTP is not configured, the token is written to the server log for an administrator.

- **New design.** All three dashboards use the NuMind logo, the Figtree typeface and one shared stylesheet.
- **Schools & classes page.** Lists each school with completion against its own target and a class-by-class table; every number opens its students, and each school has its own AI summary.
- **School switcher.** Staff with more than one school can switch every page between all schools and a single school.

## Checks to run after deploy

1. `npm test` parses every script and loads every server module.
2. Sign in to each dashboard. On the Dashboard, click Completed: the list count must equal the number on the card. Open a branch, then SEAA, then Critical: the grade-wise table must add up to the count, and the student list must match.
3. On Insights, open the Classes tab and click any cell. The list count must equal the number in the cell.
4. Download a ZIP of 3–5 completed students and open one PDF.
5. Import a CSV with an `admission_no` column, then sign in on the student page with school + access code + that ID.
6. Open Schools & classes, switch school, and click a class cell: the list count must equal the cell.
7. Press Analyse on Insights: the card should show "Analysing…" and then the analysis within about a minute.
8. On Scheduled reminders, create a schedule and check it shows a next run time; after that time, the Reminder Log should list the emails.
9. In School registry → Merge duplicate school names, search a school, tick two of its spellings and merge them: the Dashboard and the school picker show one school at once, and a student who signs in with the old spelling still gets in.
