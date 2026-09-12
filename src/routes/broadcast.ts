import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { advanceQueue, enqueueTrack, getNowPlaying, getQueue, skipCurrent } from "../services/queue.js";
import { subscribeBroadcastEvents } from "../lib/pubsub.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const broadcastRouter = Router();

async function resolveStationId(slug: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT id FROM stations WHERE slug = $1", [slug]);
  return rows[0]?.id ?? null;
}

// Public, read-only — listener-facing.
broadcastRouter.get("/:station/now-playing", asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return res.status(404).json({ error: { code: "STATION_NOT_FOUND", message: "Unknown station.", request_id: req.id } });
  const nowPlaying = await getNowPlaying(stationId);
  res.json({ nowPlaying });
}));

broadcastRouter.get("/:station/queue", asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return res.status(404).json({ error: { code: "STATION_NOT_FOUND", message: "Unknown station.", request_id: req.id } });
  const queue = await getQueue(stationId);
  res.json({ queue });
}));

broadcastRouter.get("/:station/status", asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return res.status(404).json({ error: { code: "STATION_NOT_FOUND", message: "Unknown station.", request_id: req.id } });
  const { rows } = await pool.query(
    `SELECT state, started_at FROM broadcast_sessions WHERE station_id = $1 AND ended_at IS NULL`,
    [stationId]
  );
  res.json({ state: rows[0]?.state ?? "offline", startedAt: rows[0]?.started_at ?? null });
}));

// Realtime now-playing/queue push. Public read channel — no privileged data.
broadcastRouter.get("/:station/events", asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: connected\ndata: {}\n\n`);

  const unsubscribe = await subscribeBroadcastEvents(stationId, (payload) => {
    res.write(`event: broadcast\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  req.on("close", () => {
    void unsubscribe();
  });
}));

// ── Privileged control actions below — server-verified permissions only ──

const enqueueSchema = z.object({
  trackId: z.string().uuid(),
  source: z.enum(["playlist", "ai", "request", "manual", "emergency"]).default("manual"),
});

broadcastRouter.post("/:station/queue", requirePermission("queue.modify"), asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return res.status(404).json({ error: { code: "STATION_NOT_FOUND", message: "Unknown station.", request_id: req.id } });

  const parsed = enqueueSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id } });
  }
  try {
    const queueItemId = await enqueueTrack(
      stationId,
      parsed.data.trackId,
      parsed.data.source,
      null,
      req.session.userId ?? null
    );
    res.status(201).json({ queueItemId });
  } catch (err) {
    res.status(422).json({ error: { code: "ENQUEUE_FAILED", message: (err as Error).message, request_id: req.id } });
  }
}));

broadcastRouter.post("/:station/advance", requirePermission("broadcast.control"), asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return res.status(404).json({ error: { code: "STATION_NOT_FOUND", message: "Unknown station.", request_id: req.id } });
  const result = await advanceQueue(stationId, req.id);
  res.json({ nowPlaying: result });
}));

broadcastRouter.post("/:station/skip", requirePermission("broadcast.control"), asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return res.status(404).json({ error: { code: "STATION_NOT_FOUND", message: "Unknown station.", request_id: req.id } });
  const result = await skipCurrent(stationId, req.session.userId ?? null);
  res.json({ nowPlaying: result });
}));
