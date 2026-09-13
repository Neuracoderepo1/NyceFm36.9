import type { Express } from "express";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { closeRedisClient } from "../../src/lib/redis.js";

/**
 * Builds a real app instance (not a mock) wired to the guarded test
 * DATABASE_URL / REDIS_URL that tests/helpers/setup.ts assigned into
 * process.env before this module (or src/app.ts) is ever imported.
 */
export async function buildTestApp(): Promise<Express> {
  return createApp();
}

/** Closes the shared DB pool and Redis client so a test file leaves no open handles. */
export async function closeAppResources(): Promise<void> {
  await closeRedisClient();
  await pool.end();
}
