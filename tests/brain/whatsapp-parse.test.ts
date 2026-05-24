import { describe, it, expect } from "vitest";
import { parseWhatsappExport, type ParsedMessage } from "../../src/brain/whatsapp-parse.js";

describe("parseWhatsappExport", () => {
  it("parses iOS bracket format", () => {
    const txt = `[2024-05-01, 10:23:45] Sam: How do we handle UTV?\n[2024-05-01, 10:24:01] Aisha: We reassure the client.`;
    const out = parseWhatsappExport(txt);
    expect(out).toEqual<ParsedMessage[]>([
      { ts: "2024-05-01, 10:23:45", sender: "Sam", text: "How do we handle UTV?" },
      { ts: "2024-05-01, 10:24:01", sender: "Aisha", text: "We reassure the client." },
    ]);
  });

  it("parses Android dash format and stitches multi-line messages", () => {
    const txt = `01/05/2024, 10:23 - Sam: line one\nline two\n01/05/2024, 10:24 - Aisha: ok`;
    const out = parseWhatsappExport(txt);
    expect(out).toEqual([
      { ts: "01/05/2024, 10:23", sender: "Sam", text: "line one\nline two" },
      { ts: "01/05/2024, 10:24", sender: "Aisha", text: "ok" },
    ]);
  });

  it("drops system + media lines and direction marks", () => {
    const txt =
      `‎[2024-05-01, 10:00:00] Messages and calls are end-to-end encrypted.\n` +
      `[2024-05-01, 10:01:00] Sam: ‎hello\n` +
      `[2024-05-01, 10:02:00] Sam: ‎<Media omitted>\n` +
      `[2024-05-01, 10:03:00] Aisha added Sam`;
    const out = parseWhatsappExport(txt);
    expect(out).toEqual([{ ts: "2024-05-01, 10:01:00", sender: "Sam", text: "hello" }]);
  });

  it("returns [] for empty/garbage", () => {
    expect(parseWhatsappExport("")).toEqual([]);
    expect(parseWhatsappExport("no timestamps here at all")).toEqual([]);
  });

  it("keeps real messages that contain the word 'null'", () => {
    const txt = `[2024-05-01, 10:01:00] Sam: the DataFlow result came back null`;
    const out = parseWhatsappExport(txt);
    expect(out).toEqual([{ ts: "2024-05-01, 10:01:00", sender: "Sam", text: "the DataFlow result came back null" }]);
  });
});
