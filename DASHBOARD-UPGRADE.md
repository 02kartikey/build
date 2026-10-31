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
- `css/dashboard-theme.css` (browser): the shared dashboard design (type, colour, spacing, components). Linked by all three dashboards after their own styles.
- The dashboards no longer use emoji in headings, buttons or labels.
- `DASHBOARD-UPGRADE.md`: this file.

**Changed**
- `dashboard-db.js`, `dashboard-api.js`, `db.js`, `counsellor-db.js`, `access-login-handler.js`, `match-utils.js`, `pg-core.js`, `server.js`
- `js/engine/cpi.js`, `js/pdf/download.js`, `js/dashboard-report-pdf.js`, `js/router.js`, `js/state.js`, `js/ai-counsellor.js`
- `index.html`, `dashboard-admin.html`, `dashboard-management.html`, `dashboard-counsellor.html`
- `check-syntax.js`

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

Both AI features use the existing `OPENAI_API_KEY`.

**New API route:** `GET /api/dashboard/school-summary` returns, for each school the user can see, completion against that school's target and the same figures per class, plus the follow-up groups those counts use. It respects class and section limits. Without a key the AI parts say so. The alerts, lists and charts still work.

## Behaviour changes staff will notice

- **AI analysis runs only on request, in the background.** Opening a dashboard shows the last analysis for the chosen metrics, marked when the numbers have changed since. Pressing Analyse starts the analysis on the server and the page checks back every few seconds until it is ready, so a slow model call can never fail the page's own request. If the AI fails, the card says so with a "Try again" link.
- **Overview layout.** Each dashboard's overview is: the headline numbers; two cards side by side, "What needs attention" (live alerts, one row per issue, each opening to its detail) and "AI analysis"; then one card with tabs for Progress, Schools, Classes, Results and Year on year. Schools below their target are one row with a table inside, with schools of fewer than 5 students folded into one line, so a long list of small or mistyped school names never fills the page. The same fold is used on the Schools tab, the All schools page and Analytics.
- **Scheduled reminders are now real.** The admin page used to keep schedules in the browser only and never sent anything. Schedules are now stored on the server and run by it (checked every 5 minutes, sent at the chosen hour in `APP_TIMEZONE`). Each run uses the creator's own schools and class limits, skips students reminded within the schedule's interval, and logs every email to the Reminder Log. Without SMTP settings the page says so and nothing is sent.
- **The assistant can now do the work, not just answer.** It prepares any of these as a card the user checks, edits and confirms: open a list, profile or page; send reminders; download reports; add a student; upload a CSV roster; change a student's class, section, school or Unique School ID; issue a new access code; add a note or a follow-up task; set targets; create a scheduled reminder; and for admins, add a school or a staff account. It cannot delete, reset or remove anything. Each card calls the same API route as the dashboard's own buttons, so the same permissions apply. Names, emails, IDs and passwords are typed into the card, never sent to the AI; what a confirmed action did is remembered in the conversation (with names replaced by codes). New read tools let it summarise every school and class, recent reminders, schedules, follow-up tasks and (for admins) pending student queries and recent imports.
- **Wellbeing support is always split into its three areas** (Social, Emotional, Academic adjustment) and by class: the "What needs attention" row, the wellbeing card, Results, the Schools tab, Schools & classes, Needs follow-up, the student profile, the AI analysis and the assistant. Every number opens its students. A student who needs support in two areas is counted in both. Reports from an earlier version of the wellbeing test, which used other areas, are kept apart as "Earlier version" rather than guessed into one of the three. The student report PDF already showed the three areas and is unchanged.
- **Expand button** on the assistant opens it as a large panel; the choice is remembered.
- **Follow-up tasks are stored on the server.** Counsellors' existing tasks in the browser are moved over automatically the first time they open the page.
- **Test Email page removed** (admin). Email delivery is verified by the first reminder sent; failures are logged on the server.
- **Class and section limits apply everywhere.** A user limited to certain classes or sections sees only those students in every number, list, trend, timing figure, reminder and journey, and in the assistant, and can only add or edit students in those classes.
- **Emails stay with their school.** Adding or importing a student with an email already used at another school is refused instead of moving that student.

- **Alerts have moved.** The red and blue banners on the Management dashboard are now the "What needs attention" card on every overview. Each alert is broken down by class and opens its students.
- **Targets are settings.** "80%" and "3 days" are no longer fixed in the page code. Admins can set the network-wide default and per-school values. Management can set values for their own schools. Counsellors can see the values but not change them.
- **"At-Risk" is now "Needs follow-up".** It lists four reasons:
  - **Report not generated:** all four parts answered, but no report.
  - **Stalled:** started, but no progress saved for the follow-up period.
  - **Overdue to start:** registered, but nothing answered yet.
  - **Wellbeing support:** completed, with a wellbeing area that needs support.
- **The career chart counts every completed student.** You can switch it between career-interest area and subject stream. The old chart grouped students by free-text career names and kept only the top 20, which is why it added up to fewer than the number completed.
- **The trend starts at Week 1** (the week of the first registration) and shows every week, including quiet ones. Staff can switch to a daily view or pick a date range.
- **Bulk download.** Any student list can be downloaded as a ZIP of the same PDF students receive. Students without a generated report are skipped and counted.
- **Smaller report PDFs.** Every report PDF, including the one students download themselves, is now compressed: about 0.5 MB instead of about 13 MB. Rendering takes about 2.5 seconds per report in the browser, so a 650-student ZIP takes roughly 25–30 minutes. The progress box shows where it is and can be cancelled.
- **Reminders to any list** resolve email addresses on the server (`session_ids`). Students without an email are reported as skipped. The old limit of 2,000 students is gone.
- **Forgot password** no longer returns the reset token to the browser. If SMTP is not configured, the token is written to the server log for an administrator.

- **New design.** All three dashboards use the NuMind logo, the Figtree typeface and one shared stylesheet. The overview is split into sections (Summary, Progress, Schools, Classes, Results, Year on year) with an in-page menu, and each section has a "Summarise with AI" button that writes a short summary of just that section.
- **Schools & classes page.** Lists each school with completion against its own target and a class-by-class table; every number opens its students, and each school has its own AI summary.
- **School switcher.** Staff with more than one school can switch every panel on the overview between all schools and a single school.

## Checks to run after deploy

1. `npm run test:syntax`
2. Sign in to each dashboard. Click the Completed card: the list count must equal the number on the card.
3. Open the class-wise breakdown and click any cell. The list count must equal the number in the cell.
4. Download a ZIP of 3–5 completed students and open one PDF.
5. Import a CSV with an `admission_no` column, then sign in on the student page with school + access code + that ID.
7. Press Analyse on the overview: the card should show "Analysing…" and then the analysis within about a minute.
8. On Scheduled reminders, create a schedule and check it shows a next run time; after that time, the Reminder Log should list the emails.
6. Open Schools & classes, switch school, and click a class cell: the list count must equal the cell.
