import { getSupabase } from "./supabase.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import type { Scope } from "./permissions.js";

/**
 * LLM tools — read-only Supabase queries exposed to Claude via function-calling.
 * Every tool receives the current Scope and enforces visibility there.
 *
 * Tool outputs are compact JSON / text meant for the LLM to consume, not for
 * direct display. The LLM rephrases for the user.
 */

export type ToolInput = Record<string, unknown>;
export type ToolResult = { ok: boolean; data?: unknown; error?: string };

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (scope: Scope, input: ToolInput) => Promise<ToolResult>;
};

export const tools: ToolDefinition[] = [
  {
    name: "list_my_priority_cases",
    description:
      "List all priority (high) cases assigned to the requesting user. Returns up to 30 cases with reference, client name, pipeline, stage, priority_reason.",
    input_schema: { type: "object", properties: {}, required: [] },
    async run(scope) {
      const supabase = getSupabase();
      const cfg = loadConfig();
      const { data, error } = await supabase
        .from("cases")
        .select(`
          case_reference, priority_reason, priority_set_at,
          person:persons!cases_person_id_fkey(first_name, last_name),
          stage:pipeline_stages!cases_current_stage_id_fkey(name),
          pipeline:pipelines!cases_pipeline_id_fkey(name)
        `)
        .eq("org_id", cfg.supabase.orgId)
        .eq("is_archived", false)
        .eq("status", "active")
        .in("priority", ["high", "urgent"])
        .eq("assigned_to_user_id", scope.user_id)
        .order("priority_set_at", { ascending: false })
        .limit(30);
      if (error) return { ok: false, error: error.message };
      return { ok: true, data };
    },
  },
  {
    name: "list_stuck_cases",
    description:
      "List cases currently flagged as stuck (no stage change in 7+ days). Scope-filtered: staff see only their own, leads see their team's, CEO sees all.",
    input_schema: { type: "object", properties: {}, required: [] },
    async run(scope) {
      const supabase = getSupabase();
      const cfg = loadConfig();
      let q = supabase
        .from("cases")
        .select(`
          case_reference, priority_set_at,
          person:persons!cases_person_id_fkey(first_name, last_name),
          assignee:users!cases_assigned_to_user_id_fkey(full_name),
          stage:pipeline_stages!cases_current_stage_id_fkey(name)
        `)
        .eq("org_id", cfg.supabase.orgId)
        .eq("is_archived", false)
        .eq("status", "active")
        .eq("priority_reason", "stuck_7d")
        .order("priority_set_at", { ascending: true })
        .limit(30);
      if (!scope.can_see_unassigned) {
        q = q.in("assigned_to_user_id", scope.visible_user_ids);
      }
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      return { ok: true, data };
    },
  },
  {
    name: "find_case",
    description:
      "Search cases by reference substring or client name (first or last). Returns up to 10 matches. Use this when the user mentions a case ref or client name.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search term — a case ref fragment or client name" },
      },
      required: ["query"],
    },
    async run(scope, input) {
      const query = String(input.query ?? "").trim();
      if (!query) return { ok: false, error: "query required" };

      const supabase = getSupabase();
      const cfg = loadConfig();

      // Try case_reference first, then person name
      const { data: byRef } = await supabase
        .from("cases")
        .select(`
          id, case_reference, status, priority, assigned_to_user_id,
          person:persons!cases_person_id_fkey(first_name, last_name),
          assignee:users!cases_assigned_to_user_id_fkey(full_name),
          stage:pipeline_stages!cases_current_stage_id_fkey(name),
          pipeline:pipelines!cases_pipeline_id_fkey(name)
        `)
        .eq("org_id", cfg.supabase.orgId)
        .eq("is_archived", false)
        .ilike("case_reference", `%${query}%`)
        .limit(10);

      if (byRef && byRef.length > 0) {
        const filtered = scope.can_see_unassigned
          ? byRef
          : byRef.filter((r: any) =>
              r.assigned_to_user_id && scope.visible_user_ids.includes(r.assigned_to_user_id),
            );
        return { ok: true, data: filtered };
      }

      // Fallback: search person name via a two-step query (more reliable than
      // PostgREST's foreign-table .or filter, which has been inconsistent).
      // Split on whitespace so "Zainab Oyelude" matches a person whose
      // first_name='Zainab' and last_name='Oyelude'.
      const tokens = query.split(/\s+/).filter((t) => t.length >= 2);
      const nameClauses: string[] = [];
      if (tokens.length === 0) {
        nameClauses.push(`first_name.ilike.%${query}%`, `last_name.ilike.%${query}%`);
      } else {
        for (const t of tokens) {
          const safe = t.replace(/,/g, "");
          nameClauses.push(`first_name.ilike.%${safe}%`, `last_name.ilike.%${safe}%`);
        }
      }

      const { data: rawPersons } = await supabase
        .from("persons")
        .select("id, first_name, last_name")
        .or(nameClauses.join(","))
        .limit(200);

      if (!rawPersons || rawPersons.length === 0) {
        return { ok: true, data: [] };
      }

      // For multi-token queries, require ALL tokens to appear in the full name
      // (prevents drowning in single-token matches for common names like "Zainab").
      const persons =
        tokens.length > 1
          ? rawPersons.filter((p: any) => {
              const fullName = `${p.first_name ?? ""} ${p.last_name ?? ""}`.toLowerCase();
              return tokens.every((t) => fullName.includes(t.toLowerCase()));
            })
          : rawPersons;

      if (persons.length === 0) {
        return { ok: true, data: [] };
      }

      const personIds = persons.map((p: any) => p.id);

      const { data: byName } = await supabase
        .from("cases")
        .select(`
          id, case_reference, status, priority, assigned_to_user_id,
          person:persons!cases_person_id_fkey(first_name, last_name),
          assignee:users!cases_assigned_to_user_id_fkey(full_name),
          stage:pipeline_stages!cases_current_stage_id_fkey(name),
          pipeline:pipelines!cases_pipeline_id_fkey(name)
        `)
        .eq("org_id", cfg.supabase.orgId)
        .eq("is_archived", false)
        .in("person_id", personIds)
        .limit(10);

      const result = byName ?? [];
      const filtered = scope.can_see_unassigned
        ? result
        : result.filter((r: any) =>
            r.assigned_to_user_id && scope.visible_user_ids.includes(r.assigned_to_user_id),
          );
      return { ok: true, data: filtered };
    },
  },
  {
    name: "get_case_detail",
    description:
      "Get full detail for a specific case by exact case_reference. Returns client info, stage, assignee, recent activity, last outbound/inbound times.",
    input_schema: {
      type: "object",
      properties: {
        case_reference: { type: "string", description: "The exact case reference, e.g. DFL-2181-0426-ELAB" },
      },
      required: ["case_reference"],
    },
    async run(scope, input) {
      const ref = String(input.case_reference ?? "").trim();
      if (!ref) return { ok: false, error: "case_reference required" };

      const supabase = getSupabase();
      const cfg = loadConfig();

      const { data: cases } = await supabase
        .from("cases")
        .select(`
          id, case_reference, priority, priority_reason, priority_set_at, status,
          assigned_to_user_id, sla_deadline_at, tags, created_at, updated_at,
          person:persons!cases_person_id_fkey(first_name, last_name, whatsapp_number, email),
          assignee:users!cases_assigned_to_user_id_fkey(full_name),
          stage:pipeline_stages!cases_current_stage_id_fkey(name),
          pipeline:pipelines!cases_pipeline_id_fkey(name)
        `)
        .eq("org_id", cfg.supabase.orgId)
        .ilike("case_reference", ref)
        .limit(1);

      if (!cases || cases.length === 0) return { ok: false, error: "case not found" };
      const c = cases[0] as any;

      if (!scope.can_see_unassigned && c.assigned_to_user_id && !scope.visible_user_ids.includes(c.assigned_to_user_id)) {
        return { ok: false, error: "not in your scope" };
      }

      // Recent activity (5 entries)
      const { data: timeline } = await supabase
        .from("activity_log")
        .select("created_at, action, metadata")
        .eq("entity_id", c.id)
        .eq("entity_type", "case")
        .order("created_at", { ascending: false })
        .limit(5);

      // Last outbound / last inbound via whatsapp_messages if person_id known
      let last_inbound: string | null = null;
      let last_outbound: string | null = null;
      if (c.person?.whatsapp_number) {
        const { data: msgs } = await supabase
          .from("whatsapp_messages")
          .select("created_at, direction")
          .eq("conversation_id", c.id)
          .order("created_at", { ascending: false })
          .limit(5);
        if (msgs) {
          last_inbound = (msgs.find((m: any) => m.direction === "inbound")?.created_at) ?? null;
          last_outbound = (msgs.find((m: any) => m.direction === "outbound")?.created_at) ?? null;
        }
      }

      return {
        ok: true,
        data: { case: c, recent_activity: timeline ?? [], last_inbound, last_outbound },
      };
    },
  },
  {
    name: "list_unanswered_clients",
    description:
      "List cases where a client message came in but wasn't replied to in 24h+. Scope-filtered.",
    input_schema: { type: "object", properties: {}, required: [] },
    async run(scope) {
      const supabase = getSupabase();
      const cfg = loadConfig();
      let q = supabase
        .from("cases")
        .select(`
          case_reference, priority_set_at,
          person:persons!cases_person_id_fkey(first_name, last_name),
          assignee:users!cases_assigned_to_user_id_fkey(full_name)
        `)
        .eq("org_id", cfg.supabase.orgId)
        .eq("is_archived", false)
        .eq("status", "active")
        .eq("priority_reason", "unanswered_client")
        .order("priority_set_at", { ascending: true })
        .limit(20);
      if (!scope.can_see_unassigned) {
        q = q.in("assigned_to_user_id", scope.visible_user_ids);
      }
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      return { ok: true, data };
    },
  },
  {
    name: "whatsapp_inbox_waiting",
    description:
      "List open WhatsApp conversations where the CLIENT has sent the most recent message (i.e. we haven't replied yet). Returns up to 20 conversations sorted by oldest-waiting first. Use for questions like 'who's waiting in the inbox', 'any clients unreplied', 'WhatsApp queue'.",
    input_schema: {
      type: "object",
      properties: {
        min_hours_waiting: {
          type: "number",
          description:
            "Optional — only include conversations waiting at least this many hours. Default 0 (all).",
        },
      },
      required: [],
    },
    async run(_scope, input) {
      const minHours = Number(input.min_hours_waiting ?? 0);
      const supabase = getSupabase();
      const cfg = loadConfig();

      // Pull recent open WhatsApp conversations
      const { data: convs, error } = await supabase
        .from("conversations")
        .select(`
          id, last_message_at,
          person:persons!conversations_person_id_fkey(first_name, last_name, whatsapp_number),
          case_id
        `)
        .eq("org_id", cfg.supabase.orgId)
        .eq("channel_type", "whatsapp")
        .eq("status", "open")
        .order("last_message_at", { ascending: false })
        .limit(100);

      if (error || !convs) return { ok: false, error: error?.message ?? "no data" };

      // For each, find the latest message and its direction
      const convIds = convs.map((c: any) => c.id);
      if (convIds.length === 0) return { ok: true, data: [] };

      const { data: msgs } = await supabase
        .from("whatsapp_messages")
        .select("conversation_id, direction, created_at, message_body, body_text")
        .in("conversation_id", convIds)
        .order("created_at", { ascending: false });

      const latestByConv = new Map<string, any>();
      for (const m of msgs ?? []) {
        if (!latestByConv.has((m as any).conversation_id)) {
          latestByConv.set((m as any).conversation_id, m);
        }
      }

      const now = Date.now();
      const waiting = convs
        .map((c: any) => {
          const latest = latestByConv.get(c.id);
          if (!latest || latest.direction !== "inbound") return null;
          const hours = (now - new Date(latest.created_at).getTime()) / 3600000;
          if (hours < minHours) return null;
          const name = c.person
            ? `${c.person.first_name ?? ""} ${c.person.last_name ?? ""}`.trim()
            : "Unknown";
          return {
            person: name,
            phone: c.person?.whatsapp_number ?? null,
            last_inbound_at: latest.created_at,
            last_inbound_preview: (latest.message_body ?? latest.body_text ?? "").slice(0, 80),
            hours_waiting: Math.round(hours * 10) / 10,
            conversation_id: c.id,
            case_id: c.case_id,
          };
        })
        .filter((x) => x !== null)
        .sort((a: any, b: any) => b.hours_waiting - a.hours_waiting)
        .slice(0, 20);

      return { ok: true, data: waiting };
    },
  },
  {
    name: "team_summary",
    description:
      "CEO only. Returns a count breakdown of priority cases by assignee (who has how many). Use this for questions about team workload.",
    input_schema: { type: "object", properties: {}, required: [] },
    async run(scope) {
      if (scope.role !== "ceo") return { ok: false, error: "CEO only" };

      const supabase = getSupabase();
      const cfg = loadConfig();

      // Raw query: group by assignee
      const { data, error } = await supabase
        .from("cases")
        .select(`
          assigned_to_user_id,
          assignee:users!cases_assigned_to_user_id_fkey(full_name)
        `)
        .eq("org_id", cfg.supabase.orgId)
        .eq("is_archived", false)
        .eq("status", "active")
        .in("priority", ["high", "urgent"])
        .limit(5000);

      if (error) return { ok: false, error: error.message };

      const counts = new Map<string, number>();
      for (const row of (data ?? []) as any[]) {
        const name = row.assignee?.full_name ?? "Unassigned";
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const summary = Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      return { ok: true, data: summary };
    },
  },
];

/** Run a tool by name. Returns a result the LLM can consume. */
export async function runTool(
  scope: Scope,
  name: string,
  input: ToolInput,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };
  try {
    return await tool.run(scope, input);
  } catch (e) {
    logger.error({ err: (e as Error).message, tool: name }, "tool run crashed");
    return { ok: false, error: (e as Error).message };
  }
}
