import { pool } from "../db/pool.js";
import { recordAuditEvent } from "./audit.js";

export interface PlaylistView {
  id: string;
  stationId: string;
  name: string;
  isActive: boolean;
  trackCount: number;
  createdAt: string;
}

export async function createPlaylist(
  stationId: string,
  name: string,
  createdBy: string | null
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO playlists (station_id, name, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [stationId, name, createdBy]
  );
  await recordAuditEvent({
    actorId: createdBy,
    action: "PLAYLIST_CREATED",
    resourceType: "playlist",
    resourceId: rows[0].id,
    afterState: { name },
  });
  return rows[0].id;
}

export async function listPlaylists(stationId: string): Promise<PlaylistView[]> {
  const { rows } = await pool.query(
    `SELECT p.id, p.station_id, p.name, p.is_active, p.created_at,
            COUNT(pt.track_id)::int AS track_count
     FROM playlists p
     LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
     WHERE p.station_id = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [stationId]
  );
  return rows.map((r) => ({
    id: r.id,
    stationId: r.station_id,
    name: r.name,
    isActive: r.is_active,
    trackCount: r.track_count,
    createdAt: r.created_at,
  }));
}

export async function getPlaylistTracks(playlistId: string) {
  const { rows } = await pool.query(
    `SELECT pt.position, t.id AS track_id, t.title, t.duration_seconds, t.status
     FROM playlist_tracks pt
     JOIN tracks t ON t.id = pt.track_id
     WHERE pt.playlist_id = $1
     ORDER BY pt.position ASC`,
    [playlistId]
  );
  return rows;
}

/** Appends a track at the next available position. Rejects tracks that aren't 'ready'. */
export async function addTrackToPlaylist(playlistId: string, trackId: string): Promise<void> {
  const track = await pool.query("SELECT status FROM tracks WHERE id = $1", [trackId]);
  if (track.rowCount === 0) throw new Error("Track not found.");
  if (track.rows[0].status !== "ready") {
    throw new Error(`Track is not ready (status: ${track.rows[0].status}).`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize position assignment per playlist, same pattern as the
    // broadcast queue — avoids the FOR UPDATE + aggregate error and races.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [playlistId]);
    const posRes = await client.query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM playlist_tracks WHERE playlist_id = $1`,
      [playlistId]
    );
    await client.query(
      `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ($1,$2,$3)
       ON CONFLICT (playlist_id, track_id) DO NOTHING`,
      [playlistId, trackId, posRes.rows[0].next_pos]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void> {
  await pool.query(`DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2`, [
    playlistId,
    trackId,
  ]);
}

/**
 * Reorders a playlist to exactly the given track ID sequence.
 * All-or-nothing: rejects if the ID set doesn't exactly match the
 * playlist's current tracks, so partial/stale client state can't silently
 * corrupt ordering.
 */
export async function reorderPlaylist(playlistId: string, orderedTrackIds: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [playlistId]);

    const current = await client.query(
      `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1`,
      [playlistId]
    );
    const currentIds = new Set(current.rows.map((r) => r.track_id));
    const newIds = new Set(orderedTrackIds);
    const sameSet =
      currentIds.size === newIds.size && [...currentIds].every((id) => newIds.has(id));
    if (!sameSet) {
      throw new Error("Reorder must include exactly the playlist's current tracks, no more or fewer.");
    }

    // Two-phase update avoids transiently violating the UNIQUE(playlist_id, position)
    // constraint while positions are being reassigned.
    await client.query(
      `UPDATE playlist_tracks SET position = position + 100000 WHERE playlist_id = $1`,
      [playlistId]
    );
    for (let i = 0; i < orderedTrackIds.length; i++) {
      await client.query(
        `UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND track_id = $3`,
        [i + 1, playlistId, orderedTrackIds[i]]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function setPlaylistActive(
  stationId: string,
  playlistId: string,
  isActive: boolean
): Promise<void> {
  await pool.query(`UPDATE playlists SET is_active = $1, updated_at = now() WHERE id = $2 AND station_id = $3`, [
    isActive,
    playlistId,
    stationId,
  ]);
}
