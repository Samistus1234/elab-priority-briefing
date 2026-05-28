import { runKnowledgeDocIngest } from "../brain/ingest-docs.js";
import { getSupabase } from "../supabase.js";
import { logger } from "../logger.js";

runKnowledgeDocIngest(getSupabase())
  .then((r) => {
    logger.info(r, "brain:ingest-docs:now completed");
    process.exit(0);
  })
  .catch((e) => {
    logger.error({ err: (e as Error).message }, "brain:ingest-docs:now failed");
    process.exit(1);
  });
