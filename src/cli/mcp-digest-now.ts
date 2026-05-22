import { logger } from "../logger.js";
import { runMcpHealthDigest } from "../jobs.js";

runMcpHealthDigest()
  .then(() => {
    logger.info("mcp:digest:now completed");
    process.exit(0);
  })
  .catch((e) => {
    logger.error({ err: (e as Error).message }, "mcp:digest:now failed");
    process.exit(1);
  });
