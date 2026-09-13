import { spawn } from "node:child_process";
import { pool } from "../db/pool.js";
import { ensureObjectStorage, configuredStorageProvider } from "./objectStorage.js";
import { getDefaultStationId } from "./broadcast.js";
import { getAiConfig } from "./aiDj.js";
import { startMediaProcessor } from "./mediaProcessor.js";
import { startBroadcastWorker } from "./broadcastWorker.js";
import { startAiWorker } from "./aiWorker.js";

/**
 * Boots background workers in dependency order -- storage, then media
 * processor, then broadcast worker, then AI worker -- verifying each
 * stage's prerequisites before its continuous loop is allowed to start.
 * A failed stage blocks every stage after it (the broadcast worker never
 * spins up against a media pipeline that can't read its own storage
 * backend; the AI worker never spins up against a broadcast pipeline
 * that isn't live). A failure here never throws: it's logged, and the
 * process keeps running with the affected workers simply off. /health/ready
 * remains the source of truth for what's actually degraded, and this
 * function is safe to call again later (e.g. after a fix) since every
 * start* function is idempotent (a no-op if its timer is already set).
 */

export interface WorkerActivationResult {
  storage: boolean;
  mediaProcessor: boolean;
  broadcastWorker: boolean;
  aiWorker: boolean;
}

type StageCheck = { ok: true } | { ok: false; reason: string };

function log(stage: string, msg: string) {
  console.log(`[startup:${stage}] ${msg}`);
}
function logFail(stage: string, msg: string, err?: unknown) {
  const detail = err instanceof Error ? err.message : err;
  console.error(`[startup:${stage}] ${msg}${detail ? ` -- ${detail}` : ""}`);
}

function binaryAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(bin, ["-version"]);
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => {
      if (!settled) { settled = true; resolve(false); }
    });
    child.on("close", (code) => {
      if (!settled) { settled = true; resolve(code === 0); }
    });
  });
}

async function verifyStorage(): Promise<StageCheck> {
  try {
    // ensureObjectStorage() is a no-op for the "local" provider and,
    // for "supabase", confirms (and provisions if missing) the bucket.
    await ensureObjectStorage();
    return { ok: true };
  } catch (err) {
    logFail("storage", `object storage (${configuredStorageProvider()}) is not ready`, err);
    return { ok: false, reason: "storage" };
  }
}

async function verifyMediaProcessorPrereqs(): Promise<StageCheck> {
  try {
    await pool.query("SELECT 1 FROM media_assets LIMIT 1");
  } catch (err) {
    logFail("media-processor", "database check failed", err);
    return { ok: false, reason: "database" };
  }
  const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
  if (!(await binaryAvailable(ffprobePath))) {
    logFail("media-processor", `ffprobe binary not found (checked "${ffprobePath}")`);
    return { ok: false, reason: "ffprobe" };
  }
  return { ok: true };
}

async function verifyBroadcastPrereqs(): Promise<StageCheck> {
  try {
    await getDefaultStationId();
  } catch (err) {
    logFail("broadcast-worker", "default station is not provisioned", err);
    return { ok: false, reason: "station" };
  }
  const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
  if (!(await binaryAvailable(ffmpegPath))) {
    logFail("broadcast-worker", `ffmpeg binary not found (checked "${ffmpegPath}")`);
    return { ok: false, reason: "ffmpeg" };
  }
  return { ok: true };
}

async function verifyAiPrereqs(): Promise<StageCheck> {
  try {
    const stationId = await getDefaultStationId();
    await getAiConfig(stationId);
    return { ok: true };
  } catch (err) {
    logFail("ai-worker", "AI config check failed", err);
    return { ok: false, reason: "ai-config" };
  }
}

export async function startWorkersSequenced(): Promise<WorkerActivationResult> {
  const result: WorkerActivationResult = {
    storage: false,
    mediaProcessor: false,
    broadcastWorker: false,
    aiWorker: false,
  };

  // 1. Storage
  const storage = await verifyStorage();
  if (!storage.ok) {
    logFail("sequence", "storage not confirmed -- media processor, broadcast worker and AI worker will stay OFF");
    return result;
  }
  result.storage = true;
  log("storage", `confirmed (provider: ${configuredStorageProvider()})`);

  // 2. Media processor
  const mediaPrereqs = await verifyMediaProcessorPrereqs();
  if (!mediaPrereqs.ok) {
    logFail("sequence", `media processor prerequisites failed (${mediaPrereqs.reason}) -- broadcast worker and AI worker will stay OFF`);
    return result;
  }
  startMediaProcessor();
  result.mediaProcessor = true;
  log("media-processor", "started");

  // 3. Broadcast worker
  if (process.env.BROADCAST_WORKER_ENABLED !== "true") {
    log("broadcast-worker", "disabled (BROADCAST_WORKER_ENABLED != true) -- AI worker will stay OFF");
    return result;
  }
  const broadcastPrereqs = await verifyBroadcastPrereqs();
  if (!broadcastPrereqs.ok) {
    logFail("sequence", `broadcast worker prerequisites failed (${broadcastPrereqs.reason}) -- AI worker will stay OFF`);
    return result;
  }
  startBroadcastWorker();
  result.broadcastWorker = true;
  log("broadcast-worker", "started");

  // 4. AI worker
  if (process.env.AI_WORKER_ENABLED !== "true") {
    log("ai-worker", "disabled (AI_WORKER_ENABLED != true)");
    return result;
  }
  const aiPrereqs = await verifyAiPrereqs();
  if (!aiPrereqs.ok) {
    logFail("sequence", `AI worker prerequisites failed (${aiPrereqs.reason})`);
    return result;
  }
  startAiWorker();
  result.aiWorker = true;
  log("ai-worker", "started");

  return result;
}
