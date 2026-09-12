import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { enqueueTrack, getDefaultStationId, getNowPlaying, startBroadcast, stopBroadcast } from "../services/broadcast.js";
import { broadcastWorkerStatus } from "../services/broadcastWorker.js";
import { controlBroadcast, getControlState, setOverride } from "../services/broadcastControl.js";

export const broadcastRouter=Router();
const stationSchema=z.string().uuid().optional();

broadcastRouter.get("/now-playing",async(req,res)=>{const stationId=typeof req.query.stationId==='string'?req.query.stationId:await getDefaultStationId();res.json({nowPlaying:await getNowPlaying(stationId),worker:broadcastWorkerStatus()})});
broadcastRouter.get("/control-state",async(req,res)=>res.json(await getControlState(typeof req.query.stationId==='string'?req.query.stationId:undefined)));
broadcastRouter.get("/state",requirePermission("broadcast.read"),async(req,res)=>{
  const stationId=typeof req.query.stationId==='string'?req.query.stationId:await getDefaultStationId();
  const [now,queue,control]=await Promise.all([
    getNowPlaying(stationId),
    pool.query(`SELECT q.id,q.station_id,q.media_asset_id,q.source,q.position,q.status,q.scheduled_for,q.started_at,q.ended_at,q.created_at,ma.title,ma.artist,ma.album,ma.duration_ms FROM broadcast_queue q LEFT JOIN media_assets ma ON ma.id=q.media_asset_id WHERE q.station_id=$1 AND q.status='queued' ORDER BY q.position,q.scheduled_for NULLS FIRST,q.created_at LIMIT 100`,[stationId]),
    getControlState(stationId)
  ]);
  res.json({stationId,nowPlaying:now,queue:queue.rows,control});
});

broadcastRouter.get("/control-stream",requirePermission("broadcast.read"),async(req,res)=>{
  const stationId=typeof req.query.stationId==='string'?req.query.stationId:await getDefaultStationId();
  res.status(200); res.setHeader("Content-Type","text/event-stream"); res.setHeader("Cache-Control","no-cache, no-transform"); res.setHeader("Connection","keep-alive"); res.flushHeaders?.();
  let closed=false; let last="";
  const emit=async()=>{
    if(closed)return;
    try{
      const [now,queue,control]=await Promise.all([getNowPlaying(stationId),pool.query(`SELECT q.id,q.media_asset_id,q.source,q.position,q.status,q.scheduled_for,q.started_at,ma.title,ma.artist,ma.duration_ms FROM broadcast_queue q LEFT JOIN media_assets ma ON ma.id=q.media_asset_id WHERE q.station_id=$1 AND q.status='queued' ORDER BY q.position,q.scheduled_for NULLS FIRST,q.created_at LIMIT 100`,[stationId]),getControlState(stationId)]);
      const payload=JSON.stringify({stationId,nowPlaying:now,queue:queue.rows,control});
      if(payload!==last){res.write(`event: broadcast\ndata: ${payload}\n\n`); last=payload;} else res.write(`: heartbeat\n\n`);
    }catch{ if(!closed)res.write(`event: error\ndata: {"code":"STREAM_READ_FAILED"}\n\n`); }
  };
  await emit();
  const timer=setInterval(()=>void emit(),Number(process.env.BROADCAST_SSE_INTERVAL_MS??2000));
  req.on("close",()=>{closed=true;clearInterval(timer);res.end();});
});
broadcastRouter.get("/queue",async(req,res)=>{const stationId=typeof req.query.stationId==='string'?req.query.stationId:await getDefaultStationId();const {rows}=await pool.query(`SELECT q.id,q.station_id,q.media_asset_id,q.source,q.position,q.status,q.scheduled_for,q.started_at,q.ended_at,q.created_at,ma.title,ma.artist,ma.album,ma.duration_ms FROM broadcast_queue q LEFT JOIN media_assets ma ON ma.id=q.media_asset_id WHERE q.station_id=$1 AND q.status='queued' ORDER BY q.position,q.scheduled_for NULLS FIRST,q.created_at`,[stationId]);res.json({queue:rows})});

broadcastRouter.post("/start",requirePermission("broadcast.control"),async(req,res)=>{const body=z.object({stationId:stationSchema,mode:z.enum(["operator","scheduled","ai","automation"]).default("operator")}).parse(req.body);const stationId=body.stationId??await getDefaultStationId();const sessionId=await startBroadcast({stationId,actorId:req.session.userId!,mode:body.mode,correlationId:req.id});res.status(201).json({sessionId,stationId,status:"active"})});
broadcastRouter.post("/stop",requirePermission("broadcast.control"),async(req,res)=>{const stationId=typeof req.body?.stationId==='string'?req.body.stationId:await getDefaultStationId();const sessionId=await stopBroadcast({stationId,actorId:req.session.userId!,correlationId:req.id});res.json({stationId,status:"stopped",sessionId})});
broadcastRouter.post("/control",requirePermission("broadcast.control"),async(req,res)=>{const body=z.object({stationId:stationSchema,action:z.enum(["pause","resume","skip","next","stop","emergency_stop"]),reason:z.string().max(500).optional(),expectedControlRevision:z.number().int().nonnegative().optional()}).parse(req.body);res.json(await controlBroadcast({stationId:body.stationId,action:body.action,reason:body.reason,expectedControlRevision:body.expectedControlRevision,actorId:req.session.userId!,correlationId:req.id}))});
broadcastRouter.post("/override",requirePermission("broadcast.control"),async(req,res)=>{const body=z.object({stationId:stationSchema,mode:z.enum(["automation","dj","emergency"]),reason:z.string().max(500).optional()}).parse(req.body);res.json(await setOverride({stationId:body.stationId,mode:body.mode,reason:body.reason,actorId:req.session.userId!,correlationId:req.id}))});

broadcastRouter.post("/queue",requirePermission("queue.modify"),async(req,res)=>{const body=z.object({stationId:stationSchema,mediaAssetId:z.string().uuid(),source:z.enum(["playlist","dj","producer","ai","system"]).default("dj"),scheduledFor:z.string().datetime().optional()}).parse(req.body);const stationId=body.stationId??await getDefaultStationId();const asset=await pool.query(`SELECT id FROM media_assets WHERE id=$1 AND station_id=$2 AND status='ready'`,[body.mediaAssetId,stationId]);if(!asset.rows[0])return res.status(404).json({error:{code:"MEDIA_ASSET_NOT_FOUND",message:"Ready media asset not found for station.",request_id:req.id}});const item=await enqueueTrack({stationId,mediaAssetId:body.mediaAssetId,actorId:req.session.userId!,source:body.source,correlationId:req.id});if(body.scheduledFor) await pool.query(`UPDATE broadcast_queue SET scheduled_for=$2 WHERE id=$1`,[item.id,body.scheduledFor]);res.status(201).json({item:{...item,scheduled_for:body.scheduledFor??null}})});

broadcastRouter.post("/schedule",requirePermission("system.configure"),async(req,res)=>{const body=z.object({stationId:stationSchema,programId:z.string().uuid().optional(),playlistId:z.string().uuid().optional(),dayOfWeek:z.number().int().min(0).max(6),startLocal:z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$/),endLocal:z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$/),priority:z.number().int().min(0).max(10000).default(100)}).refine(x=>x.programId||x.playlistId,{message:"programId or playlistId is required"});const stationId=body.stationId??await getDefaultStationId();const r=await pool.query(`INSERT INTO broadcast_schedules(station_id,program_id,playlist_id,day_of_week,start_local,end_local,priority,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[stationId,body.programId??null,body.playlistId??null,body.dayOfWeek,body.startLocal,body.endLocal,body.priority,req.session.userId!]);res.status(201).json({schedule:r.rows[0]})});
broadcastRouter.get("/schedules",async(req,res)=>{const stationId=typeof req.query.stationId==='string'?req.query.stationId:await getDefaultStationId();const {rows}=await pool.query(`SELECT * FROM broadcast_schedules WHERE station_id=$1 AND enabled=true ORDER BY day_of_week,start_local,priority`,[stationId]);res.json({schedules:rows})});
