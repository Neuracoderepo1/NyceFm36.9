import { pool } from "../db/pool.js";
import { recordAuditEvent } from "./audit.js";
import { enqueueTrack, getDefaultStationId, getNowPlaying } from "./broadcast.js";
import { getAudienceSnapshot } from "./audience.js";

export type AiActionType = "queue_track" | "skip_track" | "speak" | "hold" | "no_action";
export type AiMode = "recommendation" | "autonomous";

export interface AiContext {
  stationId: string;
  nowPlaying: unknown;
  queue: unknown[];
  audience: unknown;
  recentEvents: unknown[];
  config: unknown;
  requestedActionType?: "speak";
  hint?: "shoutout" | "track_intro";
}

export interface AiDecision {
  actionType: AiActionType;
  confidence: number;
  rationale: string;
  payload: Record<string, unknown>;
}

/** Provider boundary. Production providers can be added without giving them direct DB or broadcast access. */
export interface AiProvider {
  readonly name: string;
  decide(context: AiContext): Promise<AiDecision>;
}

/** Deterministic fallback provider: safe, local, auditable, and usable with no external AI credential. */
export class LocalStationProvider implements AiProvider {
  readonly name = "local-rules-v1";
  async decide(context: AiContext): Promise<AiDecision> {
    const np = context.nowPlaying as { state?: string; media_asset_id?: string; title?: string; artist?: string };
    const audience = context.audience as { listeners?: number; polls?: unknown[] };
    const queue = context.queue;

    // On-demand manual trigger (SHOUTOUT / TRACK INTRO buttons). This branch is
    // evaluated before the autonomous rules below and never mutates the queue —
    // it only proposes a 'speak' decision, which still goes through
    // actionAllowed() and still lands as a 'proposed' ai_actions row requiring
    // a separate explicit /execute call. No approval step is bypassed here.
    if (context.requestedActionType === "speak") {
      const listeners = audience?.listeners ?? 0;
      const text = context.hint === "track_intro"
        ? (np?.title ? `Coming up next on Nyce FM 36.9: "${np.title}"${np.artist ? ` by ${np.artist}` : ""}. Stay locked in!` : "Coming up next on Nyce FM 36.9 — stay locked in!")
        : `You're locked into Nyce FM 36.9${listeners > 0 ? ` with ${listeners.toLocaleString()} listeners strong` : ""} — keep it right here!`;
      return { actionType: "speak", confidence: 0.9, rationale: `Manual ${context.hint ?? "speak"} requested by operator.`, payload: { text } };
    }

    if (np?.state === "playing") {
      return { actionType: "hold", confidence: 0.99, rationale: "Current programme is active; no safe queue mutation is required.", payload: {} };
    }
    if (!np?.media_asset_id && queue.length > 0) {
      const next = queue[0] as { media_asset_id?: string };
      if (next.media_asset_id) return { actionType: "queue_track", confidence: 0.92, rationale: "Broadcast is idle and a ready queued track is available.", payload: { mediaAssetId: next.media_asset_id } };
    }
    if ((audience?.listeners ?? 0) === 0) {
      return { actionType: "hold", confidence: 0.95, rationale: "No active audience; preserve the current automation state.", payload: {} };
    }
    return { actionType: "no_action", confidence: 0.90, rationale: "No deterministic intervention is justified by the current station context.", payload: {} };
  }
}


export class AnthropicStationProvider implements AiProvider {
  readonly name = `anthropic:${process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5"}`;
  async decide(context: AiContext): Promise<AiDecision> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("AI_PROVIDER_NOT_CONFIGURED");
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    const manualRequest = context.requestedActionType === "speak"
      ? `\nThe operator has manually pressed a "${context.hint === "track_intro" ? "TRACK INTRO" : "SHOUTOUT"}" button and is requesting an on-demand voice line right now. You MUST return actionType "speak" with hype text appropriate to that request, using the real current track/audience data in the supplied context. Do not queue, skip, hold, or decline this manual request unless the context makes a speak line genuinely unsafe (e.g. missing track data for a track intro).`
      : "";
    const system = `You are NYCE FM's station intelligence engine. Return ONLY valid JSON with keys actionType, confidence, rationale, payload. actionType must be one of queue_track, skip_track, speak, hold, no_action. Never invent mediaAssetId. Keep confidence between 0 and 1. Respect the supplied station policy. skip_track must never be proposed unless explicitly justified by a real current broadcast problem. speak payload must contain text <= 2000 chars. queue_track payload must contain mediaAssetId from the supplied queue.${manualRequest}`;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 700, system: `${system}\nStation context:`, messages: [{ role: "user", content: JSON.stringify(context) }] }),
    });
    if (!response.ok) throw new Error(`AI_PROVIDER_ERROR_${response.status}`);
    const body = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = body.content?.find((part) => part.type === "text")?.text?.trim();
    if (!text) throw new Error("AI_PROVIDER_EMPTY_RESPONSE");
    const jsonText = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(jsonText) as Partial<AiDecision>;
    const actionTypes: AiActionType[] = ["queue_track", "skip_track", "speak", "hold", "no_action"];
    if (!actionTypes.includes(parsed.actionType as AiActionType) || typeof parsed.confidence !== "number" || typeof parsed.rationale !== "string" || !parsed.payload || typeof parsed.payload !== "object") throw new Error("AI_PROVIDER_INVALID_RESPONSE");
    return { actionType: parsed.actionType as AiActionType, confidence: parsed.confidence, rationale: parsed.rationale.slice(0, 4000), payload: parsed.payload as Record<string, unknown> };
  }
}

function provider(): AiProvider {
  return process.env.AI_PROVIDER === "anthropic" ? new AnthropicStationProvider() : new LocalStationProvider();
}

async function buildContext(stationId: string): Promise<AiContext> {
  const [nowPlaying, queue, audience, events, config] = await Promise.all([
    getNowPlaying(stationId),
    pool.query(`SELECT q.id,q.media_asset_id,q.source,q.position,q.status,q.scheduled_for,ma.title,ma.artist,ma.duration_ms FROM broadcast_queue q JOIN media_assets ma ON ma.id=q.media_asset_id WHERE q.station_id=$1 AND q.status='queued' ORDER BY q.position,q.scheduled_for NULLS FIRST,q.created_at LIMIT 25`, [stationId]),
    getAudienceSnapshot(stationId),
    pool.query(`SELECT event_type,metadata,occurred_at FROM audience_events WHERE station_id=$1 ORDER BY occurred_at DESC LIMIT 100`, [stationId]),
    pool.query(`SELECT * FROM ai_station_config WHERE station_id=$1`, [stationId]),
  ]);
  return { stationId, nowPlaying, queue: queue.rows, audience, recentEvents: events.rows, config: config.rows[0] ?? null };
}

async function actionAllowed(stationId: string, decision: AiDecision): Promise<{ allowed: boolean; reason?: string }> {
  if (decision.confidence < 0.75) return { allowed: false, reason: "AI_CONFIDENCE_BELOW_POLICY" };
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) return { allowed: false, reason: "INVALID_CONFIDENCE" };
  if (decision.actionType === "queue_track") {
    const id = decision.payload.mediaAssetId;
    if (typeof id !== "string") return { allowed: false, reason: "MEDIA_ASSET_REQUIRED" };
    const r = await pool.query(`SELECT id FROM media_assets WHERE id=$1 AND station_id=$2 AND status='ready'`, [id, stationId]);
    if (!r.rows[0]) return { allowed: false, reason: "MEDIA_ASSET_NOT_READY" };
  }
  if (decision.actionType === "speak") {
    const text = decision.payload.text;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > 2000) return { allowed: false, reason: "VOICE_TEXT_INVALID" };
  }
  return { allowed: true };
}

export async function runAiCycle(input: { stationId?: string; mode: AiMode; requestedActionType?: "speak"; hint?: "shoutout" | "track_intro"; actorId: string | null; correlationId: string }) {
  const stationId = input.stationId ?? await getDefaultStationId();
  const started = Date.now();
  const context: AiContext = { ...await buildContext(stationId), requestedActionType: input.requestedActionType, hint: input.hint };
  const ai = provider();
  let decision: AiDecision;
  try {
    decision = await ai.decide(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const run = await pool.query<{ id: string }>(`INSERT INTO ai_runs(station_id,mode,provider,status,input_context,output,error_code,completed_at) VALUES($1,$2,$3,'failed',$4,'{}'::jsonb,$5,now()) RETURNING id`, [stationId,input.mode,ai.name,JSON.stringify(context),message.slice(0,200)]);
    await recordAuditEvent({ actorId: input.actorId, action: "AI_PROVIDER_FAILED", resourceType: "ai_run", resourceId: run.rows[0].id, afterState: { provider: ai.name, error: message.slice(0,500), durationMs: Date.now()-started }, correlationId: input.correlationId });
    throw error;
  }
  const policy = await actionAllowed(stationId, decision);
  const status = policy.allowed ? "completed" : "rejected";
  const run = await pool.query<{ id: string }>(`INSERT INTO ai_runs(station_id,mode,provider,status,input_context,output,error_code,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id`, [stationId,input.mode,ai.name,status,JSON.stringify(context),JSON.stringify(decision),policy.reason??null]);
  const runId = run.rows[0].id;
  const action = await pool.query<{id:string}>(`INSERT INTO ai_actions(run_id,station_id,action_type,status,payload,rationale,confidence) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [runId,stationId,decision.actionType,policy.allowed ? "proposed" : "rejected",JSON.stringify(decision.payload),decision.rationale,decision.confidence]);
  await recordAuditEvent({ actorId: input.actorId, action: `AI_DECISION_${status.toUpperCase()}`, resourceType: "ai_run", resourceId: runId, afterState: { provider: ai.name, decision, policy, durationMs: Date.now()-started }, correlationId: input.correlationId });
  return { runId, actionId: action.rows[0].id, provider: ai.name, decision, policy, durationMs: Date.now()-started };
}

export async function approveAndExecuteAction(input: { actionId: string; actorId: string | null; correlationId: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{id:string;station_id:string;action_type:AiActionType;payload:Record<string, unknown>;status:string}>(`SELECT id,station_id,action_type,payload,status FROM ai_actions WHERE id=$1 FOR UPDATE`, [input.actionId]);
    if (!r.rows[0]) throw new Error("AI_ACTION_NOT_FOUND");
    const action = r.rows[0];
    if (action.status !== "proposed") throw new Error("AI_ACTION_NOT_EXECUTABLE");
    await client.query(`UPDATE ai_actions SET status='approved',approved_by=$2 WHERE id=$1`, [action.id,input.actorId]);
    await client.query("COMMIT");
    let result: unknown = null;
    if (action.action_type === "queue_track") { const mediaAssetId = action.payload.mediaAssetId; if (typeof mediaAssetId !== "string") throw new Error("AI_MEDIA_ASSET_REQUIRED"); result = await enqueueTrack({ stationId: action.station_id, mediaAssetId, actorId: input.actorId, source: "ai", correlationId: input.correlationId }); }
    else if (action.action_type === "speak") {
      const v = await pool.query(`INSERT INTO ai_voice_segments(station_id,kind,text,status,created_by) VALUES($1,'link',$2,'approved',$3) RETURNING *`, [action.station_id,String(action.payload.text),input.actorId]);
      result = v.rows[0];
    } else if (action.action_type === "hold" || action.action_type === "no_action") result = { accepted: true };
    else if (action.action_type === "skip_track") throw new Error("AI_SKIP_REQUIRES_BROADCAST_CONTROL_PATH");
    await pool.query(`UPDATE ai_actions SET status='executed',executed_at=now() WHERE id=$1`, [action.id]);
    await recordAuditEvent({actorId:input.actorId,action:"AI_ACTION_EXECUTED",resourceType:"ai_action",resourceId:action.id,afterState:{action,result},correlationId:input.correlationId});
    return { actionId: action.id, status:"executed", result };
  } catch(e) {
    await client.query("ROLLBACK");
    await pool.query(`UPDATE ai_actions SET status='failed' WHERE id=$1 AND status IN ('approved','proposed')`, [input.actionId]).catch(()=>{});
    throw e;
  } finally { client.release(); }
}

export async function getAiConfig(stationId?: string) {
  const id=stationId??await getDefaultStationId();
  const r=await pool.query(`SELECT * FROM ai_station_config WHERE station_id=$1`,[id]);
  return r.rows[0] ?? { station_id:id,enabled:false,autonomous_mode:false,max_actions_per_hour:30,max_consecutive_ai_tracks:3,min_request_confidence:0.75,require_human_approval:true };
}

export async function upsertAiConfig(input:{stationId?:string;actorId:string;enabled:boolean;autonomousMode:boolean;maxActionsPerHour:number;maxConsecutiveAiTracks:number;minRequestConfidence:number;requireHumanApproval:boolean;systemPrompt?:string;correlationId:string}) {
  const stationId=input.stationId??await getDefaultStationId();
  const r=await pool.query(`INSERT INTO ai_station_config(station_id,enabled,autonomous_mode,max_actions_per_hour,max_consecutive_ai_tracks,min_request_confidence,require_human_approval,system_prompt,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(station_id) DO UPDATE SET enabled=EXCLUDED.enabled,autonomous_mode=EXCLUDED.autonomous_mode,max_actions_per_hour=EXCLUDED.max_actions_per_hour,max_consecutive_ai_tracks=EXCLUDED.max_consecutive_ai_tracks,min_request_confidence=EXCLUDED.min_request_confidence,require_human_approval=EXCLUDED.require_human_approval,system_prompt=EXCLUDED.system_prompt,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[stationId,input.enabled,input.autonomousMode,input.maxActionsPerHour,input.maxConsecutiveAiTracks,input.minRequestConfidence,input.requireHumanApproval,input.systemPrompt??null,input.actorId]);
  await recordAuditEvent({actorId:input.actorId,action:"AI_CONFIG_UPDATED",resourceType:"ai_station_config",resourceId:stationId,afterState:r.rows[0],correlationId:input.correlationId});
  return r.rows[0];
}

export async function getAiActions(stationId?: string) { const id=stationId??await getDefaultStationId(); const r=await pool.query(`SELECT * FROM ai_actions WHERE station_id=$1 ORDER BY created_at DESC LIMIT 100`,[id]); return r.rows; }
export async function getAiRuns(stationId?: string) { const id=stationId??await getDefaultStationId(); const r=await pool.query(`SELECT id,mode,provider,status,error_code,started_at,completed_at,output FROM ai_runs WHERE station_id=$1 ORDER BY started_at DESC LIMIT 50`,[id]); return r.rows; }
