import { createClient, RedisClientType } from "redis";

let redis: RedisClientType | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (!redis) {
    redis = createClient({
      url: process.env.REDIS_URL,
    });

    redis.on("error", (err) => console.error("Redis Client Error", err));

    await redis.connect();
  }

  return redis;
}

// Session caching constants
const SESSION_TTL_SECONDS = 300; // 5 minutes

export interface CachedSession {
  accountId: string;
  json: string;
}

export async function getCachedSession(tokenHash: string): Promise<CachedSession | null> {
  const redis = await getRedis();
  const data = await redis.hGetAll(`session:${tokenHash}`);
  if (!data.accountId || !data.json) return null;
  return { accountId: data.accountId, json: data.json };
}

export async function setCachedSession(tokenHash: string, session: CachedSession): Promise<void> {
  const redis = await getRedis();
  const key = `session:${tokenHash}`;
  await redis.hSet(key, {
    accountId: session.accountId,
    json: session.json,
  });
  await redis.expire(key, SESSION_TTL_SECONDS);
}
