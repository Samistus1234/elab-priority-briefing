export interface TranscriptLine {
  who: "client" | "us";
  text: string;
}

const DEFAULT_BUDGET = 12000;

/** Build a labeled, ordered transcript string, truncated to a char budget. */
export function buildTranscript(lines: TranscriptLine[], budget = DEFAULT_BUDGET): string {
  const out = lines
    .filter((l) => l.text && l.text.trim() !== "")
    .map((l) => `${l.who === "client" ? "Client" : "Us"}: ${l.text.trim()}`)
    .join("\n");
  if (out.length <= budget) return out;
  // Truncate at the last complete line within budget — avoid half-turns / split chars.
  const cut = out.lastIndexOf("\n", budget - 1);
  return cut > 0 ? out.slice(0, cut) : out.slice(0, budget);
}
