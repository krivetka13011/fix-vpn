import type { BotEnv } from "../env";
import { clientBotToken, isTesterAccount } from "../env";
import {
  addPartnerBalance,
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
import {
  buildProtectedSubscriptionUrl,
  buildRedirectUrl,
  clientLabel,
  clientsForOs,
  defaultClientForOs,
  type VpnClientId,
} from "../connect-links";

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
  redirectByClient: Partial<Record<VpnClientId, string>>
) {
  const options = clientsForOs(os);
  return {
    inline_keyboard: options
      .map((client) => [
        {
          text: clientLabel(client),
          url: redirectByClient[client] || buildRedirectUrl(env, client, subId),
        },
      ])
      .concat([[{ text: "Назад", callback_data: "c:connect" }]]),
  };
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

function deviceLimitTotal(sub: { extra_devices?: number } | null | undefined): number {
  return 1 + Number(sub?.extra_devices || 0);
}

async function recordDeviceConnect(
  env: BotEnv,
  userId: string,
  os: string,
  vpnClient: VpnClientId
): Promise<void> {
  const label = `${osLabel(os)} · ${clientLabel(vpnClient)}`;
  await upsertVpnDeviceBinding(env, userId, os, vpnClient, label);
}

function formatPanelIpRows(ips: PanelDeviceIp[]): string {
  if (ips.length === 0) return "Нет записанных IP в панели.";
  return ips
    .map((row, index) => {
      const seen = row.seenAt ? ` · ${row.seenAt}` : "";
      return `${index + 1}. <code>${row.ip}</code>${seen}`;
    })
    .join("\n");
}

async function buildDevicesText(
  env: BotEnv,
  userId: string,
  clientEmail: string | null | undefined
): Promise<string> {
  const sub = await getSubscription(env, userId);
  const bindings = await listVpnDeviceBindings(env, userId);
  const limit = deviceLimitTotal(sub);
  const usedCount = Math.max(bindings.length, 0);
  let online = false;
  let panelIps: PanelDeviceIp[] = [];
  let lastOnlineMs = 0;

  if (clientEmail) {
    try {
      const xui = new XuiApi(env);
      const [ips, onlineEmails, lastOnlineMap] = await Promise.all([
        xui.getClientIps(clientEmail),
        xui.getOnlineClientEmails(),
        xui.getLastOnlineByEmail(),
      ]);
      panelIps = ips;
      online = onlineEmails.includes(clientEmail);
      lastOnlineMs = lastOnlineMap[clientEmail] || 0;
    } catch (error) {
      console.error("buildDevicesText:", error);
    }
  }

  const bindingLines =
    bindings.length > 0
      ? bindings
          .map((row, index) => {
            const status = online && index === 0 ? "в сети" : "не в сети";
            return (
              `${index + 1}. <b>${row.label}</b>\n` +
              `   Последний вход из бота: ${formatDateTime(row.last_seen_at)}\n` +
              `   Статус: ${status}`
            );
          })
          .join("\n\n")
      : "Пока нет устройств, подключённых через бота.\nВыберите «Подключить VPN» и укажите ОС — мы запомним её здесь.";

  const lastOnlineLine =
    lastOnlineMs > 0 ? `Последняя активность в панели: ${formatDateTime(lastOnlineMs)}\n` : "";

  return (
    `<b>Устройства</b>\n\n` +
    `Слоты: ${usedCount} / ${limit}\n` +
    `${lastOnlineLine}\n` +
    `<b>Известные устройства</b>\n${bindingLines}\n\n` +
    `<b>IP в панели</b>\n${formatPanelIpRows(panelIps)}\n\n` +
    `Панель различает устройства по IP. ОС мы показываем, если вы подключались через бота.`
  );
}

function devicesKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "Обновить список", callback_data: "c:devices" }],
      [{ text: "Сбросить все привязки", callback_data: "c:resetip" }],
      [{ text: "Назад в профиль", callback_data: "c:profile" }],
    ],
  };
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
  return buildProtectedSubscriptionUrl(env, subId);
}

function importInstructionsMessage(
  os: string,
  vpnClient: VpnClientId,
  openUrl: string
): { text: string; markup: Record<string, unknown> } {
  return {
    text:
      `<b>Импорт в ${clientLabel(vpnClient)} (${osLabel(os)})</b>\n\n` +
      `Нажмите кнопку ниже. Подписка защищена: ссылку и настройки серверов нельзя просмотреть или изменить.\n\n` +
      (vpnClient === "happ"
        ? `Удалите старые подписки «Encrypted» в Happ, затем нажмите кнопку снова.`
        : `Удалите старую подписку FIX VPN в ${clientLabel(vpnClient)}, затем импортируйте заново.`),
    markup: {
      inline_keyboard: [
        [{ text: `Открыть ${clientLabel(vpnClient)}`, url: openUrl }],
        [{ text: "Назад", callback_data: "c:connect" }],
      ],
    },
  };
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
  let sub = await getSubscription(env, user.id);
  const lockedSubId = sub?.xray_sub_id?.trim();
  const lockedUuid = sub?.xray_uuid?.trim();

  if (lockedSubId && lockedUuid) {
    try {
      const xui = new XuiApi(env);
      const panel = await xui.ensureLockedPanelClient(env, tg.id, sub);
      await patchSubscription(env, user.id, {
        client_email: panel.email,
        xray_sub_id: lockedSubId,
        xray_uuid: panel.primaryUuid,
        subscription_url: buildSubscriptionUrl(env, lockedSubId),
      });
    } catch (error) {
      console.error("resolvePanelSubId panel sync:", error);
    }
    return lockedSubId;
  }

  try {
    await ensureVpnClientOnStart(env, user, tg);
  } catch (error) {
    console.error("resolvePanelSubId ensure:", error);
  }
  sub = await getSubscription(env, user.id);
  return sub?.xray_sub_id?.trim() || null;
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
    let sub = await getSubscription(env, claimed.id);
    const panelSubId = await resolvePanelSubId(env, claimed, tg);
    sub = await getSubscription(env, claimed.id);
    if (!panelSubId || !sub?.client_email || !sub.xray_sub_id || !sub.xray_uuid) {
      throw new Error("клиент не подготовлен — нажмите /start");
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
      client_email: sub.client_email,
      xray_sub_id: sub.xray_sub_id,
      xray_uuid: sub.xray_uuid,
      subscription_url: subscriptionUrl,
    });
    await sendMessage(
      token,
      chatId,
      env.MSG_TRIAL_SUCCESS ||
        "Пробный период активирован. Откройте «Подключить VPN» в меню."
    );
  } catch (error) {
    if (!tester) await releaseTrialClaim(env, tg.id);
    const detail = error instanceof Error ? error.message : "unknown";
    console.error("activateTrial:", detail);
    await sendMessage(
      token,
      chatId,
      tester
        ? `Тест: ошибка активации — ${detail}`
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

async function showProfile(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId: number
): Promise<void> {
  const token = clientBotToken(env)!;
  const user = await upsertTelegramUser(env, tg);
  const sub = await getSubscription(env, user.id);
  const status = sub?.status || "none";
  const ends = sub?.ends_at ? `до ${sub.ends_at}` : "—";
  const text =
    `<b>Мой профиль</b>\n\n` +
    `Статус: ${status === "active" ? "активна" : status === "expired" ? "истекла" : "нет подписки"}\n` +
    `Подписка: ${sub?.plan_label || "—"} ${ends}\n` +
    `Устройства: ${deviceLimitTotal(sub)} слот(ов)\n\n` +
    `Ключи и UUID в чате не показываем.`;
  await editMessage(token, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "Мои устройства", callback_data: "c:devices" }],
      [{ text: "Назад", callback_data: "c:menu" }],
    ],
  });
}

async function showDevices(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId: number
): Promise<void> {
  const token = clientBotToken(env)!;
  const user = await upsertTelegramUser(env, tg);
  const sub = await getSubscription(env, user.id);
  const text = await buildDevicesText(env, user.id, sub?.client_email);
  await editMessage(token, chatId, messageId, text, devicesKeyboard());
}

async function resetDeviceBinding(
  env: BotEnv,
  tg: TelegramUser,
  chatId: number,
  messageId?: number
): Promise<void> {
  const token = clientBotToken(env)!;
  const user = await getUserByTelegramId(env, tg.id);
  if (!user) return;
  await resolvePanelSubId(env, user, tg);
  const sub = await getSubscription(env, user.id);
  if (!sub?.client_email) {
    await sendMessage(token, chatId, "Нет активного клиента в панели.");
    return;
  }
  try {
    const xui = new XuiApi(env);
    await xui.clearClientIps(sub.client_email);
    await clearVpnDeviceBindings(env, user.id);
    const text = await buildDevicesText(env, user.id, sub.client_email);
    const notice =
      `<b>Привязки сброшены</b>\n\n` +
      `IP-ограничения в панели очищены. Клиент и ссылка подписки в панели не удаляются — повторное подключение использует ту же ссылку.\n\n` +
      text;
    if (messageId) {
      await editMessage(token, chatId, messageId, notice, devicesKeyboard());
    } else {
      await sendMessage(token, chatId, notice, devicesKeyboard());
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.error("resetDeviceBinding:", detail);
    await sendMessage(
      token,
      chatId,
      `Не удалось сбросить привязки: ${detail}\nПопробуйте позже.`
    );
  }
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
    const txn = await getTransaction(env, txnId);
    if (!txn || txn.status !== "pending") return "Заявка не найдена";
    const user = await sbUserById(env, txn.user_id);
    if (!user) return "Пользователь не найден";
    const months = txn.billing_months as BillingMonths;
    const xui = new XuiApi(env);
    const sub = await getSubscription(env, user.id);
    const extendDays = months * 30;
    const baseMs =
      sub?.status === "active" && sub.ends_at
        ? new Date(`${sub.ends_at}T23:59:59`).getTime()
        : Date.now();
    const expiryMs = Math.max(Date.now(), baseMs) + extendDays * 24 * 60 * 60 * 1000;
    const provision = await xui.provisionUser(env, {
      userId: user.id,
      username: user.username,
      telegramId: user.telegram_id,
      expiryMs,
      dbSubscription: sub,
    });
    await persistProvision(env, user.id, provision, {
      status: "active",
      plan_type: "basic",
      plan_label: `Базовый · ${periodLabel(months)}`,
      billing_months: months,
      starts_at: sub?.starts_at || formatDateFromMs(Date.now()),
      ends_at: formatDateFromMs(expiryMs),
      is_trial: false,
    });
    if (txn.is_first_payment && user.ref_by_partner_id) {
      const commissionPct = Number(env.PARTNER_DEFAULT_COMMISSION_PERCENT || "50");
      const commission = Math.round((Number(txn.amount) * commissionPct) / 100);
      await addPartnerBalance(env, user.ref_by_partner_id, commission);
      await patchTransaction(env, txnId, {
        status: "approved",
        partner_commission_amount: commission,
      });
    } else {
      await patchTransaction(env, txnId, { status: "approved" });
    }
    if (!user.first_payment_done) {
      await patchUser(env, user.id, { first_payment_done: true });
    }
    const clientToken = clientBotToken(env);
    if (clientToken) {
      await sendMessage(
        clientToken,
        user.telegram_id,
        `Оплата подтверждена. Подписка продлена на ${periodLabel(months)}.`
      );
    }
    return "Подписка активирована";
  }

  if (data.startsWith("mgr:txn:no:")) {
    const txnId = data.slice("mgr:txn:no:".length);
    await patchTransaction(env, txnId, { status: "rejected" });
    return "Заявка отклонена";
  }

  return null;
}

async function sbUserById(env: BotEnv, userId: string) {
  const { sbJson, sbRequest } = await import("../supabase");
  const rows = await sbJson<Array<{ id: string; telegram_id: number; username: string | null; ref_by_partner_id: number | null; first_payment_done: boolean }>>(
    await sbRequest(env, `users?id=eq.${userId}&select=id,telegram_id,username,ref_by_partner_id,first_payment_done&limit=1`)
  );
  return rows[0] ?? null;
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
    if (data === "c:profile") {
      await showProfile(env, chatId, tg, messageId);
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "c:devices") {
      await answerCallback(token, cq.id, "Обновляем список…");
      await showDevices(env, chatId, tg, messageId);
      return;
    }
    if (data === "c:resetip") {
      await answerCallback(token, cq.id, "Сбрасываем привязки…");
      await resetDeviceBinding(env, tg, chatId, messageId);
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
        await editMessage(token, chatId, messageId, "Выберите ОС:", connectOsKeyboard());
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
      const openUrl = redirects[defaultClient];
      if (!openUrl) {
        await answerCallback(token, cq.id, "Импорт недоступен", { showAlert: true });
        return;
      }
      const linkMessage = importInstructionsMessage(os, defaultClient, openUrl);
      const text =
        `<b>Подключение VPN</b>\n\n` +
        `ОС: <b>${osLabel(os)}</b>\n` +
        (os === "android"
          ? `Нажмите <b>${clientLabel(defaultClient)}</b> ниже.\n` +
            `Ссылка подписки скрыта и защищена — импорт только через кнопку.\n\n`
          : `Открываем <b>${clientLabel(defaultClient)}</b>.\n` +
            `Ссылка подписки скрыта — импорт только через кнопку ниже.\n\n`) +
        `Если приложение не открылось — выберите клиент ниже:`;

      try {
        await editMessage(
          token,
          chatId,
          messageId,
          text,
          connectClientKeyboard(env, os, subId, redirects)
        );
      } catch (error) {
        console.error("connect os edit:", error);
        await sendMessage(
          token,
          chatId,
          text,
          connectClientKeyboard(env, os, subId, redirects)
        );
      }

      await recordDeviceConnect(env, user.id, os, defaultClient);
      await sendMessage(token, chatId, linkMessage.text, linkMessage.markup);

      if (os === "android") {
        await answerCallback(token, cq.id, `Нажмите ${clientLabel(defaultClient)} ниже`);
        return;
      }

      await answerCallback(token, cq.id, `Открываем ${clientLabel(defaultClient)}…`, {
        url: openUrl,
      });
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
    await showMainMenu(env, chatId, tg);
    try {
      await ensureVpnClientOnStart(env, user, tg);
    } catch (error) {
      console.error("ensureVpnClientOnStart:", error);
    }
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
