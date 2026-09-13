import { spawn } from "node:child_process";
import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import path from "node:path";
import { createObjectSignedUrl, configuredStorageProvider } from "./objectStorage.js";

let timer: NodeJS.Timeout | null = null;
let busy = false;
export function startMediaProcessor(){ if(timer) return; timer=setInterval(()=>void tick(), Number(process.env.MEDIA_PROCESSOR_INTERVAL_MS??2000)); void tick(); }
export function stopMediaProcessor(){ if(timer) clearInterval(timer); timer=null; }
async function tick(){
  if(busy) return;
  busy=true;
  let client: PoolClient | null = null;
  try{
    client=await pool.connect();
    const {rows}=await client.query<{id:string;storage_key:string;storage_provider:string}>(`SELECT id,storage_key,storage_provider FROM media_assets WHERE status='processing' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if(!rows[0]) return;
    const a=rows[0];
    const input = a.storage_provider === "supabase" || configuredStorageProvider() === "supabase"
      ? await createObjectSignedUrl(a.storage_key, 900)
      : path.resolve(process.env.MEDIA_STORAGE_PATH??"./storage/media",a.storage_key);
    const probe=spawn(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",input]);
    let out=""; let err=""; probe.stdout.on("data",d=>out+=d); probe.stderr.on("data",d=>err+=d);
    const code=await new Promise<number>(r=>probe.on("close",c=>r(c??1)));
    if(code!==0) throw new Error(`ffprobe failed: ${err}`);
    const durationMs=Math.round(Number.parseFloat(out)*1000);
    if(!Number.isFinite(durationMs)||durationMs<=0) throw new Error("Invalid audio duration");
    await client.query(`UPDATE media_assets SET duration_ms=$2,status='ready',updated_at=now() WHERE id=$1`,[a.id,durationMs]);
  }catch(err){ console.error("media processor:",err); }
  finally{client?.release();busy=false;}
}
