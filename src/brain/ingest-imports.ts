import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { getSupabase } from "../supabase.js";
import { parseWhatsappExport } from "./whatsapp-parse.js";
import { chunkIntoTranscripts } from "./import-chunk.js";
import { extractFromTranscript } from "./extract.js";
import { writeUnit } from "./write.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runImportIngestion(): Promise<{ processed: number; created: number; reinforced: number; failed: number }> {
  const cfg = loadConfig();
  const sb = getSupabase();
  const orgId = cfg.supabase.orgId;
  const bucket = cfg.brain.importBucket;

  // Self-heal: the workflow's concurrency group prevents overlapping runs, so any row
  // still in 'processing' is orphaned from a killed prior run — reset it to 'pending'.
  await sb.from("brain_imports").update({ status: "pending" })
    .eq("org_id", orgId).eq("status", "processing");

  const { data: imports, error } = await sb.from("brain_imports")
    .select("id, file_name, sender_self, file_hash, storage_path")
    .eq("org_id", orgId).eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(cfg.brain.maxImportsPerRun);
  if (error) throw new Error(`brain_imports query failed: ${error.message}`);

  let processed = 0, created = 0, reinforced = 0, failed = 0;

  for (const imp of imports ?? []) {
    // Idempotency: skip if an identical file was already processed.
    const { data: dup } = await sb.from("brain_imports")
      .select("id").eq("org_id", orgId).eq("file_hash", imp.file_hash).eq("status", "processed").limit(1);
    if (dup && dup.length > 0) {
      await sb.from("brain_imports").update({
        status: "failed", error: "duplicate of an already-processed import", processed_at: new Date().toISOString(),
      }).eq("id", imp.id);
      continue;
    }

    await sb.from("brain_imports").update({ status: "processing" }).eq("id", imp.id);
    try {
      const dl = await sb.storage.from(bucket).download(imp.storage_path);
      if (dl.error || !dl.data) throw new Error(`download failed: ${dl.error?.message ?? "no data"}`);
      const raw = await dl.data.text();
      const messages = parseWhatsappExport(raw);
      if (messages.length === 0) throw new Error("no messages parsed");
      if (!imp.sender_self?.trim()) {
        logger.warn({ importId: imp.id }, "brain import: no sender_self — all turns labeled Client (degraded extraction)");
      }

      const chunks = chunkIntoTranscripts(messages, imp.sender_self ?? "", cfg.brain.importChunkBudget, cfg.brain.maxChunksPerImport);
      let cCreated = 0, cReinforced = 0, chunksFailed = 0;
      for (let i = 0; i < chunks.length; i++) {
        try {
          const units = await extractFromTranscript(chunks[i].transcript);
          for (const u of units) {
            const r = await writeUnit(sb, { orgId, unit: u, source: "whatsapp_import", sourceId: imp.id, forcePending: true });
            if (r === "created") cCreated++;
            else if (r === "reinforced") cReinforced++;
          }
        } catch (e) {
          chunksFailed++;
          logger.error({ err: errMsg(e), importId: imp.id, chunkIndex: i }, "brain import: chunk failed");
        }
      }
      // If EVERY chunk errored, fail the import and keep the raw file — never silently
      // mark it processed-with-0-entries and delete the source (that loses data).
      if (chunks.length > 0 && chunksFailed === chunks.length) {
        throw new Error("all chunks failed to extract — raw kept; set status to 'pending' to retry");
      }

      await sb.from("brain_imports").update({
        status: "processed", entries_created: cCreated, entries_reinforced: cReinforced, processed_at: new Date().toISOString(),
      }).eq("id", imp.id);
      // Delete the raw file — only the scrubbed knowledge persists (success path only).
      await sb.storage.from(bucket).remove([imp.storage_path]).then(() => {}, () => {});
      processed++; created += cCreated; reinforced += cReinforced;
    } catch (e) {
      failed++;
      await sb.from("brain_imports").update({
        status: "failed", error: errMsg(e), processed_at: new Date().toISOString(),
      }).eq("id", imp.id);
      logger.error({ err: errMsg(e), importId: imp.id }, "brain import: failed");
    }
  }

  logger.info({ processed, created, reinforced, failed }, "brain import ingestion done");
  return { processed, created, reinforced, failed };
}
