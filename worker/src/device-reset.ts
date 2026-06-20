import { telegramIdFromClientEmail } from "./device-limit";
import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import { panelDisplayLabel } from "./panel-client-label";
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
import { debugSessionLogKv } from "./debug-session-log";
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
  "Подключение сброшено. Сначала отключите VPN на текущем устройстве, затем подключите заново во вкладке «Помощь». Следующий сброс — через 24 часа.";

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

  return xui.reenableInboundClientAfterReset(telegramId, {
    email: panelEmail,
    subId,
    primaryUuid,
  });
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
  await debugSessionLogKv(
    env,
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
    await debugSessionLogKv(
      env,
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
    await debugSessionLogKv(
      env,
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

  const emailsToClear = new Set<string>([panelEmail, String(telegramId)]);
  if (dbEmail) emailsToClear.add(dbEmail);
  const username = dbUser?.username;
  if (username) {
    for (let slot = 1; slot <= 3; slot += 1) {
      emailsToClear.add(
        panelDisplayLabel(username, dbUser?.display_name ?? null, telegramId, {
          slot,
        })
      );
    }
  }

  let cleared = false;
  for (const email of emailsToClear) {
    if (await xui.tryClearClientIps(email, 12_000)) cleared = true;
  }

  let ipsAfterClear = -1;
  try {
    ipsAfterClear = (await xui.getClientIps(panelEmail)).length;
  } catch {
    ipsAfterClear = -1;
  }
  const resetOk = cleared || ipsAfterClear === 0;
  // #region agent log
  await debugSessionLogKv(
    env,
    "device-reset.ts:resetPanelClient",
    "clearClientIps result",
    {
      telegramId,
      panelEmail,
      ipsBefore,
      cleared,
      ipsAfterClear,
      resetOk,
      emailsCleared: [...emailsToClear],
    },
    "G"
  );
  // #endregion

  if (!resetOk) {
    throw new DeviceResetPanelError();
  }

  let pruned = 0;
  let reenabled = false;
  let ipsAfter = ipsAfterClear;
  try {
    const now = new Date().toISOString();
    await clearPanelClientDbState(env, userId, telegramId, sub);
    await patchSubscription(env, userId, {
      last_device_reset: now,
    });
    await clearStuckRotationFlags(env, userId);

    if (ipsAfter < 0) {
      try {
        ipsAfter = (await xui.getClientIps(panelEmail)).length;
      } catch {
        ipsAfter = -1;
      }
    }
  } finally {
    try {
      reenabled = await ensurePanelClientActive(env, telegramId, userId, sub);
      if (!reenabled) {
        pruned = await xui.pruneDuplicateInboundClients(telegramId, panelEmail);
      }
      // #region agent log
      await debugSessionLogKv(
        env,
        "device-reset.ts:resetPanelClient",
        "post-clear panel sync",
        { telegramId, panelEmail, pruned, reenabled },
        "K"
      );
      // #endregion
    } catch {
      // #region agent log
      await debugSessionLogKv(
        env,
        "device-reset.ts:resetPanelClient",
        "post-clear panel sync failed",
        { telegramId, panelEmail },
        "K"
      );
      // #endregion
    }
  }

  // #region agent log
  await debugSessionLogKv(
    env,
    "device-reset.ts:resetPanelClient",
    "device reset complete",
    {
      telegramId,
      userId,
      panelEmail,
      ipsBefore,
      ipsAfter,
      pruned,
      reenabled,
    },
    "J"
  );
  // #endregion
}
