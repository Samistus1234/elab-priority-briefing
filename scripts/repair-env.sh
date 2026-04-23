#!/usr/bin/env bash
# Repairs /root/elab-priority-briefing/.env from a JWT pasted into a file.
# Why: terminals like Hostinger's web shell split long pastes across lines,
#      which broke the original interactive setup-env.sh. Using a file buffer
#      then stripping whitespace gives us a bulletproof path to a clean JWT.
#
# Usage:
#   1. nano /tmp/jwt.txt   (paste JWT — it may span multiple lines — save)
#   2. bash scripts/repair-env.sh /tmp/jwt.txt

set -euo pipefail

JWT_FILE="${1:-/tmp/jwt.txt}"

if [[ ! -f "$JWT_FILE" ]]; then
  echo "ERROR: $JWT_FILE not found." >&2
  echo "Usage: bash scripts/repair-env.sh <path-to-jwt-file>" >&2
  exit 1
fi

# Strip ALL whitespace (spaces, tabs, newlines, CRs) so any paste wrap is undone.
JWT="$(tr -d ' \n\r\t' < "$JWT_FILE")"

if [[ ! "$JWT" =~ ^eyJ ]]; then
  echo "ERROR: cleaned JWT does not start with 'eyJ' — check $JWT_FILE contents." >&2
  exit 1
fi

DOTS=$(tr -dc '.' <<< "$JWT" | wc -c)
if [[ "$DOTS" -ne 2 ]]; then
  echo "ERROR: JWT must have exactly 2 dots (header.payload.signature), got $DOTS." >&2
  exit 1
fi

echo "Cleaned JWT: length=${#JWT}, dots=$DOTS"

umask 077
cat > /root/elab-priority-briefing/.env <<ENV
SUPABASE_URL=https://fwmhfwprvqaovidykaqt.supabase.co
SUPABASE_SERVICE_ROLE_KEY=$JWT
SUPABASE_ORG_ID=00000000-0000-0000-0000-000000000001
META_GRAPH_TOKEN=DUMMY_NOT_USED_WITH_WHATSAPP_LIVE_FALSE_X
META_PHONE_NUMBER_ID=DUMMY_PLACEHOLDER
TELEGRAM_BOT_TOKEN=8692142452:AAEaORN8ZahdmLh2EZX7-9GrgFtojj1rP5Q
TELEGRAM_CEO_CHAT_ID=1136291655
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

chmod 600 /root/elab-priority-briefing/.env

echo "✅ .env rewritten: $(wc -l < /root/elab-priority-briefing/.env) lines, mode $(stat -c '%a' /root/elab-priority-briefing/.env)"
echo ""
echo "Now restart the container:"
echo "   docker restart elab-priority-briefing && sleep 3 && docker logs --tail 20 elab-priority-briefing"
