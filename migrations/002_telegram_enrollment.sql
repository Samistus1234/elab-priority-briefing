-- Phase 1 Telegram Pivot
-- Created: 2026-04-23
-- Purpose: Add Telegram chat ID storage + polling offset persistence.

BEGIN;

ALTER TABLE staff_notification_prefs
  ADD COLUMN IF NOT EXISTS telegram_chat_id text,
  ADD COLUMN IF NOT EXISTS telegram_enrolled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_staff_prefs_telegram
  ON staff_notification_prefs (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- Single-row table to persist Telegram getUpdates offset between restarts
CREATE TABLE IF NOT EXISTS telegram_bot_state (
  id int PRIMARY KEY DEFAULT 1,
  last_update_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO telegram_bot_state (id, last_update_id)
VALUES (1, 0) ON CONFLICT DO NOTHING;

COMMIT;
