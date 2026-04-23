import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { getSupabase } from "./supabase.js";
import {
  buildCeoRollup,
  buildEscalationNudge,
  buildEscalationNudgeTelegram,
  buildStaffBrief,
  buildStaffBriefTelegram,
} from "./briefing-builder.js";
import {
  evaluatePriority,
  fetchPriorityCases,
  findNeglectedCases,
  groupByAssignee,
} from "./priority-engine.js";
import { Dispatcher } from "./dispatcher.js";
import type { CaseLite, StaffUser, SendStatus } from "./types.js";

/**
 * Orchestrators that wire priority-engine + briefing-builder + dispatcher together.
 *
 * Channel routing:
 *   - Staff briefs + escalation nudges: Telegram (if chat_id) → WhatsApp template fallback
 *   - CEO rollup: Telegram (always)
 *   - Health check: Telegram (always)
 */

export async function runMorningBrief(): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = new Dispatcher();
  dispatcher.resetCounter();

  logger.info({ dryRun: cfg.dryRun }, "morning_brief: start");

  const evalResult = await evaluatePriority();
  logger.info(
    { newlyFlagged: evalResult.newlyFlagged.length, total: evalResult.totalHighPriority },
    "morning_brief: priority evaluated",
  );

  const priorityCases = await fetchPriorityCases();
  const neglected = await findNeglectedCases();

  if (priorityCases.length === 0) {
    logger.info("morning_brief: no priority cases, skipping all sends");
    await dispatcher.log({
      jobType: "morning_brief",
      recipientUserId: null,
      channel: "telegram",
      caseCount: 0,
      payloadSummary: { priority_count: 0, neglected_count: 0, case_refs: [] },
      status: "skipped_empty",
    });
    return;
  }

  const byAssignee = groupByAssignee(priorityCases);
  const neglectedByStaff = groupByAssignee(neglected);
  const enabledStaff = await loadEnabledStaff("morning_brief");
  const staffById = new Map(enabledStaff.map((s) => [s.id, s]));

  for (const [userId, cases] of byAssignee) {
    if (!userId) continue; // unassigned cases only appear in CEO rollup
    const staff = staffById.get(userId);
    if (!staff) continue;

    if (await dispatcher.alreadySentToday("morning_brief", userId)) {
      logger.info({ userId }, "morning_brief: already sent today, skipping");
      continue;
    }

    const neglectedForStaff = neglectedByStaff.get(userId) ?? [];
    await sendStaffBrief(dispatcher, staff, cases, neglectedForStaff, cfg.commandCentreUrl);
  }

  // CEO rollup (always Telegram)
  const assigneeNames = new Map<string, string>();
  for (const c of priorityCases) {
    if (c.assigned_to_user_id && c.assignee_full_name) {
      assigneeNames.set(c.assigned_to_user_id, c.assignee_full_name);
    }
  }

  const rollup = buildCeoRollup(byAssignee, neglected, assigneeNames, cfg.telegram.ceoChatId);
  const rollupResult = await dispatcher.sendTelegram(rollup);
  await dispatcher.log({
    jobType: "ceo_rollup",
    recipientUserId: null,
    channel: "telegram",
    caseCount: priorityCases.length,
    payloadSummary: {
      priority_count: priorityCases.length,
      neglected_count: neglected.length,
      case_refs: priorityCases.map((c) => c.case_reference ?? c.id).slice(0, 30),
    },
    status: cfg.dryRun ? "dry_run" : rollupResult.ok ? "sent" : "failed",
    error: rollupResult.error,
  });

  if (!rollupResult.ok && !cfg.dryRun) {
    await writeFallbackRollup(rollup.text).catch((e) =>
      logger.error({ err: (e as Error).message }, "fallback rollup write failed"),
    );
  }

  logger.info({ sent: dispatcher.currentCount }, "morning_brief: done");
}

async function sendStaffBrief(
  dispatcher: Dispatcher,
  staff: StaffUser,
  cases: CaseLite[],
  neglectedForStaff: CaseLite[],
  commandCentreUrl: string,
): Promise<void> {
  const cfg = loadConfig();
  const refs = cases.map((c) => c.case_reference ?? c.id).slice(0, 20);

  // Preferred: Telegram
  if (staff.telegram_chat_id) {
    const payload = buildStaffBriefTelegram(staff, cases, neglectedForStaff, commandCentreUrl);
    if (payload) {
      const result = await dispatcher.sendTelegram(payload);
      await dispatcher.log({
        jobType: "morning_brief",
        recipientUserId: staff.id,
        channel: "telegram",
        caseCount: cases.length,
        payloadSummary: {
          priority_count: cases.length,
          neglected_count: neglectedForStaff.length,
          case_refs: refs,
        },
        status: statusFor(result.ok, cfg.dryRun),
        error: result.error,
      });
      return;
    }
  }

  // Fallback: WhatsApp via staff_assignment_alert template (3 vars — cramped but works)
  if (staff.whatsapp_number) {
    const firstName = staff.full_name?.split(" ")[0] ?? "there";
    const header = `🔔 Priority Cases (${cases.length})`;
    const details =
      `${cases.length} priority cases assigned to you today. ` +
      `${neglectedForStaff.length} require outbound follow-up in the last 24h. ` +
      `Review in Command Centre: ${commandCentreUrl}`;
    const detailsClamped = details.slice(0, 200);

    const result = await dispatcher.sendWhatsApp({
      to: staff.whatsapp_number,
      template_name: "staff_assignment_alert",
      variables: [firstName, header, detailsClamped],
    });
    await dispatcher.log({
      jobType: "morning_brief",
      recipientUserId: staff.id,
      channel: "whatsapp",
      caseCount: cases.length,
      payloadSummary: {
        priority_count: cases.length,
        neglected_count: neglectedForStaff.length,
        case_refs: refs,
      },
      status: statusFor(result.ok, cfg.dryRun),
      error: result.error,
    });
    return;
  }

  // No channel available
  await dispatcher.log({
    jobType: "morning_brief",
    recipientUserId: staff.id,
    channel: "telegram",
    caseCount: cases.length,
    payloadSummary: {
      priority_count: cases.length,
      neglected_count: neglectedForStaff.length,
      case_refs: refs,
    },
    status: "skipped_empty",
    error: "no_channel",
  });
}

export async function runEscalationSweep(): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = new Dispatcher();
  dispatcher.resetCounter();

  logger.info({ dryRun: cfg.dryRun }, "escalation_sweep: start");

  const neglected = await findNeglectedCases();
  if (neglected.length === 0) {
    logger.info("escalation_sweep: none neglected");
    return;
  }

  const enabledStaff = await loadEnabledStaff("escalation");
  const staffById = new Map(enabledStaff.map((s) => [s.id, s]));

  for (const c of neglected) {
    if (!c.assigned_to_user_id) continue;
    const staff = staffById.get(c.assigned_to_user_id);
    if (!staff) continue;

    if (await dispatcher.caseNudgedToday(c.id)) continue;

    if (staff.telegram_chat_id) {
      const payload = buildEscalationNudgeTelegram(staff, c, cfg.commandCentreUrl);
      if (payload) {
        const result = await dispatcher.sendTelegram({
          chat_id: payload.chat_id,
          text: payload.text,
          parse_mode: payload.parse_mode,
        });
        await dispatcher.log({
          jobType: "escalation_sweep",
          recipientUserId: staff.id,
          channel: "telegram",
          caseCount: 1,
          payloadSummary: { case_id: c.id, case_ref: c.case_reference ?? c.id.slice(0, 8) },
          status: statusFor(result.ok, cfg.dryRun),
          error: result.error,
        });
        continue;
      }
    }

    // Fallback: WhatsApp via staff_assignment_alert template
    if (staff.whatsapp_number) {
      const firstName = staff.full_name?.split(" ")[0] ?? "there";
      const header = `⚠️ Case Needs Action`;
      const ref = c.case_reference ?? c.id.slice(0, 8);
      const who = c.person_full_name ?? "—";
      const details =
        `Case ${ref} (${who}) has not had client contact in 24h+. ` +
        `Please action today.`.slice(0, 200);

      const result = await dispatcher.sendWhatsApp({
        to: staff.whatsapp_number,
        template_name: "staff_assignment_alert",
        variables: [firstName, header, details.slice(0, 200)],
      });
      await dispatcher.log({
        jobType: "escalation_sweep",
        recipientUserId: staff.id,
        channel: "whatsapp",
        caseCount: 1,
        payloadSummary: { case_id: c.id, case_ref: ref },
        status: statusFor(result.ok, cfg.dryRun),
        error: result.error,
      });
    }
  }

  logger.info({ nudged: dispatcher.currentCount }, "escalation_sweep: done");
}

export async function runCeoHealthCheck(): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = new Dispatcher();

  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);

  const { data: logs } = await supabase
    .from("priority_briefings_log")
    .select("status, job_type")
    .eq("org_id", cfg.supabase.orgId)
    .eq("run_date", today);

  const counts = { sent: 0, failed: 0, dry_run: 0, skipped: 0 };
  for (const l of logs ?? []) {
    if (l.status === "sent") counts.sent++;
    else if (l.status === "failed") counts.failed++;
    else if (l.status === "dry_run") counts.dry_run++;
    else counts.skipped++;
  }

  const text = [
    "🩺 *Priority Briefing — Daily Health Check*",
    `Date: ${today}`,
    ``,
    `• Sent: ${counts.sent}`,
    `• Failed: ${counts.failed}${counts.failed > 0 ? " ⚠️" : ""}`,
    `• Dry-run: ${counts.dry_run}`,
    `• Skipped: ${counts.skipped}`,
  ].join("\n");

  const result = await dispatcher.sendTelegram({
    chat_id: cfg.telegram.ceoChatId,
    text,
    parse_mode: "Markdown",
  });

  await dispatcher.log({
    jobType: "health_check",
    recipientUserId: null,
    channel: "telegram",
    caseCount: 0,
    payloadSummary: counts,
    status: statusFor(result.ok, cfg.dryRun),
    error: result.error,
  });
}

// ---- helpers ----

function statusFor(ok: boolean, dryRun: boolean): SendStatus {
  if (dryRun) return "dry_run";
  return ok ? "sent" : "failed";
}

async function loadEnabledStaff(
  filter: "morning_brief" | "escalation",
): Promise<StaffUser[]> {
  const supabase = getSupabase();
  const col =
    filter === "morning_brief" ? "morning_brief_enabled" : "escalation_nudges_enabled";

  const { data, error } = await supabase
    .from("staff_notification_prefs")
    .select(`
      user_id, timezone, morning_brief_enabled, escalation_nudges_enabled, telegram_chat_id,
      user:users!staff_notification_prefs_user_id_fkey(
        id, full_name, email, whatsapp_number, is_active
      )
    `)
    .eq(col, true);

  if (error) {
    logger.error({ err: error.message }, "loadEnabledStaff failed");
    return [];
  }

  return (data ?? [])
    .filter((row: any) => row.user?.is_active)
    .map((row: any) => ({
      id: row.user.id,
      full_name: row.user.full_name,
      email: row.user.email,
      whatsapp_number: row.user.whatsapp_number,
      telegram_chat_id: row.telegram_chat_id,
      timezone: row.timezone,
      morning_brief_enabled: row.morning_brief_enabled,
      escalation_nudges_enabled: row.escalation_nudges_enabled,
    }));
}

async function writeFallbackRollup(text: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = "/data/priority-briefing/failed-rollups";
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const filename = path.join(dir, `${new Date().toISOString().slice(0, 10)}.txt`);
  await fs.writeFile(filename, text, "utf-8");
  logger.warn({ filename }, "Telegram failed — rollup saved to disk");
}
