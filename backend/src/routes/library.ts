import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { getDefaultStationId } from "../services/broadcast.js";
import { recordAuditEvent } from "../services/audit.js";

export const libraryRouter = Router();

libraryRouter.get("/", requirePermission("library.read"), async (req, res) => {
  const stationId = typeof req.query.stationId === "string" ? req.query.stationId : await getDefaultStationId();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const { rows } = await pool.query(
    `SELECT id, station_id, title, artist, album, genre, duration_ms, mime_type, storage_key,
            storage_provider, file_size_bytes, cover_art_key, status, metadata, created_at, updated_at
     FROM media_assets WHERE station_id=$1 AND status <> 'archived'
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [stationId, limit, offset]
  );
  res.json({ assets: rows, pagination: { limit, offset } });
});

libraryRouter.post("/", requirePermission("library.upload"), async (req, res) => {
  const body = z.object({
    stationId: z.string().uuid().optional(), title: z.string().trim().min(1).max(200), artist: z.string().trim().max(200).optional(),
    album: z.string().trim().max(200).optional(), genre: z.string().trim().max(100).optional(), durationMs: z.number().int().positive(),
    mimeType: z.enum(["audio/mpeg","audio/wav","audio/ogg","audio/flac","audio/aac","audio/mp4"]),
    storageKey: z.string().trim().min(1).max(500), storageProvider: z.string().trim().min(1).max(50).default("local"),
    fileSizeBytes: z.number().int().nonnegative().optional(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(), coverArtKey: z.string().max(500).optional(), metadata: z.record(z.unknown()).default({})
  }).parse(req.body);
  const stationId = body.stationId ?? await getDefaultStationId();
  const { rows } = await pool.query(
    `INSERT INTO media_assets (station_id,title,artist,album,genre,duration_ms,mime_type,storage_key,storage_provider,file_size_bytes,sha256,cover_art_key,metadata,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`, [stationId,body.title,body.artist??null,body.album??null,body.genre??null,body.durationMs,body.mimeType,body.storageKey,body.storageProvider,body.fileSizeBytes??null,body.sha256??null,body.coverArtKey??null,body.metadata,req.session.userId]
  );
  await recordAuditEvent({ actorId:req.session.userId??null, action:"MEDIA_ASSET_CREATED", resourceType:"media_asset", resourceId:rows[0].id, afterState:{title:body.title,stationId}, correlationId:req.id });
  res.status(201).json({ asset: rows[0] });
});
