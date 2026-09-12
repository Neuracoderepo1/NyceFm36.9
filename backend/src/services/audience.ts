import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { recordAuditEvent } from "./audit.js";
import { getDefaultStationId, getNowPlaying } from "./broadcast.js";

export type AudienceActor = { userId?: string | null; anonymousId?: string | null; displayName?: string };

export function actorFromRequest(req: { session?: { userId?: string } }, anonymousId?: string, displayName?: string): AudienceActor {
  return req.session?.userId ? { userId: req.session.userId, displayName } : { anonymousId: anonymousId || randomUUID(), displayName };
}

export async function stationIdOrDefault(stationId?: string) { return stationId ?? getDefaultStationId(); }

export async function trackAudienceEvent(stationId:string, actor:AudienceActor, eventType:string, entityType?:string, entityId?:string, metadata:unknown={}) {
  await pool.query(`INSERT INTO audience_events(station_id,user_id,anonymous_id,event_type,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`, [stationId, actor.userId??null, actor.anonymousId??null,eventType,entityType??null,entityId??null,JSON.stringify(metadata)]);
}

export async function getAudienceSnapshot(stationId:string) {
  const [np, presence, messages, reactions, polls] = await Promise.all([
    getNowPlaying(stationId),
    pool.query(`SELECT count(*)::int AS count FROM listener_presence WHERE station_id=$1 AND disconnected_at IS NULL AND last_seen_at > now()-interval '90 seconds'`,[stationId]),
    pool.query(`SELECT id,display_name,body,created_at FROM audience_messages WHERE station_id=$1 AND status='visible' ORDER BY created_at DESC LIMIT 50`,[stationId]),
    pool.query(`SELECT reaction,count(*)::int AS count FROM listener_reactions WHERE station_id=$1 AND created_at>now()-interval '24 hours' GROUP BY reaction ORDER BY count DESC`,[stationId]),
    pool.query(`SELECT p.id,p.question,p.status,p.starts_at,p.ends_at,json_agg(json_build_object('id',o.id,'label',o.label,'position',o.position) ORDER BY o.position) options FROM audience_polls p LEFT JOIN audience_poll_options o ON o.poll_id=p.id WHERE p.station_id=$1 AND p.status='active' GROUP BY p.id ORDER BY p.created_at DESC LIMIT 5`,[stationId])
  ]);
  return { stationId, nowPlaying:np, listeners:presence.rows[0]?.count??0, messages:messages.rows.reverse(), reactions:reactions.rows, polls:polls.rows };
}

export async function createRequest(input:{stationId:string;actor:AudienceActor;mediaAssetId?:string;title?:string;artist?:string;message?:string}) {
  if (!input.actor.userId && !input.actor.anonymousId) throw new Error("AUDIENCE_IDENTITY_REQUIRED");
  const r=await pool.query(`INSERT INTO listener_requests(station_id,user_id,anonymous_id,media_asset_id,requested_title,requested_artist,message) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[input.stationId,input.actor.userId??null,input.actor.anonymousId??null,input.mediaAssetId??null,input.title??null,input.artist??null,input.message??null]);
  await trackAudienceEvent(input.stationId,input.actor,'request_created','listener_request',r.rows[0].id);
  return r.rows[0];
}

export async function createDedication(input:{stationId:string;actor:AudienceActor;recipientName:string;message:string}) {
  const r=await pool.query(`INSERT INTO dedications(station_id,user_id,anonymous_id,recipient_name,message) VALUES($1,$2,$3,$4,$5) RETURNING *`,[input.stationId,input.actor.userId??null,input.actor.anonymousId??null,input.recipientName,input.message]);
  await trackAudienceEvent(input.stationId,input.actor,'dedication_created','dedication',r.rows[0].id);
  return r.rows[0];
}

export async function react(input:{stationId:string;actor:AudienceActor;reaction:string;mediaAssetId?:string}) {
  const r=await pool.query(`INSERT INTO listener_reactions(station_id,user_id,anonymous_id,reaction,media_asset_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,[input.stationId,input.actor.userId??null,input.actor.anonymousId??null,input.reaction,input.mediaAssetId??null]);
  await trackAudienceEvent(input.stationId,input.actor,'reaction_created','reaction',String(r.rows[0].id),{reaction:input.reaction});
  return r.rows[0];
}

export async function vote(input:{pollId:string;optionId:string;actor:AudienceActor}) {
  const r=await pool.query(`INSERT INTO audience_poll_votes(poll_id,option_id,user_id,anonymous_id) VALUES($1,$2,$3,$4) RETURNING *`,[input.pollId,input.optionId,input.actor.userId??null,input.actor.anonymousId??null]);
  await trackAudienceEvent((await pool.query(`SELECT station_id FROM audience_polls WHERE id=$1`,[input.pollId])).rows[0].station_id,input.actor,'poll_vote','poll',input.pollId,{optionId:input.optionId});
  return r.rows[0];
}

export async function presenceHeartbeat(stationId:string,actor:AudienceActor) {
  const existing=await pool.query(`SELECT id FROM listener_presence WHERE station_id=$1 AND ((user_id=$2 AND $2 IS NOT NULL) OR (anonymous_id=$3 AND $3 IS NOT NULL)) AND disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1`,[stationId,actor.userId??null,actor.anonymousId??null]);
  if(existing.rows[0]) { await pool.query(`UPDATE listener_presence SET last_seen_at=now() WHERE id=$1`,[existing.rows[0].id]); return existing.rows[0].id; }
  const r=await pool.query(`INSERT INTO listener_presence(station_id,user_id,anonymous_id) VALUES($1,$2,$3) RETURNING id`,[stationId,actor.userId??null,actor.anonymousId??null]);
  return r.rows[0].id;
}

export async function moderateMessage(messageId:string,status:"visible"|"hidden"|"deleted",moderatorId:string,reason?:string) {
  const r=await pool.query(`UPDATE audience_messages SET status=$2,moderated_by=$3,moderated_at=now(),moderation_reason=$4 WHERE id=$1 RETURNING *`,[messageId,status,moderatorId,reason??null]);
  if(!r.rows[0]) throw new Error("MESSAGE_NOT_FOUND");
  await recordAuditEvent({actorId:moderatorId,action:`AUDIENCE_MESSAGE_${status.toUpperCase()}`,resourceType:"audience_message",resourceId:messageId,afterState:r.rows[0]});
  return r.rows[0];
}
