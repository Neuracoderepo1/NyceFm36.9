import { parseBuffer } from "music-metadata";

export interface ExtractedAudioMetadata {
  durationSeconds: number | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  format: string | null;
}

/**
 * Parses real audio file bytes to get real metadata. Throws if the buffer
 * is not a decodable audio file — this doubles as content validation,
 * since a client-supplied MIME type alone (e.g. multipart Content-Type)
 * can be spoofed but the actual byte stream cannot.
 */
export async function extractAudioMetadata(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractedAudioMetadata> {
  const meta = await parseBuffer(buffer, { mimeType });
  return {
    durationSeconds: meta.format.duration ?? null,
    bitrateKbps: meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null,
    sampleRateHz: meta.format.sampleRate ?? null,
    format: meta.format.container ?? null,
  };
}
