import type { SupabaseClient } from "@supabase/supabase-js";
import { embed } from "./embed.js";
import { scrubPii } from "./pii.js";
import { statusForConfidence } from "./gating.js";
import { judgeConflict } from "./conflict.js";
import type { KnowledgeUnit } from "./types.js";
import { logger } from "../logger.js";

const DEDUP_THRESHOLD = 0.92;

export type WriteResult = "created" | "reinforced" | "discarded";

/**
 * Scrub → embed → dedup → insert-or-reinforce one knowledge unit.
 * `forcePending` caps a would-be `published` at `pending` (imports never auto-publish),
 * but a `discard`-level unit is still dropped.
 * If `increment_brain_seen` fails the result is still "reinforced" — the seen-count is advisory.
 */
export async function writeUnit(
  sb: SupabaseClient,
  opts: { orgId: string; unit: KnowledgeUnit; source: string; sourceId: string; forcePending?: boolean; conflictOpts?: { similarity: number } },
): Promise<WriteResult> {
  const { orgId, unit, source, sourceId, forcePending } = opts;
  const gated = statusForConfidence(unit.confidence); // "published" | "pending" | "discard"
  if (gated === "discard") return "discarded";
  const status = forcePending && gated === "published" ? "pending" : gated;

  const topic = scrubPii(unit.topic);
  const question = scrubPii(unit.question);
  const answer = scrubPii(unit.answer);
  const embedding = await embed(`${topic} ${question} ${answer}`);

  const { data: matches } = await sb.rpc("match_brain_entries", {
    p_org_id: orgId, query_embedding: embedding, match_count: 1,
    min_similarity: DEDUP_THRESHOLD, p_include_pending: true,
  });
  const nowIso = new Date().toISOString();

  if (matches && matches.length > 0) {
    const { error: updErr } = await sb.from("brain_entries")
      .update({ last_seen_at: nowIso, updated_at: nowIso }).eq("id", matches[0].id);
    if (updErr) throw new Error(`brain_entries update failed: ${updErr.message}`);
    await sb.rpc("increment_brain_seen", { p_id: matches[0].id })
      .then(() => {}, (e: any) => logger.warn({ err: e?.message ?? e }, "brain: increment_seen failed"));
    return "reinforced";
  }

  // No dedup match → genuinely new answer. If enabled, check it against the published
  // standard before writing; a conflict is held pending (never auto-published) + flagged.
  let conflictsWith: string | null = null;
  let conflictReason: string | null = null;
  if (opts.conflictOpts) {
    const { data: pub, error: pubErr } = await sb.rpc("match_brain_entries", {
      p_org_id: orgId, query_embedding: embedding, match_count: 1,
      min_similarity: opts.conflictOpts.similarity, p_include_pending: false,
    });
    if (pubErr) logger.warn({ err: pubErr.message }, "brain: conflict retrieval failed, skipping");
    const cand = pub?.[0];
    if (cand && cand.similarity < DEDUP_THRESHOLD) {
      const verdict = await judgeConflict(
        { question, answer },
        { question: cand.question, answer: cand.answer },
      );
      if (verdict.same_question && verdict.conflict) {
        conflictsWith = cand.id;
        conflictReason = verdict.reason;
      }
    }
  }
  const finalStatus = conflictsWith ? "pending" : status;

  const { error: insErr } = await sb.from("brain_entries").insert({
    org_id: orgId, topic, question, answer, tags: unit.tags,
    source_refs: [{ source, id: sourceId }], confidence: unit.confidence, status: finalStatus,
    embedding, conflicts_with: conflictsWith, conflict_reason: conflictReason,
  });
  if (insErr) throw new Error(`brain_entries insert failed: ${insErr.message}`);
  return "created";
}
