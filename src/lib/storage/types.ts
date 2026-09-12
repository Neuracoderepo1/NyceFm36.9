import { createHash } from "node:crypto";

export interface StoredObject {
  provider: string;
  key: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface ObjectStorage {
  readonly providerName: string;
  put(key: string, data: Buffer): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
