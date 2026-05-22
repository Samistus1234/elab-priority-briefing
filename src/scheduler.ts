import cron from "node-cron";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { runCeoHealthCheck, runEscalationSweep, runMcpHealthDigest, runMorningBrief } from "./jobs.js";
import { getSupabase } from "./supabase.js";

/**
 * Schedule the three cron jobs. Also performs a startup catchup:
 * if the morning brief hasn't run today and current time is 08:00–10:00 WAT,
 * run it now (covers container restarts during the scheduled window).
 */
export function startSchedulers(): void {
  const cfg = loadConfig();

  cron.schedule(
    cfg.cron.morningBrief,
    () => {
      runMorningBrief().catch((e) =>
        logger.error({ err: (e as Error).message }, "morning_brief crashed"),
      );
    },
    { timezone: cfg.tz },
  );

  cron.schedule(
    cfg.cron.escalationSweep,
    () => {
      runEscalationSweep().catch((e) =>
        logger.error({ err: (e as Error).message }, "escalation_sweep crashed"),
      );
    },
    { timezone: cfg.tz },
  );

  cron.schedule(
    cfg.cron.ceoHealthCheck,
    () => {
      runCeoHealthCheck().catch((e) =>
        logger.error({ err: (e as Error).message }, "health_check crashed"),
      );
    },
    { timezone: cfg.tz },
  );

  cron.schedule(
    cfg.cron.mcpHealthDigest,
    () => {
      runMcpHealthDigest().catch((e) =>
        logger.error({ err: (e as Error).message }, "mcp_health_digest crashed"),
      );
    },
    { timezone: cfg.tz },
  );

  logger.info(
    {
      morning: cfg.cron.morningBrief,
      escalation: cfg.cron.escalationSweep,
      health: cfg.cron.ceoHealthCheck,
      mcpHealthDigest: cfg.cron.mcpHealthDigest,
      tz: cfg.tz,
    },
    "Schedulers started",
  );
}

/**
 * If the morning brief hasn't run today AND it's between 08:00 and 10:00 in the
 * configured timezone, run it now. Covers container restarts during the window.
 */
export async function startupCatchup(): Promise<void> {
  const cfg = loadConfig();
  const now = new Date();

  // Compute current hour in configured TZ
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: cfg.tz,
  });
  const hour = parseInt(fmt.format(now), 10);

  if (hour < 8 || hour >= 10) {
    logger.info({ hour, tz: cfg.tz }, "startup_catchup: outside 08:00–10:00, skipping");
    return;
  }

  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from("priority_briefings_log")
    .select("id")
    .eq("org_id", cfg.supabase.orgId)
    .eq("job_type", "morning_brief")
    .eq("run_date", today)
    .limit(1);

  if (data && data.length > 0) {
    logger.info("startup_catchup: morning brief already ran today");
    return;
  }

  logger.info("startup_catchup: firing missed morning brief");
  await runMorningBrief();
}
