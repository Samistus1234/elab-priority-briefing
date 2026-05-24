import { describe, it, expect } from "vitest";
import { chunkIntoTranscripts } from "../../src/brain/import-chunk.js";
import type { ParsedMessage } from "../../src/brain/whatsapp-parse.js";

const msgs: ParsedMessage[] = [
  { ts: "t1", sender: "Sam", text: "We tell clients X." },
  { ts: "t2", sender: "Aisha", text: "Got it." },
  { ts: "t3", sender: "Sam", text: "And policy Y." },
];

describe("chunkIntoTranscripts", () => {
  it("labels the founder as Us and others as Client", () => {
    const [chunk] = chunkIntoTranscripts(msgs, "Sam", 12000, 40);
    expect(chunk.transcript).toBe("Us: We tell clients X.\nClient: Got it.\nUs: And policy Y.");
    expect(chunk.cursorTs).toBe("t3");
  });

  it("splits into multiple chunks when the budget is small, capped by maxChunks", () => {
    const chunks = chunkIntoTranscripts(msgs, "Sam", 25, 40); // tiny budget → multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    const cap = chunkIntoTranscripts(msgs, "Sam", 1, 1);
    expect(cap.length).toBe(1); // never exceed maxChunks
  });

  it("returns [] for no messages", () => {
    expect(chunkIntoTranscripts([], "Sam", 12000, 40)).toEqual([]);
  });
});
