/* ════════════════════════════════════════════════════════════════════
   counsellor-goals-reminders.js — NuMind MAPS
   --------------------------------------------------------------------
   Scheduled email reminders for milestones that have reached their
   target date. Cluster-safe: claimDueMilestoneReminders() atomically
   stamps each milestone (FOR UPDATE SKIP LOCKED), so with N PM2 workers
   each due milestone is emailed exactly once. As extra insurance, the
   scheduler only runs on worker 0 (PM2 sets NODE_APP_INSTANCE).

   Wire in server.js, inside the server.listen(...) callback (after _prewarm):

     require('./counsellor-goals-reminders.js').startReminderScheduler({
       emailFn: _emailFn,   // null when SMTP is unconfigured → scheduler stays off
       log,
     });

   Email delivery matches the rest of the app (best-effort via _emailFn). On a
   send failure the claim is released so the next sweep retries.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const goals = require('./counsellor-goals-db.js');

function _text(m) {
  const when = m.target_date ? ' (target ' + m.target_date + ')' : '';
  return (
    'Hi ' + m.firstName + ',\n\n' +
    'A quick nudge from Aria, your NuMind MAPS counsellor.\n\n' +
    'A milestone you set is now due' + when + ':\n' +
    '  \u2022 ' + m.title + '\n' +
    (m.detail ? '    ' + m.detail + '\n' : '') +
    '\nOpen Aria to mark it done or talk through your next step. You\u2019ve got this!\n\n' +
    '\u2014 Aria\n'
  );
}

/* Runs one sweep. Returns { sent, failed }. Safe to call from any worker. */
async function runReminderSweep(emailFn, log) {
  if (typeof emailFn !== 'function') return { sent: 0, failed: 0, skipped: 'no_email_fn' };

  let due;
  try {
    due = await goals.claimDueMilestoneReminders(200);
  } catch (e) {
    if (log && log.error) log.error('[milestone-reminders] claim failed:', e.message);
    return { sent: 0, failed: 0, error: e.message };
  }
  if (!due.length) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const m of due) {
    try {
      await emailFn({ to: m.email, subject: 'A milestone you set is due \u2014 ' + m.title, text: _text(m) });
      sent++;
    } catch (e) {
      failed++;
      try { await goals.unclaimReminder(m.id); } catch (_) {}
      if (log && log.warn) log.warn('[milestone-reminders] send failed for milestone', m.id, e.message);
    }
  }
  if ((sent || failed) && log && log.info) log.info('[milestone-reminders] sent=' + sent + ' failed=' + failed);
  return { sent, failed };
}

/* Starts the recurring scheduler on a single worker. Returns the interval
   handle (or null when disabled). */
function startReminderScheduler(opts) {
  opts = opts || {};
  const emailFn = opts.emailFn;
  const log = opts.log;
  const intervalMs = opts.intervalMs || 60 * 60 * 1000; // hourly

  if (typeof emailFn !== 'function') {
    if (log && log.info) log.info('[milestone-reminders] disabled (SMTP not configured)');
    return null;
  }

  // PM2 cluster: only worker 0 schedules. NODE_APP_INSTANCE is unset outside PM2.
  const inst = process.env.NODE_APP_INSTANCE;
  if (inst != null && inst !== '0') {
    if (log && log.info) log.info('[milestone-reminders] worker ' + inst + ' not scheduling (worker 0 owns it)');
    return null;
  }

  const tick = () => { runReminderSweep(emailFn, log).catch(() => {}); };
  const handle = setInterval(tick, intervalMs);
  if (handle.unref) handle.unref(); // never keep the process alive just for this
  // First run shortly after boot, not during it.
  setTimeout(tick, 30 * 1000);

  if (log && log.info) log.info('[milestone-reminders] scheduler started (every ' + Math.round(intervalMs / 60000) + 'm)');
  return handle;
}

module.exports = { runReminderSweep, startReminderScheduler };
