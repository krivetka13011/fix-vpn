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
  patchSubscription,
  patchTransaction,
  releaseTrialClaim,
  resetTesterSubscriptionState,
  resetTesterTrial,
  saveXuiInboundClients,
  setSession,
  upsertTelegramUser,
} from "../repository";
import { XuiApi } from "../xui";
import type { TelegramUser } from "../telegram";
import {
  answerCallback,
  editMessage,
  forwardMessage,
  sendMessage,
} from "./telegram-api";
import { periodLabel, type BillingMonths } from "./pricing";
import type { PlanType } from "../catalog";
import {
  calcCheckoutPrice,
  devicesKeyboard,
  devicesText,
  extraDevicesForTotal,
  includedDevices,
  parseCheckoutPayData,
  paymentMethodsKeyboard,
  paymentSummaryText,
  periodsKeyboard,
  tariffsKeyboard,
  tariffsText,
} from "./checkout-ui";
import { PRIVACY_POLICY_URL, SUPPORT_TELEGRAM_USERNAME, TERMS_OF_SERVICE_URL } from "../catalog";
import { managerTxnKeyboard, notifyManager } from "./manager";
import { handleManagerPartnerCallback } from "./partner-bot";
import { clearStuckRotationFlags } from "../subscription-rotate";
import {
  DeviceResetCooldownError,
  DeviceResetPanelError,
  deviceResetNotice,
  resetPanelClient,
} from "../device-reset";
import { approvePaidTransaction } from "../approve-transaction";
import {
  createCardlinkBill,
  shouldUseCardlink,
} from "../cardlink";
import { createPlategaPayment, shouldUsePlatega } from "../platega";
import {
  buildClientButtonUrl,
  buildPanelSubscriptionUrlForUser,
  clientLabel,
  clientsForOs,
  defaultClientForOs,
  type VpnClientId,
} from "../connect-links";
import { syncPanelSubIdForUser } from "../panel-sync";
import {
  canConnectNewDevice,
  fetchPanelDeviceIps,
  formatConnectedDevices,
  formatDeviceLimitLine,
  panelLimitIpForSubscription,
  subscriptionDeviceLimit,
  syncPanelDeviceLimit,
  telegramIdFromClientEmail,
} from "../device-limit";

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

/** Снимает «часики» Telegram сразу; повторный answerCallback на тот же id запрещён. */
async function safeAnswerCallback(
  token: string,
  callbackQueryId: string,
  text?: string,
  options?: { url?: string; showAlert?: boolean }
): Promise<void> {
  try {
    await answerCallback(token, callbackQueryId, text, options);
  } catch (error) {
    console.error("safeAnswerCallback:", error);
  }
}

function mainMenuText(displayName: string): string {
  return (
    `Привет, <b>${displayName}</b>! 👋\n` +
    `⚡️ VPN нового уровня\n\n` +
    `🌍 Свободный доступ к сайтам и сервисам\n` +
    `📞 Звонки и видео без ограничений\n` +
    `⚙️ Пробный период — 1 день\n` +
    `🔐 Полная защита и конфиденциальность\n` +
    `📶 Работает стабильно даже в мобильных сетях`
  );
}

/** Временно скрыта кнопка «Партнерство» в главном меню клиентского бота */
const SHOW_PARTNERSHIP_BUTTON = false;

function mainMenuKeyboard(env: BotEnv, hasUsedTrial: boolean) {
  const rows: Array<Array<Record<string, string>>> = [];
  if (!hasUsedTrial) {
    rows.push([{ text: "🧪 Пробный период", callback_data: "c:trial" }]);
  }
  rows.push(
    [{ text: "💳 Оформить подписку", callback_data: "c:buy" }],
    [{ text: "👤 Мой профиль", callback_data: "c:profile" }],
    [{ text: "🔌 Подключить VPN", callback_data: "c:connect" }],
    [{ text: "💬 Поддержка", callback_data: "c:support" }]
  );
  if (SHOW_PARTNERSHIP_BUTTON) {
    rows.push([
      {
        text: "🤝 Партнерство",
        url: `https://t.me/${env.PARTNER_BOT_USERNAME || "FIX_Partner_bot"}`,
      },
    ]);
  }
  return { inline_keyboard: rows };
}

function supportUsername(env: BotEnv): string {
  return (env.SUPPORT_TELEGRAM_USERNAME || SUPPORT_TELEGRAM_USERNAME).replace(/^@/, "");
}

function supportMenuKeyboard(env: BotEnv): Record<string, unknown> {
  const support = supportUsername(env);
  return {
    inline_keyboard: [
      [{ text: "👨‍💻 Написать менеджеру", url: `https://t.me/${support}` }],
      [{ text: "📄 Политика конфиденциальности", url: PRIVACY_POLICY_URL }],
      [{ text: "📋 Пользовательское соглашение", url: TERMS_OF_SERVICE_URL }],
      [{ text: "◀️ Назад", callback_data: "c:menu" }],
    ],
  };
}

async function showSupportMenu(
  env: BotEnv,
  chatId: number,
  messageId: number
): Promise<void> {
  const token = clientBotToken(env)!;
  const support = supportUsername(env);
  await editMessage(
    token,
    chatId,
    messageId,
    `<b>💬 Поддержка</b>\n\n` +
      `Контакты: @${support}\n` +
      `По вопросам оплаты, подключения и другим вопросам — напишите менеджеру.`,
    supportMenuKeyboard(env)
  );
}

function connectOsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🤖 Android", callback_data: "c:os:android" }],
      [{ text: "🍎 iOS", callback_data: "c:os:ios" }],
      [{ text: "🪟 Windows", callback_data: "c:os:windows" }],
      [{ text: "💻 macOS", callback_data: "c:os:macos" }],
      [{ text: "◀️ Назад", callback_data: "c:menu" }],
    ],
  };
}

function clientButtonEmoji(client: VpnClientId): string {
  const map: Record<VpnClientId, string> = {
    happ: "🚀",
    v2rayng: "⚡️",
    hiddify: "🛡",
    shadowrocket: "🛡",
  };
  return map[client] || "📲";
}

function connectClientKeyboard(
  env: BotEnv,
  os: string,
  subId: string,
  defaultClient: VpnClientId,
  redirectByClient: Partial<Record<VpnClientId, string>>
) {
  const options = clientsForOs(os);
  const rows: Array<Array<{ text: string; url?: string; callback_data?: string }>> = [];
  for (const client of options) {
    const emoji = clientButtonEmoji(client);
    const label =
      client === "happ"
        ? `${emoji} Открыть Happ`
        : client === "v2rayng"
          ? `${emoji} V2rayNG`
          : client === "hiddify"
            ? `${emoji} Hiddify`
            : `${emoji} ${clientLabel(client)}`;
    rows.push([
      {
        text: label,
        url: redirectByClient[client] || buildClientButtonUrl(env, client, subId),
      },
    ]);
  }
  rows.push([{ text: "◀️ Назад", callback_data: "c:connect" }]);
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
  userId: string
): Promise<void> {
  await syncPanelDeviceLimit(env, userId);
}

function buildProfileKeyboard(
  hasClient: boolean,
  planType?: string | null
): Record<string, unknown> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  if (hasClient) {
    rows.push([{ text: "🔄 Сбросить подключение", callback_data: "c:resetip" }]);
  }
  if (planType === "basic" || !planType) {
    rows.push([{ text: "➕ Докупить устройства", callback_data: "c:buy" }]);
  }
  rows.push([{ text: "◀️ Назад", callback_data: "c:menu" }]);
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

function connectOsMessage(os: string): string {
  return (
    `ОС: <b>${osLabel(os)}</b>\n` +
    `Нажмите кнопку нужного приложения ниже для автоматического импорта подписки.\n\n` +
    `⚠️ Удалите все старые подписки перед импортом.`
  );
}

function buildConnectRedirects(
  env: BotEnv,
  os: string,
  subId: string
): Partial<Record<VpnClientId, string>> {
  const redirects: Partial<Record<VpnClientId, string>> = {};
  for (const client of clientsForOs(os)) {
    redirects[client] = buildClientButtonUrl(env, client, subId);
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
      client_email: String(tg.id),
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
  return syncPanelSubIdForUser(
    env,
    user.id,
    tg.id,
    user.username,
    user.display_name,
    sub
  );
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
      displayName: user.display_name,
      telegramId: tg.id,
      limitIp: panelLimitIpForSubscription(sub),
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
  const text = mainMenuText(user.display_name);
  const markup = mainMenuKeyboard(env, Boolean(user.has_used_trial));
  if (messageId) {
    await editMessage(token, chatId, messageId, text, markup);
  } else {
    await sendMessage(token, chatId, text, markup);
  }
}

async function activateTrial(
  env: BotEnv,
  tg: TelegramUser,
  chatId: number,
  messageId?: number
): Promise<void> {
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

  const TRIAL_MS = 24 * 60 * 60 * 1000;
  const expiryMs = Date.now() + TRIAL_MS;

  try {
    await ensureVpnClientOnStart(env, claimed, tg);
    let sub = await getSubscription(env, claimed.id);

    const xui = new XuiApi(env);
    await xui.provisionUser(env, {
      userId: claimed.id,
      username: claimed.username ?? tg.username ?? null,
      displayName: claimed.display_name,
      telegramId: tg.id,
      expiryMs,
      limitIp: 1,
      dbSubscription: sub,
    });

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
      plan_label: "Пробный · 24 ч",
      billing_months: 0,
      starts_at: formatDateFromMs(Date.now()),
      ends_at: formatDateFromMs(expiryMs),
      is_trial: true,
      extra_devices: 0,
      client_email: String(tg.id),
      xray_sub_id: sub.xray_sub_id,
      xray_uuid: sub.xray_uuid,
      subscription_url: subscriptionUrl,
    });

    const text =
      `Пробный период на 24 часа успешно активирован! 🎉\n\n` +
      `Выберите операционную систему вашего устройства для настройки подключения:`;
    const markup = connectOsKeyboard();
    if (messageId) {
      await editMessage(token, chatId, messageId, text, markup);
    } else {
      await sendMessage(token, chatId, text, markup);
    }
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
  const telegramId = telegramIdFromClientEmail(sub?.client_email) ?? tg.id;
  const panelIps = await fetchPanelDeviceIps(env, telegramId);

  const limit = subscriptionDeviceLimit(sub);
  const used = panelIps.length;
  const hasClient = Boolean(sub?.client_email?.trim());
  const status = sub?.status || "none";
  const period = formatSubscriptionPeriod(sub?.starts_at, sub?.ends_at, sub?.plan_label);
  const statusLabel =
    status === "active"
      ? sub?.is_trial
        ? "Пробный период"
        : sub?.plan_type === "personal"
          ? "Активен (Про)"
          : "Активен (Базовый)"
      : status === "expired"
        ? "Истёк"
        : "нет подписки";

  const deviceLine = formatDeviceLimitLine(used, limit, sub?.plan_type);
  const ipLines = formatConnectedDevices(
    panelIps,
    user.username ?? tg.username ?? null,
    telegramId
  );

  const hint =
    "Смена устройства: Нажмите «Сбросить подключение» (доступно 1 раз в 24 часа), если вы купили новый телефон или переустановили приложение.";

  const text =
    (notice ? `${notice}\n\n` : "") +
    `👤 <b>Мой профиль</b>\n\n` +
    `Статус: ${statusLabel}\n` +
    `Период: ${period}\n` +
    `${deviceLine}${ipLines}\n\n` +
    hint;

  await editMessage(
    token,
    chatId,
    messageId,
    text,
    buildProfileKeyboard(hasClient, sub?.plan_type)
  );
}

async function resetDeviceBinding(
  env: BotEnv,
  tg: TelegramUser,
  chatId: number,
  messageId: number
): Promise<void> {
  const user = await getUserByTelegramId(env, tg.id);
  if (!user) return;

  await resetPanelClient(env, user.id, {
    telegramId: tg.id,
    isTester: user.is_tester,
  });

  await showProfile(
    env,
    chatId,
    tg,
    messageId,
    `<b>${deviceResetNotice()}</b>`
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
      await safeAnswerCallback(token, cq.id);
      const note =
        (await handleManagerClientCallback(env, data, tg.id)) ||
        (await handleManagerPartnerCallback(env, data, tg.id));
      if (note) {
        await sendMessage(token, chatId, note);
      }
      return;
    }

    if (data === "c:support") {
      await safeAnswerCallback(token, cq.id);
      await showSupportMenu(env, chatId, messageId);
      return;
    }
    if (data === "c:menu") {
      await safeAnswerCallback(token, cq.id);
      await showMainMenu(env, chatId, tg, messageId);
      return;
    }
    if (data === "c:trial") {
      await safeAnswerCallback(token, cq.id, "Активируем пробный период…");
      await activateTrial(env, tg, chatId, messageId);
      return;
    }
    if (data === "c:buy") {
      await safeAnswerCallback(token, cq.id);
      await editMessage(token, chatId, messageId, tariffsText(), tariffsKeyboard());
      return;
    }
    if (data.startsWith("c:plan:")) {
      await safeAnswerCallback(token, cq.id);
      const plan = data.split(":")[2] as PlanType;
      await editMessage(
        token,
        chatId,
        messageId,
        "Выберите период:",
        periodsKeyboard(plan)
      );
      return;
    }
    if (data.startsWith("c:period:")) {
      await safeAnswerCallback(token, cq.id);
      const parts = data.split(":");
      const plan = parts[2] as PlanType;
      const months = Number(parts[3]) as BillingMonths;
      if (plan === "personal") {
        await editMessage(
          token,
          chatId,
          messageId,
          paymentSummaryText(plan, months, 0),
          paymentMethodsKeyboard(plan, months, 0)
        );
        return;
      }
      const defaultDevices = includedDevices();
      await editMessage(
        token,
        chatId,
        messageId,
        devicesText(plan, months, defaultDevices),
        devicesKeyboard(plan, months, defaultDevices)
      );
      return;
    }
    if (data.startsWith("c:dev:")) {
      await safeAnswerCallback(token, cq.id);
      const [, , planRaw, monthsRaw, devicesRaw, promoRaw] = data.split(":");
      const plan = planRaw as PlanType;
      const months = Number(monthsRaw) as BillingMonths;
      const totalDevices = Number(devicesRaw);
      const promo = Number(promoRaw || "0");
      await editMessage(
        token,
        chatId,
        messageId,
        devicesText(plan, months, totalDevices, promo),
        devicesKeyboard(plan, months, totalDevices, promo)
      );
      return;
    }
    if (data.startsWith("c:checkout:")) {
      await safeAnswerCallback(token, cq.id);
      const [, , planRaw, monthsRaw, devicesRaw, promoRaw] = data.split(":");
      const plan = planRaw as PlanType;
      const months = Number(monthsRaw) as BillingMonths;
      const totalDevices = Number(devicesRaw);
      const promo = Number(promoRaw || "0");
      await editMessage(
        token,
        chatId,
        messageId,
        paymentSummaryText(plan, months, totalDevices, promo),
        paymentMethodsKeyboard(plan, months, totalDevices, promo)
      );
      return;
    }
    if (data.startsWith("c:promo:")) {
      await safeAnswerCallback(token, cq.id);
      const parts = data.split(":");
      const plan = parts[2] as PlanType;
      const months = Number(parts[3]) as BillingMonths;
      const totalDevices = Number(parts[4] || includedDevices());
      await setSession(env, tg.id, "client", "await_promo", {
        plan,
        months,
        totalDevices,
      });
      await editMessage(token, chatId, messageId, "🎟 Введите промокод сообщением:");
      return;
    }
    if (data.startsWith("c:pay:")) {
      await safeAnswerCallback(token, cq.id);
      const parsed = parseCheckoutPayData(data);
      if (!parsed) return;
      const { method, plan, months, promo, totalDevices } = parsed;
      const extraDevices = plan === "personal" ? 0 : extraDevicesForTotal(totalDevices);
      const price = calcCheckoutPrice(plan, months, extraDevices, promo);
      const user = await upsertTelegramUser(env, tg);
      const txn = await createTransaction(env, {
        user_id: user.id,
        amount: price,
        billing_months: months,
        plan_type: plan,
        extra_devices: extraDevices,
        payment_method: method,
        status: "pending",
        is_first_payment: !Boolean(user.first_payment_done),
      });

      if (shouldUsePlatega(env, method)) {
        try {
          const payment = await createPlategaPayment(env, {
            amount: price,
            orderId: txn.id,
            description: `FIX VPN · ${plan} · ${periodLabel(months)}`,
            method,
            telegramId: tg.id,
            username: tg.username,
          });
          await patchTransaction(env, txn.id, {
            platega_transaction_id: payment.transactionId,
            payment_url: payment.redirect,
          });
          await editMessage(
            token,
            chatId,
            messageId,
            `Оплата FIX VPN: <b>${price} ₽</b>\n\n` +
              `Нажмите кнопку ниже — откроется безопасная форма оплаты.\n` +
              `После оплаты подписка активируется автоматически.`,
            {
              inline_keyboard: [
                [{ text: "💳 Оплатить", url: payment.redirect }],
                [{ text: "◀️ Назад", callback_data: "c:menu" }],
              ],
            }
          );
        } catch (error) {
          console.error("platega payment:", error);
          await editMessage(
            token,
            chatId,
            messageId,
            `Не удалось создать ссылку на оплату.\n` +
              `${error instanceof Error ? error.message : "ошибка Platega"}\n\n` +
              `Попробуйте позже или выберите другой способ.`,
            { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:buy" }]] }
          );
        }
        return;
      }

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
            `Оплата FIX VPN: <b>${price} ₽</b> · ${periodLabel(months)} · ${totalDevices} устр.\n\n` +
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
        return;
      }

      await setSession(env, tg.id, "client", "await_receipt", {
        txnId: txn.id,
      });
      await editMessage(
        token,
        chatId,
        messageId,
        `Заявка создана: <b>${price} ₽</b> · ${periodLabel(months)} · ${totalDevices} устр. · ${method.toUpperCase()}\n\n` +
          `Менеджер отправит реквизиты. После оплаты пришлите <b>скриншот</b> и укажите <b>имя отправителя</b> отдельным сообщением.`,
        { inline_keyboard: [[{ text: "Назад", callback_data: "c:menu" }]] }
      );
      await notifyManager(
        env,
        `Оплата FIX VPN\n` +
          `Пользователь: @${tg.username || "—"} (${tg.id})\n` +
          `Сумма: ${price} ₽\n` +
          `Период: ${periodLabel(months)}\n` +
          `Устройств: ${totalDevices}\n` +
          `Способ: ${method}\n` +
          `Первая оплата: ${!user.first_payment_done ? "да" : "нет"}`,
        managerTxnKeyboard(txn.id)
      );
      return;
    }
    if (data === "c:profile" || data === "c:devices") {
      await safeAnswerCallback(token, cq.id);
      await showProfile(env, chatId, tg, messageId);
      return;
    }
    if (data === "c:resetip") {
      const user = await getUserByTelegramId(env, tg.id);
      if (!user) {
        await safeAnswerCallback(token, cq.id, "Пользователь не найден", { showAlert: true });
        return;
      }
      await safeAnswerCallback(token, cq.id, "Сбрасываем подключение…");
      try {
        await resetDeviceBinding(env, tg, chatId, messageId);
      } catch (error) {
        if (error instanceof DeviceResetCooldownError) {
          await showProfile(env, chatId, tg, messageId, `<b>${error.message}</b>`);
          return;
        }
        if (error instanceof DeviceResetPanelError) {
          await showProfile(env, chatId, tg, messageId, `<b>${error.message}</b>`);
          return;
        }
        const message =
          error instanceof Error ? error.message : "Не удалось сбросить подключение";
        await showProfile(env, chatId, tg, messageId, `<b>${message}</b>`);
      }
      return;
    }
    if (data === "c:connect") {
      await safeAnswerCallback(token, cq.id);
      const user = await upsertTelegramUser(env, tg);
      const gate = await canConnectNewDevice(env, user.id, tg.id);
      if (!gate.ok) {
        await editMessage(
          token,
          chatId,
          messageId,
          gate.message,
          { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:menu" }]] }
        );
        return;
      }
      await resolvePanelSubId(env, user, tg);
      await editMessage(
        token,
        chatId,
        messageId,
        "Выберите ОС:",
        connectOsKeyboard()
      );
      return;
    }
    if (data.startsWith("c:os:")) {
      const os = data.split(":")[2];
      const user = await upsertTelegramUser(env, tg);
      const sub = await getSubscription(env, user.id);
      if (sub?.status !== "active") {
        await safeAnswerCallback(token, cq.id, "Сначала активируйте подписку", { showAlert: true });
        return;
      }

      const gate = await canConnectNewDevice(env, user.id, tg.id);
      if (!gate.ok) {
        await safeAnswerCallback(token, cq.id, gate.message.replace(/<[^>]+>/g, ""), {
          showAlert: true,
        });
        return;
      }

      await safeAnswerCallback(token, cq.id);

      const subId = await resolvePanelSubId(env, user, tg);
      if (!subId) {
        await editMessage(
          token,
          chatId,
          messageId,
          "Ссылка подписки временно недоступна. Подождите минуту и попробуйте снова.",
          { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:connect" }]] }
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
        await editMessage(
          token,
          chatId,
          messageId,
          "Не удалось подготовить импорт. Повторите позже.",
          { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:connect" }]] }
        );
        return;
      }
      if (!redirects[defaultClient]) {
        await editMessage(
          token,
          chatId,
          messageId,
          "Импорт недоступен. Повторите позже.",
          { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:connect" }]] }
        );
        return;
      }

      const text = connectOsMessage(os);
      const markup = connectClientKeyboard(env, os, subId, defaultClient, redirects);

      try {
        await editMessage(token, chatId, messageId, text, markup);
      } catch (error) {
        console.error("connect os edit:", error);
        await sendMessage(token, chatId, text, markup);
      }

      await recordDeviceConnect(env, user.id);
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
      const sub = await getSubscription(env, user.id);
      await syncPanelSubIdForUser(
        env,
        user.id,
        tg.id,
        user.username,
        user.display_name,
        sub
      );
      const xui = new XuiApi(env);
      await xui.forceEnableClient(tg.id, String(tg.id));
    } catch (error) {
      console.error("start panel sync:", error);
    }
    return;
  }

  const session = await getSession(env, tg.id, "client");
  if (session?.state === "await_promo" && text) {
    const plan = (session.payload.plan || "basic") as PlanType;
    const months = Number(session.payload.months || 1) as BillingMonths;
    const totalDevices = Number(session.payload.totalDevices || includedDevices());
    const promo = await getPromoByCode(env, text.toUpperCase());
    await clearSession(env, tg.id, "client");
    const discount = promo?.discount_percent || 0;
    const price = calcCheckoutPrice(
      plan,
      months,
      extraDevicesForTotal(totalDevices),
      discount
    );
    await sendMessage(
      token,
      chatId,
      promo
        ? `🎟 Промокод принят: -${discount}%. Итого <b>${price} ₽</b>.`
        : "Промокод не найден. Выберите способ оплаты без скидки:",
      paymentMethodsKeyboard(plan, months, totalDevices, discount)
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
