import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
import {
  formatSubscriptionDateFields,
  isTestMode,
  trialDurationMs,
} from "./test-mode";
import {
  clearVpnDeviceBindings,
  getSubscription,
  getUserByTelegramId,
  resetTesterTrial,
  resetTesterSubscriptionState,
  upsertTelegramUser,
} from "./repository";
import { activateTrialSubscription } from "./subscription-activate";
import type { TelegramUser } from "./telegram";
import { trialButtonHidden } from "./trial-button";
import { debugSessionLog } from "./debug-session-log";

export async function activateMiniappTrial(
  env: BotEnv,
  tg: TelegramUser
): Promise<{ message: string }> {
  let user = await upsertTelegramUser(env, tg);
  let existingSub = await getSubscription(env, user.id);

  const stalePanelRefs =
    Boolean(existingSub?.xray_sub_id?.trim()) ||
    Boolean(existingSub?.xray_uuid?.trim()) ||
    Boolean(existingSub?.client_email?.trim());

  const testerRetrial =
    isTesterAccount(env, tg.id, user.is_tester) &&
    isTestMode(env) &&
    existingSub?.status !== "active" &&
    (user.has_used_trial || existingSub?.is_trial || stalePanelRefs);

  if (testerRetrial) {
    await resetTesterTrial(env, tg.id);
    await resetTesterSubscriptionState(env, user.id);
    await clearVpnDeviceBindings(env, user.id);
    user = (await getUserByTelegramId(env, tg.id)) ?? user;
    existingSub = await getSubscription(env, user.id);
    // #region agent log
    debugSessionLog(
      "miniapp-trial.ts:testerRetrial",
      "tester trial reset",
      {
        hasUsedTrial: user.has_used_trial,
        subStatus: existingSub?.status ?? null,
        hasXraySubId: Boolean(existingSub?.xray_sub_id?.trim()),
        hasXrayUuid: Boolean(existingSub?.xray_uuid?.trim()),
      },
      "C"
    );
    // #endregion
  }

  if (trialButtonHidden(user, existingSub)) {
    throw new Error(
      env.MSG_TRIAL_ALREADY_USED ||
        "Пробный период уже использован на этом аккаунте Telegram."
    );
  }

  if (existingSub?.is_trial && existingSub.status === "active") {
    return { message: "Пробный период уже активен. Перейдите во вкладку «Помощь»." };
  }

  if (existingSub?.status !== "active") {
    await clearVpnDeviceBindings(env, user.id);
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
