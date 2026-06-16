import type { BotEnv } from "./env";
import { clientBotToken } from "./env";
import { sendMessage } from "./bots/telegram-api";
import { panelLimitIpForSubscription, syncPanelDeviceLimit } from "./device-limit";
import {
  getSubscription,
  getUserByTelegramId,
  patchSubscription,
} from "./repository";
import { XuiApi } from "./xui";

/** Бонусные дни: [период мес.] → реферер / друг. */
export const REFERRAL_BONUS_BY_MONTHS: Record<
  number,
  { referrerDays: number; refereeDays: number }
> = {
  1: { referrerDays: 3, refereeDays: 1 },
  3: { referrerDays: 5, refereeDays: 3 },
  6: { referrerDays: 10, refereeDays: 7 },
  12: { referrerDays: 20, refereeDays: 15 },
};

function formatDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function extendSubscriptionDays(
  env: BotEnv,
  userId: string,
  telegramId: number,
  username: string | null,
  displayName: string | null,
  extraDays: number
): Promise<void> {
  if (extraDays <= 0) return;

  const sub = await getSubscription(env, userId);
  const baseMs =
    sub?.status === "active" && sub.ends_at
      ? new Date(`${sub.ends_at}T23:59:59`).getTime()
      : Date.now();
  const expiryMs = Math.max(Date.now(), baseMs) + extraDays * 24 * 60 * 60 * 1000;

  try {
    const xui = new XuiApi(env);
    await xui.provisionUser(env, {
      userId,
      username,
      displayName,
      telegramId,
      expiryMs,
      limitIp: panelLimitIpForSubscription(sub),
      dbSubscription: sub,
    });
  } catch (error) {
    console.error("extendSubscriptionDays panel:", error);
  }

  await patchSubscription(env, userId, {
    status: "active",
    ends_at: formatDateFromMs(expiryMs),
    ...(sub?.status !== "active" ? { starts_at: formatDateFromMs(Date.now()) } : {}),
  });
  await syncPanelDeviceLimit(env, userId);

  const token = clientBotToken(env);
  if (token) {
    await sendMessage(
      token,
      telegramId,
      `🎁 Реферальный бонус: +${extraDays} дн. к подписке FIX VPN.`
    );
  }
}

export async function applyReferralPaymentBonuses(
  env: BotEnv,
  options: {
    partnerTelegramId: number;
    refereeUserId: string;
    refereeTelegramId: number;
    refereeUsername: string | null;
    refereeDisplayName: string | null;
    billingMonths: number;
  }
): Promise<void> {
  const bonus = REFERRAL_BONUS_BY_MONTHS[options.billingMonths];
  if (!bonus) return;

  const partnerUser = await getUserByTelegramId(env, options.partnerTelegramId);
  if (partnerUser) {
    await extendSubscriptionDays(
      env,
      partnerUser.id,
      options.partnerTelegramId,
      partnerUser.username ?? null,
      partnerUser.display_name,
      bonus.referrerDays
    );
  }

  await extendSubscriptionDays(
    env,
    options.refereeUserId,
    options.refereeTelegramId,
    options.refereeUsername,
    options.refereeDisplayName,
    bonus.refereeDays
  );
}

export function referralShareMessage(env: BotEnv, link: string): string {
  return (
    `🚀 Привет! Попробуй этот VPN - быстрый, надёжный и доступный!\n\n` +
    `🎁 По моей ссылке тебе дадут бонусные дни к подписке!\n\n` +
    link
  );
}

export function referralShareUrl(env: BotEnv, link: string): string {
  const text = referralShareMessage(env, link);
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

export function referralBonusText(): string {
  return (
    `💰 <b>Бонусы за приглашения:</b>\n` +
    `💰 Денежное вознаграждение\n` +
    `Вы получаете <b>30%</b> от каждого платежа приглашённого пользователя.\n\n` +
    `🎁 За 1-мес. подписку друга:\n` +
    `  ➢ Вы: 3 дн.\n` +
    `  ➢ Друг: 1 дн.\n\n` +
    `🎁 За 3-мес. подписку друга:\n` +
    `  ➢ Вы: 5 дн.\n` +
    `  ➢ Друг: 3 дн.\n\n` +
    `🎁 За 6-мес. подписку друга:\n` +
    `  ➢ Вы: 10 дн.\n` +
    `  ➢ Друг: 7 дн.\n\n` +
    `🎁 За 12-мес. подписку друга:\n` +
    `  ➢ Вы: 20 дн.\n` +
    `  ➢ Друг: 15 дн.\n\n` +
    `📢 Поделись ссылкой с друзьями и получай бонусы!`
  );
}
