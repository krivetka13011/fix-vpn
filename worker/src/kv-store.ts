import type { StorageEnv } from "./storage-env";

const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
const RATE_LIMIT_TTL_SEC = 120;
const SUB_CACHE_TTL_SEC = 60 * 60 * 6;

export interface BotSessionRow {
  telegram_id: number;
  bot_kind: string;
  state: string;
  payload: Record<string, unknown>;
  updated_at: string;
}

function sessionKey(telegramId: number, botKind: string): string {
  return `session:${botKind}:${telegramId}`;
}

function rateKey(telegramId: number, action: string): string {
  return `rate:${telegramId}:${action}`;
}

function subCacheKey(userId: string): string {
  return `subcache:${userId}`;
}

function subStatusCacheKey(userId: string): string {
  return `substatus:${userId}`;
}

export async function kvGetSession(
  env: StorageEnv,
  telegramId: number,
  botKind: "client" | "partner"
): Promise<BotSessionRow | null> {
  const raw = await env.KV.get(sessionKey(telegramId, botKind));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BotSessionRow;
  } catch {
    return null;
  }
}

export async function kvSetSession(
  env: StorageEnv,
  telegramId: number,
  botKind: "client" | "partner",
  state: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const row: BotSessionRow = {
    telegram_id: telegramId,
    bot_kind: botKind,
    state,
    payload,
    updated_at: new Date().toISOString(),
  };
  await env.KV.put(sessionKey(telegramId, botKind), JSON.stringify(row), {
    expirationTtl: SESSION_TTL_SEC,
  });
}

export async function kvClearSession(
  env: StorageEnv,
  telegramId: number,
  botKind: "client" | "partner"
): Promise<void> {
  await kvSetSession(env, telegramId, botKind, "idle", {});
}

/** false = rate limited (too fast). */
export async function kvCheckRateLimit(
  env: StorageEnv,
  telegramId: number,
  action: string,
  windowMs = 1500
): Promise<boolean> {
  const key = rateKey(telegramId, action);
  const existing = await env.KV.get(key);
  if (existing) {
    const ts = Number(existing);
    if (Number.isFinite(ts) && Date.now() - ts < windowMs) return false;
  }
  await env.KV.put(key, String(Date.now()), {
    expirationTtl: Math.max(60, RATE_LIMIT_TTL_SEC),
  });
  return true;
}

export async function kvGetSubscriptionPayloadCache(
  env: StorageEnv,
  userId: string
): Promise<string | null> {
  return env.KV.get(subCacheKey(userId));
}

export async function kvSetSubscriptionPayloadCache(
  env: StorageEnv,
  userId: string,
  body: string
): Promise<void> {
  await env.KV.put(subCacheKey(userId), body, { expirationTtl: SUB_CACHE_TTL_SEC });
}

export async function kvClearSubscriptionPayloadCache(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await env.KV.delete(subCacheKey(userId));
}

export interface SubscriptionStatusCache {
  status: string;
  is_trial: boolean;
  expires_at: string | null;
  cached_at: string;
}

export async function kvGetSubscriptionStatusCache(
  env: StorageEnv,
  userId: string
): Promise<SubscriptionStatusCache | null> {
  const raw = await env.KV.get(subStatusCacheKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SubscriptionStatusCache;
  } catch {
    return null;
  }
}

export async function kvSetSubscriptionStatusCache(
  env: StorageEnv,
  userId: string,
  data: Omit<SubscriptionStatusCache, "cached_at">
): Promise<void> {
  const payload: SubscriptionStatusCache = {
    ...data,
    cached_at: new Date().toISOString(),
  };
  await env.KV.put(subStatusCacheKey(userId), JSON.stringify(payload), {
    expirationTtl: 300,
  });
}

export async function kvClearSubscriptionStatusCache(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await env.KV.delete(subStatusCacheKey(userId));
}
