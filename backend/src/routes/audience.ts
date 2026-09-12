import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { recordAuditEvent } from "../services/audit.js";
import { actorFromRequest, createDedication, createRequest, getAudienceSnapshot, moderateMessage, presenceHeartbeat, react, stationIdOrDefault, trackAudienceEvent, vote } from "../services/audience.js";

export const audienceRouter=Router();
const publicLimiter=rateLimit({windowMs:60_000,limit:60,standardHeaders:true,legacyHeaders:false});
const station=z.string().uuid().optional();
const actor=z.object({anonymousId:z.string().min(8).max(128).optional(),displayName:z.string().min(1).max(80).optional()});

function actorFor(req: import("express").Request, body: { anonymousId?: string; displayName?: string }) {
  return actorFromRequest(req, body.anonymousId, body.displayName);
}

audienceRouter.get("/snapshot",publicLimiter,async(req,res)=>{const id=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);res.json(await getAudienceSnapshot(id));});

audienceRouter.post("/presence",publicLimiter,async(req,res)=>{const b=actor.merge(z.object({stationId:station})).parse(req.body??{});const id=await stationIdOrDefault(b.stationId);const a=actorFor(req,b);const presenceId=await presenceHeartbeat(id,a);await trackAudienceEvent(id,a,'presence_heartbeat');res.json({presenceId,stationId:id,anonymousId:a.anonymousId??null});});

audienceRouter.post("/events",publicLimiter,async(req,res)=>{const b=actor.merge(z.object({stationId:station,eventType:z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),entityType:z.string().max(80).optional(),entityId:z.string().uuid().optional(),metadata:z.record(z.unknown()).optional()})).parse(req.body??{});const id=await stationIdOrDefault(b.stationId);const a=actorFor(req,b);await trackAudienceEvent(id,a,b.eventType,b.entityType,b.entityId,b.metadata??{});res.status(202).json({accepted:true});});

audienceRouter.post("/requests",publicLimiter,async(req,res)=>{const b=actor.merge(z.object({stationId:station,mediaAssetId:z.string().uuid().optional(),title:z.string().min(1).max(200).optional(),artist:z.string().max(200).optional(),message:z.string().max(500).optional()}).refine(x=>x.mediaAssetId||x.title,{message:'mediaAssetId or title is required'})).parse(req.body??{});const id=await stationIdOrDefault(b.stationId);const a=actorFor(req,b);res.status(201).json({request:await createRequest({stationId:id,actor:a,mediaAssetId:b.mediaAssetId,title:b.title,artist:b.artist,message:b.message})});});

audienceRouter.post("/dedications",publicLimiter,async(req,res)=>{const b=actor.merge(z.object({stationId:station,recipientName:z.string().min(1).max(120),message:z.string().min(1).max(1000)})).parse(req.body??{});const id=await stationIdOrDefault(b.stationId);const a=actorFor(req,b);res.status(201).json({dedication:await createDedication({stationId:id,actor:a,recipientName:b.recipientName,message:b.message})});});

audienceRouter.post("/reactions",publicLimiter,async(req,res)=>{const b=actor.merge(z.object({stationId:station,reaction:z.enum(['like','love','fire','dance','wow']),mediaAssetId:z.string().uuid().optional()})).parse(req.body??{});const id=await stationIdOrDefault(b.stationId);const a=actorFor(req,b);res.status(201).json({reaction:await react({stationId:id,actor:a,reaction:b.reaction,mediaAssetId:b.mediaAssetId})});});

audienceRouter.get("/polls",publicLimiter,async(req,res)=>{const id=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);const r=await pool.query(`SELECT p.*,COALESCE(json_agg(json_build_object('id',o.id,'label',o.label,'position',o.position) ORDER BY o.position) FILTER(WHERE o.id IS NOT NULL),'[]') options FROM audience_polls p LEFT JOIN audience_poll_options o ON o.poll_id=p.id WHERE p.station_id=$1 AND p.status='active' GROUP BY p.id ORDER BY p.created_at DESC`,[id]);res.json({polls:r.rows});});

audienceRouter.post("/polls/:pollId/vote",publicLimiter,async(req,res)=>{const b=actor.merge(z.object({optionId:z.string().uuid()})).parse(req.body??{});const a=actorFor(req,b);res.status(201).json({vote:await vote({pollId:req.params.pollId,optionId:b.optionId,actor:a})});});

audienceRouter.get("/chat",publicLimiter,async(req,res)=>{const id=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);const limit=Math.min(Math.max(Number(req.query.limit??50),1),100);const r=await pool.query(`SELECT id,display_name,body,created_at FROM audience_messages WHERE station_id=$1 AND status='visible' ORDER BY created_at DESC LIMIT $2`,[id,limit]);res.json({messages:r.rows.reverse()});});

audienceRouter.post("/chat",publicLimiter,async(req,res)=>{const b=actor.merge(z.object({stationId:station,body:z.string().trim().min(1).max(500)})).parse(req.body??{});const id=await stationIdOrDefault(b.stationId);const a=actorFor(req,b);const displayName=a.displayName??(a.userId?(await pool.query(`SELECT display_name FROM users WHERE id=$1`,[a.userId])).rows[0]?.display_name:'Listener')??'Listener';const r=await pool.query(`INSERT INTO audience_messages(station_id,user_id,anonymous_id,display_name,body) VALUES($1,$2,$3,$4,$5) RETURNING id,display_name,body,created_at`,[id,a.userId??null,a.anonymousId??null,displayName,b.body]);await trackAudienceEvent(id,a,'chat_message','audience_message',r.rows[0].id);res.status(201).json({message:r.rows[0]});});


audienceRouter.get("/media/search",publicLimiter,async(req,res)=>{
  const stationId=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);
  const q=typeof req.query.q==='string'?req.query.q.trim():'';
  if(q.length<2) return res.status(400).json({error:{code:'QUERY_TOO_SHORT',message:'q must contain at least 2 characters.',request_id:req.id}});
  const r=await pool.query(`SELECT id,title,artist,album,duration_ms,cover_art_key FROM media_assets WHERE station_id=$1 AND status='ready' AND (title ILIKE $2 OR artist ILIKE $2 OR album ILIKE $2) ORDER BY CASE WHEN lower(title)=lower($3) THEN 0 ELSE 1 END, title LIMIT 30`,[stationId,`%${q}%`,q]);
  res.json({assets:r.rows});
});

audienceRouter.post("/polls",requirePermission("audience.configure"),async(req,res)=>{
  const b=z.object({stationId:station,question:z.string().trim().min(3).max(300),options:z.array(z.string().trim().min(1).max(120)).min(2).max(10),startsAt:z.string().datetime().optional(),endsAt:z.string().datetime().optional()}).parse(req.body);
  const stationId=await stationIdOrDefault(b.stationId); const client=await pool.connect();
  try { await client.query('BEGIN'); const p=await client.query(`INSERT INTO audience_polls(station_id,question,status,starts_at,ends_at,created_by) VALUES($1,$2,'draft',$3,$4,$5) RETURNING *`,[stationId,b.question,b.startsAt??null,b.endsAt??null,req.session.userId]); for(let i=0;i<b.options.length;i++) await client.query(`INSERT INTO audience_poll_options(poll_id,label,position) VALUES($1,$2,$3)`,[p.rows[0].id,b.options[i],i]); await client.query('COMMIT'); res.status(201).json({poll:p.rows[0]}); } catch(e){await client.query('ROLLBACK');throw e} finally{client.release()}
});

audienceRouter.post("/polls/:pollId/publish",requirePermission("audience.configure"),async(req,res)=>{const r=await pool.query(`UPDATE audience_polls SET status='active' WHERE id=$1 AND station_id=$2 RETURNING *`,[req.params.pollId,await stationIdOrDefault(typeof req.body?.stationId==='string'?req.body.stationId:undefined)]);if(!r.rows[0])return res.status(404).json({error:{code:'POLL_NOT_FOUND'}});res.json({poll:r.rows[0]});});
audienceRouter.post("/polls/:pollId/close",requirePermission("audience.configure"),async(req,res)=>{const r=await pool.query(`UPDATE audience_polls SET status='closed' WHERE id=$1 RETURNING *`,[req.params.pollId]);if(!r.rows[0])return res.status(404).json({error:{code:'POLL_NOT_FOUND'}});res.json({poll:r.rows[0]});});

audienceRouter.get("/analytics/summary",requirePermission("analytics.read"),async(req,res)=>{const stationId=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);const [events,requests,reactions,messages]=await Promise.all([pool.query(`SELECT event_type,count(*)::int count FROM audience_events WHERE station_id=$1 AND occurred_at>now()-interval '24 hours' GROUP BY event_type ORDER BY count DESC`,[stationId]),pool.query(`SELECT status,count(*)::int count FROM listener_requests WHERE station_id=$1 AND created_at>now()-interval '24 hours' GROUP BY status`,[stationId]),pool.query(`SELECT reaction,count(*)::int count FROM listener_reactions WHERE station_id=$1 AND created_at>now()-interval '24 hours' GROUP BY reaction ORDER BY count DESC`,[stationId]),pool.query(`SELECT count(*)::int count FROM audience_messages WHERE station_id=$1 AND created_at>now()-interval '24 hours'`,[stationId])]);res.json({stationId,window:'24h',events:events.rows,requests:requests.rows,reactions:reactions.rows,messages:messages.rows[0]?.count??0});});

audienceRouter.get("/events/stream",publicLimiter,async(req,res)=>{
  const stationId=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);
  res.status(200); res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache, no-transform'); res.setHeader('Connection','keep-alive'); res.flushHeaders?.();
  let last=0; let closed=false;
  const send=async()=>{if(closed)return; try{const np=await getAudienceSnapshot(stationId); const id=Date.now(); if(id!==last){last=id;res.write(`id: ${id}\nevent: audience.snapshot\ndata: ${JSON.stringify(np)}\n\n`);}}catch{} };
  await send(); const timer=setInterval(send,5000); req.on('close',()=>{closed=true;clearInterval(timer);res.end();});
});

audienceRouter.get("/moderation/messages",requirePermission("audience.read"),async(req,res)=>{const id=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);const r=await pool.query(`SELECT * FROM audience_messages WHERE station_id=$1 AND status<>'visible' ORDER BY created_at DESC LIMIT 100`,[id]);res.json({messages:r.rows});});

audienceRouter.post("/moderation/messages/:messageId",requirePermission("audience.moderate"),async(req,res)=>{const b=z.object({status:z.enum(['visible','hidden','deleted']),reason:z.string().max(500).optional()}).parse(req.body);res.json({message:await moderateMessage(req.params.messageId,b.status,req.session.userId!,b.reason)});});

audienceRouter.get("/moderation/requests",requirePermission("audience.read"),async(req,res)=>{const id=await stationIdOrDefault(typeof req.query.stationId==='string'?req.query.stationId:undefined);const r=await pool.query(`SELECT lr.*,ma.title AS media_title,ma.artist AS media_artist FROM listener_requests lr LEFT JOIN media_assets ma ON ma.id=lr.media_asset_id WHERE lr.station_id=$1 ORDER BY lr.created_at DESC LIMIT 100`,[id]);res.json({requests:r.rows});});

audienceRouter.post("/moderation/requests/:requestId",requirePermission("audience.moderate"),async(req,res)=>{const b=z.object({status:z.enum(['approved','rejected','cancelled']),note:z.string().max(500).optional()}).parse(req.body);const r=await pool.query(`UPDATE listener_requests SET status=$2,moderation_note=$3,updated_at=now() WHERE id=$1 RETURNING *`,[req.params.requestId,b.status,b.note??null]);if(!r.rows[0])return res.status(404).json({error:{code:'REQUEST_NOT_FOUND'}});await recordAuditEvent({actorId:req.session.userId!,action:`AUDIENCE_REQUEST_${b.status.toUpperCase()}`,resourceType:'listener_request',resourceId:req.params.requestId,afterState:r.rows[0],correlationId:req.id});res.json({request:r.rows[0]});});
