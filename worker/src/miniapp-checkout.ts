import { type BillingMonths, type PlanType, TARIFFS } from "./catalog";
import { calcCheckoutPrice, periodLabel } from "./bots/pricing";
import type { BotEnv } from "./env";
import { isPlategaConfigured, createPlategaPayment } from "./platega";
import { createTransaction, getSubscription, patchTransaction, upsertTelegramUser } from "./repository";
import type { TelegramUser } from "./telegram";

export async function startMiniappPlategaCheckout(
  env: BotEnv,
  tg: TelegramUser,
  input: {
    planType: PlanType;
    months: BillingMonths;
    extraDevices: number;
    method: string;
  }
): Promise<{ paymentUrl: string; amount: number; message: string }> {
  if (!isPlategaConfigured(env)) {
    throw new Error("Оплата временно недоступна");
  }
  if (input.method === "card") {
    throw new Error("Оплата картой недоступна. Выберите СБП или USDT.");
  }
  if (input.method !== "sbp" && input.method !== "crypto_usdt") {
    throw new Error("Неверный способ оплаты");
  }

  const extra =
    input.planType === "personal"
      ? 0
      : Math.max(0, Math.min(10, input.extraDevices));
  const price = calcCheckoutPrice(
    input.planType,
    input.months,
    extra,
    0,
    env
  );
  const user = await upsertTelegramUser(env, tg);
  const txn = await createTransaction(env, {
    user_id: user.id,
    amount: price,
    billing_months: input.months,
    plan_type: input.planType,
    extra_devices: extra,
    payment_method: input.method,
    status: "pending",
    is_first_payment: !Boolean(user.first_payment_done),
  });

  const payment = await createPlategaPayment(env, {
    amount: price,
    orderId: txn.id,
    description: `FIX VPN · ${TARIFFS[input.planType].name} · ${periodLabel(input.months)}`,
    method: input.method,
    telegramId: tg.id,
    username: tg.username,
  });

  await patchTransaction(env, txn.id, {
    platega_transaction_id: payment.transactionId,
    payment_url: payment.redirect,
  });

  return {
    paymentUrl: payment.redirect,
    amount: price,
    message:
      "Откроется форма оплаты. После оплаты подписка активируется автоматически — обновите профиль через минуту.",
  };
}

export async function startMiniappAddonDevicesCheckout(
  env: BotEnv,
  tg: TelegramUser,
  input: { addDevices?: number; method: string }
): Promise<{ paymentUrl: string; amount: number; message: string }> {
  const user = await upsertTelegramUser(env, tg);
  const sub = await getSubscription(env, user.id);
  if (sub?.status !== "active" || sub.plan_type !== "basic" || sub.is_trial) {
    throw new Error("Докупка доступна при активном базовом тарифе");
  }

  const add = Math.max(1, Math.min(10, input.addDevices ?? 1));
  const newExtra = sub.extra_devices + add;
  if (newExtra > 10) {
    throw new Error("Максимум 10 дополнительных устройств (11 одновременно)");
  }

  const months = (sub.billing_months ?? 1) as BillingMonths;
  const checkout = await startMiniappPlategaCheckout(env, tg, {
    planType: "basic",
    months,
    extraDevices: newExtra,
    method: input.method,
  });

  return {
    ...checkout,
    message:
      "Откроется форма оплаты. После оплаты лимит устройств обновится автоматически — обновите профиль через минуту.",
  };
}
