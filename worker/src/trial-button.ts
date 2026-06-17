import type { DbUser } from "./types";

/** Кнопка «Пробный период» скрывается через сутки после первого выбора VPN-клиента. */
export const TRIAL_BUTTON_HIDE_AFTER_MS = 24 * 60 * 60 * 1000;

export function trialButtonHidden(user: DbUser): boolean {
  if (user.has_used_trial) return true;
  const connectedAt = user.trial_first_connect_at?.trim();
  if (!connectedAt) return false;
  const elapsed = Date.now() - new Date(connectedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= TRIAL_BUTTON_HIDE_AFTER_MS;
}

export function trialButtonGraceExpired(user: DbUser): boolean {
  const connectedAt = user.trial_first_connect_at?.trim();
  if (!connectedAt || user.has_used_trial) return false;
  const elapsed = Date.now() - new Date(connectedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= TRIAL_BUTTON_HIDE_AFTER_MS;
}
