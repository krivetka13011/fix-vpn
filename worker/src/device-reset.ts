import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import {
  clearVpnDeviceBindings,
  clearXuiInboundClients,
  getSubscription,
  patchSubscription,
} from "./repository";
import { clearStuckRotationFlags } from "./subscription-rotate";
import { XuiApi } from "./xui";

export const DEVICE_RESET_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PANEL_DELETE_TRY_TIMEOUT_MS = 8000;

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
      `Вы уже сбрасывали подключение недавно. Следующий сброс будет доступен через ${formatDeviceResetCooldown(remainingMs)}.`
    );
    this.name = "DeviceResetCooldownError";
    this.remainingMs = remainingMs;
  }
}

export const DEVICE_RESET_SUCCESS_NOTICE =
  "Подключение сброшено. Клиент удалён из панели — подключите VPN заново. Следующий сброс — через 24 часа.";

export function deviceResetNotice(): string {
  return DEVICE_RESET_SUCCESS_NOTICE;
}

async function clearPanelClientDbState(env: BotEnv, userId: string): Promise<void> {
  await clearVpnDeviceBindings(env, userId);
  await clearXuiInboundClients(env, userId);
  await patchSubscription(env, userId, {
    client_email: null,
    xray_uuid: null,
    panel_ip_clear_requested_at: null,
    subscription_payload_cache: null,
  });
}

/** Удаляет клиента из панели и очищает привязки; при повторном подключении создаётся новый клиент с тем же Telegram ID. */
export async function resetPanelClient(
  env: BotEnv,
  userId: string,
  options?: { bypassCooldown?: boolean; telegramId?: number; isTester?: boolean }
): Promise<void> {
  const sub = await getSubscription(env, userId);
  if (!sub) throw new Error("Подписка не найдена");

  const bypass =
    options?.bypassCooldown ||
    (options?.telegramId != null &&
      isTesterAccount(env, options.telegramId, options.isTester));

  if (!bypass) {
    const remaining = deviceResetCooldownRemaining(sub.last_device_reset);
    if (remaining > 0) throw new DeviceResetCooldownError(remaining);
  }

  const telegramId =
    options?.telegramId ?? Number(sub.client_email?.trim()) ?? 0;
  const now = new Date().toISOString();

  if (Number.isFinite(telegramId) && telegramId > 0) {
    const xui = new XuiApi(env);
    const panelEmail =
      (await xui.resolvePanelEmail(telegramId)) || String(telegramId);
    const deleted = await xui.tryDeletePanelClient(
      panelEmail,
      PANEL_DELETE_TRY_TIMEOUT_MS
    );
    if (!deleted) {
      console.error("resetPanelClient: panel delete failed for", panelEmail);
    }
  }

  await clearPanelClientDbState(env, userId);
  await patchSubscription(env, userId, {
    last_device_reset: now,
  });
  await clearStuckRotationFlags(env, userId);
}
