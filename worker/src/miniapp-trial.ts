import type { BotEnv } from "./env";
import {
  formatSubscriptionDateFields,
  isTestMode,
  trialDurationMs,
} from "./test-mode";
import { getSubscription, upsertTelegramUser } from "./repository";
import { activateTrialSubscription } from "./subscription-activate";
import type { TelegramUser } from "./telegram";
import { trialButtonHidden } from "./trial-button";

export async function activateMiniappTrial(
  env: BotEnv,
  tg: TelegramUser
): Promise<{ message: string }> {
  const user = await upsertTelegramUser(env, tg);
  const existingSub = await getSubscription(env, user.id);

  if (trialButtonHidden(user, existingSub)) {
    throw new Error(
      env.MSG_TRIAL_ALREADY_USED ||
        "Пробный период уже использован на этом аккаунте Telegram."
    );
  }

  if (existingSub?.is_trial && existingSub.status === "active") {
    return { message: "Пробный период уже активен. Перейдите во вкладку «Помощь»." };
  }

  const trialMs = trialDurationMs(env);
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
