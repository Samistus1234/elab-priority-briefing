import type { CaseLite, PriorityReason, StaffUser } from "./types.js";

/**
 * Pure string/object assembly for the three message formats.
 * No I/O, no logging — easy to snapshot-test.
 */

export type StaffBriefVars = {
  staff_name: string;
  priority_count: number;
  neglected_count: number;
  case_list: string;
  command_centre_url: string;
};

export type WhatsAppTemplatePayload = {
  to: string;
  template_name: string;
  variables: string[]; // positional {{1}}, {{2}}, ...
};

export type TelegramPayload = {
  chat_id: string;
  text: string;
  parse_mode: "Markdown" | "MarkdownV2" | "HTML";
};

export type EscalationNudgePayload = {
  to: string;
  template_name: string;
  variables: string[];
  case_id: string;
};

/** Telegram variant for staff briefs — rich markdown, no template. */
export type StaffTelegramBriefPayload = {
  chat_id: string;
  text: string;
  parse_mode: "Markdown";
};

/** Telegram variant for escalation nudges. */
export type EscalationTelegramPayload = {
  chat_id: string;
  text: string;
  parse_mode: "Markdown";
  case_id: string;
};

const REASON_LABELS: Record<PriorityReason, string> = {
  manual: "manually flagged",
  stuck_7d: "stuck >7d",
  sla_breach: "SLA breached",
  unanswered_client: "client waiting >24h",
  error_tag: "error/issue tag",
  long_running_45d: "long-running >45d",
  vip_tag: "VIP/referred",
};

/**
 * Build the WhatsApp template payload for a single staff member's priority cases.
 * Returns null if the staff has no priority cases OR no WhatsApp number.
 */
export function buildStaffBrief(
  staff: StaffUser,
  priorityCases: CaseLite[],
  neglectedCases: CaseLite[],
  commandCentreUrl: string,
  templateName: string,
): WhatsAppTemplatePayload | null {
  if (!staff.whatsapp_number) return null;
  if (priorityCases.length === 0) return null;

  const vars: StaffBriefVars = {
    staff_name: staff.full_name || "there",
    priority_count: priorityCases.length,
    neglected_count: neglectedCases.length,
    case_list: renderCaseList(priorityCases),
    command_centre_url: commandCentreUrl,
  };

  return {
    to: staff.whatsapp_number,
    template_name: templateName,
    variables: [
      vars.staff_name,
      String(vars.priority_count),
      vars.case_list,
      String(vars.neglected_count),
      vars.command_centre_url,
    ],
  };
}

/**
 * Build the CEO's Telegram rollup — plain markdown, no template restriction.
 */
export function buildCeoRollup(
  allByAssignee: Map<string | null, CaseLite[]>,
  neglectedCases: CaseLite[],
  assigneeNames: Map<string, string>,
  ceoChatId: string,
  neglectThresholdHours: number,
): TelegramPayload {
  const today = new Date().toISOString().slice(0, 10);
  const totalPriority = Array.from(allByAssignee.values()).reduce((s, v) => s + v.length, 0);

  const lines: string[] = [];
  lines.push(`🌅 *Priority Cases — Morning Rollup*`);
  lines.push(`Date: ${today}`);
  lines.push(``);
  lines.push(`*Total priority: ${totalPriority} cases across ${allByAssignee.size} assignment(s)*`);
  lines.push(`*Total neglected (>${neglectThresholdHours}h no outbound): ${neglectedCases.length}* ${neglectedCases.length > 0 ? "⚠️" : "✅"}`);
  lines.push(``);

  // Per-staff breakdown
  lines.push(`*By staff:*`);
  const neglectedByAssignee = new Map<string | null, number>();
  for (const c of neglectedCases) {
    const k = c.assigned_to_user_id;
    neglectedByAssignee.set(k, (neglectedByAssignee.get(k) ?? 0) + 1);
  }

  const sortedStaff = Array.from(allByAssignee.entries()).sort(
    ([, a], [, b]) => b.length - a.length,
  );

  for (const [userId, cases] of sortedStaff) {
    const name = userId ? assigneeNames.get(userId) ?? "Unknown" : "🟡 Unassigned";
    const neglectedN = neglectedByAssignee.get(userId) ?? 0;
    const neglectedTag = neglectedN > 0 ? ` (${neglectedN} neglected)` : "";
    lines.push(`• ${escapeMd(name)} — ${cases.length} priority${neglectedTag}`);
  }

  // Top neglected
  if (neglectedCases.length > 0) {
    lines.push(``);
    lines.push(`*Top ${Math.min(5, neglectedCases.length)} most-neglected:*`);
    const top = neglectedCases.slice(0, 5);
    top.forEach((c, i) => {
      const ref = c.case_reference ?? c.id.slice(0, 8);
      const who = c.person_full_name ?? "—";
      const assignee = c.assignee_full_name ?? "Unassigned";
      const days = c.last_client_outbound_at
        ? daysSince(c.last_client_outbound_at)
        : daysSince(c.priority_set_at ?? c.created_at);
      lines.push(`${i + 1}. \`${escapeMd(ref)}\` — ${escapeMd(who)} — ${days}d stale — ${escapeMd(assignee)}`);
    });
  }

  // Rule breakdown
  const byReason = new Map<string, number>();
  for (const cases of allByAssignee.values()) {
    for (const c of cases) {
      const label = c.priority_reason ? REASON_LABELS[c.priority_reason] : "uncategorised";
      byReason.set(label, (byReason.get(label) ?? 0) + 1);
    }
  }
  if (byReason.size > 0) {
    lines.push(``);
    lines.push(`*Breakdown by reason:*`);
    const sorted = Array.from(byReason.entries()).sort(([, a], [, b]) => b - a);
    for (const [label, n] of sorted) {
      lines.push(`• ${escapeMd(label)}: ${n}`);
    }
  }

  return {
    chat_id: ceoChatId,
    text: lines.join("\n"),
    parse_mode: "Markdown",
  };
}

/**
 * Build the escalation nudge WhatsApp template payload for one neglected case.
 */
export function buildEscalationNudge(
  staff: StaffUser,
  neglectedCase: CaseLite,
  templateName: string,
): EscalationNudgePayload | null {
  if (!staff.whatsapp_number) return null;

  const ref = neglectedCase.case_reference ?? neglectedCase.id.slice(0, 8);
  const who = neglectedCase.person_full_name ?? "—";
  const stage = neglectedCase.stage_name ? ` (${neglectedCase.stage_name})` : "";
  const description = `${who}${stage}`;

  return {
    to: staff.whatsapp_number,
    template_name: templateName,
    variables: [staff.full_name || "there", ref, description],
    case_id: neglectedCase.id,
  };
}

/**
 * Build a rich Telegram brief for a staff member. Full case list, no char limit.
 * Returns null if staff has no Telegram chat_id OR empty priority list.
 */
export function buildStaffBriefTelegram(
  staff: StaffUser,
  priorityCases: CaseLite[],
  neglectedCases: CaseLite[],
  commandCentreUrl: string,
): StaffTelegramBriefPayload | null {
  if (!staff.telegram_chat_id) return null;
  if (priorityCases.length === 0) return null;

  const firstName = staff.full_name?.split(" ")[0] ?? "there";
  const lines: string[] = [];
  lines.push(`🌅 *Good morning, ${escapeMd(firstName)}*`);
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(``);
  lines.push(`You have *${priorityCases.length}* priority case(s) assigned today.`);
  if (neglectedCases.length > 0) {
    lines.push(`⚠️ *${neglectedCases.length}* haven't had client contact in 24h+.`);
  }
  lines.push(``);
  lines.push(`*Your priority cases:*`);

  const top = priorityCases.slice(0, 15);
  for (const c of top) {
    const ref = c.case_reference ?? c.id.slice(0, 8);
    const who = c.person_full_name ?? "—";
    const reason = c.priority_reason ? ` (${REASON_LABELS[c.priority_reason]})` : "";
    const pipe = c.pipeline_name ? ` · ${c.pipeline_name}` : "";
    lines.push(`• \`${escapeMd(ref)}\` — ${escapeMd(who)}${escapeMd(pipe)}${escapeMd(reason)}`);
  }
  if (priorityCases.length > 15) {
    lines.push(`…and ${priorityCases.length - 15} more`);
  }

  lines.push(``);
  lines.push(`View in Command Centre: ${commandCentreUrl}`);
  lines.push(``);
  lines.push(`_Reply /status to check settings._`);

  return {
    chat_id: staff.telegram_chat_id,
    text: lines.join("\n"),
    parse_mode: "Markdown",
  };
}

/**
 * Build a Telegram escalation nudge for a single neglected case.
 */
export function buildEscalationNudgeTelegram(
  staff: StaffUser,
  neglectedCase: CaseLite,
  commandCentreUrl: string,
  neglectThresholdHours: number,
): EscalationTelegramPayload | null {
  if (!staff.telegram_chat_id) return null;

  const firstName = staff.full_name?.split(" ")[0] ?? "there";
  const ref = neglectedCase.case_reference ?? neglectedCase.id.slice(0, 8);
  const who = neglectedCase.person_full_name ?? "—";
  const stage = neglectedCase.stage_name ? ` · ${neglectedCase.stage_name}` : "";

  const lines = [
    `⚠️ *Escalation — ${escapeMd(firstName)}*`,
    ``,
    `Case \`${escapeMd(ref)}\` (${escapeMd(who)}${escapeMd(stage)}) has not had outbound client contact in over ${neglectThresholdHours} hours.`,
    ``,
    `Please action today, or mark it on hold with a reason.`,
    ``,
    `Open case: ${commandCentreUrl}/cases/${neglectedCase.id}`,
  ];

  return {
    chat_id: staff.telegram_chat_id,
    text: lines.join("\n"),
    parse_mode: "Markdown",
    case_id: neglectedCase.id,
  };
}

// ---- helpers ----

function renderCaseList(cases: CaseLite[]): string {
  const items = cases.slice(0, 10).map((c) => {
    const ref = c.case_reference ?? c.id.slice(0, 8);
    const who = c.person_full_name ?? "—";
    const reason = c.priority_reason ? REASON_LABELS[c.priority_reason] : "priority";
    return `• ${ref} — ${who} (${reason})`;
  });
  if (cases.length > 10) {
    items.push(`…and ${cases.length - 10} more`);
  }
  return items.join("\n");
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

/** Escape Telegram Markdown (legacy Markdown — not V2) */
function escapeMd(s: string): string {
  return s.replace(/[_*`\[\]]/g, (ch) => `\\${ch}`);
}
