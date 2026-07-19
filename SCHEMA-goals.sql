-- ────────────────────────────────────────────────────────────────
-- Aria goals feature — add inside pg-core.js initSchema(), alongside the
-- other CREATE TABLE IF NOT EXISTS statements (e.g. just after reminder_log).
-- Idempotent: safe to run on every boot and on existing databases.
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS student_custom_context (
  session_id TEXT PRIMARY KEY,
  fields     JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_milestones (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  detail           TEXT,
  target_date      DATE,
  status           TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'completed'
  source           TEXT NOT NULL DEFAULT 'aria',      -- 'aria' | 'student'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ                         -- set when the due-date email is claimed/sent
);
CREATE INDEX IF NOT EXISTS idx_sm_session ON student_milestones(session_id);
CREATE INDEX IF NOT EXISTS idx_sm_status  ON student_milestones(session_id, status);
CREATE INDEX IF NOT EXISTS idx_sm_due     ON student_milestones(status, target_date) WHERE reminder_sent_at IS NULL;

-- For databases created before reminder_sent_at existed:
ALTER TABLE student_milestones ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
