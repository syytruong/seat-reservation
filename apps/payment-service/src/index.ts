import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import {
  authenticateAccessToken,
  baseServiceEnv,
  checkPostgres,
  consumeEvents,
  createBroker,
  createLogger,
  createMetrics,
  createPool,
  errorHandler,
  inTransaction,
  intEnv,
  redisClient,
  redisRateLimit,
  requestContext,
  securityMiddleware,
  signWebhookPayload,
  startOutboxPublisher,
  verifyWebhookSignature,
  type DomainEvent,
  type SeatHeldPayload
} from "@seat/shared";

const serviceName = "payment-service";
const logger = createLogger(serviceName);
const env = baseServiceEnv
  .extend({
    PAYMENT_DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(32),
    WEBHOOK_SECRET: z.string().min(32),
    PAYMENT_PORT: z.coerce.number().default(3003)
  })
  .parse(process.env);

const webhookToleranceSeconds = intEnv("WEBHOOK_TOLERANCE_SECONDS", 300);
const pool = createPool(env.PAYMENT_DATABASE_URL, serviceName);
const metrics = createMetrics(serviceName);

const checkoutSchema = z.object({
  holdId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128)
});

const completeSchema = z.object({
  paymentIntentId: z.string().uuid(),
  outcome: z.enum(["succeeded", "failed"]).default("succeeded")
});

interface PaymentProvider {
  createCheckoutUrl(intent: { id: string; amountCents: number }): string;
  buildWebhook(intent: { id: string; outcome: "succeeded" | "failed" }): Buffer;
}

class MockPaymentProvider implements PaymentProvider {
  createCheckoutUrl(intent: { id: string; amountCents: number }) {
    return `/mock-checkout/${intent.id}?amount=${intent.amountCents}`;
  }

  buildWebhook(intent: { id: string; outcome: "succeeded" | "failed" }) {
    return Buffer.from(
      JSON.stringify({
        id: `evt_${crypto.randomUUID()}`,
        type: intent.outcome === "succeeded" ? "payment_intent.succeeded" : "payment_intent.payment_failed",
        data: { object: { id: intent.id } }
      })
    );
  }
}

const provider = new MockPaymentProvider();

async function handleSeatHeld(event: DomainEvent<"seat.held", SeatHeldPayload>) {
  await inTransaction(pool, async (client) => {
    const processed = await client.query(
      "INSERT INTO processed_events (event_id, consumer_group) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.eventId, "payment-seat"]
    );
    if (processed.rowCount === 0) return;
    const payload = event.payload;
    await client.query(
      `INSERT INTO seat_holds (hold_id, seat_id, seat_label, user_id, amount_cents, held_until, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'HELD')
       ON CONFLICT (hold_id) DO NOTHING`,
      [payload.holdId, payload.seatId, payload.seatLabel, payload.userId, payload.priceCents, payload.heldUntil]
    );
  });
}

async function processWebhookPayload(rawBody: Buffer, signatureHeader: string | undefined) {
  // TODO(prod): switch to ack-fast webhook inbox processing once provider volume exceeds this synchronous local-demo path.
  const verified = verifyWebhookSignature({
    secret: env.WEBHOOK_SECRET,
    payload: rawBody,
    signatureHeader,
    toleranceSeconds: webhookToleranceSeconds
  });
  if (!verified) return { status: 401 as const, body: { error: "invalid_signature" } };

  const parsed = z
    .object({
      id: z.string().min(1),
      type: z.enum(["payment_intent.succeeded", "payment_intent.payment_failed"]),
      data: z.object({ object: z.object({ id: z.string().uuid() }) })
    })
    .parse(JSON.parse(rawBody.toString("utf8")));

  const duplicateOrProcessed = await inTransaction(pool, async (client) => {
    const inserted = await client.query(
      "INSERT INTO webhook_events (stripe_event_id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING stripe_event_id",
      [parsed.id, parsed.type]
    );
    if (inserted.rowCount === 0) return "duplicate";

    const { rows } = await client.query("SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE", [parsed.data.object.id]);
    const intent = rows[0];
    if (!intent) return "missing_intent";
    if (intent.status !== "PENDING") return "already_terminal";

    const completed = parsed.type === "payment_intent.succeeded";
    await client.query("UPDATE payment_intents SET status = $1, updated_at = NOW() WHERE id = $2", [
      completed ? "COMPLETED" : "FAILED",
      intent.id
    ]);
    await client.query("UPDATE seat_holds SET status = $1, updated_at = NOW() WHERE hold_id = $2", [
      completed ? "RESERVED" : "RELEASED",
      intent.hold_id
    ]);
    await client.query("INSERT INTO outbox (event_name, payload) VALUES ($1, $2)", [
      completed ? "payment.completed" : "payment.failed",
      completed
        ? { paymentIntentId: intent.id, holdId: intent.hold_id, userId: intent.user_id, amountCents: intent.amount_cents }
        : { paymentIntentId: intent.id, holdId: intent.hold_id, userId: intent.user_id, reason: "mock_payment_failed" }
    ]);
    await client.query("UPDATE webhook_events SET processed_at = NOW() WHERE stripe_event_id = $1", [parsed.id]);
    metrics.businessEvents.inc({ action: completed ? "payment_completed" : "payment_failed", outcome: "success" });
    return "processed";
  });

  return { status: 200 as const, body: { received: true, result: duplicateOrProcessed } };
}

async function main() {
  const redis = redisClient(env.REDIS_URL);
  await redis.connect();
  const broker = await createBroker(env.RABBITMQ_URL, logger);
  const stopOutbox = await startOutboxPublisher(serviceName, pool, broker, logger);
  await consumeEvents(
    broker,
    "payment-service-events",
    ["seat.held"],
    async (event) => {
      if (event.name === "seat.held") await handleSeatHeld(event as DomainEvent<"seat.held", SeatHeldPayload>);
    },
    logger
  );

  const app = express();
  app.disable("x-powered-by");
  app.use(...securityMiddleware(env.CORS_ORIGIN));
  app.use(requestContext(logger));

  app.post("/api/payments/webhooks/mock", express.raw({ type: "application/json", limit: "64kb" }), async (req, res, next) => {
    try {
      const result = await processWebhookPayload(req.body as Buffer, req.header("x-webhook-signature"));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  app.use(express.json({ limit: "64kb" }));

  app.get("/health/live", (_req, res) => res.json({ status: "ok", uptime: process.uptime(), version: "0.1.0" }));
  app.get("/health/ready", async (_req, res) => {
    const db = await checkPostgres(pool);
    const redisStatus = redis.status === "ready" ? "ok" : "down";
    res.status(db === "ok" && redisStatus === "ok" ? 200 : 503).json({ status: db === "ok" && redisStatus === "ok" ? "ok" : "degraded", db, redis: redisStatus });
  });
  app.get("/metrics", metrics.handler);

  const authn = authenticateAccessToken(env.JWT_ACCESS_SECRET);

  app.post(
    "/api/payments/checkout",
    redisRateLimit(redis, { prefix: "payment-checkout", max: intEnv("RATE_LIMIT_PAYMENT_MAX", 30), windowSeconds: 60 }),
    authn,
    async (req, res, next) => {
      try {
        const input = checkoutSchema.parse(req.body);
        const result = await inTransaction(pool, async (client) => {
          const { rows } = await client.query("SELECT * FROM seat_holds WHERE hold_id = $1 FOR UPDATE", [input.holdId]);
          const hold = rows[0];
          if (!hold) return { status: 409 as const, body: { error: "hold_projection_not_ready" } };
          if (hold.user_id !== req.user!.sub) return { status: 403 as const, body: { error: "hold_belongs_to_another_user" } };
          if (hold.status !== "HELD" || new Date(hold.held_until).getTime() < Date.now()) {
            return { status: 409 as const, body: { error: "hold_not_payable" } };
          }

          const existing = await client.query(
            "SELECT * FROM payment_intents WHERE idempotency_key = $1 OR (hold_id = $2 AND status IN ('PENDING', 'COMPLETED')) ORDER BY created_at LIMIT 1",
            [input.idempotencyKey, input.holdId]
          );
          if (existing.rows[0]) {
            const intent = existing.rows[0];
            return {
              status: 200 as const,
              body: {
                paymentIntentId: intent.id,
                amountCents: intent.amount_cents,
                status: intent.status,
                checkoutUrl: provider.createCheckoutUrl({ id: intent.id, amountCents: intent.amount_cents })
              }
            };
          }

          const inserted = await client.query(
            `INSERT INTO payment_intents (hold_id, user_id, seat_id, amount_cents, status, idempotency_key)
             VALUES ($1, $2, $3, $4, 'PENDING', $5)
             RETURNING *`,
            [hold.hold_id, hold.user_id, hold.seat_id, hold.amount_cents, input.idempotencyKey]
          );
          const intent = inserted.rows[0];
          return {
            status: 201 as const,
            body: {
              paymentIntentId: intent.id,
              amountCents: intent.amount_cents,
              status: intent.status,
              checkoutUrl: provider.createCheckoutUrl({ id: intent.id, amountCents: intent.amount_cents })
            }
          };
        });
        if (result.status === 409) res.setHeader("Retry-After", "2");
        return res.status(result.status).json(result.body);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/payments/mock/complete",
    redisRateLimit(redis, { prefix: "payment-complete", max: intEnv("RATE_LIMIT_PAYMENT_MAX", 30), windowSeconds: 60 }),
    authn,
    async (req, res, next) => {
      try {
        const input = completeSchema.parse(req.body);
        const { rows } = await pool.query("SELECT user_id FROM payment_intents WHERE id = $1", [input.paymentIntentId]);
        if (!rows[0]) return res.status(404).json({ error: "payment_intent_not_found" });
        if (rows[0].user_id !== req.user!.sub) return res.status(403).json({ error: "payment_intent_forbidden" });

        const body = provider.buildWebhook({ id: input.paymentIntentId, outcome: input.outcome });
        const signature = signWebhookPayload(env.WEBHOOK_SECRET, body);
        const result = await processWebhookPayload(body, signature);
        return res.status(result.status).json(result.body);
      } catch (error) {
        return next(error);
      }
    }
  );

  app.use(errorHandler(logger));
  const server = app.listen(env.PAYMENT_PORT, () => logger.info({ action: "service_started", port: env.PAYMENT_PORT }));

  const shutdown = async () => {
    logger.info({ action: "shutdown_started" });
    stopOutbox();
    server.close(async () => {
      await broker.close();
      await redis.quit();
      await pool.end();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  logger.fatal({ action: "startup_failed", error });
  process.exit(1);
});
