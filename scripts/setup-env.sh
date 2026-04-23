#!/usr/bin/env bash
# Creates /root/elab-priority-briefing/.env interactively.
# Usage: bash scripts/setup-env.sh
# Reads secrets via `read -s` so they never appear in bash history or `ps`.

set -euo pipefail

ENV_PATH="/root/elab-priority-briefing/.env"

echo "=== elab-priority-briefing env setup ==="
echo ""

read -srp "Supabase service role key (JWT, starts with eyJ...): " SUPABASE_KEY
echo ""
read -rp "Telegram bot token [8692142452:AAEaORN8ZahdmLh2EZX7-9GrgFtojj1rP5Q]: " TG_TOKEN
TG_TOKEN="${TG_TOKEN:-8692142452:AAEaORN8ZahdmLh2EZX7-9GrgFtojj1rP5Q}"
read -rp "CEO Telegram chat ID [1136291655]: " TG_CEO
TG_CEO="${TG_CEO:-1136291655}"

if [[ -z "$SUPABASE_KEY" ]]; then
  echo "ERROR: Supabase service role key is required." >&2
  exit 1
fi

if [[ ! "$SUPABASE_KEY" =~ ^eyJ ]]; then
  echo "WARNING: Supabase key does not start with 'eyJ' — that may not be a valid JWT."
fi

umask 077  # created file will be 600

cat > "$ENV_PATH" <<ENV
SUPABASE_URL=https://fwmhfwprvqaovidykaqt.supabase.co
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_KEY
SUPABASE_ORG_ID=00000000-0000-0000-0000-000000000001
META_GRAPH_TOKEN=DUMMY_NOT_USED_WITH_WHATSAPP_LIVE_FALSE_X
META_PHONE_NUMBER_ID=DUMMY_PLACEHOLDER
TELEGRAM_BOT_TOKEN=$TG_TOKEN
TELEGRAM_CEO_CHAT_ID=$TG_CEO
DRY_RUN=false
TELEGRAM_LIVE=true
WHATSAPP_LIVE=false
TZ=Africa/Lagos
MORNING_BRIEF_CRON=0 8 * * *
ESCALATION_SWEEP_CRON=0 */2 * * *
CEO_HEALTH_CHECK_CRON=30 8 * * *
COMMAND_CENTRE_URL=https://app.elabsolution.org
MAX_MESSAGES_PER_RUN=30
NEGLECT_THRESHOLD_HOURS=24
LOG_LEVEL=info
ENV

echo ""
echo "✅ .env written to $ENV_PATH ($(wc -l < "$ENV_PATH") lines, mode $(stat -c '%a' "$ENV_PATH"))"
echo ""
echo "Next step: build and run the container."
