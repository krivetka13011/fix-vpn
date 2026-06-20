import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import { subscriptionExpiryMs } from "./db";
import type { DbSubscription, DbUser } from "./types";

/** Подписка ещё действует по времени (не только status=active в D1). */
export function isSubscriptionTimeActive(
  sub?: DbSubscription | null
): boolean {
  if (!sub || sub.status !== "active") return false;
  const endMs = subscriptionExpiryMs(sub);
  if (endMs == null) return true;
  return endMs > Date.now();
}

/** Кнопка «Пробный период» скрывается после использования или истечения trial. */
export const TRIAL_BUTTON_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;

export function trialButtonHidden(
  user: DbUser,
  sub?: DbSubscription | null
): boolean {
  if (user.has_used_trial) return true;
  if (sub?.is_trial && sub.status !== "active") return true;
  const connectedAt = user.trial_first_connect_at?.trim();
  if (!connectedAt) return false;
  const elapsed = Date.now() - new Date(connectedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= TRIAL_BUTTON_HIDE_AFTER_MS;
}

/** Trial доступен: не active по времени; для tester — повторная активация после истечения. */
export function canActivateTrial(
  env: BotEnv,
  telegramId: number,
  user: DbUser,
  sub?: DbSubscription | null
): boolean {
  if (isSubscriptionTimeActive(sub)) return false;
  if (isTesterAccount(env, telegramId, user.is_tester)) return true;
  return !trialButtonHidden(user, sub);
}

export function trialButtonGraceExpired(user: DbUser): boolean {
  const connectedAt = user.trial_first_connect_at?.trim();
  if (!connectedAt || user.has_used_trial) return false;
  const elapsed = Date.now() - new Date(connectedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= TRIAL_BUTTON_HIDE_AFTER_MS;
}
