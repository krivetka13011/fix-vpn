import type { BotEnv } from "../env";
import { clientBotToken, isTesterAccount } from "../env";
import {
  clearSession,
  createTransaction,
  getPartner,
  getPromoByCode,
  getSession,
  getSubscription,
  getUserByTelegramId,
  getTransaction,
  claimTrialByTelegramId,
  clearVpnDeviceBindings,
  deleteVpnDeviceBinding,
  listVpnDeviceBindings,
  patchSubscription,
  patchTransaction,
  patchUser,
  releaseTrialClaim,
  resetTesterSubscriptionState,
  resetTesterTrial,
  saveXuiInboundClients,
  setSession,
  upsertTelegramUser,
  upsertVpnDeviceBinding,
} from "../repository";
import { XuiApi, type PanelDeviceIp } from "../xui";
import type { TelegramUser } from "../telegram";
import {
  answerCallback,
  editMessage,
  forwardMessage,
  sendMessage,
} from "./telegram-api";
import { BILLING_OPTIONS, calcPrice, periodLabel, type BillingMonths } from "./pricing";
import { managerTxnKeyboard, notifyManager } from "./manager";
import { handleManagerPartnerCallback } from "./partner-bot";
import { clearStuckRotationFlags } from "../subscription-rotate";
import {
  DeviceResetCooldownError,
  DeviceResetPendingError,
  deviceResetNotice,
  resetPanelDeviceBinding,
  unbindPanelClientIp,
} from "../device-reset";
import { approvePaidTransaction } from "../approve-transaction";
import {
  createCardlinkBill,
  shouldUseCardlink,
} from "../cardlink";
import {
  buildPanelSubscriptionUrlForUser,
  buildRedirectUrl,
  clientLabel,
  clientsForOs,
  defaultClientForOs,
  type VpnClientId,
} from "../connect-links";
import { syncPanelSubIdForUser } from "../panel-sync";

type TgUpdate = {
  message?: {
    chat: { id: number };
    message_id: number;
    text?: string;
    photo?: Array<{ file_id: string }>;
    from?: TelegramUser;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
    from: TelegramUser;
  };
};

function mainMenuKeyboard(env: BotEnv, hasUsedTrial: boolean) {
  const rows: Array<Array<Record<string, string>>> = [];
  if (!hasUsedTrial) {
    rows.push([{ text: "Пробный период", callback_data: "c:trial" }]);
  }
  rows.push(
    [{ text: "Оформить подписку", callback_data: "c:buy" }],
    [{ text: "Мой профиль", callback_data: "c:profile" }],
    [{ text: "Подключить VPN", callback_data: "c:connect" }],
    [
      {
        text: "Партнерство",
        url: `https://t.me/${env.PARTNER_BOT_USERNAME || "FIX_Partner_bot"}`,
      },
    ]
  );
  return { inline_keyboard: rows };
}

function periodsKeyboard() {
  return {
    inline_keyboard: BILLING_OPTIONS.map((months) => [
      {
        text: periodLabel(months),
        callback_data: `c:period:${months}`,
      },
    ]).concat([[{ text: "Назад", callback_data: "c:menu" }]]),
  };
}

function paymentMethodsKeyboard(months: number, promo = 0) {
  return {
    inline_keyboard: [
      [{ text: "СБП", callback_data: `c:pay:sbp:${months}:${promo}` }],
      [{ text: "Карта", callback_data: `c:pay:card:${months}:${promo}` }],
      [{ text: "USDT", callback_data: `c:pay:crypto_usdt:${months}:${promo}` }],
      [{ text: "Ввести промокод", callback_data: `c:promo:${months}` }],
      [{ text: "Назад", callback_data: "c:buy" }],
    ],
  };
}

function connectOsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Android", callback_data: "c:os:android" }],
      [{ text: "iOS", callback_data: "c:os:ios" }],
      [{ text: "Windows", callback_data: "c:os:windows" }],
      [{ text: "macOS", callback_data: "c:os:macos" }],
      [{ text: "Назад", callback_data: "c:menu" }],
    ],
  };
}

function connectClientKeyboard(
  env: BotEnv,
  os: string,
  subId: string,
  defaultClient: VpnClientId,
  redirectByClient: Partial<Record<VpnClientId, string>>
) {
  const options = clientsForOs(os);
  const rows: Array<Array<{ text: string; url?: string; callback_data?: string }>> = [
    [
      {
        text: `Открыть ${clientLabel(defaultClient)}`,
        url: redirectByClient[defaultClient] || buildRedirectUrl(env, defaultClient, subId),
      },
    ],
  ];
  for (const client of options) {
    if (client === defaultClient) continue;
    rows.push([
      {
        text: clientLabel(client),
        url: redirectByClient[client] || buildRedirectUrl(env, client, subId),
      },
    ]);
  }
  rows.push([{ text: "Назад", callback_data: "c:connect" }]);
  return { inline_keyboard: rows };
}

function osLabel(os: string): string {
  const labels: Record<string, string> = {
    android: "Android",
    ios: "iOS",
    windows: "Windows",
    macos: "macOS",
  };
  return labels[os] || os;
}

function parseStartRef(text?: string): number | null {
  if (!text) return null;
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload.startsWith("ref_")) return null;
  const id = Number(payload.slice(4));
  return Number.isFinite(id) ? id : null;
}

function expiryMsFromDays(days: number): number {
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

function formatDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatDateTime(isoOrMs: string | number): string {
  const date =
    typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function deviceDisplayName(os: string, vpnClient: string): string {
  const osNames: Record<string, string> = {
    ios: "iPhone / iPad",
    android: "Android",
    windows: "Windows ПК",
    macos: "Mac",
  };
  const osName = osNames[os] || osLabel(os);
  return `${osName} · ${clientLabel(vpnClient as VpnClientId)}`;
}

async function recordDeviceConnect(
  env: BotEnv,
  userId: string,
  os: string,
  vpnClient: VpnClientId
): Promise<void> {
  const label = `${deviceDisplayName(os, vpnClient)}`;
  await upsertVpnDeviceBinding(env, userId, os, vpnClient, label);
}

function buildProfileKeyboard(
  bindings: Awaited<ReturnType<typeof listVpnDeviceBindings>>,
  panelIps: PanelDeviceIp[],
  hasSlot: boolean
): Record<string, unknown> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const row of bindings) {
    rows.push([
      {
        text: `✕ ${row.label || deviceDisplayName(row.os, row.vpn_client)}`,
        callback_data: `c:unbind:${row.id}`,
      },
    ]);
  }

  if (panelIps.length > 0 && bindings.length === 0) {
    const ip = panelIps[0].ip;
    rows.push([
      {
        text: `✕ Подключение · ${ip}`,
        callback_data: "c:resetip",
      },
    ]);
  }

  if (hasSlot) {
    rows.push([{ text: "Сбросить привязку устройств", callback_data: "c:resetip" }]);
  }

  rows.push([{ text: "Назад", callback_data: "c:menu" }]);
  return { inline_keyboard: rows };
}

async function persistProvision(
  env: BotEnv,
  userId: string,
  provision: {
    email: string;
    subId: string;
    subscriptionUrl: string;
    primaryUuid: string;
    inbounds: Array<{ inboundId: number; clientUuid: string }>;
  },
  subscription: Record<string, unknown>
): Promise<void> {
  const current = await getSubscription(env, userId);
  const lockedSubId = current?.xray_sub_id?.trim();
  const subId = lockedSubId || provision.subId;
  const subscriptionUrl = buildSubscriptionUrl(env, subId);

  if (provision.inbounds.length > 0) {
    await saveXuiInboundClients(
      env,
      userId,
      provision.inbounds.map((row) => ({
        inboundId: row.inboundId,
        clientUuid: row.clientUuid,
        clientEmail: provision.email,
      }))
    );
  }
  await patchSubscription(env, userId, {
    xray_uuid: provision.primaryUuid,
    xray_sub_id: subId,
    subscription_url: subscriptionUrl,
    client_email: provision.email,
    ...subscription,
  });
}

function buildSubscriptionUrl(env: BotEnv, subId: string): string {
  return buildPanelSubscriptionUrlForUser(env, subId);
}

function connectOsMessage(
  os: string,
  defaultClient: VpnClientId
): string {
  const happNote =
    defaultClient === "happ"
      ? `\n\n⚠️ В Happ удалите <b>все</b> старые подписки «Encrypted» перед импортом — иначе несколько профилей на одну ссылку и пинг N/D.`
      : "";
  const osHint =
    os === "android"
      ? `Нажмите <b>Открыть ${clientLabel(defaultClient)}</b> ниже.`
      : `Нажмите <b>Открыть ${clientLabel(defaultClient)}</b> — ссылка защищена, импорт только через кнопку.`;
  return (
    `<b>Подключение VPN</b>\n\n` +
    `ОС: <b>${osLabel(os)}</b>\n` +
    `${osHint}${happNote}`
  );
}

function buildConnectRedirects(
  env: BotEnv,
  os: string,
  subId: string
): Partial<Record<VpnClientId, string>> {
  const redirects: Partial<Record<VpnClientId, string>> = {};
  for (const client of clientsForOs(os)) {
    redirects[client] = buildRedirectUrl(env, client, subId);
  }
  return redirects;
}

async function syncSubscriptionFromPanel(
  env: BotEnv,
  userId: string,
  tg: TelegramUser
): Promise<string | null> {
  const sub = await getSubscription(env, userId);
  const lockedSubId = sub?.xray_sub_id?.trim();
  const lockedUuid = sub?.xray_uuid?.trim();

  try {
    const xui = new XuiApi(env);

    const panelClient = lockedSubId
      ? await xui.ensureLockedPanelClient(env, tg.id, sub)
      : await xui.resolveExistingClient(tg.id, sub);

    if (!panelClient?.subId?.trim()) {
      return lockedSubId || null;
    }

    const subId = lockedSubId || panelClient.subId;
    const subscriptionUrl = buildSubscriptionUrl(env, subId);
    const patch: Record<string, string> = {
      client_email: panelClient.email,
      xray_sub_id: subId,
      xray_uuid: panelClient.primaryUuid,
      subscription_url: subscriptionUrl,
    };
    const changed =
      sub?.client_email !== patch.client_email ||
      sub?.xray_sub_id !== patch.xray_sub_id ||
      sub?.xray_uuid !== patch.xray_uuid ||
      sub?.subscription_url !== patch.subscription_url;
    if (changed) {
      await patchSubscription(env, userId, patch);
    }
    return subId;
  } catch (error) {
    console.error("syncSubscriptionFromPanel:", error);
    return lockedSubId || null;
  }
}

async function resolvePanelSubId(
  env: BotEnv,
  user: Awaited<ReturnType<typeof upsertTelegramUser>>,
  tg: TelegramUser
): Promise<string | null> {
  const sub = await getSubscription(env, user.id);
  return syncPanelSubIdForUser(env, user.id, tg.id, user.username, sub);
}

async function ensureVpnClientOnStart(
  env: BotEnv,
  user: Awaited<ReturnType<typeof upsertTelegramUser>>,
  tg: TelegramUser
): Promise<void> {
  let sub = await getSubscription(env, user.id);

  try {
    const xui = new XuiApi(env);
    await xui.syncPanelWithDb(env, user.id, tg.id, sub);
    sub = (await getSubscription(env, user.id)) ?? sub;
    const provision = await xui.ensureClientPrepared(env, {
      userId: user.id,
      username: user.username,
      telegramId: tg.id,
      dbSubscription: sub,
    });
    await persistProvision(env, user.id, provision, {
      status: sub?.status || "none",
      plan_type: "basic",
      plan_label: sub?.plan_label ?? null,
      billing_months: sub?.billing_months ?? null,
      starts_at: sub?.starts_at ?? null,
      ends_at: sub?.ends_at ?? null,
      is_trial: sub?.is_trial ?? false,
    });
    return;
  } catch (error) {
    console.error("ensureVpnClientOnStart panel:", error);
  }

  const syncedUrl = await syncSubscriptionFromPanel(env, user.id, tg);
  if (syncedUrl) return;

  if (sub?.client_email && sub.subscription_url && sub.xray_sub_id && sub.xray_uuid) {
    return;
  }

  console.error(
    "ensureVpnClientOnStart: panel client missing and panel API unavailable for",
    tg.id
  );
}

async function showMainMenu(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId?: number
): Promise<void> {
  const token = clientBotToken(env)!;
  const user = await upsertTelegramUser(env, tg);
  const text =
    `FIX VPN\n\n` +
    `Привет, <b>${user.display_name}</b>.\n` +
    `Выберите действие:`;
  const markup = mainMenuKeyboard(env, Boolean(user.has_used_trial));
  if (messageId) {
    await editMessage(token, chatId, messageId, text, markup);
  } else {
    await sendMessage(token, chatId, text, markup);
  }
}

async function activateTrial(env: BotEnv, tg: TelegramUser, chatId: number): Promise<void> {
  const token = clientBotToken(env)!;
  const user = await upsertTelegramUser(env, tg);
  const tester = isTesterAccount(env, tg.id, user.is_tester);

  let claimed = user;
  if (tester) {
    claimed = (await resetTesterTrial(env, tg.id)) ?? user;
  } else {
    const trialClaim = await claimTrialByTelegramId(env, tg.id);
    if (!trialClaim) {
      await sendMessage(
        token,
        chatId,
        env.MSG_TRIAL_ALREADY_USED ||
          "Пробный период уже использован на этом аккаунте Telegram."
      );
      return;
    }
    claimed = trialClaim;
  }

  const trialDays = Number(env.TRIAL_DAYS || env.XUI_TRIAL_DAYS || "3");
  const expiryMs = expiryMsFromDays(trialDays);

  try {
    await ensureVpnClientOnStart(env, claimed, tg);
    let sub = await getSubscription(env, claimed.id);
    let panelSubId = await resolvePanelSubId(env, claimed, tg);
    sub = await getSubscription(env, claimed.id);

    if (!panelSubId && sub?.xray_sub_id?.trim() && sub?.xray_uuid?.trim()) {
      panelSubId = sub.xray_sub_id.trim();
    }

    if (!panelSubId || !sub?.xray_sub_id || !sub?.xray_uuid) {
      throw new Error(
        tester
          ? "клиент не подготовлен — подождите 1–2 минуты и нажмите «Пробный период» снова"
          : "клиент не подготовлен — нажмите /start ещё раз через 1–2 минуты"
      );
    }

    const subscriptionUrl =
      sub.subscription_url || buildSubscriptionUrl(env, sub.xray_sub_id);

    await patchSubscription(env, claimed.id, {
      status: "active",
      plan_type: "basic",
      plan_label: `Пробный · ${trialDays} дн.`,
      billing_months: 0,
      starts_at: formatDateFromMs(Date.now()),
      ends_at: formatDateFromMs(expiryMs),
      is_trial: true,
      client_email: sub.client_email || String(tg.id),
      xray_sub_id: sub.xray_sub_id,
      xray_uuid: sub.xray_uuid,
      subscription_url: subscriptionUrl,
    });
    await sendMessage(
      token,
      chatId,
      env.MSG_TRIAL_SUCCESS ||
        "Пробный период активирован.\n\n" +
          "На пробном тарифе одновременно работает <b>1 устройство</b>. " +
          "Сменить — «Мой профиль» → нажмите устройство или «Сбросить все».\n\n" +
          "Откройте «Подключить VPN» в меню."
    );
  } catch (error) {
    if (!tester) await releaseTrialClaim(env, tg.id);
    const detail = error instanceof Error ? error.message : "unknown";
    console.error("activateTrial:", detail);
    const provisioning =
      detail.includes("клиент не подготовлен") ||
      detail.includes("подождите");
    await sendMessage(
      token,
      chatId,
      tester
        ? `Тест: ошибка активации — ${detail}`
        : provisioning
          ? "Аккаунт ещё готовится (обычно 1–2 минуты).\n\nНажмите /start, подождите и снова «Пробный период»."
          : "Не удалось активировать пробный период. Попробуйте позже или напишите в поддержку."
    );
  }
}

async function handleTesterReset(
  env: BotEnv,
  tg: TelegramUser,
  chatId: number
): Promise<void> {
  const token = clientBotToken(env)!;
  const user = await getUserByTelegramId(env, tg.id);
  if (!user || !isTesterAccount(env, tg.id, user.is_tester)) {
    await sendMessage(token, chatId, "Команда доступна только тестовым аккаунтам.");
    return;
  }
  await resetTesterTrial(env, tg.id);
  await resetTesterSubscriptionState(env, user.id);
  await clearVpnDeviceBindings(env, user.id);
  await ensureVpnClientOnStart(env, user, tg);
  await syncSubscriptionFromPanel(env, user.id, tg);
  const sub = await getSubscription(env, user.id);
  const subHint = sub?.xray_sub_id
    ? "\nПодписка привязана к вашему клиенту в панели."
    : "";
  await sendMessage(
    token,
    chatId,
    "Тестовый сброс выполнен.\n" +
      "Ключ подписки сохранён из панели — новый случайный ID не создаётся." +
      subHint +
      "\n\nЕсли в Happ ошибка 404 — удалите старую подписку FIX VPN и подключитесь заново через «Подключить VPN»."
  );
}

function formatSubscriptionPeriod(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  planLabel: string | null | undefined
): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  if (startsAt && endsAt) return `${fmt(startsAt)} — ${fmt(endsAt)}`;
  if (endsAt) return `до ${fmt(endsAt)}`;
  if (planLabel) return planLabel;
  return "—";
}

async function showProfile(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId: number,
  notice?: string
): Promise<void> {
  const token = clientBotToken(env)!;
  const user = await upsertTelegramUser(env, tg);
  const sub = await getSubscription(env, user.id);
  if (sub?.panel_sub_rotate_requested_at || sub?.pending_xray_sub_id) {
    await clearStuckRotationFlags(env, user.id);
  }
  const bindings = await listVpnDeviceBindings(env, user.id);
  let panelIps: PanelDeviceIp[] = [];

  if (sub?.client_email) {
    try {
      panelIps = await Promise.race([
        new XuiApi(env).getClientIps(sub.client_email),
        new Promise<PanelDeviceIp[]>((resolve) => {
          setTimeout(() => resolve([]), 3000);
        }),
      ]);
    } catch (error) {
      console.error("showProfile panel ips:", error);
    }
  }

  const used = bindings.length;
  const hasSlot = used > 0 || panelIps.length > 0;
  const status = sub?.status || "none";
  const period = formatSubscriptionPeriod(sub?.starts_at, sub?.ends_at, sub?.plan_label);
  const statusLabel =
    status === "active"
      ? sub?.is_trial
        ? "пробный период"
        : "активна"
      : status === "expired"
        ? "истекла"
        : "нет подписки";

  const deviceLine = hasSlot
    ? `Устройства: <b>${Math.max(used, panelIps.length)}</b> · привязано`
    : `Устройство: <b>свободно</b>`;

  const pendingClear = Boolean(sub?.panel_ip_clear_requested_at);
  const hint = pendingClear
    ? "Сброс IP в панели выполняется (до 2 мин). Затем подключите VPN на новом устройстве."
    : hasSlot
      ? "Нажмите «Сбросить привязку устройств» для смены телефона (раз в 24 ч)."
      : "Подключите VPN в главном меню — устройство появится здесь.";

  const text =
    (notice ? `${notice}\n\n` : "") +
    `<b>Мой профиль</b>\n\n` +
    `Статус: ${statusLabel}\n` +
    `Период: ${period}\n` +
    `${deviceLine}\n\n` +
    hint;

  await editMessage(token, chatId, messageId, text, buildProfileKeyboard(bindings, panelIps, hasSlot));
}

async function unbindSingleDevice(
  env: BotEnv,
  tg: TelegramUser,
  chatId: number,
  messageId: number,
  bindingId: string
): Promise<void> {
  const user = await getUserByTelegramId(env, tg.id);
  if (!user) return;
  const sub = await getSubscription(env, user.id);

  await deleteVpnDeviceBinding(env, user.id, bindingId);

  let notice = "<b>Устройство отвязано.</b> Можно подключить другое.";
  try {
    const mode = await unbindPanelClientIp(env, user.id, sub?.client_email);
    if (mode === "queued") {
      notice = "<b>Устройство отвязано.</b> Сброс IP в панели — до 2 минут.";
    }
  } catch (error) {
    if (error instanceof DeviceResetPendingError) {
      notice = "<b>Устройство отвязано.</b> Сброс IP уже выполняется.";
    } else {
      console.error("unbindSingleDevice panel ip:", error);
    }
  }

  await showProfile(env, chatId, tg, messageId, notice);
}

async function resetDeviceBinding(
  env: BotEnv,
  tg: TelegramUser,
  chatId: number,
  messageId: number
): Promise<void> {
  const user = await getUserByTelegramId(env, tg.id);
  if (!user) return;

  const mode = await resetPanelDeviceBinding(env, user.id, {
    telegramId: tg.id,
    isTester: user.is_tester,
  });

  await showProfile(
    env,
    chatId,
    tg,
    messageId,
    `<b>${deviceResetNotice(mode)}</b>`
  );
}

export async function handleManagerClientCallback(
  env: BotEnv,
  data: string,
  managerId: number
): Promise<string | null> {
  const allowed = (env.MANAGER_TELEGRAM_IDS || env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((part) => Number(part.trim()));
  if (!allowed.includes(managerId)) return "Нет доступа";

  if (data.startsWith("mgr:txn:ok:")) {
    const txnId = data.slice("mgr:txn:ok:".length);
    const result = await approvePaidTransaction(env, txnId);
    return result.ok ? result.message : result.message;
  }

  if (data.startsWith("mgr:txn:no:")) {
    const txnId = data.slice("mgr:txn:no:".length);
    await patchTransaction(env, txnId, { status: "rejected" });
    return "Заявка отклонена";
  }

  return null;
}

export async function handleClientBotUpdate(
  env: BotEnv,
  update: TgUpdate
): Promise<void> {
  const token = clientBotToken(env);
  if (!token) return;

  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || "";
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    const tg = cq.from;
    if (!chatId || !messageId) return;

    if (data.startsWith("mgr:")) {
      const note =
        (await handleManagerClientCallback(env, data, tg.id)) ||
        (await handleManagerPartnerCallback(env, data, tg.id));
      await answerCallback(token, cq.id, note || undefined);
      if (note) {
        await sendMessage(token, chatId, note);
      }
      return;
    }

    if (data === "c:menu") {
      await showMainMenu(env, chatId, tg, messageId);
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "c:trial") {
      await answerCallback(token, cq.id, "Активируем пробный период…");
      await activateTrial(env, tg, chatId);
      return;
    }
    if (data === "c:buy") {
      await editMessage(token, chatId, messageId, "Выберите период подписки:", periodsKeyboard());
      await answerCallback(token, cq.id);
      return;
    }
    if (data.startsWith("c:period:")) {
      const months = Number(data.split(":")[2]) as BillingMonths;
      const price = calcPrice(env, months);
      await editMessage(
        token,
        chatId,
        messageId,
        `Период: <b>${periodLabel(months)}</b>\nСумма: <b>${price} ₽</b>\n\nВыберите способ оплаты:`,
        paymentMethodsKeyboard(months)
      );
      await answerCallback(token, cq.id);
      return;
    }
    if (data.startsWith("c:promo:")) {
      const months = Number(data.split(":")[2]);
      await setSession(env, tg.id, "client", "await_promo", { months });
      await editMessage(token, chatId, messageId, "Введите промокод сообщением:");
      await answerCallback(token, cq.id);
      return;
    }
    if (data.startsWith("c:pay:")) {
      const [, , method, monthsRaw, promoRaw] = data.split(":");
      const months = Number(monthsRaw) as BillingMonths;
      const promo = Number(promoRaw || "0");
      const price = calcPrice(env, months, promo);
      const user = await upsertTelegramUser(env, tg);
      const txn = await createTransaction(env, {
        user_id: user.id,
        amount: price,
        billing_months: months,
        payment_method: method,
        status: "pending",
        is_first_payment: !Boolean(user.first_payment_done),
      });

      if (shouldUseCardlink(env, method)) {
        try {
          const bill = await createCardlinkBill(env, {
            amount: price,
            orderId: txn.id,
            description: `FIX VPN · ${periodLabel(months)}`,
            method,
            custom: String(tg.id),
          });
          await patchTransaction(env, txn.id, {
            cardlink_bill_id: bill.billId,
            payment_url: bill.linkPageUrl,
          });
          await editMessage(
            token,
            chatId,
            messageId,
            `Оплата FIX VPN: <b>${price} ₽</b> · ${periodLabel(months)}\n\n` +
              `Нажмите кнопку ниже — откроется безопасная форма Cardlink.\n` +
              `После оплаты подписка активируется автоматически.`,
            {
              inline_keyboard: [
                [{ text: "Оплатить", url: bill.linkPageUrl }],
                [{ text: "Назад", callback_data: "c:menu" }],
              ],
            }
          );
        } catch (error) {
          console.error("cardlink bill:", error);
          await editMessage(
            token,
            chatId,
            messageId,
            `Не удалось создать ссылку на оплату.\n` +
              `${error instanceof Error ? error.message : "ошибка Cardlink"}\n\n` +
              `Попробуйте позже или выберите другой способ.`,
            { inline_keyboard: [[{ text: "Назад", callback_data: "c:buy" }]] }
          );
        }
        await answerCallback(token, cq.id);
        return;
      }

      await setSession(env, tg.id, "client", "await_receipt", {
        txnId: txn.id,
      });
      await editMessage(
        token,
        chatId,
        messageId,
        `Заявка создана: <b>${price} ₽</b> · ${periodLabel(months)} · ${method.toUpperCase()}\n\n` +
          `Менеджер отправит реквизиты. После оплаты пришлите <b>скриншот</b> и укажите <b>имя отправителя</b> отдельным сообщением.`,
        { inline_keyboard: [[{ text: "Назад", callback_data: "c:menu" }]] }
      );
      await notifyManager(
        env,
        `Оплата FIX VPN\n` +
          `Пользователь: @${tg.username || "—"} (${tg.id})\n` +
          `Сумма: ${price} ₽\n` +
          `Период: ${periodLabel(months)}\n` +
          `Способ: ${method}\n` +
          `Первая оплата: ${!user.first_payment_done ? "да" : "нет"}`,
        managerTxnKeyboard(txn.id)
      );
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "c:profile" || data === "c:devices") {
      await showProfile(env, chatId, tg, messageId);
      await answerCallback(token, cq.id);
      return;
    }
    if (data.startsWith("c:unbind:")) {
      const bindingId = data.slice("c:unbind:".length).trim();
      if (!bindingId) {
        await answerCallback(token, cq.id, "Устройство не найдено", { showAlert: true });
        return;
      }
      await answerCallback(token, cq.id, "Отвязываем…");
      await unbindSingleDevice(env, tg, chatId, messageId, bindingId);
      return;
    }
    if (data === "c:resetip") {
      const user = await getUserByTelegramId(env, tg.id);
      if (!user) {
        await answerCallback(token, cq.id, "Пользователь не найден", { showAlert: true });
        return;
      }
      try {
        await answerCallback(token, cq.id, "Сбрасываем привязку…");
        await resetDeviceBinding(env, tg, chatId, messageId);
      } catch (error) {
        if (error instanceof DeviceResetCooldownError) {
          await answerCallback(token, cq.id, error.message, { showAlert: true });
          return;
        }
        if (error instanceof DeviceResetPendingError) {
          await answerCallback(token, cq.id, error.message, { showAlert: true });
          return;
        }
        const message =
          error instanceof Error ? error.message : "Не удалось сбросить привязку";
        await showProfile(env, chatId, tg, messageId, `<b>${message}</b>`);
        await answerCallback(token, cq.id);
      }
      return;
    }
    if (data === "c:connect") {
      const user = await upsertTelegramUser(env, tg);
      await resolvePanelSubId(env, user, tg);
      const sub = await getSubscription(env, user.id);
      if (!sub?.subscription_url || sub.status !== "active") {
        await editMessage(
          token,
          chatId,
          messageId,
          "Сначала активируйте пробный период или оформите подписку.",
          { inline_keyboard: [[{ text: "Назад", callback_data: "c:menu" }]] }
        );
      } else {
        const warning = "";
        const osRows = connectOsKeyboard().inline_keyboard.slice(0, -1);
        await editMessage(
          token,
          chatId,
          messageId,
          `${warning}Выберите ОС:`,
          connectOsKeyboard()
        );
      }
      await answerCallback(token, cq.id);
      return;
    }
    if (data.startsWith("c:os:")) {
      const os = data.split(":")[2];
      const user = await upsertTelegramUser(env, tg);
      const sub = await getSubscription(env, user.id);
      if (sub?.status !== "active") {
        await answerCallback(token, cq.id, "Сначала активируйте подписку", { showAlert: true });
        return;
      }

      const subId = await resolvePanelSubId(env, user, tg);
      if (!subId) {
        await answerCallback(
          token,
          cq.id,
          "Ссылка подписки временно недоступна. Удалите старую подписку в Happ и повторите через минуту.",
          { showAlert: true }
        );
        return;
      }

      const defaultClient = defaultClientForOs(os);
      let redirects: Partial<Record<VpnClientId, string>>;
      try {
        redirects = buildConnectRedirects(env, os, subId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "import prep failed";
        console.error("buildConnectRedirects:", detail);
        await answerCallback(token, cq.id, "Не удалось подготовить импорт. Повторите позже.", {
          showAlert: true,
        });
        return;
      }
      if (!redirects[defaultClient]) {
        await answerCallback(token, cq.id, "Импорт недоступен", { showAlert: true });
        return;
      }

      const text = connectOsMessage(os, defaultClient);
      const markup = connectClientKeyboard(env, os, subId, defaultClient, redirects);

      try {
        await editMessage(token, chatId, messageId, text, markup);
      } catch (error) {
        console.error("connect os edit:", error);
        await sendMessage(token, chatId, text, markup);
      }

      await recordDeviceConnect(env, user.id, os, defaultClient);
      await answerCallback(token, cq.id);
      return;
    }
    return;
  }

  const message = update.message;
  if (!message?.from || !message.text && !message.photo) return;
  const tg = message.from;
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";

  if (text === "/test_reset" || text.startsWith("/test_reset@")) {
    await handleTesterReset(env, tg, chatId);
    return;
  }

  if (text.startsWith("/start")) {
    const ref = parseStartRef(text);
    let user;
    if (ref) {
      const partner = await getPartner(env, ref);
      user = partner
        ? await upsertTelegramUser(env, tg, ref)
        : await upsertTelegramUser(env, tg);
    } else {
      user = await upsertTelegramUser(env, tg);
    }
    try {
      await ensureVpnClientOnStart(env, user, tg);
      const sub = await getSubscription(env, user.id);
      await syncPanelSubIdForUser(env, user.id, tg.id, user.username, sub);
    } catch (error) {
      console.error("start panel sync:", error);
    }
    await showMainMenu(env, chatId, tg);
    return;
  }

  const session = await getSession(env, tg.id, "client");
  if (session?.state === "await_promo" && text) {
    const months = Number(session.payload.months || 1) as BillingMonths;
    const promo = await getPromoByCode(env, text.toUpperCase());
    await clearSession(env, tg.id, "client");
    const discount = promo?.discount_percent || 0;
    const price = calcPrice(env, months, discount);
    await sendMessage(
      token,
      chatId,
      promo
        ? `Промокод принят: -${discount}%. Итого <b>${price} ₽</b>.`
        : "Промокод не найден. Выберите способ оплаты без скидки:",
      paymentMethodsKeyboard(months, discount)
    );
    return;
  }

  if (session?.state === "await_receipt") {
    const txnId = String(session.payload.txnId || "");
    const txn = await getTransaction(env, txnId);
    if (!txn) return;
    if (message.photo?.length) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      await patchTransaction(env, txnId, { screenshot_file_id: fileId });
      const managerChat = env.MANAGER_NOTIFICATION_CHAT_ID;
      if (managerChat) {
        await forwardMessage(token, Number(managerChat), chatId, message.message_id);
        await notifyManager(
          env,
          `Скриншот оплаты\nПользователь: @${tg.username || "—"} (${tg.id})\nЗаявка: ${txnId}`,
          managerTxnKeyboard(txnId)
        );
      }
      await setSession(env, tg.id, "client", "await_sender_name", { txnId });
      await sendMessage(token, chatId, "Укажите имя отправителя перевода:");
      return;
    }
  }

  if (session?.state === "await_sender_name" && text) {
    const txnId = String(session.payload.txnId || "");
    await patchTransaction(env, txnId, { sender_name: text });
    await clearSession(env, tg.id, "client");
    await sendMessage(token, chatId, env.MSG_PAYMENT_PENDING || "Заявка отправлена менеджеру.");
  }
}
