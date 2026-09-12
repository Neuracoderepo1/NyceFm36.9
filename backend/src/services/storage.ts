import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const root = path.resolve(process.env.MEDIA_STORAGE_PATH ?? "./storage/media");
const maxBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);
const allowed = new Set(["audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4"]);

export function storageRoot() { return root; }

export async function ensureStorage() {
  await fs.mkdir(root, { recursive: true });
}

export function validateAudioMime(mime: string) {
  if (!allowed.has(mime)) throw new Error(`Unsupported audio MIME type: ${mime}`);
}

export async function saveAudioStream(input: NodeJS.ReadableStream, mime: string, requestedKey?: string) {
  validateAudioMime(mime);
  await ensureStorage();
  const ext = extensionForMime(mime);
  const safeKey = requestedKey ? sanitizeKey(requestedKey) : `${crypto.randomUUID()}${ext}`;
  if (!safeKey.endsWith(ext)) throw new Error("Storage key extension does not match MIME type");
  const absolute = safeResolve(safeKey);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.uploading-${crypto.randomUUID()}`;
  const hash = createHash("sha256");
  let bytes = 0;
  const limiter = async function* () {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`Upload exceeds MAX_UPLOAD_BYTES (${maxBytes})`);
      hash.update(chunk);
      yield chunk;
    }
  };
  try {
    await pipeline(limiter(), (await import("node:fs")).createWriteStream(tmp));
    await fs.rename(tmp, absolute);
    return { key: safeKey, bytes, sha256: hash.digest("hex"), absolutePath: absolute };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function resolveStorageKey(key: string) { return safeResolve(sanitizeKey(key)); }
export function createReadStreamForKey(key: string) { return createReadStream(resolveStorageKey(key)); }

function safeResolve(key: string) {
  const absolute = path.resolve(root, key);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Invalid storage key");
  return absolute;
}
function sanitizeKey(key: string) {
  const normalized = path.posix.normalize(key.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) throw new Error("Invalid storage key");
  return normalized;
}
function extensionForMime(mime: string) {
  return ({"audio/mpeg":".mp3","audio/wav":".wav","audio/ogg":".ogg","audio/flac":".flac","audio/aac":".aac","audio/mp4":".m4a"} as Record<string,string>)[mime] ?? ".audio";
}
