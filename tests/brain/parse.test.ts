import { describe, it, expect } from "vitest";
import { parseUnits } from "../../src/brain/parse.js";

describe("parseUnits", () => {
  it("extracts valid units and drops PII/invalid", () => {
    const raw = '[{"topic":"DataFlow","question":"Oman timeline?","answer":"~6-8 weeks","tags":["oman"],"confidence":0.9},{"topic":"y"}]';
    const u = parseUnits(raw);
    expect(u.length).toBe(1);
    expect(u[0].topic).toBe("DataFlow");
  });
  it("drops units with PII in tags", () => {
    const raw = '[{"topic":"t","question":"q","answer":"a","tags":["client@x.com"],"confidence":0.9}]';
    expect(parseUnits(raw).length).toBe(0);
  });
});
