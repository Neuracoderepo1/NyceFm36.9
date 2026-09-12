import { createClient, type RedisClientType } from "redis";

const CHANNEL_PREFIX = "nycefm:broadcast:";

let publisher: RedisClientType | null = null;

async function getPublisher(): Promise<RedisClientType> {
  if (!publisher) {
    publisher = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
    await publisher.connect();
  }
  return publisher;
}

export async function publishBroadcastEvent(stationId: string, payload: unknown): Promise<void> {
  const pub = await getPublisher();
  await pub.publish(CHANNEL_PREFIX + stationId, JSON.stringify(payload));
}

/** Returns a dedicated subscriber client already subscribed to the station's channel. */
export async function subscribeBroadcastEvents(
  stationId: string,
  onMessage: (payload: unknown) => void
): Promise<() => Promise<void>> {
  const sub: RedisClientType = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
  await sub.connect();
  await sub.subscribe(CHANNEL_PREFIX + stationId, (message) => {
    try {
      onMessage(JSON.parse(message));
    } catch {
      onMessage(message);
    }
  });
  return async () => {
    await sub.unsubscribe(CHANNEL_PREFIX + stationId);
    await sub.quit();
  };
}
