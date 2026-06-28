import { d1First, d1Run } from "./d1-db";
import type { StorageEnv } from "./storage-env";

/**
 * Привязка устройства по HWID (Happ / v2RayTun / V2Box).
 *
 * Hiddify и v2rayNG не отправляют X-HWID — для них остаётся IP-лимит панели.
 *
 * Хранение: D1 (таблица hwid_bindings). Раньше использовался KV, но его
 * eventual consistency (edge-кэш ~60с+) ломала механику: после сброса привязки
 * edge-ноды продолжали отдавать старое значение, и новое устройство не могло
 * подключиться несколько минут. D1 даёт строгую консистентность — всегда
 * актуальные данные.
 */

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

interface HwidBindingRow {
  hwid: unknown;
  os: unknown;
  model: unknown;
  app_version: unknown;
  vpn_client: unknown;
  bound_at: unknown;
  last_seen_at: unknown;
  [key: string]: unknown;
}

function mapRow(row: HwidBindingRow): HwidBinding {
  return {
    hwid: String(row.hwid),
    os: row.os != null ? String(row.os) : "",
    model: row.model != null ? String(row.model) : "",
    appVersion: row.app_version != null ? String(row.app_version) : "",
    vpnClient: row.vpn_client != null ? String(row.vpn_client) : "",
    boundAt: String(row.bound_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

export async function getHwidBinding(
  env: StorageEnv,
  userId: string
): Promise<HwidBinding | null> {
  const row = await d1First<HwidBindingRow>(
    env.DB,
    "SELECT hwid, os, model, app_version, vpn_client, bound_at, last_seen_at FROM hwid_bindings WHERE user_id = ? LIMIT 1",
    userId
  );
  return row ? mapRow(row) : null;
}

export async function setHwidBinding(
  env: StorageEnv,
  userId: string,
  data: Omit<HwidBinding, "boundAt" | "lastSeenAt">
): Promise<void> {
  // INSERT OR REPLACE — если привязка уже есть (маловероятно, т.к. вызывающий
  // проверил getHwidBinding === null), обновляем; иначе создаём.
  await d1Run(
    env.DB,
    `INSERT INTO hwid_bindings (user_id, hwid, os, model, app_version, vpn_client, bound_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       hwid = excluded.hwid,
       os = excluded.os,
       model = excluded.model,
       app_version = excluded.app_version,
       vpn_client = excluded.vpn_client,
       bound_at = datetime('now'),
       last_seen_at = datetime('now')`,
    userId,
    data.hwid,
    data.os,
    data.model,
    data.appVersion,
    data.vpnClient
  );
}

export async function touchHwidBinding(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await d1Run(
    env.DB,
    "UPDATE hwid_bindings SET last_seen_at = datetime('now') WHERE user_id = ?",
    userId
  );
}

export async function clearHwidBinding(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await d1Run(env.DB, "DELETE FROM hwid_bindings WHERE user_id = ?", userId);
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
