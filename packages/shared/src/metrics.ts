import type { Request, Response } from "express";
import client from "prom-client";

export function createMetrics(serviceName: string) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register: registry });
  const businessEvents = new client.Counter({
    name: "business_events_total",
    help: "Business events by action and outcome",
    labelNames: ["action", "outcome"],
    registers: [registry]
  });
  return {
    businessEvents,
    handler: async (_req: Request, res: Response) => {
      res.setHeader("content-type", registry.contentType);
      res.send(await registry.metrics());
    }
  };
}
