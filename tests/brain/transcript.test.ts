import { describe, it, expect } from "vitest";
import { buildTranscript } from "../../src/brain/transcript.js";

describe("buildTranscript", () => {
  it("labels by direction and joins in order", () => {
    const t = buildTranscript([
      { who: "client", text: "How long does Oman DataFlow take?" },
      { who: "us", text: "Usually 6-8 weeks." },
    ]);
    expect(t).toBe("Client: How long does Oman DataFlow take?\nUs: Usually 6-8 weeks.");
  });
  it("skips empty lines and truncates to the char budget", () => {
    const long = "x".repeat(100);
    const t = buildTranscript([{ who: "us", text: long }, { who: "us", text: "" }], 50);
    expect(t.length).toBeLessThanOrEqual(50);
  });
});
