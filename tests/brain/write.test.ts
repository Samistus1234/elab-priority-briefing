import { describe, it, expect, vi } from "vitest";

// embed uses transformers.js (heavy model load) — mock it to a 384-dim vector.
vi.mock("../../src/brain/embed.js", () => ({
  embed: vi.fn(async () => new Array(384).fill(0.1)),
}));

import { writeUnit } from "../../src/brain/write.js";
import type { KnowledgeUnit } from "../../src/brain/types.js";

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
});
