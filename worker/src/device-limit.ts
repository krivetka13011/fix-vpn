import type { BotEnv } from "./env";
import type { DbSubscription } from "./types";
import { getSubscription } from "./repository";
import type { PanelDeviceIp } from "./xui";
import { XuiApi } from "./xui";

/** Bot-side device slots (not panel IP). */
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

export type DeviceBindingRow = {
  os: string;
  vpn_client: string;
  label: string;
};

export type DeviceSlotStatus = {
  limit: number;
  panelIps: PanelDeviceIp[];
  bindings: DeviceBindingRow[];
};

export function effectiveDeviceUsage(
  status: Pick<DeviceSlotStatus, "bindings" | "panelIps">
): number {
  return Math.max(status.bindings.length, status.panelIps.length);
}

export function canRegisterDeviceBinding(
  status: DeviceSlotStatus,
  targetOs: string
): boolean {
  if (status.limit === 0) return true;
  if (status.bindings.some((row) => row.os === targetOs)) return true;
  return effectiveDeviceUsage(status) < status.limit;
}

export function isDifferentDeviceAttempt(
  status: DeviceSlotStatus,
  targetOs: string
): boolean {
  return !canRegisterDeviceBinding(status, targetOs);
}

export function deviceOccupiedMessage(
  status: DeviceSlotStatus,
  targetOs?: string
): string {
  const occupiedLines: string[] = [];
  for (const row of status.bindings.slice(0, 2)) {
    occupiedLines.push(`• ${row.label}`);
  }
  for (const row of status.panelIps.slice(0, 2)) {
    const seen = row.seenAt ? ` (${row.seenAt})` : "";
    occupiedLines.push(`• IP ${row.ip}${seen}`);
  }
  const occupied =
    occupiedLines.length > 0 ? occupiedLines.join("\n") : "• другое устройство";

  const replaceNote =
    targetOs && isDifferentDeviceAttempt(status, targetOs)
      ? "\n\nВы подключаете другое устройство — сначала отвяжите текущее."
      : "";

  return (
    `На этом аккаунте уже привязано устройство. Одновременно доступно ${status.limit}.\n\n` +
    `Сейчас занято:\n${occupied}${replaceNote}\n\n` +
    `Чтобы заменить: «Мой профиль» → нажмите устройство или «Сбросить все».`
  );
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
