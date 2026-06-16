import type { BotEnv } from "./env";
import type { DbSubscription } from "./types";
import { getSubscription } from "./repository";
import type { PanelDeviceIp } from "./xui";
import { XuiApi } from "./xui";

/** Лимит одновременных IP в панели (limitIp). */
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
  return subscriptionDeviceLimit(sub);
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
