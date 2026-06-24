import type { StorageEnv } from "./storage-env";

/**
 * Привязка устройства по HWID (Happ / v2RayTun / V2Box).
 *
 * Hiddify и v2rayNG не отправляют X-HWID — для них остаётся IP-лимит панели.
 *
 * Хранение: Workers KV. Ключ `hwid:{userId}` → JSON с HWID первого устройства.
 * KV выбран намеренно: ноль миграций D1, мгновенный деплой.
 */

const KEY_PREFIX = "hwid:";
const HWID_TTL_SEC = 60 * 60 * 24 * 365; // 1 год — привязка живёт, пока юзер не сбросит

export interface HwidBinding {
  /** Сам HWID или синтетический ID (из User-Agent), который присылает устройство. */
  hwid: string;
  /** ОС устройства (android/ios/windows/...), из заголовков. */
  os: string;
  /** Модель устройства, из заголовков (для отладки/поддержки). */
  model: string;
  /** Версия VPN-клиента (Happ/v2RayTun), из заголовков. */
  appVersion: string;
  /** Имя VPN-клиента, определённое по User-Agent. */
  vpnClient: string;
  boundAt: string;
  lastSeenAt: string;
}

function bindingKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export async function getHwidBinding(
  env: StorageEnv,
  userId: string
): Promise<HwidBinding | null> {
  const raw = await env.KV.get(bindingKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HwidBinding;
  } catch {
    return null;
  }
}

export async function setHwidBinding(
  env: StorageEnv,
  userId: string,
  data: Omit<HwidBinding, "boundAt" | "lastSeenAt">
): Promise<void> {
  const now = new Date().toISOString();
  const binding: HwidBinding = { ...data, boundAt: now, lastSeenAt: now };
  await env.KV.put(bindingKey(userId), JSON.stringify(binding), {
    expirationTtl: HWID_TTL_SEC,
  });
}

export async function touchHwidBinding(
  env: StorageEnv,
  userId: string
): Promise<void> {
  const existing = await getHwidBinding(env, userId);
  if (!existing) return;
  existing.lastSeenAt = new Date().toISOString();
  await env.KV.put(bindingKey(userId), JSON.stringify(existing), {
    expirationTtl: HWID_TTL_SEC,
  });
}

export async function clearHwidBinding(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await env.KV.delete(bindingKey(userId));
}

/**
 * Определяет VPN-клиент по User-Agent (для логов и как fallback).
 * Happ, v2RayTun, V2Box имеют характерные подстроки в UA.
 */
export function detectVpnClient(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes("happ")) return "happ";
  if (ua.includes("v2raytun")) return "v2raytun";
  if (ua.includes("v2box")) return "v2box";
  if (ua.includes("hiddify")) return "hiddify";
  if (ua.includes("v2rayng")) return "v2rayng";
  if (ua.includes("v2rayn")) return "v2rayn";
  if (ua.includes("streisand")) return "streisand";
  return "unknown";
}

/** true, если клиент умеет присылать HWID (значит, к нему применима защита). */
export function isHwidCapableClient(vpnClient: string): boolean {
  return vpnClient === "happ" || vpnClient === "v2raytun" || vpnClient === "v2box";
}

function readHeader(request: Request, name: string): string {
  // HTTP-заголовки case-insensitive, но Cloudflare нормализует — берём напрямую.
  return (request.headers.get(name) || "").trim();
}

export interface ExtractedHwid {
  hwid: string;
  os: string;
  model: string;
  appVersion: string;
  vpnClient: string;
}

/**
 * Извлекает HWID из запроса подписки.
 *
 * Приоритет источников:
 *  1. Заголовок `X-HWID` (шлют Happ / v2RayTun / V2Box).
 *  2. (fallback) Синтетический HWID из User-Agent + модели — для случаев,
 *     когда клиент шлёт device-модель, но не X-HWID. Это слабее, но лучше чем ничего.
 *
 * Возвращает null, если HWID определить не удалось (например, Hiddify/v2rayNG).
 */
export function extractHwidFromRequest(request: Request): ExtractedHwid | null {
  const userAgent = readHeader(request, "User-Agent");
  const vpnClient = detectVpnClient(userAgent);

  const explicitHwid = readHeader(request, "X-HWID");
  const os = readHeader(request, "X-Device-OS");
  const model = readHeader(request, "X-Device-Model");
  const appVersion =
    readHeader(request, "X-App-Version") ||
    readHeader(request, "X-Ver-OS");

  if (explicitHwid) {
    return { hwid: explicitHwid, os, model, appVersion, vpnClient };
  }

  // Fallback: синтетический HWID только для HWID-capable клиентов.
  // У Happ/v2RayTun X-HWID обычно есть, но если версия старая — соберём из модели.
  if (isHwidCapableClient(vpnClient) && model) {
    return { hwid: `ua:${vpnClient}:${model}`, os, model, appVersion, vpnClient };
  }

  return null;
}
