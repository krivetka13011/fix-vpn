import { periodLabel, type BillingMonths } from "./bots/pricing";
import { TARIFFS } from "./catalog";
import type { PlanType } from "./catalog";
import { clientBotToken, type BotEnv } from "./env";
import {
  formatExpiresAtIso,
  formatSubscriptionDateFields,
  isTestMode,
  paidSubscriptionDurationMs,
} from "./test-mode";
import { formatMskDateOnly } from "./datetime-msk";
import { panelLimitIpForSubscription, syncPanelDeviceLimit } from "./device-limit";
import { sendMessage } from "./bots/telegram-api";
import {
  addPartnerBalance,
  getSubscription,
  getTransaction,
  patchSubscription,
  patchTransaction,
  patchUser,
} from "./repository";
import { applyReferralPaymentBonuses } from "./referral-bonus";
import { getUserById } from "./repository";
import { activatePaidSubscription } from "./subscription-activate";

function formatDateFromMs(ms: number): string {
  return formatMskDateOnly(ms);
}

export async function approvePaidTransaction(
  env: BotEnv,
  txnId: string
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const txn = await getTransaction(env, txnId);
  if (!txn) return { ok: false, message: "Заявка не найдена" };
  if (txn.status === "approved") return { ok: true, message: "Уже оплачено" };
  if (txn.status !== "pending") return { ok: false, message: "Заявка не в ожидании" };

  const user = await getUserById(env, txn.user_id);
  if (!user) return { ok: false, message: "Пользователь не найден" };

  const months = txn.billing_months as BillingMonths;
  const planType = (txn.plan_type === "personal" ? "personal" : "basic") as PlanType;
  const extraDevices = planType === "personal" ? 0 : Number(txn.extra_devices ?? 0);
  const sub = await getSubscription(env, user.id);
  const subWithDevices = {
    ...(sub ?? { plan_type: planType, extra_devices: 0 }),
    extra_devices: extraDevices,
    plan_type: planType,
  };
  const extendMs = paidSubscriptionDurationMs(env, months);
  const baseMs =
    sub?.status === "active" && sub.expires_at
      ? new Date(sub.expires_at).getTime()
      : sub?.status === "active" && sub.ends_at
        ? new Date(`${sub.ends_at}T23:59:59+03:00`).getTime()
        : Date.now();
  const expiryMs = Math.floor(Math.max(Date.now(), baseMs) + extendMs);

  const now = Date.now();
  const activationStart =
    sub?.status === "active" && sub.purchased_at
      ? new Date(sub.purchased_at).getTime()
      : now;
  const dateFields = isTestMode(env)
    ? formatSubscriptionDateFields(expiryMs, activationStart)
    : {
        starts_at: sub?.starts_at || formatDateFromMs(now),
        ends_at: formatDateFromMs(expiryMs),
        expires_at: formatExpiresAtIso(expiryMs),
        purchased_at: sub?.purchased_at || new Date(now).toISOString(),
      };

  try {
    await activatePaidSubscription(env, {
      userId: user.id,
      telegramId: user.telegram_id,
      username: user.username,
      displayName: user.display_name,
      expiryMs,
      dbSubscription: sub,
      limitIp: panelLimitIpForSubscription(subWithDevices),
      subscriptionFields: {
        status: "active",
        plan_type: planType,
        plan_label: isTestMode(env)
          ? `${TARIFFS[planType].name} · тест ${Math.round(extendMs / 60000)} мин`
          : `${TARIFFS[planType].name} · ${periodLabel(months)}`,
        billing_months: months,
        extra_devices: extraDevices,
        starts_at: dateFields.starts_at,
        ends_at: dateFields.ends_at,
        expires_at: dateFields.expires_at,
        purchased_at: dateFields.purchased_at,
        expiry_warned_at: null,
        is_trial: false,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    console.error("approvePaidTransaction provision:", detail);
    return { ok: false, message: "Не удалось активировать подписку в панели" };
  }

  await syncPanelDeviceLimit(env, user.id);

  let commission = 0;
  if (user.ref_by_partner_id) {
    const commissionPct = Number(env.PARTNER_DEFAULT_COMMISSION_PERCENT || "30");
    commission = Math.round((Number(txn.amount) * commissionPct) / 100);
    if (commission > 0) {
      await addPartnerBalance(env, user.ref_by_partner_id, commission);
    }
  }

  await patchTransaction(env, txnId, {
    status: "approved",
    ...(commission > 0 ? { partner_commission_amount: commission } : {}),
  });

  if (txn.is_first_payment && user.ref_by_partner_id) {
    try {
      await applyReferralPaymentBonuses(env, {
        partnerTelegramId: user.ref_by_partner_id,
        refereeUserId: user.id,
        refereeTelegramId: user.telegram_id,
        refereeUsername: user.username,
        refereeDisplayName: user.display_name,
        billingMonths: months,
      });
    } catch (error) {
      console.error("applyReferralPaymentBonuses:", error);
    }
  }

  if (!user.first_payment_done) {
    await patchUser(env, user.id, { first_payment_done: true });
  }

  const clientToken = clientBotToken(env);
  if (clientToken) {
    await sendMessage(
      clientToken,
      user.telegram_id,
      `✅ Оплата подтверждена. ${
        isTestMode(env)
          ? `Тестовая подписка активна ${Math.round(extendMs / 60000)} мин.`
          : `Подписка продлена на ${periodLabel(months)}.`
      }`
    );
  }

  return { ok: true, message: "Подписка активирована" };
}
