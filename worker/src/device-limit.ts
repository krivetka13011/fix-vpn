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
  if (!sub?.client_email?.trim()) return;
  const limitIp = panelLimitIpForSubscription(sub);
  try {
    const xui = new XuiApi(env);
    await xui.setClientLimitIp(sub.client_email, limitIp);
  } catch (error) {
    console.error("syncPanelDeviceLimit:", error);
  }
}

export async function fetchPanelDeviceIps(
  env: BotEnv,
  clientEmail: string | null | undefined
): Promise<PanelDeviceIp[]> {
  if (!clientEmail?.trim()) return [];
  try {
    return await new XuiApi(env).getClientIps(clientEmail);
  } catch {
    return [];
  }
}
