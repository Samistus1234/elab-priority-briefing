import { logger } from "../logger.js";
import { runEscalationSweep } from "../jobs.js";

runEscalationSweep()
  .then(() => {
    logger.info("escalation:now completed");
    process.exit(0);
  })
  .catch((e) => {
    logger.error({ err: (e as Error).message }, "escalation:now failed");
    process.exit(1);
  });
