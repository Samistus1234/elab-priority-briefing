import { describe, it, expect } from "vitest";
import { embed } from "../../src/brain/embed.js";

describe("embed", () => {
  it("returns a 384-dim numeric vector", async () => {
    const v = await embed("Oman DataFlow takes about 6-8 weeks.");
    expect(v.length).toBe(384);
    expect(typeof v[0]).toBe("number");
  }, 120_000);
});
