import { Queue, Worker, type Job } from "bullmq";
import { pool } from "../../db/pool.js";
import { extractAudioMetadata } from "../../services/audioMetadata.js";
import { getStorage } from "../storage/index.js";
import { recordAuditEvent } from "../../services/audit.js";

const connection = {
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
};

export interface MediaProcessingJobData {
  trackId: string;
  mediaAssetId: string;
  storageKey: string;
  mimeType: string;
}

export const mediaProcessingQueue = new Queue<MediaProcessingJobData>("media-processing", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});

export function startMediaProcessingWorker(): Worker<MediaProcessingJobData> {
  return new Worker<MediaProcessingJobData>(
    "media-processing",
    async (job: Job<MediaProcessingJobData>) => {
      const { trackId, storageKey, mimeType } = job.data;

      await pool.query("UPDATE tracks SET status = 'processing', updated_at = now() WHERE id = $1", [
        trackId,
      ]);

      try {
        const storage = getStorage();
        const buffer = await storage.get(storageKey);
        const meta = await extractAudioMetadata(buffer, mimeType);

        if (!meta.durationSeconds || meta.durationSeconds <= 0) {
          throw new Error("Could not determine a valid audio duration from the file.");
        }

        await pool.query(
          `UPDATE tracks
           SET status = 'ready', duration_seconds = $1, bitrate_kbps = $2,
               sample_rate_hz = $3, format = $4, processing_error = NULL, updated_at = now()
           WHERE id = $5`,
          [meta.durationSeconds, meta.bitrateKbps, meta.sampleRateHz, meta.format, trackId]
        );

        await recordAuditEvent({
          actorId: null,
          action: "TRACK_PROCESSED",
          resourceType: "track",
          resourceId: trackId,
          afterState: meta,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await pool.query(
          `UPDATE tracks SET status = 'failed', processing_error = $1, updated_at = now() WHERE id = $2`,
          [message, trackId]
        );
        throw err;
      }
    },
    { connection }
  );
}
