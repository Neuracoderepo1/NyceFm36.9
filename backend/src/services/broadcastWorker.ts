import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { getDefaultStationId } from "./broadcast.js";
import { streamDir } from "./streaming.js";
import { materializeSchedule } from "./scheduler.js";
import { createObjectSignedUrl } from "./objectStorage.js";

let timer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let ticking = false;
let activeProcess: ChildProcess | null = null;
let activeTrack: { stationId: string; queueId: string; mediaAssetId: string; startedAt: Date; pid?: number; state: "playing" | "paused" } | null = null;
let requestedAction: "skip" | "stop" | "pause" | "resume" | null = null;
let restartAttempts = 0;

export function startBroadcastWorker() {
  if (timer) return;
  const interval = Number(process.env.BROADCAST_WORKER_INTERVAL_MS ?? 1000);
  timer = setInterval(() => void tick(), interval);
  watchdogTimer = setInterval(() => void watchdog(), Number(process.env.BROADCAST_WATCHDOG_INTERVAL_MS ?? 5000));
  void tick();
}
export function stopBroadcastWorker() {
  if (timer) clearInterval(timer); if (watchdogTimer) clearInterval(watchdogTimer);
  timer = null; watchdogTimer = null; activeProcess?.kill("SIGTERM"); activeProcess = null; activeTrack = null;
}
export function broadcastWorkerStatus() { return { enabled: process.env.BROADCAST_WORKER_ENABLED === "true", running: !!activeTrack, restartAttempts, activeTrack, pendingAction: requestedAction }; }
export async function requestWorkerAction(stationId: string, action: "skip" | "stop" | "pause" | "resume", controlRevision?: number) {
  if (!activeTrack || activeTrack.stationId !== stationId) return { accepted: true, active: false };
  if (action === "pause") {
    activeProcess?.kill("SIGSTOP");
    if (activeTrack) activeTrack.state = "paused";
    return { accepted: true, active: true, state: "paused", controlRevision };
  }
  if (action === "resume") {
    activeProcess?.kill("SIGCONT");
    if (activeTrack) activeTrack.state = "playing";
    return { accepted: true, active: true, state: "playing", controlRevision };
  }
  requestedAction = action;
  if (action === "skip" || action === "stop") activeProcess?.kill("SIGTERM");
  return { accepted: true, active: true };
}

async function tick() {
  if (ticking || activeTrack) return;
  ticking = true;
  const client = await pool.connect();
  try {
    const stationId = await getDefaultStationId();
    await materializeSchedule(stationId, Number(process.env.BROADCAST_SCHEDULE_HORIZON_MINUTES ?? 30));
    await client.query("BEGIN");
    const active = await client.query<{id:string}>(`SELECT id FROM broadcast_sessions WHERE station_id=$1 AND status='active' FOR UPDATE`, [stationId]);
    if (!active.rows[0]) { await client.query("ROLLBACK"); return; }
    const override = await client.query<{mode:string}>(`SELECT mode FROM broadcast_overrides WHERE station_id=$1 AND active=true ORDER BY activated_at DESC LIMIT 1`, [stationId]);
    if (override.rows[0]?.mode === "emergency") { await client.query("ROLLBACK"); return; }
    const current = await client.query(`SELECT queue_item_id FROM now_playing WHERE station_id=$1 AND state IN ('playing','paused') FOR UPDATE`, [stationId]);
    if (current.rows[0]?.queue_item_id) { await client.query("ROLLBACK"); return; }
    const claimed = await client.query(`SELECT * FROM public.claim_next_queue_item($1)`, [stationId]);
    if (!claimed.rows[0]) { await client.query("ROLLBACK"); return; }
    const q=claimed.rows[0];
    const asset = await client.query(`SELECT storage_key,status FROM media_assets WHERE id=$1 AND status='ready'`, [q.media_asset_id]);
    if (!asset.rows[0]) { await client.query(`UPDATE broadcast_queue SET status='failed',failed_reason='MEDIA_NOT_READY',ended_at=now() WHERE id=$1`, [q.id]); await client.query("COMMIT"); return; }
    await client.query(`SELECT * FROM public.advance_now_playing($1,$2,$3,$4,$5)`,[stationId,q.id,q.media_asset_id,active.rows[0].id,'auto']);
    await client.query(`INSERT INTO stream_events(station_id,event_type,queue_item_id,payload) VALUES($1,'track_started',$2,$3)`,[stationId,q.id,{media_asset_id:q.media_asset_id}]);
    await client.query("COMMIT");
    activeTrack={stationId,queueId:q.id,mediaAssetId:q.media_asset_id,startedAt:new Date(),state:"playing"};
    await playTrack(stationId,q.id,q.media_asset_id,asset.rows[0].storage_key);
  } catch(e){ try{await client.query("ROLLBACK")}catch{} console.error("broadcast worker:",e); } finally { client.release(); ticking=false; }
}

async function playTrack(stationId:string,queueId:string,mediaAssetId:string,storageKey:string) {
  const assetRow = (await pool.query<{storage_provider:string}>(`SELECT storage_provider FROM media_assets WHERE id=$1`,[mediaAssetId])).rows[0];
  const input = assetRow?.storage_provider === "supabase"
    ? await createObjectSignedUrl(storageKey, 900)
    : path.resolve(process.env.MEDIA_STORAGE_PATH??"./storage/media",storageKey);
  const dir=streamDir(stationId); await fs.mkdir(dir,{recursive:true});
  const args=["-hide_banner","-loglevel","warning","-re","-i",input,"-vn","-c:a","aac","-b:a",process.env.STREAM_AUDIO_BITRATE??"128k","-f","hls","-hls_time",process.env.HLS_SEGMENT_SECONDS??"4","-hls_list_size",process.env.HLS_LIST_SIZE??"8","-hls_flags","delete_segments+append_list+independent_segments+omit_endlist","-hls_start_number_source","epoch",path.join(dir,"index.m3u8")];
  const child=spawn(process.env.FFMPEG_PATH??"ffmpeg",args); activeProcess=child; activeTrack!.pid=child.pid;
  let stderr=""; child.stderr?.on("data",d=>{stderr=(stderr+String(d)).slice(-2000)});
  const started=Date.now();
  const revisionResult=await pool.query<{control_revision:number}>(`SELECT control_revision FROM now_playing WHERE station_id=$1 AND queue_item_id=$2`,[stationId,queueId]);
  const controlRevision=revisionResult.rows[0]?.control_revision;
  const heartbeat=setInterval(()=>void pool.query(`SELECT * FROM public.heartbeat_now_playing($1,$2,$3,$4)`,[stationId,Math.max(0,Date.now()-started),activeTrack?.state ?? "playing",controlRevision ?? null]).catch(()=>{}),1000);
  const code=await new Promise<number>(resolve=>child.on("close",c=>resolve(c??1)));
  clearInterval(heartbeat); activeProcess=null;
  const action=requestedAction; requestedAction=null;
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    let status:string="played"; let event="track_finished";
    if(action==="skip"){status="skipped";event="track_skipped"} else if(action==="stop"){status="skipped";event="broadcast_interrupted"} else if(code!==0){status="failed";event="track_failed"}
    await client.query(`UPDATE broadcast_queue SET status=$2,ended_at=now(),failed_reason=$3 WHERE id=$1`,[queueId,status,code!==0&&!action?stderr:null]);
    await client.query(`UPDATE now_playing SET state='idle',queue_item_id=NULL,media_asset_id=NULL,started_at=NULL,elapsed_ms=0,last_heartbeat_at=NULL,revision=revision+1,control_revision=control_revision+1,updated_at=now() WHERE station_id=$1 AND queue_item_id=$2`,[stationId,queueId]);
    await client.query(`INSERT INTO stream_events(station_id,event_type,queue_item_id,payload) VALUES($1,$2,$3,$4)`,[stationId,event,queueId,{ffmpeg_code:code,action:action??null,error:code!==0?stderr:null}]);
    if(event==='track_failed') { await client.query(`INSERT INTO broadcast_incidents(station_id,severity,code,message,metadata) VALUES($1,'critical','FFMPEG_TRACK_FAILED',$2,$3)`,[stationId,`FFmpeg failed while playing ${queueId}`,{queueId,code,stderr}]); }
    await client.query("COMMIT");
  } catch(e){await client.query("ROLLBACK");console.error("broadcast finalize:",e)} finally{client.release()}
  activeTrack=null;
  if(code!==0&&!action) restartAttempts++;
  else restartAttempts=0;
}

async function watchdog(){
  try {
    const stationId=await getDefaultStationId();
    if(!activeTrack){ await tick(); return; }
    const {rows}=await pool.query<{last_heartbeat_at:Date|null,state:string}>(`SELECT last_heartbeat_at,state FROM now_playing WHERE station_id=$1`,[stationId]);
    const heartbeat=rows[0]?.last_heartbeat_at?.getTime?.()??0;
    const timeout=Number(process.env.BROADCAST_WATCHDOG_TIMEOUT_MS??15000);
    if(rows[0]?.state==='playing' && heartbeat && Date.now()-heartbeat>timeout){
      await pool.query(`INSERT INTO broadcast_incidents(station_id,severity,code,message,metadata) VALUES($1,'critical','STREAM_HEARTBEAT_TIMEOUT','Broadcast heartbeat timed out',$2)`,[stationId,{timeoutMs:timeout,queueId:activeTrack.queueId}]);
      activeProcess?.kill("SIGTERM");
    }
  } catch(e){console.error("broadcast watchdog:",e)}
}
