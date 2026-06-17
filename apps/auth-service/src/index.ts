import crypto from "node:crypto";
import argon2 from "argon2";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  baseServiceEnv,
  checkPostgres,
  createBroker,
  createLogger,
  createMetrics,
  createPool,
  errorHandler,
  inTransaction,
  intEnv,
  randomToken,
  redisClient,
  redisRateLimit,
  requestContext,
  requiredEnv,
  securityMiddleware,
  sha256Base64Url,
  startOutboxPublisher,
  type AccessTokenClaims
} from "@seat/shared";
import type { Pool, PoolClient } from "pg";

const serviceName = "auth-service";
const logger = createLogger(serviceName);
const env = baseServiceEnv
  .extend({
    AUTH_DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(32),
    AUTH_PORT: z.coerce.number().default(3001)
  })
  .parse(process.env);

const accessTtlSeconds = intEnv("ACCESS_TOKEN_TTL_SECONDS", 900);
const refreshDays = intEnv("REFRESH_TOKEN_DAYS", 90);
const refreshGraceSeconds = intEnv("REFRESH_REUSE_GRACE_SECONDS", 15);
const refreshCookieName = "refresh_token";
const pool = createPool(env.AUTH_DATABASE_URL, serviceName);
const metrics = createMetrics(serviceName);

const emailPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(256)
});

const dummyHashPromise = argon2.hash("not-the-password", { type: argon2.argon2id });

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: env.NODE_ENV === "production",
    path: "/api/auth",
    maxAge: refreshDays * 24 * 60 * 60 * 1000
  };
}

function signAccessToken(user: { id: string; email: string; token_version: number }) {
  const claims: AccessTokenClaims = {
    sub: user.id,
    email: user.email,
    tokenVersion: user.token_version,
    jti: crypto.randomUUID()
  };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: accessTtlSeconds,
    issuer: "seat-reservation.auth",
    audience: "seat-reservation.api"
  });
}

async function createRefreshSession(userId: string, familyId = crypto.randomUUID(), queryClient: Pool | PoolClient = pool) {
  const token = randomToken(48);
  const tokenHash = sha256Base64Url(token);
  const { rows } = await queryClient.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::INTERVAL)
     RETURNING id`,
    [userId, tokenHash, familyId, refreshDays]
  );
  return { token, tokenId: rows[0].id as string, familyId };
}

async function audit(userId: string | null, action: string, traceId: string, metadata: Record<string, unknown> = {}) {
  await pool.query("INSERT INTO audit_log (user_id, action, trace_id, metadata) VALUES ($1, $2, $3, $4)", [
    userId,
    action,
    traceId,
    metadata
  ]);
}

async function appendTokenVersionEvent(
  client: PoolClient,
  payload: { userId: string; tokenVersion: number; reason: "logout" | "logout_all" | "refresh_reuse" }
) {
  await client.query("INSERT INTO outbox (event_name, payload) VALUES ($1, $2)", [
    "auth.token_version_changed",
    payload
  ]);
}

async function revokeRefreshFamily(familyId: string, reason: "refresh_reuse" | "logout_all") {
  await inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE family_id = $1
        RETURNING user_id`,
      [familyId]
    );
    const userIds = [...new Set(rows.map((row) => row.user_id as string))];
    for (const userId of userIds) {
      const updated = await client.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version", [
        userId
      ]);
      await appendTokenVersionEvent(client, { userId, tokenVersion: updated.rows[0].token_version, reason });
    }
  });
}

async function bootstrapDemoUser() {
  if (env.NODE_ENV === "production") return;
  const email = process.env.DEMO_USER_EMAIL ?? "demo@example.com";
  const password = process.env.DEMO_USER_PASSWORD ?? "Password123!";
  const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  await pool.query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, hash]
  );
  logger.info({ action: "demo_user_ready", email });
}

async function main() {
  const redis = redisClient(env.REDIS_URL);
  await redis.connect();
  const broker = await createBroker(env.RABBITMQ_URL, logger);
  const stopOutbox = await startOutboxPublisher(serviceName, pool, broker, logger);
  await bootstrapDemoUser();

  const app = express();
  app.disable("x-powered-by");
  app.use(...securityMiddleware(env.CORS_ORIGIN));
  app.use(requestContext(logger));
  app.use(cookieParser());
  app.use(express.json({ limit: "64kb" }));

  app.get("/health/live", (_req, res) => res.json({ status: "ok", uptime: process.uptime(), version: "0.1.0" }));
  app.get("/health/ready", async (_req, res) => {
    const db = await checkPostgres(pool);
    const redisStatus = redis.status === "ready" ? "ok" : "down";
    res.status(db === "ok" && redisStatus === "ok" ? 200 : 503).json({ status: db === "ok" && redisStatus === "ok" ? "ok" : "degraded", db, redis: redisStatus });
  });
  app.get("/metrics", metrics.handler);

  app.post(
    "/api/auth/register",
    redisRateLimit(redis, { prefix: "auth-register", max: intEnv("RATE_LIMIT_LOGIN_MAX", 10), windowSeconds: 60 }),
    async (req, res, next) => {
      try {
        const input = emailPasswordSchema.parse(req.body);
        const passwordHash = await argon2.hash(input.password, {
          type: argon2.argon2id,
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1
        });
        const { rows } = await pool.query(
          "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, token_version",
          [input.email, passwordHash]
        );
        const session = await createRefreshSession(rows[0].id);
        await audit(rows[0].id, "register", req.traceId);
        metrics.businessEvents.inc({ action: "register", outcome: "success" });
        res.cookie(refreshCookieName, session.token, cookieOptions());
        res.status(201).json({ accessToken: signAccessToken(rows[0]), user: { id: rows[0].id, email: rows[0].email } });
      } catch (error) {
        metrics.businessEvents.inc({ action: "register", outcome: "failure" });
        next(error);
      }
    }
  );

  app.post(
    "/api/auth/login",
    redisRateLimit(redis, { prefix: "auth-login", max: intEnv("RATE_LIMIT_LOGIN_MAX", 10), windowSeconds: 60 }),
    async (req, res, next) => {
      try {
        const input = emailPasswordSchema.parse(req.body);
        const { rows } = await pool.query("SELECT id, email, password_hash, token_version FROM users WHERE email = $1", [input.email]);
        const user = rows[0];
        const hashToVerify = user?.password_hash ?? (await dummyHashPromise);
        const ok = await argon2.verify(hashToVerify, input.password);
        if (!user || !ok) {
          metrics.businessEvents.inc({ action: "login", outcome: "failure" });
          return res.status(401).json({ error: "invalid_credentials" });
        }
        const session = await createRefreshSession(user.id);
        await audit(user.id, "login", req.traceId);
        metrics.businessEvents.inc({ action: "login", outcome: "success" });
        res.cookie(refreshCookieName, session.token, cookieOptions());
        return res.json({ accessToken: signAccessToken(user), user: { id: user.id, email: user.email } });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post("/api/auth/refresh", async (req, res, next) => {
    try {
      const rawToken = req.cookies[refreshCookieName] as string | undefined;
      if (!rawToken) return res.status(401).json({ error: "missing_refresh_token" });
      const tokenHash = sha256Base64Url(rawToken);
      const { rows } = await pool.query(
        `SELECT rt.*, u.email, u.token_version
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1`,
        [tokenHash]
      );
      const session = rows[0];
      if (!session || new Date(session.expires_at).getTime() < Date.now()) {
        res.clearCookie(refreshCookieName, cookieOptions());
        return res.status(401).json({ error: "invalid_refresh_token" });
      }
      if (session.revoked_at) {
        const ageSeconds = (Date.now() - new Date(session.revoked_at).getTime()) / 1000;
        if (ageSeconds > refreshGraceSeconds) {
          await revokeRefreshFamily(session.family_id, "refresh_reuse");
          await audit(session.user_id, "refresh_reuse_detected", req.traceId);
          res.clearCookie(refreshCookieName, cookieOptions());
          return res.status(401).json({ error: "refresh_reuse_detected" });
        }
        logger.warn({ action: "refresh_reuse_within_grace", userId: session.user_id, traceId: req.traceId });
      }

      const nextSession = await inTransaction(pool, async (client) => {
        const created = await createRefreshSession(session.user_id, session.family_id, client);
        await client.query("UPDATE refresh_tokens SET revoked_at = NOW(), rotated_to = $1 WHERE id = $2 AND revoked_at IS NULL", [
          created.tokenId,
          session.id
        ]);
        return created;
      });
      await audit(session.user_id, "refresh", req.traceId);
      res.cookie(refreshCookieName, nextSession.token, cookieOptions());
      return res.json({
        accessToken: signAccessToken({ id: session.user_id, email: session.email, token_version: session.token_version }),
        user: { id: session.user_id, email: session.email }
      });
    } catch (error) {
      return next(error);
    }
  });

  const authn = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (!token) return res.status(401).json({ error: "missing_access_token" });
    try {
      const claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenClaims;
      const { rows } = await pool.query("SELECT token_version FROM users WHERE id = $1", [claims.sub]);
      if (!rows[0] || rows[0].token_version !== claims.tokenVersion) return res.status(401).json({ error: "stale_access_token" });
      req.user = claims;
      return next();
    } catch {
      return res.status(401).json({ error: "invalid_access_token" });
    }
  };

  app.get("/api/auth/me", authn, async (req, res) => {
    res.json({ user: { id: req.user!.sub, email: req.user!.email } });
  });

  app.post("/api/auth/logout", authn, async (req, res, next) => {
    try {
      await inTransaction(pool, async (client) => {
        const updated = await client.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version", [
          req.user!.sub
        ]);
        await client.query(
          "UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1 AND revoked_at IS NULL",
          [req.user!.sub]
        );
        await appendTokenVersionEvent(client, {
          userId: req.user!.sub,
          tokenVersion: updated.rows[0].token_version,
          reason: "logout"
        });
        await client.query("INSERT INTO audit_log (user_id, action, trace_id) VALUES ($1, $2, $3)", [
          req.user!.sub,
          "logout",
          req.traceId
        ]);
      });
      metrics.businessEvents.inc({ action: "logout", outcome: "success" });
      res.clearCookie(refreshCookieName, cookieOptions());
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout-all", authn, async (req, res, next) => {
    try {
      await inTransaction(pool, async (client) => {
        const updated = await client.query("UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version", [
          req.user!.sub
        ]);
        await client.query("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1", [req.user!.sub]);
        await appendTokenVersionEvent(client, {
          userId: req.user!.sub,
          tokenVersion: updated.rows[0].token_version,
          reason: "logout_all"
        });
        await client.query("INSERT INTO audit_log (user_id, action, trace_id) VALUES ($1, $2, $3)", [
          req.user!.sub,
          "logout_all",
          req.traceId
        ]);
      });
      res.clearCookie(refreshCookieName, cookieOptions());
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.use(errorHandler(logger));
  const server = app.listen(env.AUTH_PORT, () => logger.info({ action: "service_started", port: env.AUTH_PORT }));

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
