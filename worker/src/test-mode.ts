import type { BillingMonths } from "./catalog";
import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import { formatMskDateOnly } from "./datetime-msk";

export function isTestMode(env: BotEnv): boolean {
  const raw = env.TEST_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function trialDurationMs(env: BotEnv): number {
  if (isTestMode(env)) {
    const minutes = Number(env.TRIAL_DURATION_MINUTES || "5");
    return Math.max(1, minutes) * 60 * 1000;
  }
  const days = Number(env.TRIAL_DAYS || env.XUI_TRIAL_DAYS || "1");
  return Math.max(1, days) * 24 * 60 * 60 * 1000;
}

/** Для tester-аккаунтов в TEST_MODE — отдельный длинный trial (по умолчанию 60 мин). */
export function effectiveTrialDurationMs(
  env: BotEnv,
  options?: { telegramId?: number; isTester?: boolean }
): number {
  const isTester =
    options?.isTester === true ||
    (options?.telegramId != null &&
      isTesterAccount(env, options.telegramId, options.isTester));
  if (isTester && isTestMode(env)) {
    const minutes = Number(env.TESTER_TRIAL_DURATION_MINUTES || "60");
    return Math.max(1, minutes) * 60 * 1000;
  }
  return trialDurationMs(env);
}

export function testCheckoutPriceRub(env: BotEnv): number | null {
  if (!isTestMode(env)) return null;
  return Math.max(1, Number(env.TEST_CHECKOUT_PRICE_RUB || "1"));
}

export function paidSubscriptionDurationMs(
  env: BotEnv,
  months: BillingMonths
): number {
  if (isTestMode(env)) {
    const minutes = Number(env.TEST_SUBSCRIPTION_MINUTES || "10");
    return Math.max(1, minutes) * 60 * 1000;
  }
  return months * 30 * 24 * 60 * 60 * 1000;
}

export function formatExpiresAtIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function formatSubscriptionDateFields(
  expiryMs: number,
  startMs = Date.now()
): {
  starts_at: string;
  ends_at: string;
  expires_at: string;
  purchased_at: string;
} {
  return {
    starts_at: formatMskDateOnly(startMs),
    ends_at: formatMskDateOnly(expiryMs),
    expires_at: formatExpiresAtIso(expiryMs),
    purchased_at: new Date(startMs).toISOString(),
  };
}
