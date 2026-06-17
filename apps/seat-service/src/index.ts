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
  startOutboxPublisher,
  type AuthTokenVersionChangedPayload,
  type DomainEvent,
  type PaymentCompletedPayload,
  type PaymentFailedPayload
} from "@seat/shared";

const serviceName = "seat-service";
const logger = createLogger(serviceName);
const env = baseServiceEnv
  .extend({
    SEAT_DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(32),
    SEAT_PORT: z.coerce.number().default(3002)
  })
  .parse(process.env);

const holdTtlSeconds = intEnv("HOLD_TTL_SECONDS", 600);
const pool = createPool(env.SEAT_DATABASE_URL, serviceName);
const metrics = createMetrics(serviceName);
const holdSchema = z.object({ seatId: z.string().min(1).max(64) });

const sseClients = new Set<express.Response>();

function publishSse(payload: unknown) {
  const encoded = `event: seat-update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(encoded);
}

async function listSeats() {
  const { rows } = await pool.query(
    `SELECT id, label, status, price_cents AS "priceCents", held_until AS "heldUntil", reserved_at AS "reservedAt"
       FROM seats
      ORDER BY label`
  );
  return rows;
}

async function cleanupExpiredHolds(batchLimit = 25) {
  const { rows } = await pool.query(
    `WITH expired AS (
       SELECT id
         FROM seats
        WHERE status = 'HELD' AND held_until < NOW()
        ORDER BY held_until
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE seats s
        SET status = 'AVAILABLE',
            current_holder_id = NULL,
            hold_id = NULL,
            held_until = NULL,
            updated_at = NOW()
       FROM expired
      WHERE s.id = expired.id
      RETURNING s.id, s.label`,
    [batchLimit]
  );
  if (rows.length > 0) {
    metrics.businessEvents.inc({ action: "holds_expired", outcome: "success" }, rows.length);
    publishSse({ action: "holds_expired", seats: rows });
  }
}

async function verifyTokenVersion(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.user) return res.status(401).json({ error: "missing_user" });
  // TODO(prod): back this projection with a Redis tokenVersion cache and fail closed on cache/projection lag for high-risk routes.
  const { rows } = await pool.query("SELECT token_version FROM auth_token_versions WHERE user_id = $1", [req.user.sub]);
  const currentVersion = rows[0]?.token_version ?? 0;
  if (req.user.tokenVersion < currentVersion) return res.status(401).json({ error: "stale_access_token" });
  return next();
}

async function handlePaymentCompleted(event: DomainEvent<"payment.completed", PaymentCompletedPayload>) {
  await inTransaction(pool, async (client) => {
    const processed = await client.query(
      "INSERT INTO processed_events (event_id, consumer_group) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.eventId, "seat-payment"]
    );
    if (processed.rowCount === 0) return;
    const { paymentIntentId, holdId, userId } = event.payload;
    const { rows } = await client.query("SELECT * FROM seats WHERE hold_id = $1 FOR UPDATE", [holdId]);
    const seat = rows[0];
    if (!seat) return;
    if (seat.status === "RESERVED") return;
    if (seat.status !== "HELD" || seat.current_holder_id !== userId) {
      logger.warn({ action: "payment_completed_hold_mismatch", holdId, userId, seatId: seat.id });
      return;
    }
    await client.query(
      `UPDATE seats
          SET status = 'RESERVED',
              reserved_by = $1,
              reserved_at = NOW(),
              updated_at = NOW()
        WHERE id = $2`,
      [userId, seat.id]
    );
    await client.query("INSERT INTO outbox (event_name, payload) VALUES ($1, $2)", [
      "seat.reserved",
      { holdId, seatId: seat.id, userId, paymentIntentId }
    ]);
    metrics.businessEvents.inc({ action: "seat_reserved", outcome: "success" });
    publishSse({ action: "seat_reserved", seatId: seat.id });
  });
}

async function handlePaymentFailed(event: DomainEvent<"payment.failed", PaymentFailedPayload>) {
  await inTransaction(pool, async (client) => {
    const processed = await client.query(
      "INSERT INTO processed_events (event_id, consumer_group) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.eventId, "seat-payment"]
    );
    if (processed.rowCount === 0) return;
    const { holdId, userId, reason } = event.payload;
    const { rows } = await client.query("SELECT * FROM seats WHERE hold_id = $1 FOR UPDATE", [holdId]);
    const seat = rows[0];
    if (!seat || seat.status !== "HELD" || seat.current_holder_id !== userId) return;
    await client.query(
      `UPDATE seats
          SET status = 'AVAILABLE',
              current_holder_id = NULL,
              hold_id = NULL,
              held_until = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [seat.id]
    );
    metrics.businessEvents.inc({ action: "payment_failed_release", outcome: reason });
    publishSse({ action: "seat_released", seatId: seat.id });
  });
}

async function handleAuthTokenVersion(event: DomainEvent<"auth.token_version_changed", AuthTokenVersionChangedPayload>) {
  const { userId, tokenVersion } = event.payload;
  await pool.query(
    `INSERT INTO auth_token_versions (user_id, token_version)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET token_version = GREATEST(auth_token_versions.token_version, EXCLUDED.token_version), updated_at = NOW()`,
    [userId, tokenVersion]
  );
}

async function main() {
  const redis = redisClient(env.REDIS_URL);
  await redis.connect();
  const subscriber = redis.duplicate();
  await subscriber.connect();
  await subscriber.subscribe("seat-updates");
  subscriber.on("message", (_channel, message) => publishSse(JSON.parse(message)));

  const broker = await createBroker(env.RABBITMQ_URL, logger);
  const stopOutbox = await startOutboxPublisher(serviceName, pool, broker, logger);
  await consumeEvents(
    broker,
    "seat-service-events",
    ["payment.completed", "payment.failed", "auth.token_version_changed"],
    async (event) => {
      if (event.name === "payment.completed") await handlePaymentCompleted(event as DomainEvent<"payment.completed", PaymentCompletedPayload>);
      if (event.name === "payment.failed") await handlePaymentFailed(event as DomainEvent<"payment.failed", PaymentFailedPayload>);
      if (event.name === "auth.token_version_changed") await handleAuthTokenVersion(event as DomainEvent<"auth.token_version_changed", AuthTokenVersionChangedPayload>);
    },
    logger
  );

  const sweeper = setInterval(async () => {
    try {
      await cleanupExpiredHolds();
    } catch (error) {
      logger.error({ action: "hold_sweeper_failed", error });
    }
  }, 15_000);
  sweeper.unref();

  const app = express();
  app.disable("x-powered-by");
  app.use(...securityMiddleware(env.CORS_ORIGIN));
  app.use(requestContext(logger));
  app.use(express.json({ limit: "64kb" }));

  app.get("/health/live", (_req, res) => res.json({ status: "ok", uptime: process.uptime(), version: "0.1.0" }));
  app.get("/health/ready", async (_req, res) => {
    const db = await checkPostgres(pool);
    const redisStatus = redis.status === "ready" ? "ok" : "down";
    res.status(db === "ok" && redisStatus === "ok" ? 200 : 503).json({ status: db === "ok" && redisStatus === "ok" ? "ok" : "degraded", db, redis: redisStatus });
  });
  app.get("/metrics", metrics.handler);

  app.get("/api/seats", async (_req, res, next) => {
    try {
      await cleanupExpiredHolds(10);
      res.json({ seats: await listSeats() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/seats/stream", (req, res) => {
    // TODO(prod): add heartbeat comments plus a since-token replay endpoint so clients can recover missed Redis pub/sub events.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    res.write(`event: ready\ndata: {"ok":true}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  const authn = [authenticateAccessToken(env.JWT_ACCESS_SECRET), verifyTokenVersion];

  app.post(
    "/api/seats/:seatId/hold",
    redisRateLimit(redis, { prefix: "seat-hold", max: intEnv("RATE_LIMIT_SEAT_MAX", 60), windowSeconds: 60 }),
    ...authn,
    async (req, res, next) => {
      try {
        const { seatId } = holdSchema.parse({ seatId: req.params.seatId });
        const holdId = crypto.randomUUID();
        const heldUntil = new Date(Date.now() + holdTtlSeconds * 1000);
        const result = await inTransaction(pool, async (client) => {
          const { rows } = await client.query("SELECT * FROM seats WHERE id = $1 FOR UPDATE", [seatId]);
          const seat = rows[0];
          if (!seat) return { status: 404 as const };
          if (seat.status === "HELD" && new Date(seat.held_until).getTime() < Date.now()) {
            await client.query(
              "UPDATE seats SET status = 'AVAILABLE', current_holder_id = NULL, hold_id = NULL, held_until = NULL WHERE id = $1",
              [seatId]
            );
            seat.status = "AVAILABLE";
          }
          if (seat.status !== "AVAILABLE") return { status: 409 as const };

          await client.query(
            `UPDATE seats
                SET status = 'HELD',
                    current_holder_id = $1,
                    hold_id = $2,
                    held_until = $3,
                    updated_at = NOW()
              WHERE id = $4`,
            [req.user!.sub, holdId, heldUntil, seatId]
          );
          await client.query("INSERT INTO outbox (event_name, payload) VALUES ($1, $2)", [
            "seat.held",
            {
              holdId,
              seatId,
              seatLabel: seat.label,
              userId: req.user!.sub,
              priceCents: seat.price_cents,
              heldUntil: heldUntil.toISOString()
            }
          ]);
          return { status: 201 as const, seat, holdId };
        });

        if (result.status === 404) return res.status(404).json({ error: "seat_not_found" });
        if (result.status === 409) {
          res.setHeader("Retry-After", "5");
          return res.status(409).json({ error: "seat_not_available" });
        }

        metrics.businessEvents.inc({ action: "seat_held", outcome: "success" });
        const payload = { action: "seat_held", seatId, holdId, heldUntil: heldUntil.toISOString() };
        await redis.publish("seat-updates", JSON.stringify(payload));
        return res.status(201).json({ holdId, seatId, heldUntil: heldUntil.toISOString() });
      } catch (error: unknown) {
        if (typeof error === "object" && error && "code" in error && error.code === "23505") {
          res.setHeader("Retry-After", "5");
          return res.status(409).json({ error: "user_already_holds_a_seat" });
        }
        return next(error);
      }
    }
  );

  app.use(errorHandler(logger));
  const server = app.listen(env.SEAT_PORT, () => logger.info({ action: "service_started", port: env.SEAT_PORT }));

  const shutdown = async () => {
    logger.info({ action: "shutdown_started" });
    clearInterval(sweeper);
    stopOutbox();
    server.close(async () => {
      await broker.close();
      await subscriber.quit();
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
