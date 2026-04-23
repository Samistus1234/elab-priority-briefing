import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { startSchedulers, startupCatchup } from "./scheduler.js";
import { startEnrollmentBot } from "./telegram-bot.js";

async function main() {
  const cfg = loadConfig();
  logger.info(
    {
      dryRun: cfg.dryRun,
      whatsappLive: cfg.whatsappLive,
      telegramLive: cfg.telegramLive,
      tz: cfg.tz,
    },
    "elab-priority-briefing starting",
  );

  startSchedulers();
  void startEnrollmentBot();
  await startupCatchup().catch((e) =>
    logger.error({ err: (e as Error).message }, "startup_catchup failed"),
  );

  // Graceful shutdown
  const shutdown = (sig: string) => {
    logger.info({ sig }, "shutting down");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  logger.error({ err: (e as Error).message, stack: (e as Error).stack }, "fatal");
  process.exit(1);
});
