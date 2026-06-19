import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import {
  clearVpnDeviceBindings,
  clearXuiInboundClients,
  getSubscription,
  getUserByTelegramId,
  kvClearSubscriptionPayloadCache,
  patchSubscription,
} from "./repository";
import { clearStuckRotationFlags } from "./subscription-rotate";
import { ensureActiveSubscriptionPanel } from "./subscription-activate";
import { debugSessionLog } from "./debug-session-log";
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
  telegramId: number,
  sub: Awaited<ReturnType<typeof getSubscription>>
): Promise<void> {
  await clearVpnDeviceBindings(env, userId);
  await clearXuiInboundClients(env, userId);
  await kvClearSubscriptionPayloadCache(env, userId);
  // Сохраняем xray_sub_id / subscription_url / client_email — Happ продолжает опрашивать тот же URL.
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
    "db state cleared, subId preserved",
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

/** Удаляет клиента из панели; при следующем подключении создаётся заново с тем же Telegram ID. */
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

  const telegramId =
    options?.telegramId ?? Number(sub.client_email?.trim()) ?? 0;
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
  const panelUser = await getUserByTelegramId(env, telegramId);
  const deleted = await xui.deletePanelClientByTelegramId(telegramId, {
    username: panelUser?.username,
    displayName: panelUser?.display_name,
  });
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
  await clearPanelClientDbState(env, userId, telegramId, sub);
  await patchSubscription(env, userId, {
    last_device_reset: now,
  });
  await clearStuckRotationFlags(env, userId);

  const refreshedSub = await getSubscription(env, userId);
  if (refreshedSub?.status === "active") {
    try {
      await ensureActiveSubscriptionPanel(env, refreshedSub);
    } catch (error) {
      console.error("resetPanelClient prewarm:", error);
    }
  }

  // #region agent log
  debugSessionLog(
    "device-reset.ts:resetPanelClient",
    "panel client reset complete",
    { telegramId, userId, panelDeleted: deleted },
    "R"
  );
  // #endregion
}
