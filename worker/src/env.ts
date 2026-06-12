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
  SUBSCRIPTION_PATH?: string;
  VPN_SERVER_HOST?: string;
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

export function subscriptionBaseUrl(env: BotEnv): string {
  const raw = env.SUBSCRIPTION_BASE_URL?.trim();
  if (!raw) return "";
  return normalizeWorkerFetchUrl(raw.replace(/\/$/, ""), env);
}
