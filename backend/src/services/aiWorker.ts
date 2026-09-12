import { getDefaultStationId } from "./broadcast.js";
import { getAiConfig, runAiCycle, approveAndExecuteAction } from "./aiDj.js";
import { pool } from "../db/pool.js";

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startAiWorker() {
  if (timer || process.env.AI_WORKER_ENABLED !== "true") return;
  timer=setInterval(()=>void tick(),Number(process.env.AI_WORKER_INTERVAL_MS??15000));
  void tick();
}
export function stopAiWorker(){if(timer)clearInterval(timer);timer=null;}

async function tick(){
  if(busy)return; busy=true;
  try{
    const stationId=await getDefaultStationId();
    const cfg=await getAiConfig(stationId) as { enabled:boolean; autonomous_mode:boolean; max_actions_per_hour:number; require_human_approval:boolean };
    if(!cfg.enabled || !cfg.autonomous_mode) return;
    const hour=await pool.query(`SELECT count(*)::int AS count FROM ai_actions WHERE station_id=$1 AND created_at>now()-interval '1 hour'`,[stationId]);
    if((hour.rows[0]?.count??0)>=cfg.max_actions_per_hour)return;
    const decision=await runAiCycle({stationId,mode:"autonomous",actorId:null,correlationId:`ai-worker-${Date.now()}`});
    if(decision.policy.allowed && !cfg.require_human_approval && decision.decision.actionType!=='skip_track') await approveAndExecuteAction({actionId:decision.actionId,actorId:null,correlationId:`ai-worker-${Date.now()}`});
  }catch(e){console.error('ai worker:',e)}finally{busy=false;}
}
