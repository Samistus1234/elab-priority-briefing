import { describe, it, expect, vi } from "vitest";

// embed uses transformers.js (heavy model load) — mock it to a 384-dim vector.
vi.mock("../../src/brain/embed.js", () => ({
  embed: vi.fn(async () => new Array(384).fill(0.1)),
}));

vi.mock("../../src/brain/conflict.js", () => ({
  judgeConflict: vi.fn(),
  setConflictBudget: vi.fn(),
}));
import { judgeConflict } from "../../src/brain/conflict.js";

import { writeUnit } from "../../src/brain/write.js";
import type { KnowledgeUnit } from "../../src/brain/types.js";

function fakeSbConflict(dedup: Array<{ id: string }>, published: Array<any>) {
  const inserted: any[] = [];
  const sb = {
    rpc: vi.fn(async (name: string, args: any) => {
      if (name !== "match_brain_entries") return { data: null, error: null };
      return { data: args.p_include_pending ? dedup : published, error: null };
    }),
    from: vi.fn(() => ({
      update: () => ({ eq: async () => ({ error: null }) }),
      insert: async (row: any) => { inserted.push(row); return { error: null }; },
    })),
  };
  return { sb, inserted };
}

function fakeSb(matchData: Array<{ id: string }>) {
  const inserted: any[] = [];
  const updated: any[] = [];
  const sb = {
    rpc: vi.fn(async (name: string) => {
      if (name === "match_brain_entries") return { data: matchData, error: null };
      return { data: null, error: null }; // increment_brain_seen
    }),
    from: vi.fn(() => ({
      update: (vals: any) => ({
        eq: async (_col: string, id: string) => { updated.push({ id, vals }); return { error: null }; },
      }),
      insert: async (row: any) => { inserted.push(row); return { error: null }; },
    })),
  };
  return { sb, inserted, updated };
}

const unit = (confidence: number): KnowledgeUnit => ({
  topic: "T", question: "Q", answer: "A", tags: ["x"], confidence,
});

describe("writeUnit", () => {
  it("discards a low-confidence unit before embedding or querying", async () => {
    const { sb, inserted } = fakeSb([]);
    const r = await writeUnit(sb as any, { orgId: "o", unit: unit(0.1), source: "s", sourceId: "id" });
    expect(r).toBe("discarded");
    expect(inserted.length).toBe(0);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("inserts a new entry with source_refs when there is no dedup match", async () => {
    const { sb, inserted } = fakeSb([]);
    const r = await writeUnit(sb as any, { orgId: "o", unit: unit(0.9), source: "whatsapp_import", sourceId: "imp1" });
    expect(r).toBe("created");
    expect(inserted.length).toBe(1);
    expect(inserted[0].source_refs).toEqual([{ source: "whatsapp_import", id: "imp1" }]);
    expect(inserted[0].status).toBe("published"); // 0.9 → published when not forced
  });

  it("forcePending caps a published-confidence entry at pending", async () => {
    const { sb, inserted } = fakeSb([]);
    const r = await writeUnit(sb as any, { orgId: "o", unit: unit(0.95), source: "whatsapp_import", sourceId: "imp1", forcePending: true });
    expect(r).toBe("created");
    expect(inserted[0].status).toBe("pending");
  });

  it("reinforces (updates, no insert) when a dedup match exists", async () => {
    const { sb, inserted, updated } = fakeSb([{ id: "existing" }]);
    const r = await writeUnit(sb as any, { orgId: "o", unit: unit(0.9), source: "s", sourceId: "id" });
    expect(r).toBe("reinforced");
    expect(inserted.length).toBe(0);
    expect(updated[0].id).toBe("existing");
  });

  it("flags a conflict: holds pending + sets conflicts_with/conflict_reason", async () => {
    const { sb, inserted } = fakeSbConflict([], [{ id: "std1", question: "Q", answer: "old", similarity: 0.85 }]);
    (judgeConflict as any).mockResolvedValue({ same_question: true, conflict: true, reason: "different fee" });
    const r = await writeUnit(sb as any, {
      orgId: "o", unit: unit(0.95), source: "s", sourceId: "id", conflictOpts: { similarity: 0.8 },
    });
    expect(r).toBe("created");
    expect(inserted[0].status).toBe("pending");
    expect(inserted[0].conflicts_with).toBe("std1");
    expect(inserted[0].conflict_reason).toBe("different fee");
  });

  it("no conflict when the judge says answers don't conflict", async () => {
    const { sb, inserted } = fakeSbConflict([], [{ id: "std1", question: "Q", answer: "old", similarity: 0.85 }]);
    (judgeConflict as any).mockResolvedValue({ same_question: true, conflict: false, reason: "" });
    const r = await writeUnit(sb as any, {
      orgId: "o", unit: unit(0.95), source: "s", sourceId: "id", conflictOpts: { similarity: 0.8 },
    });
    expect(r).toBe("created");
    expect(inserted[0].status).toBe("published");
    expect(inserted[0].conflicts_with ?? null).toBeNull();
  });

  it("skips the judge when no published candidate in band", async () => {
    const { sb, inserted } = fakeSbConflict([], []);
    (judgeConflict as any).mockClear();
    const r = await writeUnit(sb as any, {
      orgId: "o", unit: unit(0.95), source: "s", sourceId: "id", conflictOpts: { similarity: 0.8 },
    });
    expect(r).toBe("created");
    expect(judgeConflict).not.toHaveBeenCalled();
    expect(inserted[0].status).toBe("published");
  });

  it("skips conflict detection entirely when conflictOpts is omitted", async () => {
    const { sb, inserted } = fakeSbConflict([], [{ id: "std1", question: "Q", answer: "old", similarity: 0.85 }]);
    (judgeConflict as any).mockClear();
    await writeUnit(sb as any, { orgId: "o", unit: unit(0.95), source: "s", sourceId: "id" });
    expect(judgeConflict).not.toHaveBeenCalled();
    expect(inserted[0].status).toBe("published");
  });

  it("sets source_doc_id on the inserted row when provided", async () => {
    const { sb, inserted } = fakeSb([]);
    const r = await writeUnit(sb as any, {
      orgId: "o", unit: unit(0.9), source: "knowledge_doc", sourceId: "doc-uuid-1",
      sourceDocId: "doc-uuid-1",
    });
    expect(r).toBe("created");
    expect(inserted.length).toBe(1);
    expect(inserted[0].source_doc_id).toBe("doc-uuid-1");
  });

  it("omits source_doc_id when not provided (back-compat for chat sources)", async () => {
    const { sb, inserted } = fakeSb([]);
    const r = await writeUnit(sb as any, {
      orgId: "o", unit: unit(0.9), source: "whatsapp_convo", sourceId: "convo-1",
    });
    expect(r).toBe("created");
    // null is fine; undefined is fine; the key thing is no leakage of a doc id.
    expect(inserted[0].source_doc_id).toBeFalsy();
  });
});
