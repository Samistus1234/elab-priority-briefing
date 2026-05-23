import { logger } from "../logger.js";
import { runBrainSynthesis } from "../brain/synthesize.js";

runBrainSynthesis()
  .then((r) => {
    logger.info(r, "brain:synth:now completed");
    process.exit(0);
  })
  .catch((e) => {
    logger.error({ err: (e as Error).message }, "brain:synth:now failed");
    process.exit(1);
  });
