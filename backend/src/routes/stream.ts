import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDefaultStationId } from "../services/broadcast.js";
import { streamDir, streamStatus } from "../services/streaming.js";
import { broadcastWorkerStatus } from "../services/broadcastWorker.js";

export const streamRouter = Router();

streamRouter.get("/status", async (req,res) => {
  const stationId = typeof req.query.stationId === "string" ? req.query.stationId : await getDefaultStationId();
  res.json({ stream: streamStatus(stationId), broadcast: broadcastWorkerStatus() });
});

streamRouter.get("/hls/:stationId/:file", async (req,res) => {
  const stationId = req.params.stationId;
  const file = path.basename(req.params.file);
  if (!/^[A-Za-z0-9_-]+\.(m3u8|ts|m4s)$/.test(file)) return res.status(400).json({error:{code:"INVALID_STREAM_FILE",message:"Invalid stream file."}});
  const target = path.join(streamDir(stationId), file);
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("not file");
    res.setHeader("Cache-Control", file.endsWith(".m3u8") ? "no-store" : "public, max-age=5");
    res.type(file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
    res.sendFile(target);
  } catch { res.status(404).json({error:{code:"STREAM_NOT_READY",message:"Stream segment is not available."}}); }
});

streamRouter.get("/hls/:stationId", (req,res) => res.redirect(`/streams/hls/${req.params.stationId}/index.m3u8`));
