import { pool } from "../db/pool.js";
import { recordAuditEvent } from "./audit.js";
import { getDefaultStationId } from "./broadcast.js";
import { requestWorkerAction } from "./broadcastWorker.js";

export type OverrideMode = "automation" | "dj" | "emergency";

export async function controlBroadcast(input: {
  stationId?: string; action: "pause" | "resume" | "skip" | "stop" | "next" | "emergency_stop";
  actorId: string; correlationId: string; reason?: string; expectedControlRevision?: number;
}) {
  const stationId = input.stationId ?? await getDefaultStationId();
  const dbAction = input.action === "next" ? "skip" : input.action;
  const result = await pool.query(`SELECT * FROM public.control_now_playing($1,$2,$3)`, [stationId, dbAction, input.expectedControlRevision ?? null]);
  await requestWorkerAction(stationId, dbAction === "emergency_stop" ? "stop" : dbAction, Number(result.rows[0]?.control_revision ?? 0));
  await recordAuditEvent({ actorId: input.actorId, action: `BROADCAST_${input.action.toUpperCase()}`, resourceType: "station", resourceId: stationId, afterState: { reason: input.reason ?? null }, correlationId: input.correlationId });
  return { stationId, action: input.action, accepted: true, nowPlaying: result.rows[0] ?? null };
}

export async function setOverride(input: { stationId?: string; mode: OverrideMode; actorId: string; correlationId: string; reason?: string }) {
  const stationId = input.stationId ?? await getDefaultStationId();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`override:${stationId}`]);
    await client.query(`UPDATE broadcast_overrides SET active=false, ended_at=now() WHERE station_id=$1 AND active=true`, [stationId]);
    const r = await client.query<{ id: string }>(`INSERT INTO broadcast_overrides(station_id,mode,reason,activated_by) VALUES($1,$2,$3,$4) RETURNING id`, [stationId,input.mode,input.reason ?? null,input.actorId]);
    await client.query(`UPDATE broadcast_sessions SET mode=$2 WHERE station_id=$1 AND status='active'`, [stationId, input.mode === "dj" ? "operator" : input.mode]);
    await client.query("COMMIT");
    await recordAuditEvent({ actorId: input.actorId, action: `BROADCAST_OVERRIDE_${input.mode.toUpperCase()}`, resourceType: "broadcast_override", resourceId: r.rows[0].id, afterState: { stationId, mode: input.mode, reason: input.reason ?? null }, correlationId: input.correlationId });
    return r.rows[0];
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

export async function getControlState(stationId?: string) {
  const id = stationId ?? await getDefaultStationId();
  const { rows } = await pool.query(`SELECT o.id,o.mode,o.reason,o.activated_at FROM broadcast_overrides o WHERE o.station_id=$1 AND o.active=true LIMIT 1`, [id]);
  return { stationId: id, override: rows[0] ?? { mode: "automation", active: true } };
}
