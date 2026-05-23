import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

const ConfigSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_ORG_ID: z.string().uuid(),

  META_GRAPH_TOKEN: z.string().min(10),
  META_PHONE_NUMBER_ID: z.string().min(5),
  META_WA_TEMPLATE_MORNING_BRIEF: z.string().default("priority_cases_morning_brief_v2"),
  META_WA_TEMPLATE_ESCALATION_NUDGE: z.string().default("priority_case_neglected_nudge_v2"),

  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_CEO_CHAT_ID: z.string().min(1),

  DRY_RUN: z.enum(["true", "false"]).default("true"),
  TELEGRAM_LIVE: z.enum(["true", "false"]).default("false"),
  WHATSAPP_LIVE: z.enum(["true", "false"]).default("false"),

  TZ: z.string().default("Africa/Lagos"),
  MORNING_BRIEF_CRON: z.string().default("0 8 * * *"),
  // Escalation sweep runs once per day mid-morning. Dedup is per-UTC-day, so
  // running more frequently doesn't increase nag rate — it just adds log noise.
  ESCALATION_SWEEP_CRON: z.string().default("0 11 * * *"),
  CEO_HEALTH_CHECK_CRON: z.string().default("30 8 * * *"),
  MCP_HEALTH_DIGEST_CRON: z.string().default("0 9 * * *"),
  MCP_DIGEST_LOOKBACK_HOURS: z.coerce.number().int().positive().default(24),
  BRAIN_SYNTH_CRON: z.string().default("0 */2 * * *"),
  BRAIN_MAX_GROUPS_PER_RUN: z.coerce.number().int().positive().default(60),
  BRAIN_WINDOW_DAYS: z.coerce.number().int().positive().default(180),

  COMMAND_CENTRE_URL: z.string().url().default("https://app.elabsolution.org"),

  MAX_MESSAGES_PER_RUN: z.coerce.number().int().positive().default(30),
  // Hours of no outbound client contact before a priority case escalates.
  // Was 24h — too aggressive, every priority case crossed it. 72h gives
  // three working days of grace before the Telegram nag fires.
  NEGLECT_THRESHOLD_HOURS: z.coerce.number().int().positive().default(72),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // LLM (Phase 2b Round 3) — optional. If missing, NL questions fall back to help.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  LLM_MAX_QUERIES_PER_HOUR: z.coerce.number().int().positive().default(30),
});

export type AppConfig = {
  supabase: { url: string; key: string; orgId: string };
  meta: {
    token: string;
    phoneNumberId: string;
    templateMorningBrief: string;
    templateEscalationNudge: string;
  };
  telegram: { botToken: string; ceoChatId: string };
  dryRun: boolean;
  telegramLive: boolean;
  whatsappLive: boolean;
  tz: string;
  cron: {
    morningBrief: string;
    escalationSweep: string;
    ceoHealthCheck: string;
    mcpHealthDigest: string;
  };
  commandCentreUrl: string;
  mcp: { digestLookbackHours: number };
  brain: { synthCron: string; maxGroupsPerRun: number; windowDays: number };
  maxMessagesPerRun: number;
  neglectThresholdHours: number;
  logLevel: "debug" | "info" | "warn" | "error";
  llm: {
    apiKey: string | null;
    model: string;
    maxQueriesPerHour: number;
  };
};

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const e = parsed.data;
  cached = {
    supabase: {
      url: e.SUPABASE_URL,
      key: e.SUPABASE_SERVICE_ROLE_KEY,
      orgId: e.SUPABASE_ORG_ID,
    },
    meta: {
      token: e.META_GRAPH_TOKEN,
      phoneNumberId: e.META_PHONE_NUMBER_ID,
      templateMorningBrief: e.META_WA_TEMPLATE_MORNING_BRIEF,
      templateEscalationNudge: e.META_WA_TEMPLATE_ESCALATION_NUDGE,
    },
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, ceoChatId: e.TELEGRAM_CEO_CHAT_ID },
    dryRun: e.DRY_RUN === "true",
    telegramLive: e.TELEGRAM_LIVE === "true",
    whatsappLive: e.WHATSAPP_LIVE === "true",
    tz: e.TZ,
    cron: {
      morningBrief: e.MORNING_BRIEF_CRON,
      escalationSweep: e.ESCALATION_SWEEP_CRON,
      ceoHealthCheck: e.CEO_HEALTH_CHECK_CRON,
      mcpHealthDigest: e.MCP_HEALTH_DIGEST_CRON,
    },
    commandCentreUrl: e.COMMAND_CENTRE_URL,
    mcp: { digestLookbackHours: e.MCP_DIGEST_LOOKBACK_HOURS },
    brain: {
      synthCron: e.BRAIN_SYNTH_CRON,
      maxGroupsPerRun: e.BRAIN_MAX_GROUPS_PER_RUN,
      windowDays: e.BRAIN_WINDOW_DAYS,
    },
    maxMessagesPerRun: e.MAX_MESSAGES_PER_RUN,
    neglectThresholdHours: e.NEGLECT_THRESHOLD_HOURS,
    logLevel: e.LOG_LEVEL,
    llm: {
      apiKey: e.ANTHROPIC_API_KEY ?? null,
      model: e.ANTHROPIC_MODEL,
      maxQueriesPerHour: e.LLM_MAX_QUERIES_PER_HOUR,
    },
  };
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
