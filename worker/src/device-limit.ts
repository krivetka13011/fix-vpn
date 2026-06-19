import type { BotEnv } from "./env";
import type { DbSubscription } from "./types";
import { deviceSlotDisplayName } from "./panel-client-label";
import { getSubscription, listVpnDeviceBindings } from "./repository";
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
  telegramId: number,
  userId?: string
): Promise<number> {
  if (!Number.isFinite(telegramId) || telegramId <= 0) return 0;

  if (userId) {
    const bindings = await listVpnDeviceBindings(env, userId);
    if (bindings.length > 0) return bindings.length;
  }

  let used = 0;
  try {
    const xui = new XuiApi(env);
    const panelEmail = await xui.resolvePanelEmail(telegramId);
    if (panelEmail) {
      try {
        const ips = await xui.getClientIps(panelEmail);
        used = ips.length;
      } catch {
        used = 0;
      }
      if (used === 0) {
        try {
          const onlines = await xui.getOnlineClientEmails();
          if (onlines.some((entry) => entry === panelEmail)) used = 1;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    used = 0;
  }

  return used;
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
  const limit = subscriptionDeviceLimit(sub);
  if (limit === 0) return { ok: true };
  const used = await countUsedDeviceSlots(env, telegramId, userId);
  if (used >= limit) {
    return {
      ok: false,
      message:
        `Все ${used} устройств заняты (<b>${used}/${limit}</b>).\n\n` +
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
