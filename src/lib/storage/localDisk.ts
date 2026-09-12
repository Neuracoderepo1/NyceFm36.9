import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256, type ObjectStorage, type StoredObject } from "./types.js";

/**
 * Local filesystem storage. Suitable for development and single-box
 * deployments. Swap for an S3Storage implementing the same ObjectStorage
 * interface for production — nothing calling ObjectStorage needs to change.
 */
export class LocalDiskStorage implements ObjectStorage {
  readonly providerName = "local";

  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    const resolved = path.resolve(this.rootDir, key);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error("Path traversal attempt detected in storage key.");
    }
    return resolved;
  }

  async put(key: string, data: Buffer): Promise<StoredObject> {
    const filePath = this.resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return {
      provider: this.providerName,
      key,
      sizeBytes: data.length,
      checksumSha256: sha256(data),
    };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
