-- Priority Case Briefing System — Schema Migration
-- Created: 2026-04-23
-- Purpose: Adds priority metadata + tags to cases, and audit/prefs tables for daily briefing service.

BEGIN;

-- ============================================================================
-- 1. Priority metadata on cases
-- ============================================================================

-- priority enum (low|normal|high|urgent) already exists; we only use normal/high.
-- priority_reason: why was this case flagged?
ALTER TABLE cases ADD COLUMN IF NOT EXISTS priority_reason text;

COMMENT ON COLUMN cases.priority_reason IS
  'Why this case is high priority. Values: manual, stuck_3d, sla_breach, unanswered_client, error_tag, long_running_45d, vip_tag';

-- priority_set_at: when the flag was raised (for audit + staleness math).
ALTER TABLE cases ADD COLUMN IF NOT EXISTS priority_set_at timestamptz;

COMMENT ON COLUMN cases.priority_set_at IS
  'Timestamp when priority was set to high. Null if never raised.';

-- tags: freeform labels applied to a case (error, issue, vip, referred, etc.)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[];

COMMENT ON COLUMN cases.tags IS
  'Freeform tags. Used by priority-briefing rules R4 (error|issue) and R6 (vip|referred).';

-- Index to make priority sweeps fast
CREATE INDEX IF NOT EXISTS idx_cases_priority_active
  ON cases (priority)
  WHERE is_archived = false AND status = 'active';

-- GIN index for tag queries
CREATE INDEX IF NOT EXISTS idx_cases_tags ON cases USING GIN (tags);

-- Speed up the "last outbound client contact per case" lookup
CREATE INDEX IF NOT EXISTS idx_activity_log_case_outbound
  ON activity_log (entity_id, created_at DESC)
  WHERE entity_type = 'case'
    AND action IN ('whatsapp_message_sent', 'message_sent_email', 'whatsapp_template_sent');

-- Speed up the "last stage change per case" lookup via case_stage_history
-- (case_stage_history uses created_at as the change timestamp)
CREATE INDEX IF NOT EXISTS idx_case_stage_history_case_created
  ON case_stage_history (case_id, created_at DESC);

-- ============================================================================
-- 2. Briefings audit log
-- ============================================================================

CREATE TABLE IF NOT EXISTS priority_briefings_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  run_date date NOT NULL DEFAULT CURRENT_DATE,
  job_type text NOT NULL CHECK (job_type IN ('morning_brief', 'escalation_sweep', 'ceo_rollup', 'health_check')),
  recipient_user_id uuid REFERENCES users(id),
  recipient_channel text NOT NULL CHECK (recipient_channel IN ('whatsapp', 'telegram')),
  case_count int NOT NULL DEFAULT 0,
  payload_summary jsonb,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'dry_run', 'skipped_duplicate', 'skipped_empty')),
  error text,
  org_id uuid NOT NULL
);

COMMENT ON TABLE priority_briefings_log IS
  'Audit trail of every priority briefing sent. Also used for idempotency (dedupe within same day).';

COMMENT ON COLUMN priority_briefings_log.run_date IS
  'Date the briefing ran (UTC). Used for daily uniqueness — indexed expressions cannot call date() on timestamptz since that is not IMMUTABLE.';

-- Dedupe index: one successful brief per (job, recipient, date)
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefings_log_daily_dedup
  ON priority_briefings_log (job_type, recipient_user_id, run_date)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_briefings_log_by_run_at
  ON priority_briefings_log (run_at DESC);

CREATE INDEX IF NOT EXISTS idx_briefings_log_recipient
  ON priority_briefings_log (recipient_user_id, run_at DESC);

-- ============================================================================
-- 3. Staff notification preferences
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_notification_prefs (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'Africa/Lagos',
  morning_brief_enabled boolean NOT NULL DEFAULT false,
  escalation_nudges_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE staff_notification_prefs IS
  'Opt-in preferences for priority briefings. WhatsApp number comes from users.whatsapp_number.';

CREATE INDEX IF NOT EXISTS idx_staff_prefs_enabled
  ON staff_notification_prefs (morning_brief_enabled, escalation_nudges_enabled);

COMMIT;

-- ============================================================================
-- Rollback script (manual)
-- ============================================================================
-- BEGIN;
-- DROP TABLE IF EXISTS staff_notification_prefs;
-- DROP TABLE IF EXISTS priority_briefings_log;
-- DROP INDEX IF EXISTS idx_case_stage_history_case_created;
-- DROP INDEX IF EXISTS idx_activity_log_case_outbound;
-- DROP INDEX IF EXISTS idx_cases_tags;
-- DROP INDEX IF EXISTS idx_cases_priority_active;
-- ALTER TABLE cases DROP COLUMN IF EXISTS tags;
-- ALTER TABLE cases DROP COLUMN IF EXISTS priority_set_at;
-- ALTER TABLE cases DROP COLUMN IF EXISTS priority_reason;
-- COMMIT;
