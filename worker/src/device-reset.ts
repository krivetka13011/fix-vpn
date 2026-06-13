import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import {
  clearVpnDeviceBindings,
  getSubscription,
  patchSubscription,
} from "./repository";
import { clearDeviceSwapState } from "./subscription-rotate";
import { XuiApi } from "./xui";

export const DEVICE_RESET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function deviceResetCooldownRemaining(
  lastReset: string | null | undefined
): number {
  if (!lastReset) return 0;
  const elapsed = Date.now() - new Date(lastReset).getTime();
  return Math.max(0, DEVICE_RESET_COOLDOWN_MS - elapsed);
}

export function formatDeviceResetCooldown(remainingMs: number): string {
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} ч ${minutes} мин`;
  if (hours > 0) return `${hours} ч`;
  return `${minutes} мин`;
}

export class DeviceResetCooldownError extends Error {
  readonly remainingMs: number;

  constructor(remainingMs: number) {
    super(
      `Вы уже сбрасывали привязку устройств недавно. Следующий сброс будет доступен через ${formatDeviceResetCooldown(remainingMs)}.`
    );
    this.name = "DeviceResetCooldownError";
    this.remainingMs = remainingMs;
  }
}

export const DEVICE_RESET_SUCCESS_NOTICE =
  "Привязка устройств успешно сброшена! Теперь вы можете подключить новый телефон. Обратите внимание: следующий сброс будет доступен ровно через 24 часа.";

export async function resetPanelDeviceBinding(
  env: BotEnv,
  userId: string,
  options?: { bypassCooldown?: boolean; telegramId?: number; isTester?: boolean }
): Promise<void> {
  const sub = await getSubscription(env, userId);
  if (!sub?.client_email?.trim()) {
    throw new Error("Нет активного клиента в панели");
  }

  const bypass =
    options?.bypassCooldown ||
    (options?.telegramId != null &&
      isTesterAccount(env, options.telegramId, options.isTester));

  const remaining = deviceResetCooldownRemaining(sub.last_device_reset);
  if (!bypass && remaining > 0) {
    throw new DeviceResetCooldownError(remaining);
  }

  const xui = new XuiApi(env);
  await xui.clearClientIps(sub.client_email.trim());

  await clearVpnDeviceBindings(env, userId);
  await clearDeviceSwapState(env, userId);
  await patchSubscription(env, userId, {
    last_device_reset: new Date().toISOString(),
    panel_ip_clear_requested_at: null,
  });
}
