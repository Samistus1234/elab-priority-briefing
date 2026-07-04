import { getSupabase } from "../supabase.js";
import { buildTranscript, type TranscriptLine } from "./transcript.js";

export interface Group {
  source: string;   // 'whatsapp_convo' | 'case' | 'ticket'
  groupId: string;
  cursorTs: string; // last_activity ISO; advances the source cursor
  transcript: string;
}

export async function fetchWhatsappGroups(windowStart: string, cursor: string, limit: number): Promise<Group[]> {
  const sb = getSupabase();
  const { data: groups, error } = await sb.rpc("brain_whatsapp_groups", {
    p_window_start: windowStart, p_cursor: cursor, p_limit: limit,
  });
  if (error) { console.error("brain_whatsapp_groups failed:", error.message); return []; }
  const out: Group[] = [];
  for (const g of groups ?? []) {
    const { data: msgs, error: msgErr } = await sb.from("whatsapp_messages")
      .select("message_body, direction, created_at")
      .eq("conversation_id", g.group_id).order("created_at", { ascending: true }).limit(500);
    // Skip (don't advance the cursor over) a group whose rows we couldn't read,
    // so it's retried next run rather than synthesized from an empty transcript.
    if (msgErr) { console.error(`whatsapp_messages fetch failed for ${g.group_id}:`, msgErr.message); continue; }
    const lines: TranscriptLine[] = (msgs ?? []).map((m: any) => ({
      who: m.direction === "inbound" ? "client" : "us", text: m.message_body ?? "",
    }));
    out.push({ source: "whatsapp_convo", groupId: g.group_id, cursorTs: g.last_activity, transcript: buildTranscript(lines) });
  }
  return out;
}

export async function fetchCaseGroups(windowStart: string, cursor: string, limit: number): Promise<Group[]> {
  const sb = getSupabase();
  const { data: groups, error } = await sb.rpc("brain_case_groups", {
    p_window_start: windowStart, p_cursor: cursor, p_limit: limit,
  });
  if (error) { console.error("brain_case_groups failed:", error.message); return []; }
  const out: Group[] = [];
  for (const g of groups ?? []) {
    const { data: notes, error: notesErr } = await sb.from("case_notes")
      .select("content, created_at").eq("case_id", g.group_id).order("created_at", { ascending: true }).limit(500);
    if (notesErr) { console.error(`case_notes fetch failed for ${g.group_id}:`, notesErr.message); continue; }
    const lines: TranscriptLine[] = (notes ?? []).map((n: any) => ({ who: "us" as const, text: n.content ?? "" }));
    out.push({ source: "case", groupId: g.group_id, cursorTs: g.last_activity, transcript: buildTranscript(lines) });
  }
  return out;
}

export async function fetchChannelGroups(windowStart: string, cursor: string, limit: number): Promise<Group[]> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc("brain_channel_groups", {
    p_window_start: windowStart,
    p_cursor: cursor,
    p_limit: limit,
  });
  if (error || !data) {
    console.error("brain_channel_groups failed:", (error as any)?.message ?? "no data");
    return [];
  }

  return (data as { group_key: string; cursor_ts: string; lines: { who: string; text: string }[] }[])
    .map(row => {
      const lines = row.lines.map(l => `${l.who}: ${l.text}`);
      let transcript = "";
      for (const line of lines) {
        const next = transcript ? `${transcript}\n${line}` : line;
        if (next.length > 12000) break;
        transcript = next;
      }
      return {
        source: "channel",
        groupId: row.group_key,
        cursorTs: row.cursor_ts,
        transcript,
      };
    })
    .filter(g => g.transcript.length > 0);
}

export async function fetchTicketGroups(windowStart: string, cursor: string, limit: number): Promise<Group[]> {
  const sb = getSupabase();
  const { data: tickets, error } = await sb.from("helpdesk_tickets")
    .select("id, subject, description, updated_at")
    .gt("updated_at", cursor).gte("updated_at", windowStart)
    .order("updated_at", { ascending: true }).limit(limit);
  if (error) { console.error("ticket fetch failed:", error.message); return []; }
  const out: Group[] = [];
  for (const t of tickets ?? []) {
    const { data: comments, error: commentsErr } = await sb.from("helpdesk_ticket_comments")
      .select("content, created_at").eq("ticket_id", t.id).order("created_at", { ascending: true }).limit(200);
    if (commentsErr) { console.error(`ticket comments fetch failed for ${t.id}:`, commentsErr.message); continue; }
    const lines: TranscriptLine[] = [
      { who: "client", text: `${t.subject ?? ""}. ${t.description ?? ""}` },
      ...(comments ?? []).map((c: any) => ({ who: "us" as const, text: c.content ?? "" })),
    ];
    out.push({ source: "ticket", groupId: t.id, cursorTs: t.updated_at, transcript: buildTranscript(lines) });
  }
  return out;
}
