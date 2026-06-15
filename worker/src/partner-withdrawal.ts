import type { BotEnv } from "./env";
import { partnerBotToken } from "./env";
import { notifyManager, managerWithdrawKeyboard } from "./bots/manager";
import { sendMessage } from "./bots/telegram-api";
import {
  cardlinkBalanceCovers,
  createCardlinkPartnerPayout,
  getCardlinkBalance,
  isCardlinkPayoutConfigured,
} from "./cardlink-payout";
import {
  addPartnerBalance,
  createWithdrawal,
  getPartner,
  patchWithdrawal,
} from "./repository";

export type WithdrawalSubmitResult = {
  withdrawalId: string;
  mode: "cardlink" | "queued";
  message: string;
};

async function notifyPartner(
  env: BotEnv,
  partnerId: number,
  text: string
): Promise<void> {
  const token = partnerBotToken(env);
  if (!token) return;
  await sendMessage(token, partnerId, text);
}

export async function tryCardlinkWithdrawalPayout(
  env: BotEnv,
  withdrawalId: string
): Promise<{ ok: true; payoutId: string } | { ok: false; reason: string }> {
  const { getWithdrawal } = await import("./repository");
  const wd = await getWithdrawal(env, withdrawalId);
  if (!wd || wd.status !== "pending") {
    return { ok: false, reason: "Заявка не в ожидании" };
  }
  if (!isCardlinkPayoutConfigured(env)) {
    return { ok: false, reason: "Cardlink payout не настроен" };
  }

  const amount = Number(wd.amount);
  const partnerId = Number(wd.partner_id);
  const partner = await getPartner(env, partnerId);
  if (!partner) return { ok: false, reason: "Партнёр не найден" };

  const balance = await getCardlinkBalance(env);
  if (!cardlinkBalanceCovers(amount, balance)) {
    const available = balance?.available ?? 0;
    return {
      ok: false,
      reason: `На балансе Cardlink ${available} ₽, нужно ${amount} ₽`,
    };
  }

  try {
    const payout = await createCardlinkPartnerPayout(env, {
      withdrawalId,
      amount,
      method: wd.method as "sbp" | "card",
      details: String(wd.details),
      partnerName: partner.display_name,
      sbpBankId: wd.sbp_bank_id ? String(wd.sbp_bank_id) : null,
    });
    await patchWithdrawal(env, withdrawalId, {
      status: "processing",
      payout_source: "cardlink",
      cardlink_payout_id: payout.payoutId,
      manager_note: `cardlink:${payout.status}`,
    });
    return { ok: true, payoutId: payout.payoutId };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "ошибка Cardlink payout",
    };
  }
}

export async function submitPartnerWithdrawal(
  env: BotEnv,
  input: {
    partnerId: number;
    amount: number;
    method: "sbp" | "card";
    details: string;
    sbpBankId?: string | null;
    username?: string | null;
  }
): Promise<WithdrawalSubmitResult> {
  const partner = await getPartner(env, input.partnerId);
  if (!partner) throw new Error("Партнёр не найден");
  if (input.amount <= 0 || input.amount > Number(partner.balance)) {
    throw new Error("Недостаточно средств на балансе");
  }

  await addPartnerBalance(env, input.partnerId, -input.amount);
  const wd = await createWithdrawal(env, {
    partner_id: input.partnerId,
    amount: input.amount,
    method: input.method,
    details: input.details,
    sbp_bank_id: input.method === "sbp" ? input.sbpBankId ?? null : null,
    status: "pending",
  });

  const payout = await tryCardlinkWithdrawalPayout(env, wd.id);
  if (payout.ok) {
    await notifyPartner(
      env,
      input.partnerId,
      `✅ <b>Выплата отправлена</b>\n\n` +
        `Сумма: <b>${input.amount} ₽</b>\n` +
        `Средства уходят на ваши реквизиты через Cardlink.\n` +
        `Обычно зачисление занимает от нескольких минут до суток.`
    );
    return {
      withdrawalId: wd.id,
      mode: "cardlink",
      message: "Выплата отправлена через Cardlink",
    };
  }

  const balance = await getCardlinkBalance(env);
  const balanceHint = balance
    ? `\nБаланс Cardlink: ${balance.available} ₽ (холд ${balance.hold} ₽)`
    : "";

  await notifyManager(
    env,
    `Вывод FIX Partner (очередь Cardlink)\n` +
      `Партнер: @${input.username || "—"} (${input.partnerId})\n` +
      `Сумма: ${input.amount} ₽\n` +
      `Метод: ${input.method}\n` +
      `Реквизиты партнёра: ${input.details}\n` +
      `Cardlink: ${payout.reason}${balanceHint}`,
    managerWithdrawKeyboard(wd.id)
  );

  await notifyPartner(
    env,
    input.partnerId,
    `⏳ <b>Заявка в очереди</b>\n\n` +
      `Сумма: <b>${input.amount} ₽</b>\n` +
      `Выплата пойдёт на ваши реквизиты через Cardlink, как только на балансе появятся средства.`
  );

  return {
    withdrawalId: wd.id,
    mode: "queued",
    message: payout.reason,
  };
}

export async function approveWithdrawalWithCardlink(
  env: BotEnv,
  withdrawalId: string
): Promise<string> {
  const payout = await tryCardlinkWithdrawalPayout(env, withdrawalId);
  if (payout.ok) {
    return "Выплата отправлена через Cardlink на реквизиты партнёра";
  }

  const { getWithdrawal } = await import("./repository");
  const wd = await getWithdrawal(env, withdrawalId);
  if (wd?.status === "processing") {
    return "Выплата уже в обработке Cardlink";
  }
  return payout.reason;
}

export async function rejectWithdrawal(
  env: BotEnv,
  withdrawalId: string
): Promise<void> {
  const { getWithdrawal } = await import("./repository");
  const wd = await getWithdrawal(env, withdrawalId);
  if (!wd || wd.status === "rejected" || wd.status === "approved") return;
  await addPartnerBalance(env, Number(wd.partner_id), Number(wd.amount));
  await patchWithdrawal(env, withdrawalId, { status: "rejected" });
}
