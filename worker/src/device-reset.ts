import type { BotEnv } from "./env";
import {
  clearVpnDeviceBindings,
  clearXuiInboundClients,
  getSubscription,
  kvClearSubscriptionPayloadCache,
  patchSubscription,
} from "./repository";
import { clearStuckRotationFlags } from "./subscription-rotate";
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
      `Вы уже сбрасывали подключение недавно. Следующий сброс будет доступен через ${formatDeviceResetCooldown(remainingMs)}.`
    );
    this.name = "DeviceResetCooldownError";
    this.remainingMs = remainingMs;
  }
}

export class DeviceResetPanelError extends Error {
  constructor() {
    super(
      "Не удалось удалить клиента из панели. Подождите 1–2 минуты и повторите сброс."
    );
    this.name = "DeviceResetPanelError";
  }
}

export const DEVICE_RESET_SUCCESS_NOTICE =
  "Подключение сброшено. Клиент удалён из панели — подключите VPN заново. Следующий сброс — через 24 часа.";

export function deviceResetNotice(): string {
  return DEVICE_RESET_SUCCESS_NOTICE;
}

async function clearPanelClientDbState(
  env: BotEnv,
  userId: string,
  telegramId: number
): Promise<void> {
  await clearVpnDeviceBindings(env, userId);
  await clearXuiInboundClients(env, userId);
  await kvClearSubscriptionPayloadCache(env, userId);
  await patchSubscription(env, userId, {
    client_email: String(telegramId),
    xray_uuid: null,
    panel_ip_clear_requested_at: null,
  });
}

/** Удаляет клиента из панели; при следующем подключении создаётся заново с тем же Telegram ID. */
export async function resetPanelClient(
  env: BotEnv,
  userId: string,
  options?: { bypassCooldown?: boolean; telegramId?: number; isTester?: boolean }
): Promise<void> {
  const sub = await getSubscription(env, userId);
  if (!sub) throw new Error("Подписка не найдена");

  const telegramId =
    options?.telegramId ?? Number(sub.client_email?.trim()) ?? 0;
  if (!Number.isFinite(telegramId) || telegramId <= 0) {
    throw new Error("Не удалось определить Telegram ID");
  }

  const bypass = options?.bypassCooldown === true;

  if (!bypass) {
    const remaining = deviceResetCooldownRemaining(sub.last_device_reset);
    if (remaining > 0) throw new DeviceResetCooldownError(remaining);
  }

  const xui = new XuiApi(env);
  const deleted = await xui.deletePanelClientByTelegramId(telegramId);
  const stillThere = await xui.findClientByTelegramId(telegramId);
  if (stillThere) {
    console.error(
      "resetPanelClient: delete failed for",
      telegramId,
      stillThere.email,
      "removed=",
      deleted
    );
    throw new DeviceResetPanelError();
  }

  const now = new Date().toISOString();
  await clearPanelClientDbState(env, userId, telegramId);
  await patchSubscription(env, userId, {
    last_device_reset: now,
  });
  await clearStuckRotationFlags(env, userId);
}
