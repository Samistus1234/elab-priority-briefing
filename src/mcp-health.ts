import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { getSupabase } from "./supabase.js";

export interface McpCallRow {
  tool: string;
  ok: boolean;
  error: string | null;
  duration_ms: number;
  arg_keys: string[] | null;
  created_at: string;
}

export interface ToolStat {
  tool: string;
  calls: number;
  failures: number;
  failureRate: number; // 0..1
  sampleErrors: string[]; // up to 3 distinct
}

export interface McpStats {
  totalCalls: number;
  totalFailures: number;
  toolsUsed: number;
  perTool: ToolStat[];
  failing: ToolStat[];
  lookbackHours: number;
}

export function aggregateRows(rows: McpCallRow[], lookbackHours: number): McpStats {
  const map = new Map<string, { calls: number; failures: number; errs: string[] }>();
  for (const r of rows) {
    const e = map.get(r.tool) ?? { calls: 0, failures: 0, errs: [] };
    e.calls += 1;
    if (!r.ok) {
      e.failures += 1;
      if (r.error && !e.errs.includes(r.error) && e.errs.length < 3) {
        e.errs.push(r.error);
      }
    }
    map.set(r.tool, e);
  }

  const perTool: ToolStat[] = [...map.entries()].map(([tool, e]) => ({
    tool,
    calls: e.calls,
    failures: e.failures,
    failureRate: e.calls === 0 ? 0 : e.failures / e.calls,
    sampleErrors: e.errs,
  }));
  perTool.sort((a, b) => b.failures - a.failures || b.calls - a.calls);

  return {
    totalCalls: rows.length,
    totalFailures: rows.filter((r) => !r.ok).length,
    toolsUsed: map.size,
    perTool,
    failing: perTool.filter((t) => t.failures > 0),
    lookbackHours,
  };
}

export function buildMcpDigest(stats: McpStats, diagnosis?: string): string {
  const h = stats.lookbackHours;

  if (stats.totalCalls === 0) {
    return `🔭 *MCP Health* — no tool calls logged in the last ${h}h (server idle or telemetry off).`;
  }

  if (stats.totalFailures === 0) {
    return `✅ *MCP Health* — ${stats.toolsUsed} tools, ${stats.totalCalls} calls, 0 failures (last ${h}h).`;
  }

  const lines: string[] = [];
  lines.push(
    `⚠️ *MCP Health* — ${stats.totalFailures} failure(s) across ${stats.failing.length} tool(s) in the last ${h}h.`,
  );
  lines.push(`Total: ${stats.totalCalls} calls / ${stats.toolsUsed} tools.`);
  lines.push("");
  for (const t of stats.failing) {
    const pct = Math.round(t.failureRate * 100);
    lines.push(`🔴 \`${t.tool}\` — ${t.failures}/${t.calls} failed (${pct}%)`);
    if (t.sampleErrors[0]) lines.push(`   ↳ ${t.sampleErrors[0].slice(0, 160)}`);
  }
  if (diagnosis && diagnosis.trim()) {
    lines.push("");
    lines.push("*Diagnosis*");
    lines.push(diagnosis.trim());
  }
  return lines.join("\n");
}

/** Fetch the last `lookbackHours` of tool calls for this org and aggregate. */
export async function gatherMcpStats(lookbackHours: number): Promise<McpStats> {
  const supabase = getSupabase();
  const cfg = loadConfig();
  const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();

  const { data, error } = await supabase
    .from("mcp_tool_calls")
    .select("tool, ok, error, duration_ms, arg_keys, created_at")
    .eq("org_id", cfg.supabase.orgId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    logger.error({ err: error.message }, "gatherMcpStats query failed");
    return aggregateRows([], lookbackHours);
  }
  return aggregateRows((data ?? []) as McpCallRow[], lookbackHours);
}

/** Delete telemetry rows older than `retentionDays`. Never throws. */
export async function pruneOldMcpCalls(retentionDays = 90): Promise<void> {
  const supabase = getSupabase();
  const cfg = loadConfig();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

  const { error } = await supabase
    .from("mcp_tool_calls")
    .delete()
    .eq("org_id", cfg.supabase.orgId)
    .lt("created_at", cutoff);

  if (error) logger.error({ err: error.message }, "pruneOldMcpCalls failed");
}

/** One Anthropic completion diagnosing the failing tools. Empty string if no key. */
export async function diagnoseFailures(failing: ToolStat[]): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.llm.apiKey || failing.length === 0) return "";

  const client = new Anthropic({ apiKey: cfg.llm.apiKey });
  const failureBlock = failing
    .map(
      (t) =>
        `- ${t.tool}: ${t.failures}/${t.calls} failed. Sample errors: ${
          t.sampleErrors.join(" | ") || "(none captured)"
        }`,
    )
    .join("\n");

  const system = [
    "You diagnose failures in the ELAB MCP tool server (elab-ops-monitor).",
    "These are TypeScript tool functions in a single index.ts that query Supabase via PostgREST (supabase-js).",
    "For each failing tool give: (1) probable root cause, (2) one concrete fix — at most 2 sentences each.",
    "Be specific and terse. One markdown bullet per tool. No preamble.",
  ].join("\n");

  try {
    const resp = await client.messages.create({
      model: cfg.llm.model,
      max_tokens: 800,
      system,
      messages: [{ role: "user", content: `Failing MCP tools:\n${failureBlock}` }],
    });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (e) {
    logger.error({ err: (e as Error).message }, "diagnoseFailures failed");
    return "_(diagnosis unavailable — Anthropic call failed)_";
  }
}
