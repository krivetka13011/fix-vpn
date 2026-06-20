import { telegramIdFromClientEmail } from "./device-limit";
import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import {
  clearVpnDeviceBindings,
  clearXuiInboundClients,
  getSubscription,
  getUserById,
  getUserByTelegramId,
  kvClearSubscriptionPayloadCache,
  patchSubscription,
} from "./repository";
import { clearStuckRotationFlags } from "./subscription-rotate";
import { debugSessionLog } from "./debug-session-log";
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
  "Подключение сброшено. В Happ обновите подписку (потяните вниз), затем подключитесь заново во вкладке «Помощь». Следующий сброс — через 24 часа.";

export function deviceResetNotice(): string {
  return DEVICE_RESET_SUCCESS_NOTICE;
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
  // #region agent log
  debugSessionLog(
    "device-reset.ts:clearPanelClientDbState",
    "db bindings cleared, subId preserved",
    {
      telegramId,
      userId,
      preservedSubId: Boolean(sub?.xray_sub_id?.trim()),
      preservedUuid: Boolean(sub?.xray_uuid?.trim()),
    },
    "A"
  );
  // #endregion
}

/**
 * Сброс устройства: очищаем IP-привязки в панели (clearClientIps), клиент и subId не удаляем.
 * После сброса слот свободен — можно подключиться снова с тем же URL подписки.
 */
export async function resetPanelClient(
  env: BotEnv,
  userId: string,
  options?: { bypassCooldown?: boolean; telegramId?: number; isTester?: boolean }
): Promise<void> {
  const sub = await getSubscription(env, userId);
  if (!sub) throw new Error("Подписка не найдена");
  if (sub.status !== "active") {
    // #region agent log
    debugSessionLog(
      "device-reset.ts:resetPanelClient",
      "reset blocked inactive subscription",
      { userId, status: sub.status },
      "E"
    );
    // #endregion
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
    // #region agent log
    debugSessionLog(
      "device-reset.ts:resetPanelClient",
      "no panel email for reset",
      { telegramId, userId },
      "G"
    );
    // #endregion
    throw new DeviceResetPanelError(
      "Клиент не найден в панели. Сначала подключитесь во вкладке «Помощь», затем повторите сброс."
    );
  }

  let ipsBefore = 0;
  try {
    ipsBefore = (await xui.getClientIps(panelEmail)).length;
  } catch {
    ipsBefore = -1;
  }

  const cleared = await xui.tryClearClientIps(panelEmail, 12_000);
  let ipsAfterClear = -1;
  try {
    ipsAfterClear = (await xui.getClientIps(panelEmail)).length;
  } catch {
    ipsAfterClear = -1;
  }
  const resetOk = cleared || ipsAfterClear === 0;
  // #region agent log
  debugSessionLog(
    "device-reset.ts:resetPanelClient",
    "clearClientIps result",
    { telegramId, panelEmail, ipsBefore, cleared, ipsAfterClear, resetOk },
    "G"
  );
  // #endregion

  if (!resetOk) {
    throw new DeviceResetPanelError();
  }

  const now = new Date().toISOString();
  await clearPanelClientDbState(env, userId, telegramId, sub);
  await patchSubscription(env, userId, {
    last_device_reset: now,
  });
  await clearStuckRotationFlags(env, userId);

  let ipsAfter = ipsAfterClear;
  if (ipsAfter < 0) {
    try {
      ipsAfter = (await xui.getClientIps(panelEmail)).length;
    } catch {
      ipsAfter = -1;
    }
  }

  // #region agent log
  debugSessionLog(
    "device-reset.ts:resetPanelClient",
    "device reset complete",
    {
      telegramId,
      userId,
      panelEmail,
      ipsBefore,
      ipsAfter,
    },
    "J"
  );
  // #endregion
}
