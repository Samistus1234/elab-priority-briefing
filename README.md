# elab-priority-briefing

Daily priority case briefing service. Sends a WhatsApp morning brief to each staff member (priority cases assigned to them) and a Telegram rollup to the CEO. Auto-escalates cases with no outbound client contact in 24h+.

See spec: `../docs/superpowers/specs/2026-04-23-priority-case-briefing-design.md`

## Architecture

- **scheduler.ts** — node-cron jobs (8 AM WAT morning brief, every 2h escalation sweep, 8:30 AM health check)
- **priority-engine.ts** — 6 auto-rules that raise priority; neglected-case finder; group-by-assignee
- **briefing-builder.ts** — pure string assembly for WhatsApp templates + Telegram markdown
- **dispatcher.ts** — all outbound I/O; retries; idempotency; safety valve; audit log
- **jobs.ts** — orchestrators that wire the above together

## Local development

```bash
cp .env.example .env     # fill in secrets
npm install
npm test                  # unit tests
npm run dev               # start with node-cron (needs all env vars)
npm run brief:now         # manually trigger morning brief (useful for dry-run verification)
npm run escalation:now    # manually trigger escalation sweep
```

## Deployment (VPS)

### 1. Apply the SQL migration

Run `migrations/001_priority_briefing_schema.sql` against the production Supabase. This adds:
- `cases.priority_reason`, `cases.priority_set_at`, `cases.tags`
- `priority_briefings_log` table
- `staff_notification_prefs` table
- Supporting indexes

### 2. Seed staff preferences

For each staff user who should receive morning briefs:
```sql
INSERT INTO staff_notification_prefs (user_id, morning_brief_enabled, escalation_nudges_enabled)
VALUES ('<user-uuid>', true, true);
```

### 3. Submit Meta WhatsApp templates

Two templates must be approved in Meta Business Manager before `WHATSAPP_LIVE=true`:

**Template 1 — `priority_cases_morning_brief` (UTILITY)**
```
Good morning {{1}}. Here are your priority cases for today:

🔴 {{2}} priority case(s) need your attention:
{{3}}

⚠️ {{4}} case(s) haven't moved in 24h+ — please action today.

Full details in Command Centre: {{5}}
```

**Template 2 — `priority_case_neglected_nudge` (UTILITY)**
```
Hi {{1}}, the following priority case hasn't had client contact in over 24 hours:

📌 {{2}} — {{3}}

Please action today, or mark it on hold with a reason. Thank you.
```

### 4. Copy code to VPS

```bash
# From Mac:
rsync -av --exclude node_modules --exclude build /Users/samuel/elab-priority-briefing/ root@srv1480502.hstgr.cloud:/root/elab-priority-briefing/
```

### 5. Create `.env` on VPS

```bash
# In Hostinger web terminal:
cd /root/elab-priority-briefing
cp .env.example .env
nano .env   # fill in real values (Supabase key, Meta token, Telegram token)
```

### 6. Add to docker-compose.yml

Merge `docker-compose.snippet.yml` into the existing `/docker/openclaw-el4v/docker-compose.yml` (or wherever docker-compose lives on the VPS).

### 7. Launch

```bash
docker compose up -d elab-priority-briefing
docker logs -f elab-priority-briefing
```

First week: keep `DRY_RUN=true` + `TELEGRAM_LIVE=false` + `WHATSAPP_LIVE=false`. Review audit logs in `priority_briefings_log` daily.

## Rollout phases

See the spec: Phase 1 (DRY_RUN), Phase 2 (CEO only via Telegram), Phase 3 (pilot staff Bukola + Helen), Phase 4 (full team).

## Rollback

```bash
# Stop all sends immediately:
docker exec elab-priority-briefing sh -c 'export DRY_RUN=true'
docker restart elab-priority-briefing

# Revert auto-flagged priority:
UPDATE cases SET priority='normal', priority_reason=NULL
WHERE priority_reason IN ('stuck_3d','sla_breach','unanswered_client','error_tag','long_running_45d','vip_tag');
```

Schema changes are non-destructive (`ADD COLUMN IF NOT EXISTS`). Migration can be reverted via the rollback SQL in `migrations/001_priority_briefing_schema.sql`.
