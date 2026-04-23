import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { getSupabase } from "./supabase.js";
import type {
  EscalationNudgePayload,
  TelegramPayload,
  WhatsAppTemplatePayload,
} from "./briefing-builder.js";
import type { JobType, SendResult, SendStatus, BriefingPayloadSummary } from "./types.js";

/**
 * Dispatcher — all I/O with external services + audit logging.
 * - Handles retries and rate-limit backoff.
 * - Applies DRY_RUN / WHATSAPP_LIVE / TELEGRAM_LIVE kill-switches.
 * - Enforces the daily idempotency check via priority_briefings_log.
 * - Enforces the runtime safety valve (MAX_MESSAGES_PER_RUN).
 */

const META_GRAPH_API = "https://graph.facebook.com/v21.0";

/** In-memory counter for the current run — reset by each top-level job. */
class RunCounter {
  private sent = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  canSend(): boolean {
    return this.sent < this.max;
  }

  tick(): void {
    this.sent += 1;
  }

  count(): number {
    return this.sent;
  }

  reached(): boolean {
    return this.sent >= this.max;
  }
}

export class Dispatcher {
  private counter: RunCounter;
  private cfg = loadConfig();

  constructor() {
    this.counter = new RunCounter(this.cfg.maxMessagesPerRun);
  }

  /** Reset the per-run counter (call at start of each scheduled job). */
  resetCounter(): void {
    this.counter = new RunCounter(this.cfg.maxMessagesPerRun);
  }

  get currentCount(): number {
    return this.counter.count();
  }

  /**
   * Send a WhatsApp template. Honours DRY_RUN + WHATSAPP_LIVE.
   * Retries once on 429. Never throws — returns SendResult.
   */
  async sendWhatsApp(payload: WhatsAppTemplatePayload): Promise<SendResult> {
    if (!this.counter.canSend()) {
      return { ok: false, error: "safety_valve_tripped" };
    }

    if (this.cfg.dryRun || !this.cfg.whatsappLive) {
      logger.info(
        { to: mask(payload.to), template: payload.template_name, dry: true },
        "[DRY] WhatsApp send",
      );
      this.counter.tick();
      return { ok: true, messageId: "dry-run" };
    }

    const url = `${META_GRAPH_API}/${this.cfg.meta.phoneNumberId}/messages`;
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: payload.to,
      type: "template",
      template: {
        name: payload.template_name,
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: payload.variables.map((v) => ({ type: "text", text: v })),
          },
        ],
      },
    };

    const attempt = async (retry = false): Promise<SendResult> => {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.meta.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const j: any = await resp.json().catch(() => ({}));
        if (resp.status === 429 && !retry) {
          await sleep(60_000);
          return attempt(true);
        }
        if (!resp.ok) {
          return {
            ok: false,
            error: `meta_${resp.status}: ${j?.error?.message ?? "unknown"}`,
          };
        }
        const messageId = j?.messages?.[0]?.id ?? "unknown";
        return { ok: true, messageId };
      } catch (e) {
        return { ok: false, error: `network: ${(e as Error).message}` };
      }
    };

    const result = await attempt();
    if (result.ok) this.counter.tick();
    return result;
  }

  /**
   * Send a Telegram message. Honours DRY_RUN + TELEGRAM_LIVE.
   * Retries once on failure. Falls back to writing the rollup to disk if both fail.
   */
  async sendTelegram(payload: TelegramPayload): Promise<SendResult> {
    if (this.cfg.dryRun || !this.cfg.telegramLive) {
      logger.info(
        { chat: mask(payload.chat_id), preview: payload.text.slice(0, 80), dry: true },
        "[DRY] Telegram send",
      );
      return { ok: true, messageId: "dry-run" };
    }

    const url = `https://api.telegram.org/bot${this.cfg.telegram.botToken}/sendMessage`;
    const body = {
      chat_id: payload.chat_id,
      text: payload.text,
      parse_mode: payload.parse_mode,
      disable_web_page_preview: true,
    };

    const attempt = async (retry = false): Promise<SendResult> => {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j: any = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          if (!retry) {
            await sleep(30_000);
            return attempt(true);
          }
          return { ok: false, error: `telegram_${resp.status}: ${j?.description ?? "unknown"}` };
        }
        return { ok: true, messageId: String(j?.result?.message_id ?? "unknown") };
      } catch (e) {
        return { ok: false, error: `network: ${(e as Error).message}` };
      }
    };

    return attempt();
  }

  /**
   * Check if an identical briefing was already sent today (idempotency).
   */
  async alreadySentToday(
    jobType: JobType,
    recipientUserId: string | null,
  ): Promise<boolean> {
    const supabase = getSupabase();
    const today = new Date().toISOString().slice(0, 10);

    const query = supabase
      .from("priority_briefings_log")
      .select("id")
      .eq("org_id", this.cfg.supabase.orgId)
      .eq("job_type", jobType)
      .eq("status", "sent")
      .eq("run_date", today)
      .limit(1);

    const { data } = recipientUserId
      ? await query.eq("recipient_user_id", recipientUserId)
      : await query.is("recipient_user_id", null);

    return !!(data && data.length > 0);
  }

  /**
   * Check if a specific neglected case was already nudged today.
   */
  async caseNudgedToday(caseId: string): Promise<boolean> {
    const supabase = getSupabase();
    const today = new Date().toISOString().slice(0, 10);

    const { data } = await supabase
      .from("priority_briefings_log")
      .select("id")
      .eq("org_id", this.cfg.supabase.orgId)
      .eq("job_type", "escalation_sweep")
      .eq("status", "sent")
      .eq("run_date", today)
      .contains("payload_summary", { case_id: caseId })
      .limit(1);

    return !!(data && data.length > 0);
  }

  /**
   * Write an audit row. Never throws.
   */
  async log(args: {
    jobType: JobType;
    recipientUserId: string | null;
    channel: "whatsapp" | "telegram";
    caseCount: number;
    payloadSummary: BriefingPayloadSummary | Record<string, unknown>;
    status: SendStatus;
    error?: string;
  }): Promise<void> {
    const supabase = getSupabase();
    const { error } = await supabase.from("priority_briefings_log").insert({
      org_id: this.cfg.supabase.orgId,
      job_type: args.jobType,
      recipient_user_id: args.recipientUserId,
      recipient_channel: args.channel,
      case_count: args.caseCount,
      payload_summary: args.payloadSummary,
      status: args.status,
      error: args.error ?? null,
    });
    if (error) {
      logger.error({ err: error.message }, "Failed to write briefings log");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mask(s: string): string {
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}
