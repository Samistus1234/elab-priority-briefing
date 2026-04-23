import pino from "pino";

let cached: pino.Logger | null = null;

function resolve(): pino.Logger {
  if (cached) return cached;
  const level = process.env.LOG_LEVEL ?? "info";
  cached = pino({
    level,
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return cached;
}

export const logger = new Proxy({} as pino.Logger, {
  get(_, prop) {
    return (resolve() as any)[prop];
  },
});
