import { describe, it, expect, vi, beforeEach } from "vitest";

const fromMock = vi.fn();
vi.mock("../../src/supabase.js", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({ supabase: { orgId: "org-1" } }),
}));

import { postChannelMessage } from "../../src/channels/post.js";

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "insert", "limit"]) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.maybeSingle = vi.fn().mockResolvedValue(result);
  c.single = vi.fn().mockResolvedValue(result);
  c.then = undefined;
  return c;
}

describe("postChannelMessage", () => {
  beforeEach(() => fromMock.mockReset());

  it("inserts with service user, channel id, and agent metadata", async () => {
    const userChain = chain({ data: { id: "svc-1" }, error: null });
    const channelChain = chain({ data: { id: "chan-1" }, error: null });
    const insertChain = { insert: vi.fn().mockResolvedValue({ error: null }) };
    const updateChain = { update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }) };
    fromMock
      .mockReturnValueOnce(userChain)
      .mockReturnValueOnce(channelChain)
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(updateChain);

    const ok = await postChannelMessage({ channelName: "daily-briefs", body: "Morning brief", agent: "Herald" });

    expect(ok).toBe(true);
    expect(insertChain.insert).toHaveBeenCalledWith({
      channel_id: "chan-1",
      user_id: "svc-1",
      body: "Morning brief",
      metadata: { agent: "Herald" },
    });
  });

  it("returns false (never throws) when the service user is missing", async () => {
    fromMock.mockReturnValueOnce(chain({ data: null, error: null }));
    await expect(postChannelMessage({ channelName: "daily-briefs", body: "x", agent: "Herald" }))
      .resolves.toBe(false);
  });

  it("returns false when insert errors", async () => {
    fromMock
      .mockReturnValueOnce(chain({ data: { id: "svc-1" }, error: null }))
      .mockReturnValueOnce(chain({ data: { id: "chan-1" }, error: null }))
      .mockReturnValueOnce({ insert: vi.fn().mockResolvedValue({ error: { message: "boom" } }) });
    await expect(postChannelMessage({ channelName: "daily-briefs", body: "x", agent: "Herald" }))
      .resolves.toBe(false);
  });

  it("returns false when the channel is missing", async () => {
    fromMock
      .mockReturnValueOnce(chain({ data: { id: "svc-1" }, error: null }))
      .mockReturnValueOnce(chain({ data: null, error: null }));
    await expect(postChannelMessage({ channelName: "daily-briefs", body: "x", agent: "Herald" }))
      .resolves.toBe(false);
  });
});
