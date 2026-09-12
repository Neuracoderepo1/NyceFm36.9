import { pool } from "../db/pool.js";

/** Materializes the active weekly schedule into the queue without duplicating future items. */
export async function materializeSchedule(stationId: string, horizonMinutes = 30) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedule:${stationId}`]);
    const schedules = await client.query(`
      SELECT s.*, p.name AS playlist_name
      FROM broadcast_schedules s
      LEFT JOIN playlists p ON p.id=s.playlist_id
      WHERE s.station_id=$1 AND s.enabled=true
    `,[stationId]);
    let added = 0;
    for (const s of schedules.rows) {
      if (!s.playlist_id) continue;
      const items = await client.query(`SELECT media_asset_id FROM playlist_items pi JOIN media_assets ma ON ma.id=pi.media_asset_id WHERE pi.playlist_id=$1 AND ma.status='ready' ORDER BY pi.position`,[s.playlist_id]);
      for (const item of items.rows) {
        const duplicate = await client.query(`SELECT 1 FROM broadcast_queue WHERE station_id=$1 AND media_asset_id=$2 AND source='playlist' AND status='queued' AND scheduled_for > now() AND scheduled_for <= now()+($3 || ' minutes')::interval LIMIT 1`,[stationId,item.media_asset_id,horizonMinutes]);
        if (duplicate.rows[0]) continue;
        const next = await client.query(`SELECT COALESCE(MAX(scheduled_for), now()) AS at FROM broadcast_queue WHERE station_id=$1 AND status='queued'`,[stationId]);
        const at = new Date(next.rows[0].at);
        const scheduled = new Date(Math.max(Date.now(), at.getTime()+1000));
        await client.query(`INSERT INTO broadcast_queue(station_id,media_asset_id,source,position,status,scheduled_for) SELECT $1,$2,'playlist',COALESCE(MAX(position)+1,0),'queued',$3 FROM broadcast_queue WHERE station_id=$1 AND status='queued'`,[stationId,item.media_asset_id,scheduled]);
        added++;
        if (added >= 20) break;
      }
      if (added >= 20) break;
    }
    await client.query("COMMIT");
    return added;
  } catch(e){ await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
