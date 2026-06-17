import type { BotEnv } from "./env";
import type { DbSubscription } from "./types";
import { deviceSlotDisplayName } from "./panel-client-label";
import { getSubscription } from "./repository";
import type { PanelDeviceIp } from "./xui";
import { XuiApi } from "./xui";

/** Лимит одновременных IP в панели (limitIp). 0 = без лимита. */
export function subscriptionDeviceLimit(
  sub: Pick<DbSubscription, "plan_type" | "extra_devices"> | null | undefined
): number {
  if (!sub) return 1;
  if (sub.plan_type === "personal") return 0;
  return 1 + Number(sub.extra_devices || 0);
}

export function panelLimitIpForSubscription(
  sub: Pick<DbSubscription, "plan_type" | "extra_devices"> | null | undefined
): number {
  const limit = subscriptionDeviceLimit(sub);
  return limit === 0 ? 0 : limit;
}

export function formatDeviceLimitLine(
  used: number,
  limit: number,
  planType?: string | null
): string {
  if (planType === "personal" || limit === 0) {
    return `Устройства: ${used} / ∞`;
  }
  return `Устройства: ${Math.min(used, limit)} / ${limit}`;
}

export function formatConnectedDevices(
  ips: PanelDeviceIp[],
  username: string | null | undefined,
  telegramId: number
): string {
  if (!ips.length) return "";
  const lines = ips
    .slice(0, 10)
    .map((_, index) => `• ${deviceSlotDisplayName(username, telegramId, index + 1)}`);
  return `\n\nПодключённые устройства:\n${lines.join("\n")}`;
}

export async function countUsedDeviceSlots(
  env: BotEnv,
  telegramId: number
): Promise<number> {
  const ips = await fetchPanelDeviceIps(env, telegramId);
  return ips.length;
}

export async function canConnectNewDevice(
  env: BotEnv,
  userId: string,
  telegramId: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  const sub = await getSubscription(env, userId);
  if (!sub || sub.status !== "active") {
    return { ok: false, message: "Сначала активируйте пробный период или оформите подписку." };
  }
  if (sub.is_trial) {
    return { ok: true };
  }
  const limit = subscriptionDeviceLimit(sub);
  if (limit === 0) return { ok: true };
  const used = await countUsedDeviceSlots(env, telegramId);
  if (used >= limit) {
    return {
      ok: false,
      message:
        `Все слоты заняты (<b>${used}/${limit}</b>).\n\n` +
        `Сбросьте подключение в профиле (раз в 24 ч) или докупите устройства.`,
    };
  }
  return { ok: true };
}

export async function syncPanelDeviceLimit(
  env: BotEnv,
  userId: string
): Promise<void> {
  const sub = await getSubscription(env, userId);
  const telegramId = Number(sub?.client_email);
  if (!Number.isFinite(telegramId) || telegramId <= 0) return;

  const limitIp = panelLimitIpForSubscription(sub);
  try {
    const xui = new XuiApi(env);
    const panelEmail = await xui.resolvePanelEmail(telegramId);
    if (!panelEmail) return;
    await xui.setClientLimitIp(panelEmail, limitIp);
  } catch (error) {
    console.error("syncPanelDeviceLimit:", error);
  }
}

export async function fetchPanelDeviceIps(
  env: BotEnv,
  telegramId: number
): Promise<PanelDeviceIp[]> {
  if (!Number.isFinite(telegramId) || telegramId <= 0) return [];
  try {
    const xui = new XuiApi(env);
    const panelEmail = await xui.resolvePanelEmail(telegramId);
    if (!panelEmail) return [];
    return await xui.getClientIps(panelEmail);
  } catch {
    return [];
  }
}

export function telegramIdFromClientEmail(
  clientEmail: string | null | undefined
): number | null {
  const raw = clientEmail?.trim();
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}
