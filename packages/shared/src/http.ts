import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import type { AccessTokenClaims } from "./contracts";
import type { Logger } from "./logger";

declare global {
  namespace Express {
    interface Request {
      traceId: string;
      user?: AccessTokenClaims;
    }
  }
}

export function requestContext(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header("x-request-id");
    req.traceId = incoming && incoming.length <= 128 ? incoming : crypto.randomUUID();
    res.setHeader("x-request-id", req.traceId);
    logger.info({ action: "http_request", method: req.method, path: req.path, traceId: req.traceId });
    next();
  };
}

export function securityMiddleware(corsOrigin: string) {
  return [
    helmet({
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" }
    }),
    cors({
      origin: corsOrigin,
      credentials: true,
      allowedHeaders: ["content-type", "authorization", "x-request-id", "x-webhook-signature"]
    })
  ];
}

export function authenticateAccessToken(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (!token) return res.status(401).json({ error: "missing_access_token" });
    try {
      req.user = jwt.verify(token, secret) as AccessTokenClaims;
      return next();
    } catch {
      return res.status(401).json({ error: "invalid_access_token" });
    }
  };
}

export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ action: "unhandled_error", traceId: req.traceId, error });
    res.status(500).json({ error: "internal_error" });
  };
}
