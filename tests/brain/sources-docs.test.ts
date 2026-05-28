import { describe, it, expect, vi } from "vitest";
import { fetchKnowledgeDocs, buildDocTranscript, hashDocContent, MAX_DOC_TRANSCRIPT_CHARS } from "../../src/brain/sources-docs.js";

function makeSb(rows: any[]) {
  const calls: any[] = [];
  const sb = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn((col: string, val: any) => {
          calls.push({ op: "eq", col, val });
          return {
            or: vi.fn((expr: string) => {
              calls.push({ op: "or", expr });
              return {
                order: vi.fn(() => ({
                  limit: vi.fn(async () => ({ data: rows, error: null })),
                })),
              };
            }),
          };
        }),
      })),
    })),
  };
  return { sb, calls };
}

describe("hashDocContent", () => {
  it("is stable for identical inputs", () => {
    expect(hashDocContent("hello")).toBe(hashDocContent("hello"));
  });
  it("differs when content changes", () => {
    expect(hashDocContent("hello")).not.toBe(hashDocContent("hello!"));
  });
  it("returns a 64-char hex sha256", () => {
    expect(hashDocContent("x")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("buildDocTranscript", () => {
  it("starts with the SOP-tagged us: line including the title", () => {
    const out = buildDocTranscript({ title: "Qatar DataFlow", content: "Body." });
    expect(out.startsWith("Us: [SOP] Qatar DataFlow\n\n")).toBe(true);
    expect(out).toContain("Body.");
  });

  it("head-truncates content exceeding the budget and marks the truncation", () => {
    const long = "x".repeat(MAX_DOC_TRANSCRIPT_CHARS + 1000);
    const out = buildDocTranscript({ title: "T", content: long });
    expect(out.length).toBeLessThanOrEqual(MAX_DOC_TRANSCRIPT_CHARS + 200); // 200 chars of headroom for the marker + header
    expect(out).toContain("[...content truncated]");
  });
});

describe("fetchKnowledgeDocs", () => {
  it("filters by org_id and includes active IS NULL OR active = true", async () => {
    const { sb, calls } = makeSb([
      { id: "d1", title: "T1", content: "C1", category: null, tags: null, active: true, updated_at: "2026-05-27T00:00:00Z" },
    ]);
    const out = await fetchKnowledgeDocs(sb as any, { orgId: "org-1", limit: 100 });
    expect(calls.find((c) => c.op === "eq" && c.col === "org_id" && c.val === "org-1")).toBeTruthy();
    expect(calls.find((c) => c.op === "or" && /active/i.test(c.expr))).toBeTruthy();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sourceType: "knowledge_doc",
      sourceId: "d1",
      sourceTitle: "T1",
      groupKey: "knowledge-doc:d1",
    });
    expect(out[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(out[0].transcript.startsWith("Us: [SOP] T1\n\n")).toBe(true);
  });

  it("normalizes NULL tags/category to safe defaults", async () => {
    const { sb } = makeSb([
      { id: "d2", title: "T2", content: "C2", category: null, tags: null, active: null, updated_at: "2026-05-27T00:00:00Z" },
    ]);
    const out = await fetchKnowledgeDocs(sb as any, { orgId: "org-1", limit: 100 });
    expect(out[0].sourceCategory).toBeNull();
    expect(out[0].sourceTags).toEqual([]);
  });
});
