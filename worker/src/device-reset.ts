import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import {
  clearVpnDeviceBindings,
  getSubscription,
  patchSubscription,
} from "./repository";
import { clearStuckRotationFlags } from "./subscription-rotate";
import { syncPanelDeviceLimit } from "./device-limit";
import { XuiApi } from "./xui";

export const DEVICE_RESET_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PANEL_CLEAR_PENDING_MS = 5 * 60 * 1000;
const PANEL_CLEAR_TRY_TIMEOUT_MS = 5000;

export async function clearPanelIpsOnly(
  env: BotEnv,
  clientEmail: string
): Promise<"cleared" | "queued"> {
  const email = clientEmail.trim();
  if (!email) return "cleared";

  const xui = new XuiApi(env);
  const cleared = await xui.tryClearClientIps(email, PANEL_CLEAR_TRY_TIMEOUT_MS);
  return cleared ? "cleared" : "queued";
}

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

export class DeviceResetPendingError extends Error {
  constructor() {
    super("Сброс уже выполняется. Подождите 1–2 минуты и обновите профиль.");
    this.name = "DeviceResetPendingError";
  }
}

export const DEVICE_RESET_SUCCESS_NOTICE =
  "Привязка устройств успешно сброшена! Теперь вы можете подключить новый телефон. Следующий сброс — через 24 часа.";

export const DEVICE_RESET_QUEUED_NOTICE =
  "Сброс IP в панели выполняется (обычно до 2 минут). Можно подключать новое устройство после обновления профиля.";

function panelClearPending(sub: {
  panel_ip_clear_requested_at?: string | null;
}): boolean {
  const raw = sub.panel_ip_clear_requested_at;
  if (!raw) return false;
  return Date.now() - new Date(raw).getTime() < PANEL_CLEAR_PENDING_MS;
}

export async function clearPanelClientIps(
  env: BotEnv,
  userId: string,
  clientEmail: string,
  options?: { enforceCooldown?: boolean; bypassCooldown?: boolean; telegramId?: number; isTester?: boolean }
): Promise<"cleared" | "queued"> {
  const sub = await getSubscription(env, userId);
  if (!sub) throw new Error("Подписка не найдена");

  const email = clientEmail.trim();
  if (!email) throw new Error("Нет активного клиента в панели");

  const bypass =
    options?.bypassCooldown ||
    (options?.telegramId != null &&
      isTesterAccount(env, options.telegramId, options.isTester));

  if (options?.enforceCooldown && !bypass) {
    const remaining = deviceResetCooldownRemaining(sub.last_device_reset);
    if (remaining > 0) throw new DeviceResetCooldownError(remaining);
  }

  if (panelClearPending(sub)) {
    throw new DeviceResetPendingError();
  }

  await clearVpnDeviceBindings(env, userId);

  const xui = new XuiApi(env);
  const cleared = await xui.tryClearClientIps(email, PANEL_CLEAR_TRY_TIMEOUT_MS);
  const now = new Date().toISOString();

  if (cleared) {
    await patchSubscription(env, userId, {
      last_device_reset: options?.enforceCooldown ? now : sub.last_device_reset,
      panel_ip_clear_requested_at: null,
    });
    await clearStuckRotationFlags(env, userId);
    return "cleared";
  }

  await patchSubscription(env, userId, {
    panel_ip_clear_requested_at: now,
    ...(options?.enforceCooldown ? { last_device_reset: now } : {}),
  });
  return "queued";
}

export async function resetPanelDeviceBinding(
  env: BotEnv,
  userId: string,
  options?: { bypassCooldown?: boolean; telegramId?: number; isTester?: boolean }
): Promise<"cleared" | "queued"> {
  const sub = await getSubscription(env, userId);
  if (!sub?.client_email?.trim()) {
    throw new Error("Нет активного клиента в панели");
  }

  const mode = await clearPanelClientIps(env, userId, sub.client_email, {
    enforceCooldown: true,
    bypassCooldown: options?.bypassCooldown,
    telegramId: options?.telegramId,
    isTester: options?.isTester,
  });
  await syncPanelDeviceLimit(env, userId);
  return mode;
}

export async function unbindPanelClientIp(
  env: BotEnv,
  _userId: string,
  clientEmail: string | null | undefined
): Promise<"cleared" | "queued" | "skipped"> {
  if (!clientEmail?.trim()) return "skipped";
  const mode = await clearPanelIpsOnly(env, clientEmail);
  return mode;
}

export function deviceResetNotice(mode: "cleared" | "queued"): string {
  return mode === "cleared" ? DEVICE_RESET_SUCCESS_NOTICE : DEVICE_RESET_QUEUED_NOTICE;
}
