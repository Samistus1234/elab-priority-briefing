import { getSupabase } from "./supabase.js";
import { logger } from "./logger.js";
import { loadConfig } from "./config.js";
import type { Scope } from "./permissions.js";
import type { CaseLite } from "./types.js";

/**
 * Slash command handlers. Each returns a markdown string to send back via Telegram.
 * Pure read-only in Phase 2a. Action commands (/note, /reply, /escalate) come in 2b.
 */

const REASON_LABELS: Record<string, string> = {
  manual: "manually flagged",
  stuck_7d: "stuck >7d",
  sla_breach: "SLA breached",
  unanswered_client: "client waiting >24h",
  error_tag: "error/issue tag",
  long_running_45d: "long-running >45d",
  vip_tag: "VIP/referred",
};

export async function cmdHelp(scope: Scope): Promise<string> {
  const roleBlurb =
    scope.role === "ceo"
      ? "You are logged in as CEO — full access."
      : scope.role === "lead"
        ? `You are logged in as team lead (${scope.visible_user_ids.length - 1} direct reports).`
        : "You are logged in as staff — you see your own cases.";

  const lines = [
    `🤖 *ELAB Ops Team Bot — help*`,
    ``,
    roleBlurb,
    ``,
    `*Read-only commands:*`,
    `• \`/mycases\` — your priority cases`,
    `• \`/stuck\` — priority cases stuck 7+ days`,
    `• \`/case <ref>\` — full detail for one case (e.g. \`/case DFL-2181\`)`,
    `• \`/status\` — your enrollment settings`,
    `• \`/help\` — this message`,
  ];

  lines.push(``, `*Action commands:*`);
  if (scope.can_note) lines.push(`• \`/note <ref> <text>\` — add an internal note`);
  if (scope.can_escalate) lines.push(`• \`/escalate <ref> <reason>\` — alert the CEO`);
  if (scope.can_reply) {
    lines.push(`• \`/reply <ref> <message>\` — WhatsApp reply to client (requires \`/confirm\`)`);
    lines.push(`• \`/confirm\` — send pending reply draft`);
    lines.push(`• \`/cancel\` — discard pending reply draft`);
  }

  lines.push(``, `Natural-language questions: _coming soon_`);

  return lines.join("\n");
}

export async function cmdMyCases(scope: Scope): Promise<string> {
  const supabase = getSupabase();
  const cfg = loadConfig();

  let query = supabase
    .from("cases")
    .select(`
      id, case_reference, priority, priority_reason, priority_set_at,
      assigned_to_user_id, sla_deadline_at,
      person:persons!cases_person_id_fkey(first_name, last_name),
      stage:pipeline_stages!cases_current_stage_id_fkey(name),
      pipeline:pipelines!cases_pipeline_id_fkey(name)
    `)
    .eq("org_id", cfg.supabase.orgId)
    .eq("is_archived", false)
    .eq("status", "active")
    .in("priority", ["high", "urgent"])
    .in("assigned_to_user_id", [scope.user_id])
    .order("priority_set_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error.message }, "cmdMyCases failed");
    return "Something went wrong fetching your cases.";
  }
  if (!data || data.length === 0) {
    return "You have no priority cases assigned right now. 🎉";
  }

  const lines: string[] = [
    `📋 *Your priority cases (${data.length})*`,
    ``,
  ];
  for (const c of data.slice(0, 20) as any[]) {
    const ref = c.case_reference ?? c.id.slice(0, 8);
    const who = c.person ? `${c.person.first_name ?? ""} ${c.person.last_name ?? ""}`.trim() : "—";
    const reason = c.priority_reason ? ` (${REASON_LABELS[c.priority_reason] ?? c.priority_reason})` : "";
    const stage = c.stage?.name ? ` · ${c.stage.name}` : "";
    lines.push(`• \`${escapeMd(ref)}\` — ${escapeMd(who)}${escapeMd(stage)}${escapeMd(reason)}`);
  }
  if (data.length > 20) lines.push(`…and ${data.length - 20} more`);
  lines.push(``, `Use \`/case <ref>\` for details.`);
  return lines.join("\n");
}

export async function cmdStuck(scope: Scope): Promise<string> {
  const supabase = getSupabase();
  const cfg = loadConfig();

  let query = supabase
    .from("cases")
    .select(`
      id, case_reference, assigned_to_user_id, priority_set_at,
      person:persons!cases_person_id_fkey(first_name, last_name),
      assignee:users!cases_assigned_to_user_id_fkey(full_name),
      stage:pipeline_stages!cases_current_stage_id_fkey(name)
    `)
    .eq("org_id", cfg.supabase.orgId)
    .eq("is_archived", false)
    .eq("status", "active")
    .eq("priority_reason", "stuck_7d")
    .order("priority_set_at", { ascending: true, nullsFirst: false })
    .limit(50);

  if (!scope.can_see_unassigned) {
    query = query.in("assigned_to_user_id", scope.visible_user_ids);
  } else {
    // CEO: filter to assigned-or-unassigned within visible universe — effectively all
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error.message }, "cmdStuck failed");
    return "Something went wrong fetching stuck cases.";
  }
  if (!data || data.length === 0) {
    return "No stuck cases in your scope. ✅";
  }

  const header =
    scope.role === "ceo"
      ? `⚠️ *Stuck cases (org-wide) — ${data.length}*`
      : scope.role === "lead"
        ? `⚠️ *Stuck cases (your team) — ${data.length}*`
        : `⚠️ *Your stuck cases — ${data.length}*`;

  const lines: string[] = [header, ``];
  for (const c of data.slice(0, 15) as any[]) {
    const ref = c.case_reference ?? c.id.slice(0, 8);
    const who = c.person ? `${c.person.first_name ?? ""} ${c.person.last_name ?? ""}`.trim() : "—";
    const owner = c.assignee?.full_name ?? "🟡 Unassigned";
    lines.push(`• \`${escapeMd(ref)}\` — ${escapeMd(who)} · ${escapeMd(owner)}`);
  }
  if (data.length > 15) lines.push(`…and ${data.length - 15} more`);
  return lines.join("\n");
}

export async function cmdCase(scope: Scope, args: string): Promise<string> {
  const ref = args.trim().split(/\s+/)[0];
  if (!ref) {
    return "Usage: `/case <case-reference>` e.g. `/case DFL-2181` or `/case 2181`";
  }

  const supabase = getSupabase();
  const cfg = loadConfig();

  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  let query = supabase
    .from("cases")
    .select(`
      id, case_reference, priority, priority_reason, priority_set_at, status,
      assigned_to_user_id, sla_deadline_at, tags, created_at, updated_at,
      person:persons!cases_person_id_fkey(first_name, last_name, whatsapp_number, email),
      assignee:users!cases_assigned_to_user_id_fkey(id, full_name),
      stage:pipeline_stages!cases_current_stage_id_fkey(name),
      pipeline:pipelines!cases_pipeline_id_fkey(name)
    `)
    .eq("org_id", cfg.supabase.orgId);

  if (isUuid) {
    query = query.eq("id", ref);
  } else {
    // Substring match on case_reference (case-insensitive)
    query = query.ilike("case_reference", `%${ref}%`);
  }

  const { data: cases, error } = await query.order("created_at", { ascending: false }).limit(5);

  if (error || !cases || cases.length === 0) {
    return `Case \`${escapeMd(ref)}\` not found.`;
  }

  // If multiple matches, list them and ask user to be more specific
  if (cases.length > 1) {
    const lines = [`Found ${cases.length} cases matching \`${escapeMd(ref)}\`:`, ``];
    for (const c of cases) {
      const r = (c as any).case_reference ?? (c as any).id.slice(0, 8);
      const who = (c as any).person
        ? `${(c as any).person.first_name ?? ""} ${(c as any).person.last_name ?? ""}`.trim()
        : "—";
      lines.push(`• \`${escapeMd(r)}\` — ${escapeMd(who)}`);
    }
    lines.push(``, `Use a more specific reference.`);
    return lines.join("\n");
  }

  const c = cases[0] as any;

  // Permission check
  if (!scope.can_see_unassigned && c.assigned_to_user_id && !scope.visible_user_ids.includes(c.assigned_to_user_id)) {
    return `You don't have access to case \`${escapeMd(ref)}\`.`;
  }
  if (!scope.can_see_unassigned && !c.assigned_to_user_id) {
    return `You don't have access to unassigned cases.`;
  }

  const who = c.person ? `${c.person.first_name ?? ""} ${c.person.last_name ?? ""}`.trim() : "—";
  const owner = c.assignee?.full_name ?? "🟡 Unassigned";
  const tags = (c.tags ?? []).length > 0 ? ` · tags: ${c.tags.join(", ")}` : "";

  const lines = [
    `📄 *Case \`${escapeMd(c.case_reference ?? c.id)}\`*`,
    ``,
    `*Client:* ${escapeMd(who)}`,
    `*Pipeline:* ${escapeMd(c.pipeline?.name ?? "—")}`,
    `*Stage:* ${escapeMd(c.stage?.name ?? "—")}`,
    `*Status:* ${escapeMd(c.status)}`,
    `*Priority:* ${escapeMd(c.priority)}${c.priority_reason ? ` (${REASON_LABELS[c.priority_reason] ?? c.priority_reason})` : ""}`,
    `*Assigned to:* ${escapeMd(owner)}`,
    `*Created:* ${new Date(c.created_at).toISOString().slice(0, 10)}${escapeMd(tags)}`,
  ];

  if (c.sla_deadline_at) {
    lines.push(`*SLA deadline:* ${new Date(c.sla_deadline_at).toISOString().slice(0, 10)}`);
  }
  if (c.person?.whatsapp_number) {
    lines.push(`*Client WhatsApp:* ${escapeMd(c.person.whatsapp_number)}`);
  }
  if (c.person?.email) {
    lines.push(`*Client email:* ${escapeMd(c.person.email)}`);
  }

  lines.push(``, `Open in Command Centre: ${cfg.commandCentreUrl}/cases/${c.id}`);
  return lines.join("\n");
}

export async function cmdStatus(scope: Scope): Promise<string> {
  const supabase = getSupabase();
  const { data: prefs } = await supabase
    .from("staff_notification_prefs")
    .select("timezone, morning_brief_enabled, escalation_nudges_enabled, telegram_enrolled_at")
    .eq("user_id", scope.user_id)
    .maybeSingle();

  const lines = [
    `✅ *Enrolled as ${escapeMd(scope.full_name)}* (${escapeMd(scope.email)})`,
    `Role: *${scope.role}*`,
    `Morning brief: ${prefs?.morning_brief_enabled ? "ON" : "off"}`,
    `Escalation nudges: ${prefs?.escalation_nudges_enabled ? "ON" : "off"}`,
    `Timezone: ${prefs?.timezone ?? "Africa/Lagos"}`,
  ];
  if (prefs?.telegram_enrolled_at) {
    lines.push(`Enrolled at: ${prefs.telegram_enrolled_at.slice(0, 10)}`);
  }
  return lines.join("\n");
}

// ============================================================================
// /reply flow — in-memory pending drafts
// ============================================================================

type PendingReply = {
  chat_id: number;
  user_id: string;
  case_id: string;
  case_ref: string;
  client_phone: string;
  client_name: string;
  message: string;
  created_at: number;
};

const DRAFT_TTL_MS = 5 * 60 * 1000; // 5 minutes

const pendingReplies = new Map<number, PendingReply>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [chatId, draft] of pendingReplies) {
    if (now - draft.created_at > DRAFT_TTL_MS) pendingReplies.delete(chatId);
  }
}

export function getPendingReply(chatId: number): PendingReply | null {
  purgeExpired();
  return pendingReplies.get(chatId) ?? null;
}

export function clearPendingReply(chatId: number): void {
  pendingReplies.delete(chatId);
}

/**
 * /reply <ref> <message>
 * Shows preview + asks for /confirm. Scope-checked. Requires 24h window with client.
 */
export async function cmdReply(
  scope: Scope,
  chatId: number,
  args: string,
): Promise<string> {
  if (!scope.can_reply) {
    return "You don't have permission to send client replies.";
  }

  const match = args.trim().match(/^(\S+)\s+(.+)$/s);
  if (!match) {
    return "Usage: `/reply <case-reference> <message>`\nExample: `/reply DFL-2181 Hi, following up on your transcript.`";
  }
  const [, ref, message] = match;

  if (message.length > 1000) {
    return "Message too long (max 1000 chars). Shorten it or use Command Centre.";
  }

  const supabase = getSupabase();
  const cfg = loadConfig();

  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  let q = supabase
    .from("cases")
    .select(`
      id, case_reference, assigned_to_user_id,
      person:persons!cases_person_id_fkey(first_name, last_name, whatsapp_number)
    `)
    .eq("org_id", cfg.supabase.orgId);
  q = isUuid ? q.eq("id", ref) : q.ilike("case_reference", `%${ref}%`);
  const { data: cases, error } = await q.limit(5);

  if (error || !cases || cases.length === 0) {
    return `Case \`${escapeMd(ref)}\` not found.`;
  }
  if (cases.length > 1) {
    const lines = [`Multiple cases match \`${escapeMd(ref)}\`. Be more specific:`];
    for (const c of cases) lines.push(`• \`${escapeMd((c as any).case_reference ?? (c as any).id)}\``);
    return lines.join("\n");
  }
  const c = cases[0] as any;

  if (!scope.can_see_unassigned && c.assigned_to_user_id && !scope.visible_user_ids.includes(c.assigned_to_user_id)) {
    return `You don't have access to \`${escapeMd(ref)}\`.`;
  }
  if (!scope.can_see_unassigned && !c.assigned_to_user_id) {
    return `You don't have access to unassigned cases.`;
  }

  const phone = c.person?.whatsapp_number;
  if (!phone) {
    return `Case \`${escapeMd(c.case_reference)}\` has no WhatsApp number on file. Use email instead via Command Centre.`;
  }

  // Check 24h window — is there a client inbound in last 24h?
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentInbound } = await supabase
    .from("activity_log")
    .select("created_at")
    .eq("entity_id", c.id)
    .eq("entity_type", "case")
    .eq("action", "message_received")
    .gte("created_at", twentyFourHoursAgo)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!recentInbound || recentInbound.length === 0) {
    return (
      `⚠️ Client hasn't messaged in the last 24h — WhatsApp policy blocks free text.\n\n` +
      `Use Command Centre to send via an approved template:\n` +
      `${cfg.commandCentreUrl}/cases/${c.id}`
    );
  }

  const clientName = c.person
    ? `${c.person.first_name ?? ""} ${c.person.last_name ?? ""}`.trim()
    : "—";

  // Stash pending draft
  pendingReplies.set(chatId, {
    chat_id: chatId,
    user_id: scope.user_id,
    case_id: c.id,
    case_ref: c.case_reference ?? c.id,
    client_phone: phone,
    client_name: clientName,
    message,
    created_at: Date.now(),
  });

  return [
    `📤 *Reply preview*`,
    ``,
    `*To:* ${escapeMd(clientName)} (${escapeMd(phone)})`,
    `*Case:* \`${escapeMd(c.case_reference ?? c.id)}\``,
    `*Via:* WhatsApp (within 24h window)`,
    ``,
    `*Message:*`,
    escapeMd(message),
    ``,
    `Send \`/confirm\` to deliver, or \`/cancel\` to discard.`,
    `Draft expires in 5 minutes.`,
  ].join("\n");
}

/** Send the pending draft. Returns the response text. */
export async function cmdConfirm(
  scope: Scope,
  chatId: number,
): Promise<string> {
  const draft = getPendingReply(chatId);
  if (!draft) {
    return "No pending reply to confirm. Start one with `/reply <ref> <message>`.";
  }
  if (draft.user_id !== scope.user_id) {
    clearPendingReply(chatId);
    return "That draft doesn't belong to you. Discarded.";
  }

  const cfg = loadConfig();
  const supabase = getSupabase();

  if (cfg.dryRun || !cfg.whatsappLive) {
    clearPendingReply(chatId);
    return `✅ [DRY RUN] Would send to ${escapeMd(draft.client_name)} for \`${escapeMd(draft.case_ref)}\`.\n\nWhatsApp isn't live yet — flip WHATSAPP_LIVE=true to actually send.`;
  }

  // Send via Meta Graph API
  const url = `https://graph.facebook.com/v21.0/${cfg.meta.phoneNumberId}/messages`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.meta.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: draft.client_phone,
        type: "text",
        text: { body: draft.message },
      }),
    });
    const j: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      logger.error({ status: resp.status, err: j?.error?.message }, "reply send failed");
      return `Failed to send: ${escapeMd(j?.error?.message ?? String(resp.status))}`;
    }

    const messageId = j?.messages?.[0]?.id ?? "unknown";

    // Log outbound in activity_log so priority engine sees the case as "touched"
    await supabase
      .from("activity_log")
      .insert({
        org_id: cfg.supabase.orgId,
        user_id: draft.user_id,
        action: "whatsapp_message_sent",
        entity_type: "case",
        entity_id: draft.case_id,
        metadata: {
          to: draft.client_phone,
          caseId: draft.case_id,
          messageId,
          source: "telegram_bot",
        },
      })
      .then(({ error }) => {
        if (error) logger.error({ err: error.message }, "activity_log insert failed");
      });

    clearPendingReply(chatId);
    return `✅ Sent to ${escapeMd(draft.client_name)} on \`${escapeMd(draft.case_ref)}\`.`;
  } catch (e) {
    logger.error({ err: (e as Error).message }, "reply send crashed");
    return `Network error sending reply. Draft is still pending — try \`/confirm\` again.`;
  }
}

export async function cmdCancel(
  scope: Scope,
  chatId: number,
): Promise<string> {
  const draft = getPendingReply(chatId);
  if (!draft) return "No pending draft to cancel.";
  clearPendingReply(chatId);
  return `Draft for \`${escapeMd(draft.case_ref)}\` discarded.`;
}

/**
 * /note <ref> <text>
 * Looks up the case (with scope check), writes to case_notes. Low-risk.
 */
export async function cmdNote(scope: Scope, args: string): Promise<string> {
  const match = args.trim().match(/^(\S+)\s+(.+)$/s);
  if (!match) {
    return "Usage: `/note <case-reference> <note text>`\nExample: `/note DFL-2181 Called client, awaiting transcript.`";
  }
  const [, ref, content] = match;

  const supabase = getSupabase();
  const cfg = loadConfig();

  // Find the case
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  let q = supabase
    .from("cases")
    .select("id, case_reference, assigned_to_user_id")
    .eq("org_id", cfg.supabase.orgId);
  q = isUuid ? q.eq("id", ref) : q.ilike("case_reference", `%${ref}%`);
  const { data: cases, error: caseErr } = await q.limit(5);

  if (caseErr || !cases || cases.length === 0) {
    return `Case \`${escapeMd(ref)}\` not found.`;
  }
  if (cases.length > 1) {
    const lines = [`Multiple cases match \`${escapeMd(ref)}\`. Be more specific:`];
    for (const c of cases) lines.push(`• \`${escapeMd((c as any).case_reference ?? (c as any).id)}\``);
    return lines.join("\n");
  }
  const c = cases[0] as any;

  // Scope check
  if (!scope.can_see_unassigned && c.assigned_to_user_id && !scope.visible_user_ids.includes(c.assigned_to_user_id)) {
    return `You don't have access to \`${escapeMd(ref)}\`.`;
  }
  if (!scope.can_see_unassigned && !c.assigned_to_user_id) {
    return `You don't have access to unassigned cases.`;
  }

  if (!scope.can_note) {
    return `You don't have permission to add notes.`;
  }

  const { error: noteErr } = await supabase.from("case_notes").insert({
    case_id: c.id,
    created_by_user_id: scope.user_id,
    content,
    is_client_visible: false,
  });

  if (noteErr) {
    logger.error({ err: noteErr.message, case_id: c.id }, "cmdNote failed");
    return `Failed to add note: ${escapeMd(noteErr.message)}`;
  }

  return `✅ Note added to \`${escapeMd(c.case_reference ?? c.id)}\`.`;
}

/**
 * /escalate <ref> <reason>
 * Sends a Telegram alert to the CEO about the given case.
 */
export async function cmdEscalate(scope: Scope, args: string): Promise<string> {
  const match = args.trim().match(/^(\S+)\s+(.+)$/s);
  if (!match) {
    return "Usage: `/escalate <case-reference> <reason>`\nExample: `/escalate DFL-2181 Client is threatening to cancel — urgent.`";
  }
  const [, ref, reason] = match;

  if (!scope.can_escalate) {
    return `As CEO, you don't need to escalate to yourself. Use \`/note\` to record the concern.`;
  }

  const supabase = getSupabase();
  const cfg = loadConfig();

  // Find the case
  const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
  let q = supabase
    .from("cases")
    .select(`
      id, case_reference, priority, priority_reason, assigned_to_user_id,
      person:persons!cases_person_id_fkey(first_name, last_name),
      stage:pipeline_stages!cases_current_stage_id_fkey(name),
      pipeline:pipelines!cases_pipeline_id_fkey(name)
    `)
    .eq("org_id", cfg.supabase.orgId);
  q = isUuid ? q.eq("id", ref) : q.ilike("case_reference", `%${ref}%`);
  const { data: cases, error: caseErr } = await q.limit(5);

  if (caseErr || !cases || cases.length === 0) {
    return `Case \`${escapeMd(ref)}\` not found.`;
  }
  if (cases.length > 1) {
    const lines = [`Multiple cases match \`${escapeMd(ref)}\`. Be more specific:`];
    for (const c of cases) lines.push(`• \`${escapeMd((c as any).case_reference ?? (c as any).id)}\``);
    return lines.join("\n");
  }
  const c = cases[0] as any;

  // Scope check
  if (!scope.can_see_unassigned && c.assigned_to_user_id && !scope.visible_user_ids.includes(c.assigned_to_user_id)) {
    return `You don't have access to \`${escapeMd(ref)}\`.`;
  }

  const who = c.person ? `${c.person.first_name ?? ""} ${c.person.last_name ?? ""}`.trim() : "—";

  // Build CEO alert
  const alertLines = [
    `🚨 *Escalation from ${escapeMd(scope.full_name)}*`,
    ``,
    `*Case:* \`${escapeMd(c.case_reference ?? c.id)}\``,
    `*Client:* ${escapeMd(who)}`,
    `*Pipeline/Stage:* ${escapeMd(c.pipeline?.name ?? "—")} / ${escapeMd(c.stage?.name ?? "—")}`,
    `*Current priority:* ${escapeMd(c.priority)}${c.priority_reason ? ` (${escapeMd(c.priority_reason)})` : ""}`,
    ``,
    `*Reason:*`,
    escapeMd(reason),
    ``,
    `Open: ${cfg.commandCentreUrl}/cases/${c.id}`,
  ];

  // Send via Telegram to CEO
  const telegramResp = await fetch(
    `https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.telegram.ceoChatId,
        text: alertLines.join("\n"),
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    },
  );

  if (!telegramResp.ok) {
    logger.error({ status: telegramResp.status, case_id: c.id }, "escalation Telegram send failed");
    return `Failed to send escalation. Please try again.`;
  }

  // Also record it as a case_note so there's an audit trail
  await supabase
    .from("case_notes")
    .insert({
      case_id: c.id,
      created_by_user_id: scope.user_id,
      content: `[ESCALATED TO CEO] ${reason}`,
      is_client_visible: false,
      title: "Escalation",
    })
    .then(({ error }) => {
      if (error) logger.error({ err: error.message }, "escalation note insert failed");
    });

  return `✅ Escalation sent to CEO for \`${escapeMd(c.case_reference ?? c.id)}\`.\nA note was also added to the case for audit.`;
}

function escapeMd(s: string): string {
  if (!s) return "";
  return String(s).replace(/[_*`\[\]]/g, (ch) => `\\${ch}`);
}
