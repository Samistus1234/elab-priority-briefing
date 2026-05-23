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
  return out.length > budget ? out.slice(0, budget) : out;
}
