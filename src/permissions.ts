import { getSupabase } from "./supabase.js";
import { logger } from "./logger.js";

/**
 * Permission/scope resolver.
 *
 * Three tiers:
 *  - ceo: sees and actions everything
 *  - lead: sees and actions their direct reports' cases (via users.reports_to_user_id)
 *  - staff: sees only cases assigned to themselves
 *
 * CEO detection: configurable via env CEO_USER_IDS (comma-separated uuids) OR
 * any user whose staff_role row has name containing 'ceo' / 'admin' / 'owner'.
 * For simplicity v1 uses env list; fall back to top-of-reports-chain.
 */

export type Role = "ceo" | "lead" | "staff";

export type Scope = {
  user_id: string;
  full_name: string;
  email: string;
  role: Role;
  /** user_ids this person can see cases for (includes self) */
  visible_user_ids: string[];
  /** If true, person can see unassigned cases too (CEO only) */
  can_see_unassigned: boolean;
  /** If true, can send WhatsApp replies on behalf of ELAB */
  can_reply: boolean;
  /** If true, can add notes to cases they see */
  can_note: boolean;
  /** If true, can escalate to CEO */
  can_escalate: boolean;
};

const CEO_USER_IDS: string[] =
  (process.env.CEO_USER_IDS ?? "63986b60-0600-4a08-a76f-fc1e02a9f400")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export async function resolveScopeForUser(userId: string): Promise<Scope | null> {
  const supabase = getSupabase();

  const { data: me, error } = await supabase
    .from("users")
    .select("id, full_name, email, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (error || !me || !me.is_active) {
    logger.warn({ userId, err: error?.message }, "resolveScopeForUser: user not found or inactive");
    return null;
  }

  const isCeo = CEO_USER_IDS.includes(userId);

  // Lead detection (kept for display purposes only, since scope is now flat)
  const { data: reports } = await supabase
    .from("users")
    .select("id")
    .eq("reports_to_user_id", userId)
    .eq("is_active", true);

  const reportIds: string[] = (reports ?? []).map((r: any) => r.id);
  const isLead = !isCeo && reportIds.length > 0;

  const role: Role = isCeo ? "ceo" : isLead ? "lead" : "staff";

  // FLAT model: every active user sees every active user's cases.
  // This mirrors how ELAB staff already operate in Command Centre — they
  // routinely cover for each other and look up any case. Tight scoping
  // would just push them back to the web UI.
  const { data: allUsers } = await supabase
    .from("users")
    .select("id")
    .eq("is_active", true);
  const visible_user_ids: string[] = (allUsers ?? []).map((u: any) => u.id);

  return {
    user_id: userId,
    full_name: me.full_name,
    email: me.email,
    role,
    visible_user_ids,
    can_see_unassigned: true, // everyone can see unassigned cases
    can_reply: true,          // everyone can draft + /confirm a WhatsApp reply
    can_note: true,           // everyone can note any case
    can_escalate: !isCeo,     // CEO doesn't escalate to self
  };
}

/** Look up a staff user by their telegram chat_id. */
export async function findUserByChatId(chatId: string | number): Promise<string | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("staff_notification_prefs")
    .select("user_id")
    .eq("telegram_chat_id", String(chatId))
    .maybeSingle();
  return data?.user_id ?? null;
}
