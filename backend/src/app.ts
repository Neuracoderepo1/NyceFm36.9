import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import "express-async-errors";
import { ZodError } from "zod";
import helmet from "helmet";
import cors from "cors";
import session from "express-session";
import { ensureStorage } from "./services/storage.js";
import { ensureStreamStorage } from "./services/streaming.js";
import RedisStore from "connect-redis";
import { requestId } from "./middleware/requestId.js";
import { getRedisClient } from "./lib/redis.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { healthRouter } from "./routes/health.js";
import { libraryRouter } from "./routes/library.js";
import { playlistsRouter } from "./routes/playlists.js";
import { broadcastRouter } from "./routes/broadcast.js";
import { mediaRouter } from "./routes/media.js";
import { streamRouter } from "./routes/stream.js";
import { audienceRouter } from "./routes/audience.js";
import { aiRouter } from "./routes/ai.js";
import { paymentsRouter, handleStripeWebhook } from "./routes/payments.js";
import { ensureObjectStorage } from "./services/objectStorage.js";
import { innhouseRouter } from "./routes/innhouse.js";
import houseListenerRouter from "./routes/houseListener.js";

export async function createApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === "production";

  app.set("trust proxy", 1);
  app.use(requestId);
  app.post("/api/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }), (req, res, next) => { void handleStripeWebhook(req, res).catch(next); });
  app.use(express.json({ limit: "1mb" }));

  app.use(
    helmet({
      contentSecurityPolicy: isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "https:"],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
            },
          }
        : false,
      referrerPolicy: { policy: "no-referrer" },
    })
  );

  app.use(
    cors({
      origin: (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
      credentials: true,
    })
  );

  const redisClient = await getRedisClient();

  app.use(
    session({
      store: new RedisStore({ client: redisClient, prefix: "nycefm:sess:" }),
      name: "nycefm.sid",
      secret: requireEnv("SESSION_SECRET"),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
      },
    })
  );

  app.use("/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/library", libraryRouter);
  app.use("/api/playlists", playlistsRouter);
  app.use("/api/broadcast", broadcastRouter);
  app.use("/api/media", mediaRouter);
  app.use("/streams", streamRouter);
  app.use("/api/audience", audienceRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/houses", houseListenerRouter);
  app.use("/api/houses", innhouseRouter);

  await ensureStorage();
  await ensureStreamStorage();
  try {
    await ensureObjectStorage();
  } catch (err) {
    // Non-fatal: the API (including /health/ready, which independently
    // re-checks storage per request) should still come up even if object
    // storage is degraded at boot. Background workers that depend on
    // storage are separately gated by startWorkersSequenced() in
    // server.ts and will simply stay off until this is resolved.
    console.error("[startup] object storage check failed -- API is still starting, but storage-dependent workers will stay off:", err instanceof Error ? err.message : err);
  }

  // 404
  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found.", request_id: req.id } });
  });

  // Centralized error handler — never leak stack traces in production.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${req.id}]`, err);
    const isProdEnv = process.env.NODE_ENV === "production";
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Request validation failed.", issues: err.issues, request_id: req.id },
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    if (normalized.includes("control_revision_conflict")) {
      return res.status(409).json({
        error: { code: "CONTROL_REVISION_CONFLICT", message: "Broadcast state changed; refresh control state and retry.", request_id: req.id },
      });
    }
    if (normalized.includes("invalid_control_action") || normalized.includes("invalid_transition_mode") || normalized.includes("invalid_now_playing_state") || normalized.includes("invalid_elapsed_ms")) {
      return res.status(400).json({
        error: { code: "INVALID_BROADCAST_STATE", message: "The requested broadcast operation is invalid.", request_id: req.id },
      });
    }
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
        request_id: req.id,
        ...(isProdEnv ? {} : { detail: message }),
      },
    });
  });

  return app;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}
