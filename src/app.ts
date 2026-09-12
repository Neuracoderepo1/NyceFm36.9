import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import session from "express-session";
import RedisStore from "connect-redis";
import { requestId } from "./middleware/requestId.js";
import { getRedisClient } from "./lib/redis.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { healthRouter } from "./routes/health.js";
import { libraryRouter } from "./routes/library.js";
import { broadcastRouter } from "./routes/broadcast.js";
import { playlistRouter } from "./routes/playlist.js";

export async function createApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === "production";

  app.set("trust proxy", 1);
  app.use(requestId);
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
  app.use("/api/broadcast", broadcastRouter);
  app.use("/api/broadcast", playlistRouter);

  // 404
  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found.", request_id: req.id } });
  });

  // Centralized error handler — never leak stack traces in production.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${req.id}]`, err);
    const isProdEnv = process.env.NODE_ENV === "production";
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong.",
        request_id: req.id,
        ...(isProdEnv ? {} : { detail: err instanceof Error ? err.message : String(err) }),
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
