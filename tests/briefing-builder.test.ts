import { describe, it, expect } from "vitest";
import {
  buildCeoRollup,
  buildEscalationNudge,
  buildEscalationNudgeTelegram,
  buildStaffBrief,
  buildStaffBriefTelegram,
} from "../src/briefing-builder.js";
import type { CaseLite, StaffUser } from "../src/types.js";

const staff: StaffUser = {
  id: "u1",
  full_name: "Bukola Bunmi",
  email: "bukola@elab.com",
  whatsapp_number: "2348000000001",
  telegram_chat_id: null,
  timezone: "Africa/Lagos",
  morning_brief_enabled: true,
  escalation_nudges_enabled: true,
};

function makeCase(overrides: Partial<CaseLite> = {}): CaseLite {
  return {
    id: "case-uuid-1",
    case_reference: "DFL-2181-0426",
    priority: "high",
    priority_reason: "stuck_7d",
    priority_set_at: "2026-04-20T08:00:00.000Z",
    status: "active",
    assigned_to_user_id: "u1",
    current_stage_id: "stage-1",
    sla_deadline_at: null,
    tags: [],
    created_at: "2026-04-15T08:00:00.000Z",
    updated_at: "2026-04-20T08:00:00.000Z",
    person_full_name: "Zainab Oyelude",
    stage_name: "Incoming Stage",
    pipeline_name: "DataFlow",
    assignee_full_name: "Bukola Bunmi",
    assignee_whatsapp: "2348000000001",
    ...overrides,
  };
}

describe("buildStaffBrief", () => {
  it("returns null when staff has no WhatsApp number", () => {
    const staffNoWA: StaffUser = { ...staff, whatsapp_number: null };
    const result = buildStaffBrief(staffNoWA, [makeCase()], [], "https://cc", "tmpl");
    expect(result).toBeNull();
  });

  it("returns null when priority list is empty", () => {
    const result = buildStaffBrief(staff, [], [], "https://cc", "tmpl");
    expect(result).toBeNull();
  });

  it("builds a valid WhatsApp template payload", () => {
    const cases = [makeCase(), makeCase({ id: "case-2", case_reference: "MU-0149" })];
    const result = buildStaffBrief(staff, cases, [cases[0]], "https://cc", "priority_cases_morning_brief");
    expect(result).not.toBeNull();
    expect(result!.to).toBe("2348000000001");
    expect(result!.template_name).toBe("priority_cases_morning_brief");
    expect(result!.variables).toHaveLength(5);
    expect(result!.variables[0]).toBe("Bukola Bunmi");
    expect(result!.variables[1]).toBe("2");
    expect(result!.variables[2]).toContain("DFL-2181-0426");
    expect(result!.variables[2]).toContain("MU-0149");
    expect(result!.variables[3]).toBe("1");
    expect(result!.variables[4]).toBe("https://cc");
  });

  it("truncates the case list at 10 items", () => {
    const cases = Array.from({ length: 15 }, (_, i) =>
      makeCase({ id: `c-${i}`, case_reference: `REF-${i}` }),
    );
    const result = buildStaffBrief(staff, cases, [], "https://cc", "tmpl");
    expect(result!.variables[2]).toContain("…and 5 more");
    expect(result!.variables[1]).toBe("15"); // count still accurate
  });
});

describe("buildCeoRollup", () => {
  it("renders header, staff breakdown, and neglected top 5", () => {
    const cases = [makeCase(), makeCase({ id: "c2", case_reference: "MU-0149", assigned_to_user_id: "u2", assignee_full_name: "Helen Ehinmisan" })];
    const byAssignee = new Map<string | null, CaseLite[]>([
      ["u1", [cases[0]]],
      ["u2", [cases[1]]],
    ]);
    const names = new Map([
      ["u1", "Bukola Bunmi"],
      ["u2", "Helen Ehinmisan"],
    ]);
    const result = buildCeoRollup(byAssignee, [cases[0]], names, "12345");
    expect(result.chat_id).toBe("12345");
    expect(result.parse_mode).toBe("Markdown");
    expect(result.text).toContain("Priority Cases");
    expect(result.text).toContain("Total priority: 2");
    expect(result.text).toContain("Total neglected");
    expect(result.text).toContain("Bukola Bunmi");
    expect(result.text).toContain("Helen Ehinmisan");
    expect(result.text).toContain("DFL-2181-0426");
  });

  it("shows ✅ when zero neglected", () => {
    const cases = [makeCase()];
    const byAssignee = new Map([["u1", cases]]);
    const result = buildCeoRollup(byAssignee, [], new Map([["u1", "Bukola Bunmi"]]), "12345");
    expect(result.text).toContain("✅");
  });

  it("shows ⚠️ when neglected > 0", () => {
    const cases = [makeCase()];
    const byAssignee = new Map([["u1", cases]]);
    const result = buildCeoRollup(byAssignee, cases, new Map([["u1", "Bukola Bunmi"]]), "12345");
    expect(result.text).toContain("⚠️");
  });
});

describe("buildStaffBriefTelegram", () => {
  it("returns null when staff has no telegram_chat_id", () => {
    const result = buildStaffBriefTelegram(staff, [makeCase()], [], "https://cc");
    expect(result).toBeNull();
  });

  it("returns null when priority list is empty", () => {
    const s: StaffUser = { ...staff, telegram_chat_id: "12345" };
    const result = buildStaffBriefTelegram(s, [], [], "https://cc");
    expect(result).toBeNull();
  });

  it("builds a rich Telegram payload", () => {
    const s: StaffUser = { ...staff, telegram_chat_id: "12345" };
    const cases = [makeCase(), makeCase({ id: "c2", case_reference: "MU-0149" })];
    const result = buildStaffBriefTelegram(s, cases, [cases[0]], "https://cc");
    expect(result).not.toBeNull();
    expect(result!.chat_id).toBe("12345");
    expect(result!.parse_mode).toBe("Markdown");
    expect(result!.text).toContain("Good morning, Bukola");
    expect(result!.text).toContain("2* priority case");
    expect(result!.text).toContain("1* haven't had client contact");
    expect(result!.text).toContain("DFL-2181-0426");
    expect(result!.text).toContain("MU-0149");
    expect(result!.text).toContain("https://cc");
  });

  it("truncates case list at 15 items", () => {
    const s: StaffUser = { ...staff, telegram_chat_id: "12345" };
    const cases = Array.from({ length: 20 }, (_, i) =>
      makeCase({ id: `c-${i}`, case_reference: `REF-${i}` }),
    );
    const result = buildStaffBriefTelegram(s, cases, [], "https://cc");
    expect(result!.text).toContain("…and 5 more");
  });
});

describe("buildEscalationNudgeTelegram", () => {
  it("returns null without telegram_chat_id", () => {
    const result = buildEscalationNudgeTelegram(staff, makeCase(), "https://cc");
    expect(result).toBeNull();
  });

  it("builds a Telegram escalation payload", () => {
    const s: StaffUser = { ...staff, telegram_chat_id: "12345" };
    const c = makeCase();
    const result = buildEscalationNudgeTelegram(s, c, "https://cc");
    expect(result).not.toBeNull();
    expect(result!.chat_id).toBe("12345");
    expect(result!.case_id).toBe("case-uuid-1");
    expect(result!.text).toContain("Escalation — Bukola");
    expect(result!.text).toContain("DFL-2181-0426");
    expect(result!.text).toContain("Zainab Oyelude");
    expect(result!.text).toContain("https://cc/cases/case-uuid-1");
  });
});

describe("buildEscalationNudge", () => {
  it("builds a one-case nudge payload", () => {
    const c = makeCase();
    const result = buildEscalationNudge(staff, c, "priority_case_neglected_nudge");
    expect(result).not.toBeNull();
    expect(result!.to).toBe("2348000000001");
    expect(result!.template_name).toBe("priority_case_neglected_nudge");
    expect(result!.case_id).toBe("case-uuid-1");
    expect(result!.variables).toEqual([
      "Bukola Bunmi",
      "DFL-2181-0426",
      "Zainab Oyelude (Incoming Stage)",
    ]);
  });

  it("returns null when staff has no WhatsApp number", () => {
    const s: StaffUser = { ...staff, whatsapp_number: null };
    const result = buildEscalationNudge(s, makeCase(), "tmpl");
    expect(result).toBeNull();
  });
});
