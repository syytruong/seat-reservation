import pino from "pino";

export function createLogger(service: string) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

export type Logger = ReturnType<typeof createLogger>;
