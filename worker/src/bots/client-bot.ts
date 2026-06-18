import type { BotEnv } from "../env";
import { clientBotToken } from "../env";
import {
  clearSession,
  createTransaction,
  checkCallbackRateLimit,
  finalizeTrialButtonGrace,
  getPartner,
  getPromoByCode,
  getSession,
  getSubscription,
  getUserByTelegramId,
  getTransaction,
  markTrialFirstConnectAt,
  patchSubscription,
  patchTransaction,
  resetTesterTrialPlan,
  setSession,
  upsertTelegramUser,
  upsertVpnDeviceBinding,
} from "../repository";
import { trialButtonHidden } from "../trial-button";
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
import { resolvePaymentBackend } from "../payment-routing";
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
  createPlategaPayment,
  isPlategaConfigured,
} from "../platega";
import {
  buildClientButtonUrl,
  buildPanelSubscriptionUrlForUser,
  clientLabel,
  defaultClientForOs,
  type VpnClientId,
} from "../connect-links";
import { syncPanelSubIdForUser } from "../panel-sync";
import { formatSubscriptionPeriodMsk } from "../datetime-msk";
import { escapeTelegramHtml } from "../telegram-html";
import {
  activateTrialSubscription,
  ensurePanelClientRecord,
} from "../subscription-activate";
import {
  formatSubscriptionDateFields,
  isTestMode,
  trialDurationMs,
} from "../test-mode";
import {
  canConnectNewDevice,
  countUsedDeviceSlots,
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
  const safeName = escapeTelegramHtml(displayName);
  return (
    `Привет, <b>${safeName}</b>! 👋\n` +
    `⚡️ VPN нового уровня\n` +
    `🌍 Свободный доступ к сайтам и сервисам\n` +
    `📞 Звонки и видео без ограничений\n` +
    `⚙️ Пробный период — 1 день\n` +
    `🔐 Полная защита и конфиденциальность\n` +
    `📶 Работает стабильно даже в мобильных сетях`
  );
}

function mainMenuKeyboard(env: BotEnv, hasUsedTrial: boolean) {
  const rows: Array<Array<Record<string, string>>> = [];
  if (!hasUsedTrial) {
    rows.push([{ text: "🧪 Пробный период", callback_data: "c:trial" }]);
  }
  rows.push(
    [{ text: "💳 Оформить подписку", callback_data: "c:buy" }],
    [{ text: "👤 Мой профиль", callback_data: "c:profile" }],
    [{ text: "🔌 Подключить VPN", callback_data: "c:connect" }],
    [{ text: "💬 Поддержка", callback_data: "c:support" }],
    [
      {
        text: "🤝 Партнёрство",
        url: `https://t.me/${env.PARTNER_BOT_USERNAME || "FIX_Partner_bot"}`,
      },
    ]
  );
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
    `💬 Поддержка\n\n` +
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

async function showConnectOsMenu(
  token: string,
  chatId: number,
  messageId?: number
): Promise<void> {
  const text = "Выберите ОС:";
  const markup = connectOsKeyboard();
  try {
    if (messageId) {
      await editMessage(token, chatId, messageId, text, markup, undefined);
    } else {
      await sendMessage(token, chatId, text, markup, undefined);
    }
  } catch (error) {
    console.error("showConnectOsMenu:", error);
    await sendMessage(token, chatId, text, markup, undefined);
  }
}

async function waitForSubscriptionReady(
  env: BotEnv,
  userId: string,
  attempts = 24,
  delayMs = 500
) {
  for (let i = 0; i < attempts; i += 1) {
    const sub = await getSubscription(env, userId);
    if (sub?.status === "active" && sub.xray_sub_id?.trim()) return sub;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return getSubscription(env, userId);
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

const CONNECT_APP_CLIENTS: VpnClientId[] = ["happ", "v2rayng", "hiddify"];

function connectClientKeyboard(
  env: BotEnv,
  os: string,
  subId: string,
  defaultClient: VpnClientId,
  redirectByClient: Partial<Record<VpnClientId, string>>
) {
  void os;
  const rows: Array<Array<{ text: string; url?: string; callback_data?: string }>> = [];
  for (const client of CONNECT_APP_CLIENTS) {
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
  return Math.floor(Date.now() + days * 24 * 60 * 60 * 1000);
}

function deviceBindingLabel(os: string, vpnClient: string): string {
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
  tg: TelegramUser,
  os: string,
  vpnClient: VpnClientId
): Promise<void> {
  const label = deviceBindingLabel(os, vpnClient);
  await upsertVpnDeviceBinding(env, userId, os, vpnClient, label);
  await syncPanelDeviceLimit(env, userId);

  const sub = await getSubscription(env, userId);
  if (sub?.is_trial) {
    await markTrialFirstConnectAt(env, tg.id);
  }
}

function buildProfileKeyboard(
  hasClient: boolean,
  sub?: {
    status?: string | null;
    plan_type?: string | null;
    is_trial?: boolean | null;
  } | null
): Record<string, unknown> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  if (hasClient) {
    rows.push([{ text: "🔄 Сбросить подключение", callback_data: "c:resetip" }]);
  }
  const showAddDevices =
    sub?.status === "active" && sub?.plan_type === "basic" && !sub?.is_trial;
  if (showAddDevices) {
    rows.push([{ text: "➕ Докупить устройства", callback_data: "c:adddevices" }]);
  }
  rows.push([{ text: "◀️ Назад", callback_data: "c:menu" }]);
  return { inline_keyboard: rows };
}

function connectOsMessage(os: string): string {
  return (
    `ОС: <b>${osLabel(os)}</b>\n` +
    `Нажмите кнопку нужного приложения ниже для автоматического импорта подписки.\n\n` +
    `⚠️ Удалите все старые подписки перед импортом.`
  );
}

function buildSubscriptionUrl(env: BotEnv, subId: string): string {
  return buildPanelSubscriptionUrlForUser(env, subId);
}

function buildConnectRedirects(
  env: BotEnv,
  os: string,
  subId: string
): Partial<Record<VpnClientId, string>> {
  void os;
  const redirects: Partial<Record<VpnClientId, string>> = {};
  for (const client of CONNECT_APP_CLIENTS) {
    redirects[client] = buildClientButtonUrl(env, client, subId);
  }
  return redirects;
}

async function syncSubscriptionFromPanel(
  env: BotEnv,
  userId: string,
  tg: TelegramUser
): Promise<string | null> {
  const user = await getUserByTelegramId(env, tg.id);
  const sub = await getSubscription(env, userId);
  const lockedSubId = sub?.xray_sub_id?.trim();

  try {
    const xui = new XuiApi(env);

    const panelClient = lockedSubId
      ? await xui.ensureLockedPanelClient(
          env,
          tg.id,
          sub,
          user?.username ?? tg.username ?? null,
          user?.display_name ?? tg.first_name
        )
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

async function activateTrial(
  env: BotEnv,
  tg: TelegramUser,
  chatId: number,
  messageId?: number
): Promise<void> {
  const token = clientBotToken(env);
  if (!token) return;
  const user = await upsertTelegramUser(env, tg);

  if (user.has_used_trial) {
    await sendMessage(
      token,
      chatId,
      env.MSG_TRIAL_ALREADY_USED ||
        "Пробный период уже использован на этом аккаунте Telegram."
    );
    return;
  }

  const existingSub = await getSubscription(env, user.id);
  if (existingSub?.is_trial) {
    if (existingSub.status === "active") {
      await showConnectOsMenu(token, chatId, messageId);
      return;
    }
    await sendMessage(
      token,
      chatId,
      env.MSG_TRIAL_ALREADY_USED ||
        "Пробный период уже использован на этом аккаунте Telegram."
    );
    return;
  }

  const TRIAL_MS = trialDurationMs(env);
  const expiryMs = Math.floor(Date.now() + TRIAL_MS);
  const trialPlanLabel = isTestMode(env)
    ? `Пробный · ${Math.round(TRIAL_MS / 60000)} мин`
    : "Пробный · 24 ч";
  const trialDates = formatSubscriptionDateFields(expiryMs);

  if (messageId) {
    try {
      await editMessage(
        token,
        chatId,
        messageId,
        "⏳ Активируем пробный период…",
        undefined,
        undefined
      );
    } catch {
      /* ignore */
    }
  }

  const failText =
    "Не удалось активировать пробный период в панели. Подождите минуту и нажмите «Пробный период» снова.";

  try {
    await activateTrialSubscription(env, {
      userId: user.id,
      telegramId: tg.id,
      username: user.username ?? tg.username ?? null,
      displayName: user.display_name,
      expiryMs,
      dbSubscription: existingSub,
      subscriptionFields: {
        status: "active",
        plan_type: "basic",
        plan_label: trialPlanLabel,
        billing_months: 0,
        starts_at: trialDates.starts_at,
        ends_at: trialDates.ends_at,
        expires_at: trialDates.expires_at,
        purchased_at: trialDates.purchased_at,
        expiry_warned_at: null,
        is_trial: true,
        extra_devices: 0,
      },
    });
    await showConnectOsMenu(token, chatId, messageId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.error("activateTrial:", detail);

    const subAfter = await getSubscription(env, user.id);
    if (subAfter?.status === "active" && subAfter.is_trial) {
      await showConnectOsMenu(token, chatId, messageId);
      return;
    }

    if (isTestMode(env)) {
      await resetTesterTrialPlan(env, user.id);
    }

    const errorText =
      detail.includes("не ответила вовремя") || detail.includes("timeout")
        ? `${failText}\n\nПричина: панель отвечает слишком долго.`
        : failText;

    if (messageId) {
      try {
        await editMessage(token, chatId, messageId, errorText, {
          inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:menu" }]],
        }, undefined);
        return;
      } catch {
        /* fall through */
      }
    }
    await sendMessage(token, chatId, errorText);
  }
}

async function showMainMenu(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId?: number
): Promise<void> {
  const token = clientBotToken(env);
  if (!token) {
    console.error("showMainMenu: missing CLIENT_BOT_TOKEN");
    return;
  }
  const user = await upsertTelegramUser(env, tg);
  const freshUser = (await finalizeTrialButtonGrace(env, tg.id)) ?? user;
  const sub = await getSubscription(env, freshUser.id);
  const text = mainMenuText(freshUser.display_name);
  const markup = mainMenuKeyboard(env, trialButtonHidden(freshUser, sub));
  try {
    if (messageId) {
      await editMessage(token, chatId, messageId, text, markup);
    } else {
      await sendMessage(token, chatId, text, markup);
    }
  } catch (error) {
    console.error("showMainMenu:", error);
    const plain = `Привет, ${freshUser.display_name}! Выберите действие:`;
    if (messageId) {
      await editMessage(token, chatId, messageId, plain, markup, undefined);
    } else {
      await sendMessage(token, chatId, plain, markup, undefined);
    }
  }
}

function formatSubscriptionPeriod(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  planLabel: string | null | undefined,
  expiresAt?: string | null,
  purchasedAt?: string | null,
  durationMs?: number
): string {
  return formatSubscriptionPeriodMsk({
    startsAt,
    endsAt,
    expiresAt,
    purchasedAt,
    planLabel,
    durationMs,
  });
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
  const limit = subscriptionDeviceLimit(sub);
  const used = await countUsedDeviceSlots(env, telegramId, user.id);
  const hasClient = Boolean(sub?.client_email?.trim());
  const status = sub?.status || "none";
  const period = formatSubscriptionPeriod(
    sub?.starts_at,
    sub?.ends_at,
    sub?.plan_label,
    sub?.expires_at,
    sub?.purchased_at,
    sub?.is_trial ? trialDurationMs(env) : undefined
  );
  const statusLabel =
    status === "active"
      ? sub?.is_trial
        ? "Пробный период"
        : sub?.plan_type === "personal"
          ? "Активен (Про)"
          : "Активен (Базовый)"
      : "Истёк";

  const deviceLine = formatDeviceLimitLine(used, limit, sub?.plan_type);

  const hint =
    "Смена устройства: Нажмите «Сбросить подключение» (доступно 1 раз в 24 часа), если вы купили новый телефон или переустановили приложение.";

  const text =
    (notice ? `${notice}\n\n` : "") +
    `👤 Мой профиль\n` +
    `Статус: ${statusLabel}\n` +
    `Период: ${period}\n` +
    `${deviceLine}\n` +
    hint;

  await editMessage(
    token,
    chatId,
    messageId,
    text,
    buildProfileKeyboard(hasClient, sub)
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
  if (!token) {
    console.error("handleClientBotUpdate: missing CLIENT_BOT_TOKEN");
    return;
  }

  try {
    await handleClientBotUpdateInner(env, update, token);
  } catch (error) {
    console.error("handleClientBotUpdate:", error);
  }
}

async function handleClientBotUpdateInner(
  env: BotEnv,
  update: TgUpdate,
  token: string
): Promise<void> {
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
      if (!(await checkCallbackRateLimit(env, tg.id, "trial"))) {
        await safeAnswerCallback(token, cq.id);
        return;
      }
      await safeAnswerCallback(token, cq.id);
      await activateTrial(env, tg, chatId, messageId);
      return;
    }
    if (data === "c:buy" || data === "c:adddevices") {
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
        periodsKeyboard(env, plan)
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
          paymentSummaryText(env, plan, months, 0),
          paymentMethodsKeyboard(plan, months, 0)
        );
        return;
      }
      const defaultDevices = includedDevices();
      await editMessage(
        token,
        chatId,
        messageId,
        devicesText(env, plan, months, defaultDevices),
        devicesKeyboard(env, plan, months, defaultDevices)
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
        devicesText(env, plan, months, totalDevices, promo),
        devicesKeyboard(env, plan, months, totalDevices, promo)
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
        paymentSummaryText(env, plan, months, totalDevices, promo),
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
      const price = calcCheckoutPrice(plan, months, extraDevices, promo, env);
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

      const backend = resolvePaymentBackend(env, method);

      const showPaymentMessage = async (url: string, provider: string) => {
        await editMessage(
          token,
          chatId,
          messageId,
          `Оплата FIX VPN: <b>${price} ₽</b>${totalDevices > 1 ? ` · ${totalDevices} устр.` : ""}\n\n` +
            `Нажмите кнопку ниже — откроется безопасная форма ${provider}.\n` +
            `После оплаты подписка активируется автоматически.`,
          {
            inline_keyboard: [
              [{ text: "💳 Оплатить", url }],
              [{ text: "◀️ Назад", callback_data: "c:menu" }],
            ],
          }
        );
      };

      const showPaymentError = async (detail: string) => {
        const hint = isPlategaConfigured(env)
          ? detail
          : `${detail}\n\nОплата не настроена: задайте PLATEGA_MERCHANT_ID и PLATEGA_API_SECRET.`;
        await editMessage(
          token,
          chatId,
          messageId,
          `Не удалось создать ссылку на оплату.\n${hint}\n\n` +
            `Попробуйте другой способ или напишите в поддержку.`,
          { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:buy" }]] }
        );
      };

      if (backend === "platega") {
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
          await showPaymentMessage(payment.redirect, "Platega");
        } catch (error) {
          console.error("platega payment:", error);
          await showPaymentError(
            error instanceof Error ? error.message : "ошибка Platega"
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
      if (!(await checkCallbackRateLimit(env, tg.id, "connect"))) {
        await safeAnswerCallback(token, cq.id);
        return;
      }
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
      await safeAnswerCallback(token, cq.id);
      const user = await upsertTelegramUser(env, tg);
      let sub = await waitForSubscriptionReady(env, user.id);
      if (sub?.status !== "active") {
        await editMessage(
          token,
          chatId,
          messageId,
          "Сначала активируйте подписку или пробный период.",
          { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:menu" }]] }
        );
        return;
      }

      const gate = await canConnectNewDevice(env, user.id, tg.id);
      if (!gate.ok) {
        await editMessage(
          token,
          chatId,
          messageId,
          gate.message,
          { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "c:connect" }]] }
        );
        return;
      }

      let subId = sub.xray_sub_id?.trim() || null;
      if (!subId) {
        subId = await resolvePanelSubId(env, user, tg);
      }
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

      await recordDeviceConnect(env, user.id, tg, os, defaultClient);
      return;
    }
    return;
  }

  const message = update.message;
  if (!message?.from || !message.text && !message.photo) return;
  const tg = message.from;
  const chatId = message.chat.id;
  const text = message.text?.trim() || "";

  if (text.startsWith("/start")) {
    try {
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
      const sub = await getSubscription(env, user.id);
      const hasPanelBinding = Boolean(
        sub?.xray_sub_id?.trim() && sub?.xray_uuid?.trim()
      );
      if (!hasPanelBinding) {
        await ensurePanelClientRecord(env, {
          userId: user.id,
          telegramId: tg.id,
          username: user.username,
          displayName: user.display_name,
          dbSubscription: sub,
          enableClient: true,
        });
      } else if (sub?.status === "active") {
        await syncPanelSubIdForUser(
          env,
          user.id,
          tg.id,
          user.username,
          user.display_name,
          sub
        );
      }
    } catch (error) {
      console.error("/start:", error);
      await sendMessage(
        token,
        chatId,
        "Привет! Что-то пошло не так — попробуйте /start ещё раз.",
        undefined,
        undefined
      );
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
      discount,
      env
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
