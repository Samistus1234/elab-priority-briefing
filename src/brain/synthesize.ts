import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { getSupabase } from "../supabase.js";
import { fetchWhatsappGroups, fetchCaseGroups, fetchTicketGroups, type Group } from "./sources.js";
import { extractFromTranscript } from "./extract.js";
import { embed } from "./embed.js";
import { statusForConfidence } from "./gating.js";
import { scrubPii } from "./pii.js";

const DEDUP_THRESHOLD = 0.92;

type Reader = (windowStart: string, cursor: string, limit: number) => Promise<Group[]>;
const SOURCES: { source: string; read: Reader }[] = [
  { source: "whatsapp_convo", read: fetchWhatsappGroups },
  { source: "case", read: fetchCaseGroups },
  { source: "ticket", read: fetchTicketGroups },
];

export async function runBrainSynthesis(): Promise<{ created: number; reinforced: number; discarded: number; processedGroups: number }> {
  const cfg = loadConfig();
  const sb = getSupabase();
  const orgId = cfg.supabase.orgId;
  const windowStart = new Date(Date.now() - cfg.brain.windowDays * 86400000).toISOString();
  const perSource = Math.ceil(cfg.brain.maxGroupsPerRun / SOURCES.length);

  let created = 0, reinforced = 0, discarded = 0, processedGroups = 0;

  for (const { source, read } of SOURCES) {
    const { data: stateRow } = await sb.from("brain_sync_state")
      .select("forward_cursor").eq("org_id", orgId).eq("source", source).maybeSingle();
    const cursor = stateRow?.forward_cursor ?? "1970-01-01T00:00:00Z";

    let groups: Group[] = [];
    try {
      groups = await read(windowStart, cursor, perSource);
    } catch (e) {
      logger.error({ err: (e as Error).message, source }, "brain: group read failed");
      continue;
    }

    let maxCursor = cursor;
    for (const g of groups) {
      processedGroups++;
      try {
        if (!g.transcript || g.transcript.trim().length < 30) { maxCursor = max(maxCursor, g.cursorTs); continue; }
        const units = await extractFromTranscript(g.transcript);
        for (const u of units) {
          const status = statusForConfidence(u.confidence);
          if (status === "discard") { discarded++; continue; }
          const topic = scrubPii(u.topic), question = scrubPii(u.question), answer = scrubPii(u.answer);
          const embedding = await embed(`${topic} ${question} ${answer}`);
          const { data: matches } = await sb.rpc("match_brain_entries", {
            p_org_id: orgId, query_embedding: embedding, match_count: 1,
            min_similarity: DEDUP_THRESHOLD, p_include_pending: true,
          });
          if (matches && matches.length > 0) {
            await sb.from("brain_entries").update({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", matches[0].id);
            await sb.rpc("increment_brain_seen", { p_id: matches[0].id }).then(() => {}, () => {});
            reinforced++;
          } else {
            await sb.from("brain_entries").insert({
              org_id: orgId, topic, question, answer, tags: u.tags,
              source_refs: [{ source, id: g.groupId }], confidence: u.confidence, status, embedding,
            });
            created++;
          }
        }
        maxCursor = max(maxCursor, g.cursorTs);
      } catch (e) {
        logger.error({ err: (e as Error).message, source, groupId: g.groupId }, "brain: group failed");
        // do NOT advance past a failed group
      }
    }

    if (maxCursor !== cursor) {
      await sb.from("brain_sync_state").upsert(
        { org_id: orgId, source, forward_cursor: maxCursor, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: "org_id,source" },
      );
    }
  }

  logger.info({ created, reinforced, discarded, processedGroups }, "brain synthesis done");
  return { created, reinforced, discarded, processedGroups };
}

function max(a: string, b: string): string { return a >= b ? a : b; }
