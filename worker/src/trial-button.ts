import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import type { DbSubscription, DbUser } from "./types";

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

/** Trial доступен: не active; для tester — повторная активация после истечения. */
export function canActivateTrial(
  env: BotEnv,
  telegramId: number,
  user: DbUser,
  sub?: DbSubscription | null
): boolean {
  if (sub?.status === "active") return false;
  if (isTesterAccount(env, telegramId, user.is_tester)) return true;
  return !trialButtonHidden(user, sub);
}

export function trialButtonGraceExpired(user: DbUser): boolean {
  const connectedAt = user.trial_first_connect_at?.trim();
  if (!connectedAt || user.has_used_trial) return false;
  const elapsed = Date.now() - new Date(connectedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= TRIAL_BUTTON_HIDE_AFTER_MS;
}
