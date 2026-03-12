import type { KVNamespace } from "@cloudflare/workers-types";

const SESSION_TTL_SECONDS = 300; // 5 minutes

export interface CachedSession {
  accountId: string;
  json: string;
}

let kv: KVNamespace | null = null;

export function setKVBinding(kvBinding: KVNamespace): void {
  kv = kvBinding;
}

export async function getCachedSession(tokenHash: string): Promise<CachedSession | null> {
  if (!kv) return null;
  const data = await kv.get<CachedSession>(`session:${tokenHash}`, "json");
  return data ?? null;
}

export async function setCachedSession(tokenHash: string, session: CachedSession): Promise<void> {
  if (!kv) return;
  await kv.put(`session:${tokenHash}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}
