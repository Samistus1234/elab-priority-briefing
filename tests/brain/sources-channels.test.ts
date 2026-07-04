import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
vi.mock("../../src/supabase.js", () => ({ getSupabase: () => ({ rpc: rpcMock }) }));

import { fetchChannelGroups } from "../../src/brain/sources.js";

describe("fetchChannelGroups", () => {
  beforeEach(() => rpcMock.mockReset());

  it("maps RPC rows to Groups with speaker-labelled transcript", async () => {
    rpcMock.mockResolvedValue({
      data: [{
        group_key: "chan-1:2026-07-04",
        cursor_ts: "2026-07-04T10:00:00Z",
        lines: [
          { who: "Amina", text: "Client asked about UTV", at: "2026-07-04T09:00:00Z" },
          { who: "Bukola", text: "UTV means unable to verify", at: "2026-07-04T10:00:00Z" },
        ],
      }],
      error: null,
    });

    const groups = await fetchChannelGroups("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 10);

    expect(rpcMock).toHaveBeenCalledWith("brain_channel_groups", {
      p_window_start: "2026-01-01T00:00:00Z",
      p_cursor: "2026-01-01T00:00:00Z",
      p_limit: 10,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe("channel");
    expect(groups[0].groupId).toBe("chan-1:2026-07-04");
    expect(groups[0].cursorTs).toBe("2026-07-04T10:00:00Z");
    expect(groups[0].transcript).toBe("Amina: Client asked about UTV\nBukola: UTV means unable to verify");
  });

  it("returns [] on RPC error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(fetchChannelGroups("a", "b", 5)).resolves.toEqual([]);
  });

  it("truncates transcripts to the 12000-char budget at a line boundary", async () => {
    const long = "x".repeat(7000);
    rpcMock.mockResolvedValue({
      data: [{
        group_key: "c:d",
        cursor_ts: "t",
        lines: [
          { who: "A", text: long, at: "1" },
          { who: "B", text: long, at: "2" },
        ],
      }],
      error: null,
    });
    const groups = await fetchChannelGroups("a", "b", 5);
    expect(groups[0].transcript.length).toBeLessThanOrEqual(12000);
    expect(groups[0].transcript.endsWith(long)).toBe(true); // cut at line boundary, not mid-line
  });
});
