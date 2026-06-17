import type { NextFunction, Request, Response } from "express";
import Redis from "ioredis";

export function redisClient(url: string): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
}

export function redisRateLimit(redis: Redis, options: { prefix: string; max: number; windowSeconds: number }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `rate:${options.prefix}:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, options.windowSeconds);
    const ttl = await redis.ttl(key);
    res.setHeader("X-RateLimit-Limit", String(options.max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(options.max - count, 0)));
    if (count > options.max) {
      res.setHeader("Retry-After", String(Math.max(ttl, 1)));
      return res.status(429).json({ error: "rate_limited" });
    }
    return next();
  };
}
