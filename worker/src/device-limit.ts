import type { BotEnv } from "./env";
import type { DbSubscription } from "./types";
import { debugSessionLog } from "./debug-session-log";
import { deviceSlotDisplayName } from "./panel-client-label";
import { getSubscription, getUserById } from "./repository";
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

export async function resolvePanelEmailForUser(
  env: BotEnv,
  telegramId: number,
  userId?: string
): Promise<string | null> {
  const xui = new XuiApi(env);
  if (userId) {
    const sub = await getSubscription(env, userId);
    const dbEmail = sub?.client_email?.trim();
    if (dbEmail) {
      const byDbEmail = await xui.findClientByEmail(dbEmail);
      if (byDbEmail?.email) return byDbEmail.email;
    }
  }
  return xui.resolvePanelEmail(telegramId);
}

export async function countUsedDeviceSlots(
  env: BotEnv,
  telegramId: number,
  userId?: string
): Promise<number> {
  if (!Number.isFinite(telegramId) || telegramId <= 0) return 0;

  try {
    const xui = new XuiApi(env);
    const panelEmail = await resolvePanelEmailForUser(env, telegramId, userId);
    if (!panelEmail) {
      // #region agent log
      debugSessionLog(
        "device-limit.ts:countUsedDeviceSlots",
        "no panel email — slots free",
        { telegramId, used: 0, source: "no-email" },
        "F"
      );
      // #endregion
      return 0;
    }

    try {
      const ips = await xui.getClientIps(panelEmail);
      const used = ips.length;
      // #region agent log
      debugSessionLog(
        "device-limit.ts:countUsedDeviceSlots",
        "panel ip slot count",
        { telegramId, panelEmail, used, source: "ips" },
        "F"
      );
      // #endregion
      // limitIp tracks bound IPs; empty IPs = free slot even if VPN still online
      return used;
    } catch {
      // fall through to online fallback only when IPs API fails
    }

    try {
      const onlines = await xui.getOnlineClientEmails();
      const used = onlines.includes(panelEmail) ? 1 : 0;
      // #region agent log
      debugSessionLog(
        "device-limit.ts:countUsedDeviceSlots",
        "panel online slot count",
        { telegramId, panelEmail, used, source: "onlines" },
        "F"
      );
      // #endregion
      return used;
    } catch {
      // #region agent log
      debugSessionLog(
        "device-limit.ts:countUsedDeviceSlots",
        "panel unreachable — slots free",
        { telegramId, used: 0, source: "unreachable" },
        "F"
      );
      // #endregion
      return 0;
    }
  } catch {
    // #region agent log
    debugSessionLog(
      "device-limit.ts:countUsedDeviceSlots",
      "panel lookup failed — slots free",
      { telegramId, used: 0, source: "error" },
      "F"
    );
    // #endregion
    return 0;
  }
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
  const user = await getUserById(env, userId);
  const telegramId =
    telegramIdFromClientEmail(sub?.client_email) ?? user?.telegram_id ?? 0;
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
  telegramId: number,
  userId?: string
): Promise<PanelDeviceIp[]> {
  if (!Number.isFinite(telegramId) || telegramId <= 0) return [];
  try {
    const xui = new XuiApi(env);
    const panelEmail = await resolvePanelEmailForUser(env, telegramId, userId);
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
