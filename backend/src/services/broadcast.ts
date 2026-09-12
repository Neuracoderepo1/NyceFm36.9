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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM broadcast_sessions WHERE station_id = $1 AND status = 'active' FOR UPDATE`,
      [input.stationId]
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const result = await client.query<{ id: string }>(
      `INSERT INTO broadcast_sessions (station_id, started_by, mode) VALUES ($1,$2,$3) RETURNING id`,
      [input.stationId, input.actorId, input.mode]
    );
    await client.query(
      `INSERT INTO now_playing (station_id, broadcast_session_id, state, revision)
       VALUES ($1,$2,'idle',1)
       ON CONFLICT (station_id) DO UPDATE SET broadcast_session_id = EXCLUDED.broadcast_session_id,
         state = 'idle', revision = now_playing.revision + 1, updated_at = now()`,
      [input.stationId, result.rows[0].id]
    );
    await client.query("COMMIT");
    await recordAuditEvent({ actorId: input.actorId, action: "BROADCAST_STARTED", resourceType: "broadcast_session", resourceId: result.rows[0].id, afterState: { stationId: input.stationId, mode: input.mode }, correlationId: input.correlationId });
    return result.rows[0].id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

export async function stopBroadcast(input: { stationId: string; actorId: string; correlationId: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string }>(
      `UPDATE broadcast_sessions SET status='stopped', ended_at=now()
       WHERE station_id=$1 AND status='active' RETURNING id`, [input.stationId]
    );
    await client.query(
      `INSERT INTO now_playing (station_id,state,revision) VALUES ($1,'stopped',1)
       ON CONFLICT (station_id) DO UPDATE SET state='stopped', queue_item_id=NULL, media_asset_id=NULL,
       broadcast_session_id=NULL, revision=now_playing.revision+1, updated_at=now()`, [input.stationId]
    );
    await client.query("COMMIT");
    if (result.rows[0]) await recordAuditEvent({ actorId: input.actorId, action: "BROADCAST_STOPPED", resourceType: "broadcast_session", resourceId: result.rows[0].id, correlationId: input.correlationId });
    return result.rows[0]?.id ?? null;
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

export async function enqueueTrack(input: { stationId: string; mediaAssetId: string; actorId: string | null; source: "playlist" | "dj" | "producer" | "ai" | "system"; correlationId: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize queue-position allocation per station to prevent duplicate positions under concurrency.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.stationId]);
    const result = await client.query<{ id: string; position: number }>(
      `INSERT INTO broadcast_queue (station_id, media_asset_id, source, requested_by, position)
       SELECT $1,$2,$3,$4,COALESCE(MAX(position)+1,0)
       FROM broadcast_queue WHERE station_id=$1 AND status='queued'
       RETURNING id, position`,
      [input.stationId, input.mediaAssetId, input.source, input.actorId]
    );
    if (!result.rows[0]) throw new Error("Unable to enqueue track");
    await client.query("COMMIT");
    await recordAuditEvent({ actorId: input.actorId, action: "QUEUE_ITEM_ADDED", resourceType: "broadcast_queue", resourceId: result.rows[0].id, afterState: { mediaAssetId: input.mediaAssetId, source: input.source, position: result.rows[0].position }, correlationId: input.correlationId });
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}
