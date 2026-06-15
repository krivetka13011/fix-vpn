import type { SupabaseEnv } from "./supabase";

export interface BotEnv extends SupabaseEnv {
  WEBAPP_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  CLIENT_BOT_TOKEN?: string;
  PARTNER_BOT_TOKEN?: string;
  CLIENT_BOT_USERNAME?: string;
  PARTNER_BOT_USERNAME?: string;
  MANAGER_TELEGRAM_IDS?: string;
  MANAGER_NOTIFICATION_CHAT_ID?: string;
  ADMIN_TELEGRAM_IDS?: string;
  SUPPORT_TELEGRAM_USERNAME?: string;
  TELEGRAM_CHANNEL_URL?: string;
  XUI_BASE_URL?: string;
  XUI_API_TOKEN?: string;
  XUI_USERNAME?: string;
  XUI_PASSWORD?: string;
  XUI_INSECURE_SSL?: string;
  XUI_INBOUND_IDS?: string;
  XUI_CLIENT_LIMIT_IP?: string;
  XUI_TRIAL_DAYS?: string;
  SUBSCRIPTION_BASE_URL?: string;
  SUBSCRIPTION_CLIENT_BASE_URL?: string;
  SUBSCRIPTION_WORKER_FETCH_URL?: string;
  SUBSCRIPTION_PATH?: string;
  VPN_SERVER_HOST?: string;
  /** Host in vless/trojan links inside subscription (default: panel IP). */
  VPN_SUBSCRIPTION_HOST?: string;
  /** Happ Provider ID (8 chars) — hide-settings и расширенное управление. */
  HAPP_PROVIDER_ID?: string;
  PARTNER_DEFAULT_COMMISSION_PERCENT?: string;
  BASE_PRICE_RUB_PER_MONTH?: string;
  DISCOUNT_3_MONTHS_PERCENT?: string;
  DISCOUNT_6_MONTHS_PERCENT?: string;
  DISCOUNT_12_MONTHS_PERCENT?: string;
  TRIAL_DAYS?: string;
  MSG_TRIAL_SUCCESS?: string;
  MSG_TRIAL_ALREADY_USED?: string;
  MSG_PAYMENT_PENDING?: string;
  MSG_PARTNER_REGISTERED?: string;
  TESTER_TELEGRAM_IDS?: string;
  XUI_WORKER_BASE_URL?: string;
  PANEL_ORIGIN_IP?: string;
  /** Secret for X-Fix-Vpn-E2E header — enables webhook trace JSON (CI / agent tests). */
  E2E_TRACE_SECRET?: string;
  CARDLINK_API_TOKEN?: string;
  CARDLINK_SHOP_ID?: string;
  /** "1" = клиент платит комиссию Cardlink */
  CARDLINK_PAYER_PAYS_COMMISSION?: string;
  /** "0" = отключить автовыплаты партнёрам через Cardlink */
  CARDLINK_PAYOUT_ENABLED?: string;
  /** ID банка СБП для payout API (см. /api/v1/payout/dictionaries/sbp_banks) */
  CARDLINK_DEFAULT_SBP_BANK_ID?: string;
}

export const XUI_INBOUND_IDS_DEFAULT = [19, 20, 21, 24];

export function clientBotToken(env: BotEnv): string | undefined {
  return env.CLIENT_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
}

export function partnerBotToken(env: BotEnv): string | undefined {
  return env.PARTNER_BOT_TOKEN;
}

export function parseIdList(raw: string | undefined): number[] {
  if (!raw) return XUI_INBOUND_IDS_DEFAULT;
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

export function parseManagerIds(env: BotEnv): number[] {
  const raw = env.MANAGER_TELEGRAM_IDS || env.ADMIN_TELEGRAM_IDS || "";
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

export function parseTesterIds(env: BotEnv): number[] {
  const raw = env.TESTER_TELEGRAM_IDS || "";
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

export function isTesterAccount(
  env: BotEnv,
  telegramId: number,
  userIsTester?: boolean
): boolean {
  if (userIsTester) return true;
  return parseTesterIds(env).includes(telegramId);
}

export function managerChatId(env: BotEnv): number | null {
  const raw = env.MANAGER_NOTIFICATION_CHAT_ID?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const LEGACY_PANEL_IP = "31.76.2.248";
const DEFAULT_VPN_HOST = "fixvp.xyz";
/** Публичный хост подписки — Worker custom domain (HTTPS :443). */
export const SUBSCRIPTION_PUBLIC_HOST_DEFAULT = "sub.fixvp.xyz";
export const WEBAPP_PUBLIC_URL_DEFAULT = "https://app.fixvp.xyz";
export const HAPP_PROVIDER_ID_DEFAULT = "6Azh5Bya";

export function happProviderId(env: BotEnv): string {
  return env.HAPP_PROVIDER_ID?.trim() || HAPP_PROVIDER_ID_DEFAULT;
}

export function subscriptionPublicHost(env: BotEnv): string {
  return env.VPN_SUBSCRIPTION_HOST?.trim() || SUBSCRIPTION_PUBLIC_HOST_DEFAULT;
}

/** Public Mini App / redirect base — never workers.dev in user-facing links. */
export function webappPublicUrl(env: BotEnv): string {
  const raw = (env.WEBAPP_URL || "").replace(/\/$/, "");
  if (!raw || /\.workers\.dev$/i.test(raw)) {
    return WEBAPP_PUBLIC_URL_DEFAULT;
  }
  return raw;
}

export function resolveVpnHost(env: BotEnv): string {
  return env.VPN_SERVER_HOST?.trim() || DEFAULT_VPN_HOST;
}

export function normalizeWorkerFetchUrl(url: string, env: BotEnv): string {
  return url.replaceAll(LEGACY_PANEL_IP, resolveVpnHost(env));
}

export function xuiBaseUrl(env: BotEnv): string {
  const raw = env.XUI_BASE_URL?.trim();
  if (!raw) throw new Error("XUI_BASE_URL missing");
  return normalizeWorkerFetchUrl(raw.replace(/\/$/, ""), env);
}

/** Direct panel API URL for Cloudflare Worker (bypass CF 526 on hostname). */
export function xuiWorkerBaseUrl(env: BotEnv): string {
  const worker = env.XUI_WORKER_BASE_URL?.trim();
  if (worker) return worker.replace(/\/$/, "");
  const raw = env.XUI_BASE_URL?.trim();
  if (!raw) throw new Error("XUI_BASE_URL missing");
  return raw.replace(/\/$/, "");
}

export function xuiBaseUrlCandidates(env: BotEnv): string[] {
  const hostname = xuiBaseUrl(env);
  const direct = xuiWorkerBaseUrl(env);
  return [hostname, direct].filter(
    (base, index, list) => base && list.indexOf(base) === index
  );
}

export function subscriptionBaseUrl(env: BotEnv): string {
  const raw = env.SUBSCRIPTION_BASE_URL?.trim();
  if (!raw) return "";
  return normalizeWorkerFetchUrl(raw.replace(/\/$/, ""), env);
}

/** URL that VPN clients fetch on device (must pass strict TLS on Android/iOS). */
export function subscriptionClientBaseUrl(env: BotEnv): string {
  const raw =
    env.SUBSCRIPTION_CLIENT_BASE_URL?.trim() ||
    env.SUBSCRIPTION_WORKER_FETCH_URL?.trim() ||
    env.SUBSCRIPTION_BASE_URL?.trim() ||
    "";
  if (!raw) return "";
  return raw.replace(/\/$/, "");
}

/** Worker-internal fetch base — hostname; use panelFetch + resolveOverride to reach origin. */
export function workerSubscriptionFetchBase(env: BotEnv): string {
  const hostname =
    subscriptionBaseUrl(env) || subscriptionClientBaseUrl(env) || "";
  if (hostname) return hostname;
  const raw = env.SUBSCRIPTION_WORKER_FETCH_URL?.trim() || "";
  return raw.replace(/\/$/, "");
}
