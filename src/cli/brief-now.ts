import { logger } from "../logger.js";
import { runMorningBrief } from "../jobs.js";

runMorningBrief()
  .then(() => {
    logger.info("brief:now completed");
    process.exit(0);
  })
  .catch((e) => {
    logger.error({ err: (e as Error).message }, "brief:now failed");
    process.exit(1);
  });
