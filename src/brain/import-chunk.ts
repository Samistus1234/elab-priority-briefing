import { buildTranscript, type TranscriptLine } from "./transcript.js";
import type { ParsedMessage } from "./whatsapp-parse.js";

export interface ImportChunk {
  transcript: string;
  cursorTs: string; // last message ts in the chunk
}

/**
 * Group parsed messages into transcript windows so a long history isn't truncated.
 * `senderSelf` (the founder's display name) is labeled "Us"; everyone else "Client".
 * Accumulates messages until the labeled text would exceed `budget`, then starts a new
 * chunk. Never produces more than `maxChunks` (excess history is dropped — re-export
 * narrower ranges if needed).
 */
export function chunkIntoTranscripts(
  messages: ParsedMessage[],
  senderSelf: string,
  budget: number,
  maxChunks: number,
): ImportChunk[] {
  const chunks: ImportChunk[] = [];
  let lines: TranscriptLine[] = [];
  let lastTs = "";
  let size = 0;
  const self = senderSelf.trim();

  const flush = () => {
    if (lines.length === 0) return;
    chunks.push({ transcript: buildTranscript(lines, budget), cursorTs: lastTs });
    lines = [];
    size = 0;
  };

  for (const m of messages) {
    if (chunks.length >= maxChunks) break;
    const text = m.text.trim();
    if (!text) continue;
    const who: TranscriptLine["who"] = m.sender.trim() === self ? "us" : "client";
    const lineLen = who.length + text.length + 8;
    if (size > 0 && size + lineLen > budget) {
      flush();
      if (chunks.length >= maxChunks) break;
    }
    lines.push({ who, text });
    lastTs = m.ts;
    size += lineLen;
  }
  if (chunks.length < maxChunks) flush();
  return chunks;
}
