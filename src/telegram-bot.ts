import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { getSupabase } from "./supabase.js";
import { findUserByChatId, resolveScopeForUser } from "./permissions.js";
import {
  cmdCase,
  cmdHelp,
  cmdMyCases,
  cmdStatus,
  cmdStuck,
} from "./commands.js";

/**
 * Long-polling Telegram bot that handles enrollment.
 *
 * Commands:
 *   /start — Welcomes the user. If they include their ELAB email after /start,
 *            we auto-link their chat_id. Otherwise we ask them to send their email.
 *   /enroll <email> — Explicit enrollment command.
 *   /status — Shows the staff member their enrollment status.
 *   /mycases — Phase 2 placeholder (not yet implemented).
 *
 * State:
 *   Persists last_update_id to `telegram_bot_state` table so restarts don't
 *   replay messages or miss new ones.
 */

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 30; // long-poll

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

const pendingEmailByChatId = new Map<number, { awaiting: boolean; ts: number }>();

export async function startEnrollmentBot(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.telegram.botToken) {
    logger.warn("Telegram bot token missing — enrollment bot not started");
    return;
  }

  logger.info("Starting Telegram enrollment bot");
  void pollLoop();
}

async function pollLoop(): Promise<void> {
  let offset = await loadOffset();
  for (;;) {
    try {
      const updates = await fetchUpdates(offset);
      for (const upd of updates) {
        await handleUpdate(upd);
        offset = upd.update_id + 1;
      }
      if (updates.length > 0) {
        await saveOffset(offset);
      }
    } catch (e) {
      logger.error({ err: (e as Error).message }, "telegram poll error");
      await sleep(5000);
    }
  }
}

async function fetchUpdates(offset: number): Promise<TelegramUpdate[]> {
  const { telegram } = loadConfig();
  const url = `${TELEGRAM_API}/bot${telegram.botToken}/getUpdates?timeout=${POLL_TIMEOUT_SECONDS}&offset=${offset}&allowed_updates=%5B%22message%22%5D`;

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`getUpdates ${resp.status}`);
  }
  const j: any = await resp.json();
  if (!j.ok) throw new Error(`getUpdates failed: ${j.description}`);
  return (j.result ?? []) as TelegramUpdate[];
}

async function handleUpdate(upd: TelegramUpdate): Promise<void> {
  const msg = upd.message;
  if (!msg || !msg.text || msg.chat.type !== "private") return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  try {
    if (text.startsWith("/start")) {
      await handleStart(chatId, text);
    } else if (text.startsWith("/enroll")) {
      await handleEnroll(chatId, text);
    } else if (pendingEmailByChatId.get(chatId)?.awaiting && isEmail(text)) {
      await linkEmailToChat(chatId, text);
      pendingEmailByChatId.delete(chatId);
    } else {
      // Everything else requires enrollment
      await handleAuthenticatedCommand(chatId, text);
    }
  } catch (e) {
    logger.error({ err: (e as Error).message, chatId }, "handleUpdate error");
  }
}

async function handleStart(chatId: number, text: string): Promise<void> {
  const parts = text.split(/\s+/);
  // /start user@example.com  — deep-link form
  if (parts.length > 1 && isEmail(parts[1])) {
    await linkEmailToChat(chatId, parts[1]);
    return;
  }

  // Already enrolled?
  const existing = await findPrefsByChatId(chatId);
  if (existing) {
    await reply(
      chatId,
      `✅ You're already enrolled (as ${existing.email}). You'll receive your priority brief each morning at 8 AM WAT.`,
    );
    return;
  }

  pendingEmailByChatId.set(chatId, { awaiting: true, ts: Date.now() });
  await reply(
    chatId,
    "Welcome to ELAB Ops Priority Briefings.\n\nPlease reply with your ELAB email address so I can link this Telegram account to your staff profile.",
  );
}

async function handleEnroll(chatId: number, text: string): Promise<void> {
  const parts = text.split(/\s+/);
  if (parts.length < 2 || !isEmail(parts[1])) {
    await reply(chatId, "Usage: /enroll your-email@elab.com");
    return;
  }
  await linkEmailToChat(chatId, parts[1]);
}

async function handleAuthenticatedCommand(chatId: number, text: string): Promise<void> {
  const userId = await findUserByChatId(chatId);
  if (!userId) {
    await reply(
      chatId,
      "You're not enrolled yet. Send `/enroll your-email@elabsolution.org` to get started.",
      "Markdown",
    );
    return;
  }

  const scope = await resolveScopeForUser(userId);
  if (!scope) {
    await reply(chatId, "Your account seems to be inactive. Please contact an admin.");
    return;
  }

  // Parse command and args
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");

  let responseText: string;
  try {
    switch (cmd) {
      case "/help":
        responseText = await cmdHelp(scope);
        break;
      case "/mycases":
        responseText = await cmdMyCases(scope);
        break;
      case "/stuck":
        responseText = await cmdStuck(scope);
        break;
      case "/case":
        responseText = await cmdCase(scope, args);
        break;
      case "/status":
        responseText = await cmdStatus(scope);
        break;
      case "/note":
      case "/reply":
      case "/escalate":
        responseText = `\`${cmd}\` is coming in a future update. For now you can use Command Centre to add notes / reply / escalate.`;
        break;
      default:
        responseText =
          `Unknown command: \`${escapeMd(cmd)}\`\n\nSend \`/help\` to see what's available.`;
    }
  } catch (e) {
    logger.error({ err: (e as Error).message, cmd, userId }, "command handler crashed");
    responseText = "Something went wrong running that command. The error has been logged.";
  }

  await reply(chatId, responseText, "Markdown");
}

async function linkEmailToChat(chatId: number, email: string): Promise<void> {
  const supabase = getSupabase();
  const { data: user, error } = await supabase
    .from("users")
    .select("id, full_name, email, is_active")
    .ilike("email", email)
    .maybeSingle();

  if (error || !user) {
    await reply(
      chatId,
      `No ELAB staff account found for ${email}. Please check the email is correct, or ask an admin to add you.`,
    );
    return;
  }

  if (!user.is_active) {
    await reply(chatId, "Your account is marked inactive. Please contact an admin.");
    return;
  }

  // Upsert prefs with this chat_id
  const { error: upErr } = await supabase.from("staff_notification_prefs").upsert(
    {
      user_id: user.id,
      telegram_chat_id: String(chatId),
      telegram_enrolled_at: new Date().toISOString(),
      morning_brief_enabled: true,
      escalation_nudges_enabled: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (upErr) {
    logger.error({ err: upErr.message }, "enrollment upsert failed");
    await reply(chatId, "Something went wrong saving your enrollment. Please try again.");
    return;
  }

  await reply(
    chatId,
    `✅ Enrolled, ${user.full_name}. You'll receive your daily priority brief here at 8 AM WAT.\n\nCommands:\n/status — check your settings\n/mycases — (coming soon)`,
  );
  logger.info({ userId: user.id, chatId }, "staff enrolled via telegram");
}

async function reply(
  chatId: number,
  text: string,
  parseMode?: "Markdown" | "MarkdownV2" | "HTML",
): Promise<void> {
  const { telegram } = loadConfig();
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;

  const resp = await fetch(`${TELEGRAM_API}/bot${telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    logger.error({ status: resp.status, chatId }, "telegram reply failed");
  }
}

async function findPrefsByChatId(
  chatId: number,
): Promise<{ email: string; morning_brief_enabled: boolean; escalation_nudges_enabled: boolean; timezone: string } | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("staff_notification_prefs")
    .select(`
      morning_brief_enabled, escalation_nudges_enabled, timezone,
      user:users!staff_notification_prefs_user_id_fkey(email)
    `)
    .eq("telegram_chat_id", String(chatId))
    .maybeSingle();
  if (!data || !(data as any).user) return null;
  return {
    email: (data as any).user.email,
    morning_brief_enabled: (data as any).morning_brief_enabled,
    escalation_nudges_enabled: (data as any).escalation_nudges_enabled,
    timezone: (data as any).timezone,
  };
}

async function loadOffset(): Promise<number> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("telegram_bot_state")
    .select("last_update_id")
    .eq("id", 1)
    .maybeSingle();
  return data?.last_update_id ?? 0;
}

async function saveOffset(offset: number): Promise<void> {
  const supabase = getSupabase();
  await supabase
    .from("telegram_bot_state")
    .update({ last_update_id: offset, updated_at: new Date().toISOString() })
    .eq("id", 1);
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function escapeMd(s: string): string {
  return s.replace(/[_*`\[\]]/g, (ch) => `\\${ch}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
