import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";

export type StorageProvider = "local" | "supabase";

const provider = (process.env.MEDIA_STORAGE_PROVIDER ?? (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "local")) as StorageProvider;
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "nycefm-media";

function requireSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase object storage is not configured");
  return { url: url.replace(/\/$/, ""), key };
}

export function configuredStorageProvider(): StorageProvider { return provider; }

export async function ensureObjectStorage() {
  if (provider !== "supabase") return;
  const { url, key } = requireSupabase();
  const response = await fetch(`${url}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  });
  if (response.ok) return;
  if (response.status !== 404) throw new Error(`Supabase storage bucket check failed (${response.status})`);
  const create = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024) }),
  });
  if (!create.ok && create.status !== 409) throw new Error(`Supabase storage bucket creation failed (${create.status})`);
}

export async function uploadLocalFileToObjectStorage(localPath: string, key: string, contentType: string) {
  if (provider !== "supabase") return;
  const { url, key: secret } = requireSupabase();
  const body = createReadStream(localPath);
  const response = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, apikey: secret, "Content-Type": contentType, "x-upsert": "false" },
    body: body as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) throw new Error(`Supabase storage upload failed (${response.status}): ${await response.text()}`);
}

export async function createObjectSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
  if (provider !== "supabase") throw new Error("Signed URLs are only available for Supabase object storage");
  const { url, key: secret } = requireSupabase();
  const response = await fetch(`${url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, apikey: secret, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) throw new Error(`Supabase signed URL creation failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { signedURL?: string };
  if (!payload.signedURL) throw new Error("Supabase signed URL response did not include signedURL");
  return payload.signedURL.startsWith("http") ? payload.signedURL : `${url}/storage/v1${payload.signedURL}`;
}

export async function deleteObject(key: string) {
  if (provider !== "supabase") return;
  const { url, key: secret } = requireSupabase();
  const response = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${secret}`, apikey: secret },
  });
  if (!response.ok && response.status !== 404) throw new Error(`Supabase storage delete failed (${response.status})`);
}

export async function removeLocalFile(localPath: string) { await fs.rm(localPath, { force: true }); }
