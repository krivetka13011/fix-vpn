import { periodLabel, type BillingMonths } from "./bots/pricing";
import { clientBotToken, type BotEnv } from "./env";
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
      ref_by_partner_id: number | null;
      first_payment_done: boolean;
    }>
  >(
    await sbRequest(
      env,
      `users?id=eq.${userId}&select=id,telegram_id,username,ref_by_partner_id,first_payment_done&limit=1`
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
  const xui = new XuiApi(env);
  const sub = await getSubscription(env, user.id);
  const extendDays = months * 30;
  const baseMs =
    sub?.status === "active" && sub.ends_at
      ? new Date(`${sub.ends_at}T23:59:59`).getTime()
      : Date.now();
  const expiryMs = Math.max(Date.now(), baseMs) + extendDays * 24 * 60 * 60 * 1000;
  const provision = await xui.provisionUser(env, {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    telegramId: user.telegram_id,
    expiryMs,
    limitIp: panelLimitIpForSubscription(sub),
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
    plan_type: "basic",
    plan_label: `Базовый · ${periodLabel(months)}`,
    billing_months: months,
    starts_at: sub?.starts_at || formatDateFromMs(Date.now()),
    ends_at: formatDateFromMs(expiryMs),
    is_trial: false,
    client_email: provision.email,
    xray_sub_id: subId,
    xray_uuid: provision.primaryUuid,
    subscription_url: subscriptionUrl,
    updated_at: new Date().toISOString(),
  });

  await syncPanelDeviceLimit(env, user.id);

  if (txn.is_first_payment && user.ref_by_partner_id) {
    const commissionPct = Number(env.PARTNER_DEFAULT_COMMISSION_PERCENT || "50");
    const commission = Math.round((Number(txn.amount) * commissionPct) / 100);
    await addPartnerBalance(env, user.ref_by_partner_id, commission);
    await patchTransaction(env, txnId, {
      status: "approved",
      partner_commission_amount: commission,
    });
  } else {
    await patchTransaction(env, txnId, { status: "approved" });
  }

  if (!user.first_payment_done) {
    await patchUser(env, user.id, { first_payment_done: true });
  }

  const clientToken = clientBotToken(env);
  if (clientToken) {
    await sendMessage(
      clientToken,
      user.telegram_id,
      `Оплата подтверждена. Подписка продлена на ${periodLabel(months)}.`
    );
  }

  return { ok: true, message: "Подписка активирована" };
}
