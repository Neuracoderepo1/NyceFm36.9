import { Router } from "express";
import { pool } from "../db/pool.js";
import { getRedisClient } from "../lib/redis.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => res.json({ status: "ok" }));

healthRouter.get("/live", (_req, res) => res.status(200).json({ status: "live" }));

healthRouter.get("/ready", async (_req, res) => {
  const checks: Record<string, "healthy" | "unhealthy"> = {};

  try {
    await pool.query("SELECT 1");
    checks.database = "healthy";
  } catch {
    checks.database = "unhealthy";
  }

  try {
    const redis = await getRedisClient();
    await redis.ping();
    checks.redis = "healthy";
  } catch {
    checks.redis = "unhealthy";
  }

  const allHealthy = Object.values(checks).every((v) => v === "healthy");
  res.status(allHealthy ? 200 : 503).json({ status: allHealthy ? "ready" : "not_ready", checks });
});
