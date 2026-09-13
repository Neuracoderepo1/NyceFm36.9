import { pool } from "../db/pool.js";
import { recordAuditEvent } from "./audit.js";

export async function getDefaultStationId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM stations WHERE slug = 'nyce-fm' LIMIT 1`
  );
  if (!rows[0]) throw new Error("Default station is not provisioned. Run migrations.");
  return rows[0].id;
}

export async function getNowPlaying(stationId: string) {
  const { rows } = await pool.query(
    `SELECT np.*, ma.title, ma.artist, ma.album, ma.duration_ms, ma.cover_art_key
     FROM now_playing np
     LEFT JOIN media_assets ma ON ma.id = np.media_asset_id
     WHERE np.station_id = $1`,
    [stationId]
  );
  return rows[0] ?? { station_id: stationId, state: "idle", revision: 0, elapsed_ms: 0 };
}

export async function startBroadcast(input: {
  stationId: string; actorId: string; mode: "operator" | "scheduled" | "ai" | "automation"; correlationId: string;
}) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM public.start_broadcast_session($1,$2,$3)`,
    [input.stationId, input.actorId, input.mode]
  );
  if (!rows[0]) throw new Error("Unable to start broadcast session");
  await recordAuditEvent({ actorId: input.actorId, action: "BROADCAST_STARTED", resourceType: "broadcast_session", resourceId: rows[0].id, afterState: { stationId: input.stationId, mode: input.mode }, correlationId: input.correlationId });
  return rows[0].id;
}

export async function stopBroadcast(input: { stationId: string; actorId: string; correlationId: string }) {
  const { rows } = await pool.query<{ id: string | null }>(
    `SELECT id FROM public.stop_broadcast_session($1)`,
    [input.stationId]
  );
  if (rows[0]?.id) await recordAuditEvent({ actorId: input.actorId, action: "BROADCAST_STOPPED", resourceType: "broadcast_session", resourceId: rows[0].id, correlationId: input.correlationId });
  return rows[0]?.id ?? null;
}

export async function enqueueTrack(input: { stationId: string; mediaAssetId: string; actorId: string | null; source: "playlist" | "dj" | "producer" | "ai" | "system"; scheduledFor?: string; correlationId: string }) {
  const { rows } = await pool.query<{ id: string; position: number; scheduled_for: string | null }>(
    `SELECT id, position, scheduled_for FROM public.enqueue_queue_item($1,$2,$3,$4,$5)`,
    [input.stationId, input.mediaAssetId, input.source, input.actorId, input.scheduledFor ?? null]
  );
  if (!rows[0]) throw new Error("Unable to enqueue track");
  await recordAuditEvent({ actorId: input.actorId, action: "QUEUE_ITEM_ADDED", resourceType: "broadcast_queue", resourceId: rows[0].id, afterState: { mediaAssetId: input.mediaAssetId, source: input.source, position: rows[0].position, scheduledFor: rows[0].scheduled_for }, correlationId: input.correlationId });
  return rows[0];
}
