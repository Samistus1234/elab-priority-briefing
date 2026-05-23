import { describe, it, expect } from "vitest";
import { statusForConfidence } from "../../src/brain/gating.js";

describe("gating", () => {
  it("thresholds", () => {
    expect(statusForConfidence(0.85)).toBe("published");
    expect(statusForConfidence(0.6)).toBe("pending");
    expect(statusForConfidence(0.4)).toBe("discard");
  });
});
