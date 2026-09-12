import { pool } from "../db/pool.js";
import { recordAuditEvent } from "./audit.js";
import { publishBroadcastEvent } from "../lib/pubsub.js";

export interface QueueItemView {
  id: string;
  trackId: string;
  title: string;
  durationSeconds: number | null;
  status: string;
  position: number;
  source: string;
  scheduledStart: string | null;
  actualStart: string | null;
}

async function recordEvent(
  stationId: string,
  eventType: string,
  queueItemId: string | null,
  payload: Record<string, unknown>,
  correlationId?: string
) {
  await pool.query(
    `INSERT INTO broadcast_events (station_id, event_type, queue_item_id, payload, correlation_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [stationId, eventType, queueItemId, JSON.stringify(payload), correlationId ?? null]
  );
}

/** Adds a ready track to the end of a station's queue. */
export async function enqueueTrack(
  stationId: string,
  trackId: string,
  source: "playlist" | "ai" | "request" | "manual" | "emergency",
  requestedBy: string | null,
  insertedBy: string | null
): Promise<string> {
  const track = await pool.query("SELECT status FROM tracks WHERE id = $1", [trackId]);
  if (track.rowCount === 0) throw new Error("Track not found.");
  if (track.rows[0].status !== "ready") {
    throw new Error(`Track is not ready for broadcast (status: ${track.rows[0].status}).`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Postgres disallows FOR UPDATE combined with an aggregate function, and
    // there are no existing rows to lock when the queue is empty anyway.
    // A transaction-scoped advisory lock keyed on the station serializes
    // concurrent enqueues so two callers can never compute the same
    // "next position" value.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [stationId]);

    const posRes = await client.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
       FROM queue_items WHERE station_id = $1 AND status = 'queued'`,
      [stationId]
    );
    const nextPos = posRes.rows[0].next_pos;

    const insertRes = await client.query(
      `INSERT INTO queue_items (station_id, track_id, source, status, position, requested_by, inserted_by)
       VALUES ($1,$2,$3,'queued',$4,$5,$6) RETURNING id`,
      [stationId, trackId, source, nextPos, requestedBy, insertedBy]
    );
    await client.query("COMMIT");

    const queueItemId = insertRes.rows[0].id;
    await recordEvent(stationId, "QUEUE_ITEM_ADDED", queueItemId, { trackId, source, position: nextPos });
    await publishBroadcastEvent(stationId, { type: "QUEUE_UPDATED" });
    return queueItemId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Advances the broadcast: marks the current 'playing' item 'played' (if any)
 * and promotes the next 'queued' item (by position) to 'playing'.
 *
 * Serialized per-station via a Postgres advisory transaction lock, so
 * concurrent calls (e.g. a manual skip racing the scheduler's timer) queue
 * up and run one at a time rather than racing to promote two tracks to
 * 'playing' simultaneously (which the unique partial index would reject —
 * see the comment below on why SKIP LOCKED was the wrong tool for this).
 */
export async function advanceQueue(
  stationId: string,
  correlationId?: string
): Promise<QueueItemView | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // The whole advance operation is serialized per-station. Using
    // SKIP LOCKED on the singleton "currently playing" row (there can only
    // ever be one, per the unique partial index) is the wrong tool here:
    // if a concurrent call held that row locked, SKIP LOCKED would make
    // this call blind to it and wrongly conclude "nothing is playing,"
    // then try to promote a second row to 'playing' — violating the
    // unique index and, worse, crashing the process on an unhandled
    // constraint error. An advisory lock makes concurrent advances queue
    // up and run one at a time instead of racing.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [stationId]);

    const currentRes = await client.query(
      `SELECT id FROM queue_items WHERE station_id = $1 AND status = 'playing'`,
      [stationId]
    );

    if (currentRes.rowCount && currentRes.rowCount > 0) {
      const currentId = currentRes.rows[0].id;
      await client.query(
        `UPDATE queue_items SET status = 'played', actual_end = now() WHERE id = $1`,
        [currentId]
      );
      await recordEvent(stationId, "TRACK_COMPLETED", currentId, {}, correlationId);
    }

    const nextRes = await client.query(
      `SELECT qi.id, qi.track_id, qi.position, qi.source, t.title, t.duration_seconds
       FROM queue_items qi
       JOIN tracks t ON t.id = qi.track_id
       WHERE qi.station_id = $1 AND qi.status = 'queued'
       ORDER BY qi.position ASC
       LIMIT 1`,
      [stationId]
    );

    if (nextRes.rowCount === 0) {
      await client.query("COMMIT");
      await publishBroadcastEvent(stationId, { type: "QUEUE_EMPTY" });
      return null;
    }

    const next = nextRes.rows[0];
    await client.query(
      `UPDATE queue_items SET status = 'playing', actual_start = now() WHERE id = $1`,
      [next.id]
    );
    await client.query("COMMIT");

    await recordEvent(
      stationId,
      "TRACK_STARTED",
      next.id,
      { trackId: next.track_id, title: next.title },
      correlationId
    );

    const view: QueueItemView = {
      id: next.id,
      trackId: next.track_id,
      title: next.title,
      durationSeconds: next.duration_seconds,
      status: "playing",
      position: next.position,
      source: next.source,
      scheduledStart: null,
      actualStart: new Date().toISOString(),
    };

    await publishBroadcastEvent(stationId, { type: "NOW_PLAYING_CHANGED", queueItem: view });
    return view;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getNowPlaying(stationId: string): Promise<QueueItemView | null> {
  const { rows } = await pool.query(
    `SELECT qi.id, qi.track_id, qi.position, qi.source, qi.actual_start, t.title, t.duration_seconds
     FROM queue_items qi JOIN tracks t ON t.id = qi.track_id
     WHERE qi.station_id = $1 AND qi.status = 'playing' LIMIT 1`,
    [stationId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    trackId: r.track_id,
    title: r.title,
    durationSeconds: r.duration_seconds,
    status: "playing",
    position: r.position,
    source: r.source,
    scheduledStart: null,
    actualStart: r.actual_start,
  };
}

export async function getQueue(stationId: string): Promise<QueueItemView[]> {
  const { rows } = await pool.query(
    `SELECT qi.id, qi.track_id, qi.position, qi.source, qi.status, t.title, t.duration_seconds
     FROM queue_items qi JOIN tracks t ON t.id = qi.track_id
     WHERE qi.station_id = $1 AND qi.status = 'queued'
     ORDER BY qi.position ASC LIMIT 100`,
    [stationId]
  );
  return rows.map((r) => ({
    id: r.id,
    trackId: r.track_id,
    title: r.title,
    durationSeconds: r.duration_seconds,
    status: r.status,
    position: r.position,
    source: r.source,
    scheduledStart: null,
    actualStart: null,
  }));
}

export async function skipCurrent(stationId: string, actorId: string | null): Promise<QueueItemView | null> {
  const current = await getNowPlaying(stationId);
  if (current) {
    await pool.query(`UPDATE queue_items SET status = 'skipped', actual_end = now() WHERE id = $1`, [
      current.id,
    ]);
    await recordEvent(stationId, "TRACK_SKIPPED", current.id, { actorId });
    await recordAuditEvent({
      actorId,
      action: "TRACK_SKIPPED",
      resourceType: "queue_item",
      resourceId: current.id,
    });
  }
  return advanceQueue(stationId);
}
