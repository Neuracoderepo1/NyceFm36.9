import path from "node:path";
import { LocalDiskStorage } from "./localDisk.js";
import type { ObjectStorage } from "./types.js";

let instance: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (instance) return instance;

  const provider = process.env.STORAGE_PROVIDER || "local";

  if (provider === "local") {
    const root = process.env.STORAGE_LOCAL_ROOT || path.resolve(process.cwd(), "data", "media");
    instance = new LocalDiskStorage(root);
    return instance;
  }

  // Phase-2 scope is local disk only. Wire an S3Storage implementing the
  // same ObjectStorage interface here when object storage credentials
  // (STORAGE_BUCKET / STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY) are available.
  throw new Error(
    `Storage provider "${provider}" is not implemented yet. Set STORAGE_PROVIDER=local, or implement an S3Storage adapter.`
  );
}
