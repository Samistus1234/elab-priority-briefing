/**
 * Shared types across modules. Keep this file free of runtime imports.
 */

export type PriorityReason =
  | "manual"
  | "stuck_7d"
  | "sla_breach"
  | "unanswered_client"
  | "error_tag"
  | "long_running_45d"
  | "vip_tag";

export const AUTO_PRIORITY_REASONS: PriorityReason[] = [
  "stuck_7d",
  "sla_breach",
  "unanswered_client",
  "error_tag",
  "long_running_45d",
  "vip_tag",
];

export type CaseLite = {
  id: string;
  case_reference: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  priority_reason: PriorityReason | null;
  priority_set_at: string | null;
  status: "active" | "on_hold" | "completed" | "cancelled";
  assigned_to_user_id: string | null;
  current_stage_id: string | null;
  sla_deadline_at: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;

  // Joined fields (may be absent depending on query)
  person_full_name?: string | null;
  stage_name?: string | null;
  pipeline_name?: string | null;
  assignee_full_name?: string | null;
  assignee_whatsapp?: string | null;

  // Computed (populated by priority-engine)
  last_stage_change_at?: string | null;
  last_client_outbound_at?: string | null;
};

export type StaffUser = {
  id: string;
  full_name: string;
  email: string;
  whatsapp_number: string | null;
  telegram_chat_id: string | null;
  timezone: string;
  morning_brief_enabled: boolean;
  escalation_nudges_enabled: boolean;
};

export type BriefingPayloadSummary = {
  priority_count: number;
  neglected_count: number;
  case_refs: string[];
};

export type JobType =
  | "morning_brief"
  | "escalation_sweep"
  | "ceo_rollup"
  | "health_check";

export type SendStatus =
  | "sent"
  | "failed"
  | "dry_run"
  | "skipped_duplicate"
  | "skipped_empty";

export type SendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};
