import { telegramIdFromClientEmail, panelLimitIpForSubscription, syncPanelDeviceLimit } from "./device-limit";
import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import { subscriptionExpiryMs } from "./db";
import {
  clearVpnDeviceBindings,
  clearXuiInboundClients,
  getSubscription,
  getUserById,
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
  const resetAt = new Date(lastReset).getTime();
  if (!Number.isFinite(resetAt)) return 0;
  const elapsed = Date.now() - resetAt;
  if (elapsed < 0) return 0;
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
  constructor(message?: string) {
    super(
      message ??
        "Не удалось сбросить привязку устройств в панели. Подождите 1–2 минуты и повторите."
    );
    this.name = "DeviceResetPanelError";
  }
}

export const DEVICE_RESET_SUCCESS_NOTICE =
  "Подключение сброшено. Отключите VPN на телефоне, обновите подписку в Happ на ПК (↻), затем подключите через «Подключить VPN». Следующий сброс — через 24 часа.";

export function deviceResetNotice(): string {
  return DEVICE_RESET_SUCCESS_NOTICE;
}

export async function ensurePanelClientActive(
  env: BotEnv,
  telegramId: number,
  userId: string,
  sub?: Awaited<ReturnType<typeof getSubscription>>
): Promise<boolean> {
  const subscription = sub ?? (await getSubscription(env, userId));
  if (!subscription || subscription.status !== "active") return false;

  const xui = new XuiApi(env);
  let panelEmail: string | null = null;
  const dbEmail = subscription.client_email?.trim();
  if (dbEmail) {
    const byDbEmail = await xui.findClientByEmail(dbEmail);
    if (byDbEmail) panelEmail = byDbEmail.email;
  }
  if (!panelEmail) {
    panelEmail = await xui.resolvePanelEmail(telegramId);
  }
  if (!panelEmail) return false;

  const clientInfo = await xui.findClientByTelegramId(telegramId);
  const subId = subscription.xray_sub_id?.trim() || clientInfo?.subId || "";
  const primaryUuid =
    subscription.xray_uuid?.trim() || clientInfo?.primaryUuid || "";
  if (!subId || !primaryUuid) return false;

  const expiryMs = subscriptionExpiryMs(subscription);
  if (!expiryMs || expiryMs <= Date.now()) return false;

  return xui.reenableInboundClientAfterReset(
    telegramId,
    {
      email: panelEmail,
      subId,
      primaryUuid,
    },
    {
      expiryMs,
      limitIp: panelLimitIpForSubscription(subscription),
    }
  );
}

async function clearPanelClientDbState(
  env: BotEnv,
  userId: string,
  telegramId: number,
  sub: Awaited<ReturnType<typeof getSubscription>>
): Promise<void> {
  await clearVpnDeviceBindings(env, userId);
  await clearXuiInboundClients(env, userId);
  await kvClearSubscriptionPayloadCache(env, userId);
  const patch: Record<string, unknown> = {
    panel_ip_clear_requested_at: null,
  };
  if (!sub?.client_email?.trim()) {
    patch.client_email = String(telegramId);
  }
  await patchSubscription(env, userId, patch);
}

/**
 * Сброс устройства: удаляем клиента в панели (Xray-core разрывает все активные
 * сессии старого устройства) и пересоздаём с теми же UUID/subId/expiryTime/limitIp.
 * После сброса старое устройство реально отключается — слот limitIp освобождается.
 *
 * Важно: ensurePanelClientActive/reenableInboundClientAfterReset здесь НЕ вызываем —
 * клиент уже создан и активирован внутри recreatePanelClient. Повторный addClient
 * приводил к дублированию клиента в каждом инбаунде, из-за чего Xray-core ломал
 * счётчик limitIp и после сброса работали оба устройства.
 */
export async function resetPanelClient(
  env: BotEnv,
  userId: string,
  options?: { bypassCooldown?: boolean; telegramId?: number; isTester?: boolean }
): Promise<void> {
  const sub = await getSubscription(env, userId);
  if (!sub) throw new Error("Подписка не найдена");
  if (sub.status !== "active") {
    throw new Error("Подписка неактивна. Оформите или продлите доступ перед сбросом.");
  }

  const dbUser = await getUserById(env, userId);
  const telegramId =
    options?.telegramId ??
    telegramIdFromClientEmail(sub.client_email) ??
    dbUser?.telegram_id ??
    0;
  if (!Number.isFinite(telegramId) || telegramId <= 0) {
    throw new Error("Не удалось определить Telegram ID");
  }

  const bypass =
    options?.bypassCooldown === true ||
    (Number.isFinite(telegramId) &&
      telegramId > 0 &&
      isTesterAccount(env, telegramId, options?.isTester));

  if (!bypass) {
    const remaining = deviceResetCooldownRemaining(sub.last_device_reset);
    if (remaining > 0) throw new DeviceResetCooldownError(remaining);
  }

  const xui = new XuiApi(env);
  let panelEmail: string | null = null;
  const dbEmail = sub.client_email?.trim();
  if (dbEmail) {
    const byDbEmail = await xui.findClientByEmail(dbEmail);
    if (byDbEmail) panelEmail = byDbEmail.email;
  }
  if (!panelEmail) {
    panelEmail = await xui.resolvePanelEmail(telegramId);
  }
  if (!panelEmail) {
    throw new DeviceResetPanelError(
      "Клиент не найден в панели. Сначала подключитесь во вкладке «Помощь», затем повторите сброс."
    );
  }

  // Сброс через delete+recreate: удаляем клиента в панели (Xray-core разрывает
  // все активные сессии старого устройства) и пересоздаём с теми же UUID/subId/
  // expiryTime/limitIp. clearClientIps для этой задачи не подходит — он чистит
  // список IP, но не убивает активные VPN-сессии, поэтому работали оба устройства.
  const username = dbUser?.username;
  try {
    await xui.recreatePanelClient(telegramId, panelEmail, {
      username,
      displayName: dbUser?.display_name ?? null,
    });
  } catch (error) {
    console.error("resetPanelClient: recreatePanelClient failed", error);
    throw new DeviceResetPanelError(
      "Не удалось пересоздать клиента в панели. Подождите 1–2 минуты и повторите сброс."
    );
  }

  const now = new Date().toISOString();
  await clearPanelClientDbState(env, userId, telegramId, sub);
  await patchSubscription(env, userId, {
    last_device_reset: now,
  });
  await clearStuckRotationFlags(env, userId);

  // Лучшая попытка синхронизации состояния в панели. Клиент уже создан и
  // активирован внутри recreatePanelClient — здесь только подстраховка:
  // forceEnableClient idempotent (без addClient), syncPanelDeviceLimit
  // выставляет limitIp. НЕ вызываем ensurePanelClientActive — он повторно
  // добавил бы клиента в инбаунды и создал дубли (см. комментарий выше).
  try {
    await xui.forceEnableClient(telegramId, panelEmail);
    await syncPanelDeviceLimit(env, userId);
  } catch {
    // panel sync best-effort
  }
}
