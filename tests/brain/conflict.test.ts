import { describe, it, expect, beforeEach } from "vitest";
import { parseConflictVerdict, judgeConflict, setConflictBudget } from "../../src/brain/conflict.js";

describe("parseConflictVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseConflictVerdict('{"same_question":true,"conflict":true,"reason":"different fee"}'))
      .toEqual({ same_question: true, conflict: true, reason: "different fee" });
  });
  it("parses JSON wrapped in prose/fences", () => {
    const v = parseConflictVerdict('Here:\n```json\n{"same_question":true,"conflict":false,"reason":"complementary"}\n```');
    expect(v.same_question).toBe(true);
    expect(v.conflict).toBe(false);
  });
  it("falls back to no-conflict on malformed output", () => {
    expect(parseConflictVerdict("not json at all")).toEqual({ same_question: false, conflict: false, reason: "" });
  });
});

describe("judgeConflict budget", () => {
  beforeEach(() => setConflictBudget(0)); // exhausted
  it("returns no-conflict without calling the API when budget is exhausted", async () => {
    const v = await judgeConflict({ question: "q", answer: "a1" }, { question: "q", answer: "a2" });
    expect(v).toEqual({ same_question: false, conflict: false, reason: "" });
  });
});
