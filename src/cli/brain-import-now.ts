import { runImportIngestion } from "../brain/ingest-imports.js";
import { logger } from "../logger.js";

runImportIngestion()
  .then((r) => {
    logger.info(r, "brain:import:now completed");
    process.exit(0);
  })
  .catch((e) => {
    logger.error({ err: (e as Error).message }, "brain:import:now failed");
    process.exit(1);
  });
