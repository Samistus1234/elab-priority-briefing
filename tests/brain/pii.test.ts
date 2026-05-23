import { describe, it, expect } from "vitest";
import { findPii, scrubPii } from "../../src/brain/pii.js";

describe("pii", () => {
  it("flags emails and >=10-digit phones, not dates", () => {
    expect(findPii("john@x.com").includes("email")).toBe(true);
    expect(findPii("call +2348012345678").includes("phone")).toBe(true);
    expect(findPii("between 2024-01-15 and 2024-05-30")).toEqual([]);
  });
  it("scrubs emails + long digit runs", () => {
    const out = scrubPii("john@x.com / +2348012345678");
    expect(out.includes("john@x.com")).toBe(false);
    expect(out.includes("[redacted]")).toBe(true);
  });
});
