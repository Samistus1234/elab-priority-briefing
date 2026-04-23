import { describe, it, expect } from "vitest";
import { classify } from "../src/priority-engine.js";

function candidate(overrides: Partial<Parameters<typeof classify>[0]> = {}): Parameters<typeof classify>[0] {
  const now = "2026-04-23T08:00:00.000Z";
  return {
    id: "test-id",
    priority: "normal",
    status: "active",
    is_archived: false,
    tags: [],
    sla_deadline_at: null,
    created_at: now,
    last_stage_change_at: now,
    last_client_outbound_at: null,
    latest_inbound_at: null,
    ...overrides,
  };
}

const NOW = "2026-04-23T08:00:00.000Z";
const TWO_DAYS_AGO = "2026-04-21T08:00:00.000Z";
const FOUR_DAYS_AGO = "2026-04-19T08:00:00.000Z"; // UNDER stuck_7d threshold
const EIGHT_DAYS_AGO = "2026-04-15T08:00:00.000Z"; // OVER stuck_7d threshold
const FIFTY_DAYS_AGO = "2026-03-04T08:00:00.000Z";
const ONE_HOUR_AGO = "2026-04-23T07:00:00.000Z";
const TWENTY_FIVE_HOURS_AGO = "2026-04-22T07:00:00.000Z";

describe("classify — R2 SLA breach (highest precedence)", () => {
  it("flags when SLA deadline is in the past", () => {
    const c = candidate({ sla_deadline_at: TWO_DAYS_AGO });
    expect(classify(c, NOW)).toBe("sla_breach");
  });

  it("does not flag when SLA deadline is in the future", () => {
    const c = candidate({ sla_deadline_at: "2027-01-01T00:00:00.000Z" });
    expect(classify(c, NOW)).toBeNull();
  });

  it("sla_breach wins over stuck_7d", () => {
    const c = candidate({
      sla_deadline_at: TWO_DAYS_AGO,
      last_stage_change_at: EIGHT_DAYS_AGO,
    });
    expect(classify(c, NOW)).toBe("sla_breach");
  });
});

describe("classify — R3 unanswered client", () => {
  it("flags when inbound > 24h ago and no outbound since", () => {
    const c = candidate({
      latest_inbound_at: TWENTY_FIVE_HOURS_AGO,
      last_client_outbound_at: null,
    });
    expect(classify(c, NOW)).toBe("unanswered_client");
  });

  it("does not flag when outbound is after inbound", () => {
    const c = candidate({
      latest_inbound_at: TWENTY_FIVE_HOURS_AGO,
      last_client_outbound_at: ONE_HOUR_AGO,
    });
    expect(classify(c, NOW)).toBeNull();
  });

  it("does not flag when inbound is within 24h", () => {
    const c = candidate({ latest_inbound_at: ONE_HOUR_AGO });
    expect(classify(c, NOW)).toBeNull();
  });
});

describe("classify — R1 stuck >7d", () => {
  it("flags when last_stage_change_at is >7 days ago", () => {
    const c = candidate({ last_stage_change_at: EIGHT_DAYS_AGO });
    expect(classify(c, NOW)).toBe("stuck_7d");
  });

  it("does not flag when last change is only 4 days ago", () => {
    const c = candidate({ last_stage_change_at: FOUR_DAYS_AGO });
    expect(classify(c, NOW)).toBeNull();
  });

  it("does not flag when last change is 2 days ago", () => {
    const c = candidate({ last_stage_change_at: TWO_DAYS_AGO });
    expect(classify(c, NOW)).toBeNull();
  });

  it("falls back to created_at when last_stage_change_at is null", () => {
    const c = candidate({
      last_stage_change_at: null,
      created_at: EIGHT_DAYS_AGO,
    });
    expect(classify(c, NOW)).toBe("stuck_7d");
  });
});

describe("classify — R4 error/issue tag", () => {
  it("flags when tag is 'error'", () => {
    const c = candidate({ tags: ["error"] });
    expect(classify(c, NOW)).toBe("error_tag");
  });

  it("flags when tag is 'issue'", () => {
    const c = candidate({ tags: ["issue", "dataflow"] });
    expect(classify(c, NOW)).toBe("error_tag");
  });

  it("does not flag on unrelated tags", () => {
    const c = candidate({ tags: ["dataflow", "qatar"] });
    expect(classify(c, NOW)).toBeNull();
  });
});

describe("classify — R5 long-running >45d", () => {
  it("flags when created_at > 45 days ago", () => {
    const c = candidate({
      created_at: FIFTY_DAYS_AGO,
      last_stage_change_at: ONE_HOUR_AGO, // avoid stuck_7d
    });
    expect(classify(c, NOW)).toBe("long_running_45d");
  });

  it("does not flag recent cases", () => {
    const c = candidate({ created_at: FOUR_DAYS_AGO, last_stage_change_at: ONE_HOUR_AGO });
    expect(classify(c, NOW)).toBeNull();
  });
});

describe("classify — R6 VIP/referred tag", () => {
  it("flags when tag is 'vip'", () => {
    const c = candidate({ tags: ["vip"], last_stage_change_at: ONE_HOUR_AGO });
    expect(classify(c, NOW)).toBe("vip_tag");
  });

  it("flags when tag is 'referred'", () => {
    const c = candidate({ tags: ["referred"], last_stage_change_at: ONE_HOUR_AGO });
    expect(classify(c, NOW)).toBe("vip_tag");
  });
});

describe("classify — no match", () => {
  it("returns null for fresh, in-progress, tagless cases", () => {
    const c = candidate({
      created_at: ONE_HOUR_AGO,
      last_stage_change_at: ONE_HOUR_AGO,
    });
    expect(classify(c, NOW)).toBeNull();
  });
});

describe("classify — precedence", () => {
  it("unanswered_client beats stuck_7d", () => {
    const c = candidate({
      latest_inbound_at: TWENTY_FIVE_HOURS_AGO,
      last_stage_change_at: EIGHT_DAYS_AGO,
    });
    expect(classify(c, NOW)).toBe("unanswered_client");
  });

  it("stuck_7d beats error_tag", () => {
    const c = candidate({
      last_stage_change_at: EIGHT_DAYS_AGO,
      tags: ["error"],
    });
    expect(classify(c, NOW)).toBe("stuck_7d");
  });

  it("error_tag beats long_running", () => {
    const c = candidate({
      created_at: FIFTY_DAYS_AGO,
      last_stage_change_at: ONE_HOUR_AGO,
      tags: ["error"],
    });
    expect(classify(c, NOW)).toBe("error_tag");
  });

  it("long_running beats vip_tag", () => {
    const c = candidate({
      created_at: FIFTY_DAYS_AGO,
      last_stage_change_at: ONE_HOUR_AGO,
      tags: ["vip"],
    });
    expect(classify(c, NOW)).toBe("long_running_45d");
  });
});
