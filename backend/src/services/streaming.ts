import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDefaultStationId } from "./broadcast.js";

const streamRoot = path.resolve(process.env.STREAM_STORAGE_PATH ?? "./storage/streams");
let ffmpeg: ChildProcess | null = null;
let startedAt: Date | null = null;
let lastError: string | null = null;

export async function ensureStreamStorage() { await fs.mkdir(streamRoot, { recursive: true }); }
export function streamDir(stationId: string) { return path.join(streamRoot, stationId); }
export function publicStreamBase(stationId: string) {
  const base = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  return `${base.replace(/\/$/, "")}/streams/hls/${stationId}`;
}

export async function startHlsStream(stationId?: string) {
  stationId = stationId ?? await getDefaultStationId();
  if (ffmpeg && !ffmpeg.killed) return { status: "already_running", stationId, url: `${publicStreamBase(stationId)}/index.m3u8` };
  await ensureStreamStorage();
  const dir = streamDir(stationId);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const input = process.env.STREAM_INPUT_URL;
  if (!input) throw new Error("STREAM_INPUT_URL is not configured; use the broadcast worker to generate HLS from the queue.");
  ffmpeg = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-i", input, "-vn", "-c:a", "aac", "-b:a", process.env.STREAM_AUDIO_BITRATE ?? "128k", "-f", "hls",
    "-hls_time", process.env.HLS_SEGMENT_SECONDS ?? "4", "-hls_list_size", process.env.HLS_LIST_SIZE ?? "8", "-hls_flags", "delete_segments+append_list+independent_segments",
    path.join(dir, "index.m3u8")
  ]);
  startedAt = new Date(); lastError = null;
  ffmpeg.stderr?.on("data", d => { lastError = String(d).trim().slice(-1000); });
  ffmpeg.on("exit", (code) => { if (code !== 0) lastError = `ffmpeg exited with code ${code}`; ffmpeg = null; });
  return { status: "started", stationId, url: `${publicStreamBase(stationId)}/index.m3u8` };
}

export function streamStatus(stationId: string) {
  return { stationId, running: !!ffmpeg && !ffmpeg.killed, startedAt, lastError, hlsUrl: `${publicStreamBase(stationId)}/index.m3u8` };
}

export async function stopHlsStream() {
  if (!ffmpeg) return false;
  ffmpeg.kill("SIGTERM"); ffmpeg = null; return true;
}
