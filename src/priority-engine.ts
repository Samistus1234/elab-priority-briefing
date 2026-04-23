import { getSupabase } from "./supabase.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import type { CaseLite, PriorityReason } from "./types.js";
import { AUTO_PRIORITY_REASONS } from "./types.js";

/**
 * Priority Engine — pure logic around case prioritization.
 *
 * Responsibilities:
 *  1. Evaluate the 6 auto-rules and raise priority on matching cases.
 *  2. Find priority cases that have been neglected (>24h no outbound).
 *  3. Group cases by assignee for per-staff briefings.
 *
 * Design:
 *  - No message formatting or sending here.
 *  - No LLM.
 *  - All rules expressed as SQL or deterministic filters — testable in isolation.
 *  - Manual priority (priority_reason = 'manual') is never downgraded automatically.
 */

const STUCK_DAYS = 7;
const LONG_RUNNING_DAYS = 45;
const ERROR_TAGS = ["error", "issue"];
const VIP_TAGS = ["vip", "referred"];

type EvaluationResult = {
  newlyFlagged: Array<{ case_id: string; reason: PriorityReason }>;
  totalHighPriority: number;
};

/**
 * Apply all 6 auto-rules. Flips matching cases to priority='high' with the
 * earliest-matching reason (rule order: sla_breach > unanswered > stuck > error > long_running > vip).
 * Does NOT touch cases already at 'high' (preserves manual flags and existing reasons).
 */
export async function evaluatePriority(): Promise<EvaluationResult> {
  const supabase = getSupabase();
  const { orgId } = loadConfig().supabase;
  const now = new Date().toISOString();

  // Fetch candidates with the signals we need (inline — no RPC dependency).
  const rows = await fetchCandidatesInline();

  const toFlag: Array<{ case_id: string; reason: PriorityReason }> = [];

  for (const c of rows) {
    if (c.priority === "high" || c.priority === "urgent") continue; // already prioritised
    if (c.status !== "active" || c.is_archived) continue;

    const reason = classify(c, now);
    if (reason) {
      toFlag.push({ case_id: c.id, reason });
    }
  }

  // Batch update
  if (toFlag.length > 0) {
    // Group by reason to minimize queries
    const byReason = new Map<PriorityReason, string[]>();
    for (const { case_id, reason } of toFlag) {
      const arr = byReason.get(reason) ?? [];
      arr.push(case_id);
      byReason.set(reason, arr);
    }

    const CHUNK = 200;
    for (const [reason, ids] of byReason) {
      let chunkErrors = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { error: updErr } = await supabase
          .from("cases")
          .update({
            priority: "high",
            priority_reason: reason,
            priority_set_at: now,
          })
          .in("id", slice);
        if (updErr) {
          chunkErrors++;
          logger.error(
            { err: updErr.message, reason, chunk_size: slice.length },
            "Failed to raise priority for chunk",
          );
        }
      }
      logger.info(
        { reason, count: ids.length, chunk_errors: chunkErrors },
        "Raised priority",
      );
    }
  }

  // Count total high/urgent after the update
  const { count: totalHighPriority } = await supabase
    .from("cases")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("is_archived", false)
    .eq("status", "active")
    .in("priority", ["high", "urgent"]);

  return { newlyFlagged: toFlag, totalHighPriority: totalHighPriority ?? 0 };
}

type RawCandidate = {
  id: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "active" | "on_hold" | "completed" | "cancelled";
  is_archived: boolean;
  tags: string[];
  sla_deadline_at: string | null;
  created_at: string;
  last_stage_change_at: string | null;
  last_client_outbound_at: string | null;
  latest_inbound_at: string | null;
};

/**
 * Inline fallback when the RPC is missing. Builds the candidate set via
 * LATERAL-style subqueries against activity_log + case_stage_history.
 * Kept simple with separate queries — correctness over perf on cold start.
 */
async function fetchCandidatesInline(): Promise<RawCandidate[]> {
  const { orgId } = loadConfig().supabase;
  const supabase = getSupabase();

  // Base cases
  const { data: cases, error } = await supabase
    .from("cases")
    .select("id, priority, status, is_archived, tags, sla_deadline_at, created_at")
    .eq("org_id", orgId)
    .eq("is_archived", false)
    .eq("status", "active");

  if (error || !cases) {
    logger.error({ err: error?.message }, "fetchCandidatesInline: base query failed");
    return [];
  }

  if (cases.length === 0) return [];

  const ids = cases.map((c) => c.id);

  // Latest stage change per case
  const { data: stageHistory } = await supabase
    .from("case_stage_history")
    .select("case_id, created_at")
    .in("case_id", ids)
    .order("created_at", { ascending: false });

  const lastStageByCase = new Map<string, string>();
  for (const h of stageHistory ?? []) {
    if (!lastStageByCase.has(h.case_id)) lastStageByCase.set(h.case_id, h.created_at);
  }

  // Latest outbound client message per case (activity_log)
  const { data: outbounds } = await supabase
    .from("activity_log")
    .select("entity_id, created_at")
    .in("entity_id", ids)
    .eq("entity_type", "case")
    .in("action", ["whatsapp_message_sent", "message_sent_email", "whatsapp_template_sent"])
    .order("created_at", { ascending: false });

  const lastOutboundByCase = new Map<string, string>();
  for (const a of outbounds ?? []) {
    if (!lastOutboundByCase.has(a.entity_id)) lastOutboundByCase.set(a.entity_id, a.created_at);
  }

  // Latest inbound client message per case (activity_log)
  const { data: inbounds } = await supabase
    .from("activity_log")
    .select("entity_id, created_at")
    .in("entity_id", ids)
    .eq("entity_type", "case")
    .eq("action", "message_received")
    .order("created_at", { ascending: false });

  const lastInboundByCase = new Map<string, string>();
  for (const a of inbounds ?? []) {
    if (!lastInboundByCase.has(a.entity_id)) lastInboundByCase.set(a.entity_id, a.created_at);
  }

  return cases.map((c) => ({
    id: c.id,
    priority: c.priority,
    status: c.status,
    is_archived: c.is_archived,
    tags: c.tags ?? [],
    sla_deadline_at: c.sla_deadline_at,
    created_at: c.created_at,
    last_stage_change_at: lastStageByCase.get(c.id) ?? c.created_at,
    last_client_outbound_at: lastOutboundByCase.get(c.id) ?? null,
    latest_inbound_at: lastInboundByCase.get(c.id) ?? null,
  }));
}

/**
 * Apply the 6 rules. Returns the reason if the case should be flagged, else null.
 * Rule priority order: sla_breach > unanswered > stuck > error > long_running > vip.
 * PURE function — safe to unit-test with in-memory fixtures.
 */
export function classify(c: RawCandidate, nowIso: string): PriorityReason | null {
  const now = new Date(nowIso).getTime();

  // R2: SLA breached
  if (c.sla_deadline_at && new Date(c.sla_deadline_at).getTime() < now) {
    return "sla_breach";
  }

  // R3: client message unanswered 24h+
  if (c.latest_inbound_at) {
    const inbound = new Date(c.latest_inbound_at).getTime();
    const outbound = c.last_client_outbound_at
      ? new Date(c.last_client_outbound_at).getTime()
      : 0;
    if (inbound > outbound && now - inbound > 24 * 60 * 60 * 1000) {
      return "unanswered_client";
    }
  }

  // R1: stuck >3 days in same stage (or since creation if no stage change)
  const lastChange = c.last_stage_change_at ?? c.created_at;
  const daysSinceChange = (now - new Date(lastChange).getTime()) / (24 * 60 * 60 * 1000);
  if (daysSinceChange > STUCK_DAYS) {
    return "stuck_7d";
  }

  // R4: error/issue tag
  if (c.tags.some((t) => ERROR_TAGS.includes(t))) {
    return "error_tag";
  }

  // R5: long-running (>45 days old, still active)
  const ageDays = (now - new Date(c.created_at).getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > LONG_RUNNING_DAYS) {
    return "long_running_45d";
  }

  // R6: VIP/referred tag
  if (c.tags.some((t) => VIP_TAGS.includes(t))) {
    return "vip_tag";
  }

  return null;
}

/**
 * Fetch all currently-priority cases (for briefings). Includes assignee + person + stage joins.
 */
export async function fetchPriorityCases(): Promise<CaseLite[]> {
  const { orgId } = loadConfig().supabase;
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("cases")
    .select(`
      id, case_reference, priority, priority_reason, priority_set_at,
      status, assigned_to_user_id, current_stage_id, sla_deadline_at, tags,
      created_at, updated_at,
      person:persons!cases_person_id_fkey(first_name, last_name),
      assignee:users!cases_assigned_to_user_id_fkey(id, full_name, whatsapp_number),
      stage:pipeline_stages!cases_current_stage_id_fkey(name),
      pipeline:pipelines!cases_pipeline_id_fkey(name)
    `)
    .eq("org_id", orgId)
    .eq("is_archived", false)
    .eq("status", "active")
    .in("priority", ["high", "urgent"])
    .order("priority_set_at", { ascending: false, nullsFirst: false })
    .limit(5000);

  if (error) {
    logger.error({ err: error.message }, "fetchPriorityCases failed");
    return [];
  }

  return (data ?? []).map((row: any) => ({
    id: row.id,
    case_reference: row.case_reference,
    priority: row.priority,
    priority_reason: row.priority_reason,
    priority_set_at: row.priority_set_at,
    status: row.status,
    assigned_to_user_id: row.assigned_to_user_id,
    current_stage_id: row.current_stage_id,
    sla_deadline_at: row.sla_deadline_at,
    tags: row.tags ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    person_full_name: row.person
      ? `${row.person.first_name ?? ""} ${row.person.last_name ?? ""}`.trim() || null
      : null,
    stage_name: row.stage?.name ?? null,
    pipeline_name: row.pipeline?.name ?? null,
    assignee_full_name: row.assignee?.full_name ?? null,
    assignee_whatsapp: row.assignee?.whatsapp_number ?? null,
  }));
}

/**
 * Find priority cases neglected for > neglectThresholdHours (no outbound client contact).
 * Uses priority_set_at or last_client_outbound_at — whichever is later.
 */
export async function findNeglectedCases(): Promise<CaseLite[]> {
  const { neglectThresholdHours } = loadConfig();
  const priorityCases = await fetchPriorityCases();
  if (priorityCases.length === 0) return [];

  const ids = priorityCases.map((c) => c.id);
  const supabase = getSupabase();

  const { data: outbounds } = await supabase
    .from("activity_log")
    .select("entity_id, created_at")
    .in("entity_id", ids)
    .eq("entity_type", "case")
    .in("action", ["whatsapp_message_sent", "message_sent_email", "whatsapp_template_sent"])
    .order("created_at", { ascending: false });

  const latestOutbound = new Map<string, string>();
  for (const a of outbounds ?? []) {
    if (!latestOutbound.has(a.entity_id)) latestOutbound.set(a.entity_id, a.created_at);
  }

  const thresholdMs = neglectThresholdHours * 60 * 60 * 1000;
  const now = Date.now();

  return priorityCases
    .map((c) => ({ ...c, last_client_outbound_at: latestOutbound.get(c.id) ?? null }))
    .filter((c) => {
      const reference = c.last_client_outbound_at
        ? new Date(c.last_client_outbound_at).getTime()
        : c.priority_set_at
          ? new Date(c.priority_set_at).getTime()
          : new Date(c.created_at).getTime();
      return now - reference > thresholdMs;
    });
}

/** Group cases by assignee. Unassigned cases go under null. PURE. */
export function groupByAssignee(cases: CaseLite[]): Map<string | null, CaseLite[]> {
  const groups = new Map<string | null, CaseLite[]>();
  for (const c of cases) {
    const key = c.assigned_to_user_id;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  return groups;
}

// Re-export for tests that want constants
export const PRIORITY_THRESHOLDS = {
  STUCK_DAYS,
  LONG_RUNNING_DAYS,
  ERROR_TAGS,
  VIP_TAGS,
  AUTO_PRIORITY_REASONS,
};
