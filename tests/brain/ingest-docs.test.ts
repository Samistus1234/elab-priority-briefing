import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the LLM extractor — we test the orchestrator, not Anthropic.
vi.mock("../../src/brain/extract.js", () => ({
  extractFromCanonicalDoc: vi.fn(async (transcript: string) => {
    // Default: one unit per call. Specific tests override per-call.
    return [{ topic: "T", question: "Q", answer: transcript.slice(0, 20), tags: [], confidence: 0.9 }];
  }),
}));

// Mock writeUnit so we don't depend on embed/match_brain_entries.
vi.mock("../../src/brain/write.js", () => ({
  writeUnit: vi.fn(async () => "created"),
}));

// Mock config so we don't need env vars.
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(() => ({
    supabase: { orgId: "org-1" },
    brain: { maxDocsPerRun: 20, conflictDetection: false, conflictSimilarity: 0.8, maxConflictChecksPerRun: 0 },
    llm: { apiKey: "k", model: "claude-sonnet-4-6" },
  })),
}));

import { runKnowledgeDocIngest } from "../../src/brain/ingest-docs.js";
import { extractFromCanonicalDoc } from "../../src/brain/extract.js";
import { writeUnit } from "../../src/brain/write.js";

/**
 * Build a fake supabase client. We control:
 *  - knowledge_documents.select → returns `docs`
 *  - brain_doc_ingestions.select → returns `tracked`
 *  - All writes (delete/upsert/etc) recorded into `calls`.
 */
function fakeSb(docs: any[], tracked: any[]) {
  const calls: any[] = [];
  const sb: any = {
    from: vi.fn((table: string) => {
      if (table === "knowledge_documents") {
        return {
          select: () => ({
            eq: () => ({
              or: () => ({
                order: () => ({
                  limit: async () => ({ data: docs, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "brain_doc_ingestions") {
        return {
          select: () => ({
            eq: async () => ({ data: tracked, error: null }),
          }),
          delete: () => ({
            eq: vi.fn(async (col: string, val: string) => {
              calls.push({ table: "brain_doc_ingestions", op: "delete", col, val });
              return { error: null };
            }),
          }),
          upsert: async (row: any) => {
            calls.push({ table: "brain_doc_ingestions", op: "upsert", row });
            return { error: null };
          },
        };
      }
      if (table === "brain_entries") {
        return {
          delete: () => ({
            eq: vi.fn(async (col: string, val: string) => {
              calls.push({ table: "brain_entries", op: "delete", col, val });
              return { error: null };
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  };
  return { sb, calls };
}

beforeEach(() => {
  vi.mocked(extractFromCanonicalDoc).mockClear();
  vi.mocked(writeUnit).mockClear();
});

function doc(id: string, content: string) {
  return { id, title: `Doc ${id}`, content, category: null, tags: null, active: true, updated_at: "2026-05-27T00:00:00Z" };
}

import { hashDocContent } from "../../src/brain/sources-docs.js";

describe("runKnowledgeDocIngest", () => {
  it("extracts and tracks brand-new docs", async () => {
    const docs = [doc("d1", "Body 1"), doc("d2", "Body 2")];
    const { sb, calls } = fakeSb(docs, []);
    const summary = await runKnowledgeDocIngest(sb);
    expect(extractFromCanonicalDoc).toHaveBeenCalledTimes(2);
    expect(writeUnit).toHaveBeenCalledTimes(2);
    // Each writeUnit got sourceDocId set.
    expect(vi.mocked(writeUnit).mock.calls[0][1]).toMatchObject({ source: "knowledge_doc", sourceDocId: "d1" });
    // Two upserts to brain_doc_ingestions.
    const upserts = calls.filter((c) => c.table === "brain_doc_ingestions" && c.op === "upsert");
    expect(upserts).toHaveLength(2);
    expect(summary.newCount).toBe(2);
    expect(summary.changedCount).toBe(0);
    expect(summary.staleCount).toBe(0);
    expect(summary.entriesCreated).toBe(2);
  });

  it("skips docs whose content hash is unchanged", async () => {
    const docs = [doc("d1", "Body 1")];
    const tracked = [{ doc_id: "d1", content_hash: hashDocContent("Body 1"), org_id: "org-1" }];
    const { sb, calls } = fakeSb(docs, tracked);
    const summary = await runKnowledgeDocIngest(sb);
    expect(extractFromCanonicalDoc).not.toHaveBeenCalled();
    expect(writeUnit).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === "upsert")).toHaveLength(0);
    expect(summary.newCount).toBe(0);
    expect(summary.changedCount).toBe(0);
  });

  it("on hash change: deletes prior brain_entries for that doc, then re-extracts", async () => {
    const docs = [doc("d1", "NEW body")];
    const tracked = [{ doc_id: "d1", content_hash: hashDocContent("OLD body"), org_id: "org-1" }];
    const { sb, calls } = fakeSb(docs, tracked);
    const summary = await runKnowledgeDocIngest(sb);
    // The delete-by-source_doc_id happened FIRST.
    const delIdx = calls.findIndex((c) => c.table === "brain_entries" && c.op === "delete" && c.val === "d1");
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(extractFromCanonicalDoc).toHaveBeenCalledTimes(1);
    expect(summary.changedCount).toBe(1);
  });

  it("on stale (was tracked, no longer in active set): cleans up entries + tracking", async () => {
    const docs: any[] = []; // nothing active
    const tracked = [{ doc_id: "d1", content_hash: "anything", org_id: "org-1" }];
    const { sb, calls } = fakeSb(docs, tracked);
    const summary = await runKnowledgeDocIngest(sb);
    const entryDelete = calls.find((c) => c.table === "brain_entries" && c.op === "delete" && c.val === "d1");
    const trackingDelete = calls.find((c) => c.table === "brain_doc_ingestions" && c.op === "delete" && c.val === "d1");
    expect(entryDelete).toBeTruthy();
    expect(trackingDelete).toBeTruthy();
    expect(summary.staleCount).toBe(1);
    expect(extractFromCanonicalDoc).not.toHaveBeenCalled();
  });

  it("respects maxDocsPerRun for new+changed (stale is always processed)", async () => {
    const docs = Array.from({ length: 5 }, (_, i) => doc(`d${i}`, `Body ${i}`));
    const tracked: any[] = [];
    const { sb } = fakeSb(docs, tracked);
    // Override config to cap at 2.
    const { loadConfig } = await import("../../src/config.js");
    vi.mocked(loadConfig).mockReturnValueOnce({
      supabase: { orgId: "org-1" },
      brain: { maxDocsPerRun: 2, conflictDetection: false, conflictSimilarity: 0.8, maxConflictChecksPerRun: 0 },
      llm: { apiKey: "k", model: "claude-sonnet-4-6" },
    } as any);
    const summary = await runKnowledgeDocIngest(sb);
    expect(extractFromCanonicalDoc).toHaveBeenCalledTimes(2);
    expect(summary.newCount).toBe(2);
    expect(summary.docsScanned).toBe(5);
  });

  it("isolates per-doc errors: one doc throwing does not prevent others from being processed", async () => {
    const docs = [doc("d1", "Body 1"), doc("d2", "Body 2")];
    const tracked: any[] = [];
    vi.mocked(extractFromCanonicalDoc)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([{ topic: "T", question: "Q", answer: "A", tags: [], confidence: 0.9 }]);
    const { sb, calls } = fakeSb(docs, tracked);
    const summary = await runKnowledgeDocIngest(sb);
    expect(summary.errors).toBe(1);
    expect(summary.entriesCreated).toBe(1);
    // The successful doc d2 got upserted; the failed doc d1 did NOT.
    const upserts = calls.filter((c) => c.table === "brain_doc_ingestions" && c.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row.doc_id).toBe("d2");
  });
});
