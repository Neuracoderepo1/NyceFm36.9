import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { getStorage } from "../lib/storage/index.js";
import { sha256 } from "../lib/storage/types.js";
import { requirePermission } from "../middleware/rbac.js";
import { mediaProcessingQueue } from "../lib/queue/mediaProcessing.js";
import { recordAuditEvent } from "../services/audit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const libraryRouter = Router();

const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/aac",
  "audio/ogg",
]);
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    // First-pass filter on the client-declared MIME type. This is NOT
    // trusted alone — extractAudioMetadata() later parses real bytes and
    // the track is marked 'failed' if the content isn't decodable audio.
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Unsupported content type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

const uploadMetaSchema = z.object({
  title: z.string().min(1).max(200),
  genre: z.string().max(80).optional(),
  explicit: z.coerce.boolean().optional(),
});

// Multer's fileFilter errors arrive via the middleware's own error-first
// callback path, not a route handler — catch them explicitly so a rejected
// upload (bad content type) returns 400 instead of an unhandled error.
function handleUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      return res.status(400).json({
        error: { code: "UPLOAD_REJECTED", message: err instanceof Error ? err.message : "Upload rejected.", request_id: req.id },
      });
    }
    next();
  });
}

libraryRouter.post(
  "/upload",
  requirePermission("library.upload"),
  handleUpload,
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: { code: "NO_FILE", message: "No file uploaded under field 'file'.", request_id: req.id },
      });
    }
    const parsed = uploadMetaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id },
      });
    }

    const storage = getStorage();
    const key = `tracks/${randomUUID()}-${req.file.originalname}`;
    const stored = await storage.put(key, req.file.buffer);
    const checksum = sha256(req.file.buffer);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const assetRes = await client.query(
        `INSERT INTO media_assets
           (storage_provider, storage_key, original_filename, mime_type, size_bytes, checksum_sha256, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [stored.provider, stored.key, req.file.originalname, req.file.mimetype, stored.sizeBytes, checksum, req.session.userId]
      );
      const mediaAssetId = assetRes.rows[0].id;

      const trackRes = await client.query(
        `INSERT INTO tracks (media_asset_id, title, genre, explicit, status)
         VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
        [mediaAssetId, parsed.data.title, parsed.data.genre ?? null, parsed.data.explicit ?? false]
      );
      const trackId = trackRes.rows[0].id;

      await client.query("COMMIT");

      await mediaProcessingQueue.add("process-track", {
        trackId,
        mediaAssetId,
        storageKey: stored.key,
        mimeType: req.file.mimetype,
      });

      await recordAuditEvent({
        actorId: req.session.userId ?? null,
        action: "TRACK_UPLOADED",
        resourceType: "track",
        resourceId: trackId,
        afterState: { filename: req.file.originalname, sizeBytes: stored.sizeBytes },
        correlationId: req.id,
      });

      res.status(202).json({ trackId, mediaAssetId, status: "pending" });
    } catch (err) {
      await client.query("ROLLBACK");
      await storage.delete(key); // don't leave orphaned files if the DB insert failed
      throw err;
    } finally {
      client.release();
    }
  })
);

libraryRouter.get("/tracks", requirePermission("library.read"), asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, genre, duration_seconds, bitrate_kbps, format, status, processing_error, created_at
     FROM tracks ORDER BY created_at DESC LIMIT 200`
  );
  res.json({ tracks: rows });
}));

libraryRouter.get("/tracks/:id", requirePermission("library.read"), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM tracks WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Track not found.", request_id: req.id } });
  }
  res.json({ track: rows[0] });
}));
