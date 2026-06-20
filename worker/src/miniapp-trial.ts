import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import { getBundle } from "./db";
import {
  effectiveTrialDurationMs,
  formatSubscriptionDateFields,
  isTestMode,
} from "./test-mode";
import {
  clearVpnDeviceBindings,
  resetTesterTrial,
  upsertTelegramUser,
} from "./repository";
import { activateTrialSubscription } from "./subscription-activate";
import type { TelegramUser } from "./telegram";
import { canActivateTrial, isSubscriptionTimeActive } from "./trial-button";

export async function activateMiniappTrial(
  env: BotEnv,
  tg: TelegramUser
): Promise<{ message: string }> {
  await upsertTelegramUser(env, tg);
  const bundle = await getBundle(env, tg.id);
  if (!bundle) throw new Error("Пользователь не найден");
  const user = bundle.user;
  const existingSub = bundle.subscription;

  if (!canActivateTrial(env, tg.id, user, existingSub)) {
    throw new Error(
      env.MSG_TRIAL_ALREADY_USED ||
        "Пробный период уже использован на этом аккаунте Telegram."
    );
  }

  if (
    isTesterAccount(env, tg.id, user.is_tester) &&
    !isSubscriptionTimeActive(existingSub)
  ) {
    await resetTesterTrial(env, tg.id);
  }

  if (existingSub?.is_trial && isSubscriptionTimeActive(existingSub)) {
    return { message: "Пробный период уже активен. Перейдите во вкладку «Помощь»." };
  }

  if (existingSub?.status !== "active") {
    await clearVpnDeviceBindings(env, user.id);
  }

  const trialMs = effectiveTrialDurationMs(env, {
    telegramId: tg.id,
    isTester: user.is_tester,
  });
  const expiryMs = Math.floor(Date.now() + trialMs);
  const trialPlanLabel = isTestMode(env)
    ? `Пробный · ${Math.round(trialMs / 60000)} мин`
    : "Пробный · 24 ч";
  const trialDates = formatSubscriptionDateFields(expiryMs);

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
      updated_at: new Date().toISOString(),
    },
  });

  return {
    message: isTestMode(env)
      ? `Пробный период активен ${Math.round(trialMs / 60000)} мин. Откройте «Помощь» для подключения.`
      : "Пробный период активирован. Откройте «Помощь» для подключения.",
  };
}
