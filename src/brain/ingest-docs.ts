import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { fetchKnowledgeDocs, type DocGroup } from "./sources-docs.js";
import { extractFromCanonicalDoc } from "./extract.js";
import { writeUnit } from "./write.js";
import { setConflictBudget } from "./conflict.js";

export interface IngestSummary {
  docsScanned: number;
  newCount: number;
  changedCount: number;
  staleCount: number;
  entriesCreated: number;
  entriesReinforced: number;
  errors: number;
}

interface TrackedRow {
  doc_id: string;
  content_hash: string;
  org_id: string;
}

export async function runKnowledgeDocIngest(sb: SupabaseClient): Promise<IngestSummary> {
  const cfg = loadConfig();
  setConflictBudget(cfg.brain.conflictDetection ? cfg.brain.maxConflictChecksPerRun : 0);
  const conflictOpts = cfg.brain.conflictDetection
    ? { similarity: cfg.brain.conflictSimilarity }
    : undefined;
  const orgId = cfg.supabase.orgId;

  // 1. Active set (capped here by passing a generous upper bound — the per-run cap below
  //    bounds how many of the new+changed we actually extract).
  const active: DocGroup[] = await fetchKnowledgeDocs(sb, { orgId, limit: 500 });

  // 2. Tracked set.
  const { data: trackedData, error: trackedErr } = await sb
    .from("brain_doc_ingestions")
    .select("doc_id, content_hash, org_id")
    .eq("org_id", orgId);
  if (trackedErr) throw new Error(`brain_doc_ingestions fetch failed: ${trackedErr.message}`);
  const tracked = (trackedData ?? []) as TrackedRow[];
  const trackedById = new Map(tracked.map((t) => [t.doc_id, t]));
  const activeById = new Map(active.map((a) => [a.sourceId, a]));

  // 3. Diff.
  const newDocs: DocGroup[] = [];
  const changedDocs: DocGroup[] = [];
  for (const d of active) {
    const t = trackedById.get(d.sourceId);
    if (!t) newDocs.push(d);
    else if (t.content_hash !== d.contentHash) changedDocs.push(d);
  }
  const staleIds: string[] = [];
  for (const t of tracked) {
    if (!activeById.has(t.doc_id)) staleIds.push(t.doc_id);
  }

  const summary: IngestSummary = {
    docsScanned: active.length,
    newCount: 0,
    changedCount: 0,
    staleCount: 0,
    entriesCreated: 0,
    entriesReinforced: 0,
    errors: 0,
  };

  // 4. Stale cleanup (always processed, no cap — these are just deletes).
  for (const docId of staleIds) {
    try {
      await sb.from("brain_entries").delete().eq("source_doc_id", docId);
      await sb.from("brain_doc_ingestions").delete().eq("doc_id", docId);
      summary.staleCount++;
    } catch (e) {
      logger.error({ err: (e as Error).message, docId }, "brain doc ingest: stale cleanup failed");
      summary.errors++;
    }
  }

  // 5. New + changed (capped).
  const toProcess: Array<{ doc: DocGroup; kind: "new" | "changed" }> = [
    ...newDocs.map((d) => ({ doc: d, kind: "new" as const })),
    ...changedDocs.map((d) => ({ doc: d, kind: "changed" as const })),
  ].slice(0, cfg.brain.maxDocsPerRun);

  for (const { doc, kind } of toProcess) {
    try {
      if (kind === "changed") {
        await sb.from("brain_entries").delete().eq("source_doc_id", doc.sourceId);
      }
      const units = await extractFromCanonicalDoc(doc.transcript);
      let createdHere = 0, reinforcedHere = 0;
      for (const u of units) {
        const r = await writeUnit(sb, {
          orgId,
          unit: u,
          source: "knowledge_doc",
          sourceId: doc.sourceId,
          sourceDocId: doc.sourceId,
          conflictOpts,
        });
        if (r === "created") createdHere++;
        else if (r === "reinforced") reinforcedHere++;
      }
      await sb.from("brain_doc_ingestions").upsert({
        doc_id: doc.sourceId,
        org_id: orgId,
        content_hash: doc.contentHash,
        last_ingested_at: new Date().toISOString(),
        entry_count: createdHere,
      });
      summary.entriesCreated += createdHere;
      summary.entriesReinforced += reinforcedHere;
      if (kind === "new") summary.newCount++;
      else summary.changedCount++;
    } catch (e) {
      logger.error({ err: (e as Error).message, docId: doc.sourceId }, "brain doc ingest: per-doc failed");
      summary.errors++;
      // Do NOT upsert tracking — next run will retry.
    }
  }

  logger.info(summary, "brain doc ingest done");
  return summary;
}
