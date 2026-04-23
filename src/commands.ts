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

  if (scope.can_note) lines.push(`• \`/note <ref> <text>\` — _coming soon_`);
  if (scope.can_reply) lines.push(`• \`/reply <ref> <message>\` — _coming soon_`);
  if (scope.can_escalate) lines.push(`• \`/escalate <ref> <reason>\` — _coming soon_`);

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

function escapeMd(s: string): string {
  if (!s) return "";
  return String(s).replace(/[_*`\[\]]/g, (ch) => `\\${ch}`);
}
