import { describe, it, expect } from "vitest";
import { aggregateRows, buildMcpDigest, type McpCallRow } from "../src/mcp-health.js";

function row(over: Partial<McpCallRow> = {}): McpCallRow {
  return {
    tool: "search_cases",
    ok: true,
    error: null,
    duration_ms: 10,
    arg_keys: ["q"],
    created_at: "2026-05-22T08:00:00.000Z",
    ...over,
  };
}

describe("aggregateRows", () => {
  it("returns zeros for empty input", () => {
    const s = aggregateRows([], 24);
    expect(s.totalCalls).toBe(0);
    expect(s.totalFailures).toBe(0);
    expect(s.toolsUsed).toBe(0);
    expect(s.failing).toEqual([]);
    expect(s.lookbackHours).toBe(24);
  });

  it("counts calls, failures, and failure rate per tool", () => {
    const s = aggregateRows(
      [
        row({ tool: "search_cases", ok: true }),
        row({ tool: "search_cases", ok: false, error: "boom" }),
        row({ tool: "search_invoices", ok: false, error: "embed crash" }),
      ],
      24,
    );
    expect(s.totalCalls).toBe(3);
    expect(s.totalFailures).toBe(2);
    expect(s.toolsUsed).toBe(2);
    const inv = s.perTool.find((t) => t.tool === "search_invoices")!;
    expect(inv.failures).toBe(1);
    expect(inv.calls).toBe(1);
    expect(inv.failureRate).toBe(1);
  });

  it("sorts perTool by failures desc then calls desc and exposes failing subset", () => {
    const s = aggregateRows(
      [
        row({ tool: "a", ok: true }),
        row({ tool: "a", ok: true }),
        row({ tool: "b", ok: false, error: "x" }),
      ],
      24,
    );
    expect(s.perTool[0].tool).toBe("b");
    expect(s.failing.map((t) => t.tool)).toEqual(["b"]);
  });

  it("collects up to 3 distinct sample errors", () => {
    const s = aggregateRows(
      [
        row({ tool: "x", ok: false, error: "e1" }),
        row({ tool: "x", ok: false, error: "e1" }),
        row({ tool: "x", ok: false, error: "e2" }),
        row({ tool: "x", ok: false, error: "e3" }),
        row({ tool: "x", ok: false, error: "e4" }),
      ],
      24,
    );
    const x = s.perTool.find((t) => t.tool === "x")!;
    expect(x.sampleErrors).toEqual(["e1", "e2", "e3"]);
  });
});

describe("buildMcpDigest", () => {
  it("reports idle when there are no calls", () => {
    const text = buildMcpDigest(aggregateRows([], 24));
    expect(text).toContain("no tool calls");
    expect(text).toContain("24h");
  });

  it("reports healthy when there are calls but no failures", () => {
    const rows = [row({ tool: "a" }), row({ tool: "b" })];
    const text = buildMcpDigest(aggregateRows(rows, 24));
    expect(text).toContain("✅");
    expect(text).toContain("0 failures");
    expect(text).toContain("2 calls");
  });

  it("lists failing tools and appends diagnosis when present", () => {
    const rows = [
      row({ tool: "search_invoices", ok: false, error: "embed parser crash" }),
      row({ tool: "search_invoices", ok: true }),
    ];
    const text = buildMcpDigest(aggregateRows(rows, 24), "- search_invoices: rewrite query");
    expect(text).toContain("⚠️");
    expect(text).toContain("`search_invoices`");
    expect(text).toContain("embed parser crash");
    expect(text).toContain("Diagnosis");
    expect(text).toContain("rewrite query");
  });

  it("omits the Diagnosis section when diagnosis is blank/whitespace", () => {
    const rows = [row({ tool: "x", ok: false, error: "boom" })];
    const text = buildMcpDigest(aggregateRows(rows, 24), "   ");
    expect(text).not.toContain("Diagnosis");
  });

  it("renders sample errors Telegram-Markdown-safe and rounds failure rate", () => {
    const rows = [
      row({ tool: "y", ok: false, error: 'relation "x" does not *exist* `weird`' }),
      row({ tool: "y", ok: true }),
      row({ tool: "y", ok: true }),
    ];
    const text = buildMcpDigest(aggregateRows(rows, 24));
    expect(text).toContain("(33%)"); // 1/3 rounded
    expect(text).not.toContain("`weird`"); // backticks stripped from error content
    expect(text).toContain("does not *exist*"); // literal, but now inside a code span
  });
});
