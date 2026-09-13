import { afterAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { buildTestApp, closeAppResources } from "../helpers/app.js";
import { pool } from "../../src/db/pool.js";
import { getRedisClient } from "../../src/lib/redis.js";

let app: Express;

describe("health & readiness", () => {
  afterAll(async () => {
    await closeAppResources();
  });

  it("GET /health returns 200 with a minimal ok payload", async () => {
    app = app ?? (await buildTestApp());
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /health/live returns 200 without touching the database or Redis", async () => {
    app = app ?? (await buildTestApp());
    const dbSpy = vi.spyOn(pool, "query");
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "live" });
    // Liveness must not depend on downstream health - assert it never even
    // queries the database.
    expect(dbSpy).not.toHaveBeenCalled();
    dbSpy.mockRestore();
  });

  it("GET /health/ready returns 200 and reports both dependencies healthy", async () => {
    app = app ?? (await buildTestApp());
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      checks: { database: "healthy", redis: "healthy" },
    });
  });

  it("GET /health/ready never leaks connection strings or credentials", async () => {
    app = app ?? (await buildTestApp());
    const res = await request(app).get("/health/ready");
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/postgres(ql)?:\/\//i);
    expect(raw).not.toMatch(/redis:\/\//i);
    expect(raw).not.toContain(process.env.SESSION_SECRET ?? "__unset__");
  });

  it("GET /health/ready returns 503 when the database check fails", async () => {
    app = app ?? (await buildTestApp());
    const dbSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated db outage"));
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.database).toBe("unhealthy");
    dbSpy.mockRestore();
  });

  it("GET /health/ready returns 503 when the redis check fails", async () => {
    app = app ?? (await buildTestApp());
    const redis = await getRedisClient();
    const pingSpy = vi.spyOn(redis, "ping").mockRejectedValueOnce(new Error("simulated redis outage"));
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.redis).toBe("unhealthy");
    pingSpy.mockRestore();
  });

  it("GET /health/ready never falsely reports ready when any dependency is unhealthy", async () => {
    app = app ?? (await buildTestApp());
    const dbSpy = vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("simulated db outage"));
    const redis = await getRedisClient();
    const pingSpy = vi.spyOn(redis, "ping").mockResolvedValueOnce("PONG" as unknown as string);
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).not.toBe("ready");
    dbSpy.mockRestore();
    pingSpy.mockRestore();
  });
});
