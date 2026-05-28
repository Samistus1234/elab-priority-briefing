import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const MAX_DOC_TRANSCRIPT_CHARS = 15_000;
const TRUNCATION_MARKER = "\n\n[...content truncated]\n";

export interface DocGroup {
  groupKey: string;          // "knowledge-doc:<uuid>"
  sourceType: "knowledge_doc";
  sourceId: string;          // knowledge_documents.id
  sourceTitle: string;
  sourceCategory: string | null;
  sourceTags: string[];
  contentHash: string;       // sha256 hex of raw content
  transcript: string;
}

export function hashDocContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Build the canonical-SOP transcript for one knowledge doc.
 * Format: `Us: [SOP] <title>\n\n<content>` — head-truncated to fit the LLM budget.
 */
export function buildDocTranscript(doc: { title: string; content: string }): string {
  const header = `Us: [SOP] ${doc.title}\n\n`;
  const budget = MAX_DOC_TRANSCRIPT_CHARS - header.length;
  if (doc.content.length <= budget) return header + doc.content;
  // Head-truncate: keep the beginning, drop the tail. SOPs are typically front-loaded
  // with the most important info; this avoids accidentally dropping a critical price/rule
  // at the start.
  const keep = budget - TRUNCATION_MARKER.length;
  return header + doc.content.slice(0, keep) + TRUNCATION_MARKER;
}

/**
 * Fetch all knowledge_documents rows for an org that are active. NULL `active` is treated
 * as active (matches the rule the chatbot's own search uses).
 */
export async function fetchKnowledgeDocs(
  sb: SupabaseClient,
  opts: { orgId: string; limit: number },
): Promise<DocGroup[]> {
  const { data, error } = await sb
    .from("knowledge_documents")
    .select("id, title, content, category, tags, active, updated_at")
    .eq("org_id", opts.orgId)
    .or("active.is.null,active.eq.true")
    .order("updated_at", { ascending: false })
    .limit(opts.limit);

  if (error) throw new Error(`knowledge_documents fetch failed: ${error.message}`);

  return (data ?? []).map((d: any) => {
    const content: string = d.content ?? "";
    return {
      groupKey: `knowledge-doc:${d.id}`,
      sourceType: "knowledge_doc" as const,
      sourceId: d.id,
      sourceTitle: d.title ?? "",
      sourceCategory: d.category ?? null,
      sourceTags: Array.isArray(d.tags) ? d.tags : [],
      contentHash: hashDocContent(content),
      transcript: buildDocTranscript({ title: d.title ?? "", content }),
    };
  });
}
