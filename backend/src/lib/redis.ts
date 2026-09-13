import { createClient, type RedisClientType } from "redis";
import "dotenv/config";

let client: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
    client.on("error", (err) => console.error("Redis client error", err));
    await client.connect();
  }
  return client;
}

/** Gracefully closes the shared Redis client, if one was ever created. Safe to call more than once. */
export async function closeRedisClient(): Promise<void> {
  if (client && client.isOpen) {
    await client.quit();
  }
  client = null;
}
