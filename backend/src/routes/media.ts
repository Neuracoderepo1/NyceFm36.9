import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { getDefaultStationId } from "../services/broadcast.js";
import { recordAuditEvent } from "../services/audit.js";
import { saveAudioStream } from "../services/storage.js";
import { configuredStorageProvider, uploadLocalFileToObjectStorage, removeLocalFile } from "../services/objectStorage.js";

export const mediaRouter = Router();

mediaRouter.post("/upload", requirePermission("library.upload"), async (req,res) => {
  const meta = z.object({ title:z.string().trim().min(1).max(200), artist:z.string().trim().max(200).optional(), album:z.string().trim().max(200).optional(), genre:z.string().trim().max(100).optional(), mimeType:z.enum(["audio/mpeg","audio/wav","audio/ogg","audio/flac","audio/aac","audio/mp4"]), stationId:z.string().uuid().optional(), storageKey:z.string().trim().max(500).optional() }).parse({ title:req.header("x-media-title"),artist:req.header("x-media-artist")||undefined,album:req.header("x-media-album")||undefined,genre:req.header("x-media-genre")||undefined,mimeType:req.header("content-type"),stationId:req.header("x-station-id")||undefined,storageKey:req.header("x-storage-key")||undefined });
  const stationId = meta.stationId ?? await getDefaultStationId();
  const saved = await saveAudioStream(req, meta.mimeType, meta.storageKey);
  const storageProvider = configuredStorageProvider();
  try {
    if (storageProvider === "supabase") await uploadLocalFileToObjectStorage(saved.absolutePath, saved.key, meta.mimeType);
  } catch (err) {
    await removeLocalFile(saved.absolutePath).catch(() => undefined);
    throw err;
  }
  if (storageProvider === "supabase") await removeLocalFile(saved.absolutePath);
  // Duration is authoritative from ffprobe in production. The ingestion worker fills it before readiness.
  const result = await pool.query(`INSERT INTO media_assets(station_id,title,artist,album,genre,duration_ms,mime_type,storage_key,storage_provider,file_size_bytes,sha256,status,created_by) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,'processing',$11) RETURNING *`, [stationId,meta.title,meta.artist??null,meta.album??null,meta.genre??null,meta.mimeType,saved.key,storageProvider,saved.bytes,saved.sha256,req.session.userId]);
  await recordAuditEvent({actorId:req.session.userId??null,action:"MEDIA_UPLOAD_ACCEPTED",resourceType:"media_asset",resourceId:result.rows[0].id,afterState:{stationId,storageKey:saved.key,sha256:saved.sha256,bytes:saved.bytes},correlationId:req.id});
  res.status(202).json({asset:result.rows[0],message:"Upload accepted for media inspection/processing."});
});
