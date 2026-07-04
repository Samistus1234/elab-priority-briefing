import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { getSupabase } from "../supabase.js";
import { fetchWhatsappGroups, fetchCaseGroups, fetchTicketGroups, fetchChannelGroups, type Group } from "./sources.js";
import { extractFromTranscript } from "./extract.js";
import { writeUnit } from "./write.js";
import { setConflictBudget } from "./conflict.js";

type Reader = (windowStart: string, cursor: string, limit: number) => Promise<Group[]>;
const SOURCES: { source: string; read: Reader }[] = [
  { source: "whatsapp_convo", read: fetchWhatsappGroups },
  { source: "case", read: fetchCaseGroups },
  { source: "ticket", read: fetchTicketGroups },
  { source: "channel", read: fetchChannelGroups },
];

export async function runBrainSynthesis(): Promise<{ created: number; reinforced: number; discarded: number; processedGroups: number }> {
  const cfg = loadConfig();
  setConflictBudget(cfg.brain.conflictDetection ? cfg.brain.maxConflictChecksPerRun : 0);
  const conflictOpts = cfg.brain.conflictDetection ? { similarity: cfg.brain.conflictSimilarity } : undefined;
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
        if (!g.transcript || g.transcript.trim().length < 30) { maxCursor = maxTs(maxCursor, g.cursorTs); continue; }
        const units = await extractFromTranscript(g.transcript);
        for (const u of units) {
          const result = await writeUnit(sb, { orgId, unit: u, source, sourceId: g.groupId, conflictOpts });
          if (result === "created") created++;
          else if (result === "reinforced") reinforced++;
          else discarded++;
        }
        maxCursor = maxTs(maxCursor, g.cursorTs);
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

// Return the later of two timestamps. Uses numeric time when both parse (robust to
// format differences, e.g. "…+00" vs "Z"); falls back to string compare otherwise.
function maxTs(a: string, b: string): string {
  const da = Date.parse(a), db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return a >= b ? a : b;
  return da >= db ? a : b;
}
