import { periodLabel, type BillingMonths } from "./bots/pricing";
import { TARIFFS } from "./catalog";
import type { PlanType } from "./catalog";
import { clientBotToken, type BotEnv } from "./env";
import {
  formatExpiresAtIso,
  isTestMode,
  paidSubscriptionDurationMs,
} from "./test-mode";
import { panelLimitIpForSubscription, syncPanelDeviceLimit } from "./device-limit";
import { sendMessage } from "./bots/telegram-api";
import { XuiApi } from "./xui";
import {
  addPartnerBalance,
  getSubscription,
  getTransaction,
  patchSubscription,
  patchTransaction,
  patchUser,
  saveXuiInboundClients,
} from "./repository";
import { applyReferralPaymentBonuses } from "./referral-bonus";
import { sbJson, sbRequest } from "./supabase";

function formatDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function buildSubscriptionUrl(env: BotEnv, subId: string): string {
  const base = env.WEBAPP_URL?.replace(/\/$/, "") || "";
  return base ? `${base}/sub/${subId}` : `/sub/${subId}`;
}

async function sbUserById(env: BotEnv, userId: string) {
  const rows = await sbJson<
    Array<{
      id: string;
      telegram_id: number;
      username: string | null;
      display_name: string | null;
      ref_by_partner_id: number | null;
      first_payment_done: boolean;
    }>
  >(
    await sbRequest(
      env,
      `users?id=eq.${userId}&select=id,telegram_id,username,display_name,ref_by_partner_id,first_payment_done&limit=1`
    )
  );
  return rows[0] ?? null;
}

export async function approvePaidTransaction(
  env: BotEnv,
  txnId: string
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const txn = await getTransaction(env, txnId);
  if (!txn) return { ok: false, message: "Заявка не найдена" };
  if (txn.status === "approved") return { ok: true, message: "Уже оплачено" };
  if (txn.status !== "pending") return { ok: false, message: "Заявка не в ожидании" };

  const user = await sbUserById(env, txn.user_id);
  if (!user) return { ok: false, message: "Пользователь не найден" };

  const months = txn.billing_months as BillingMonths;
  const planType = (txn.plan_type === "personal" ? "personal" : "basic") as PlanType;
  const extraDevices = planType === "personal" ? 0 : Number(txn.extra_devices ?? 0);
  const xui = new XuiApi(env);
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
        ? new Date(`${sub.ends_at}T23:59:59`).getTime()
        : Date.now();
  const expiryMs = Math.max(Date.now(), baseMs) + extendMs;
  const provision = await xui.provisionUser(env, {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    telegramId: user.telegram_id,
    expiryMs,
    limitIp: panelLimitIpForSubscription(subWithDevices),
    dbSubscription: sub,
  });

  const current = await getSubscription(env, user.id);
  const lockedSubId = current?.xray_sub_id?.trim();
  const subId = lockedSubId || provision.subId;
  const subscriptionUrl = buildSubscriptionUrl(env, subId);

  if (provision.inbounds.length > 0) {
    await saveXuiInboundClients(
      env,
      user.id,
      provision.inbounds.map((row) => ({
        inboundId: row.inboundId,
        clientUuid: row.clientUuid,
        clientEmail: provision.email,
      }))
    );
  }

  await patchSubscription(env, user.id, {
    status: "active",
    plan_type: planType,
    plan_label: isTestMode(env)
      ? `${TARIFFS[planType].name} · тест ${Math.round(extendMs / 60000)} мин`
      : `${TARIFFS[planType].name} · ${periodLabel(months)}`,
    billing_months: months,
    extra_devices: extraDevices,
    starts_at: sub?.starts_at || formatDateFromMs(Date.now()),
    ends_at: formatDateFromMs(expiryMs),
    expires_at: formatExpiresAtIso(expiryMs),
    expiry_warned_at: null,
    is_trial: false,
    client_email: provision.email,
    xray_sub_id: subId,
    xray_uuid: provision.primaryUuid,
    subscription_url: subscriptionUrl,
    updated_at: new Date().toISOString(),
  });

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
