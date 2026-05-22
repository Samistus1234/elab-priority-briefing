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
