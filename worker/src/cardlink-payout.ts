import type { BotEnv } from "./env";
import { isCardlinkConfigured } from "./cardlink";

const CARDLINK_BALANCE_API = "https://cardlink.link/api/v1/merchant/balance";
const CARDLINK_PAYOUT_API = "https://cardlink.link/api/v1/payout/regular/create";

export type CardlinkBalance = {
  available: number;
  locked: number;
  hold: number;
  currency: string;
};

export type CardlinkPayoutResult = {
  payoutId: string;
  status: string;
  amount: number;
  commission: number;
};

function authHeaders(env: BotEnv): Record<string, string> {
  const token = env.CARDLINK_API_TOKEN?.trim();
  if (!token) throw new Error("Cardlink не настроен");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export function isCardlinkPayoutConfigured(env: BotEnv): boolean {
  return isCardlinkConfigured(env) && env.CARDLINK_PAYOUT_ENABLED !== "0";
}

export async function getCardlinkBalance(env: BotEnv): Promise<CardlinkBalance | null> {
  if (!isCardlinkConfigured(env)) return null;
  const response = await fetch(CARDLINK_BALANCE_API, {
    headers: authHeaders(env),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.success === false) return null;
  const balances = (payload.balances as Array<Record<string, unknown>>) || [];
  const rub =
    balances.find((row) => String(row.currency_code || row.currency || "RUB") === "RUB") ||
    balances[0];
  if (!rub) return null;
  return {
    available: Number(rub.balance_available || 0),
    locked: Number(rub.balance_locked || 0),
    hold: Number(rub.balance_hold || 0),
    currency: String(rub.currency_code || rub.currency || "RUB"),
  };
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return raw.trim();
}

function normalizeCard(raw: string): string {
  return raw.replace(/\D/g, "");
}

function cardHolderName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Zа-яА-ЯёЁ\s]/g, " ")
    .trim()
    .toUpperCase();
  return cleaned || "PARTNER";
}

export async function createCardlinkPartnerPayout(
  env: BotEnv,
  input: {
    withdrawalId: string;
    amount: number;
    method: "sbp" | "card";
    details: string;
    partnerName: string;
    sbpBankId?: string | null;
  }
): Promise<CardlinkPayoutResult> {
  if (!isCardlinkPayoutConfigured(env)) {
    throw new Error("Cardlink payout API не включён");
  }

  const form = new URLSearchParams();
  form.set("amount", String(input.amount));
  form.set("currency", "RUB");
  form.set("account_currency", "RUB");
  form.set("recipient_pays_commission", "0");
  form.set("order_id", `wd-${input.withdrawalId}`);

  if (input.method === "card") {
    form.set("account_type", "credit_card");
    form.set("account_identifier", normalizeCard(input.details));
    form.set("card_holder", cardHolderName(input.partnerName));
  } else {
    const bankId = input.sbpBankId?.trim() || env.CARDLINK_DEFAULT_SBP_BANK_ID?.trim();
    if (!bankId) {
      throw new Error("Не указан банк СБП для выплаты");
    }
    form.set("account_type", "sbp");
    form.set("account_identifier", normalizePhone(input.details));
    form.set("account_bank", bankId);
    form.set("card_holder", cardHolderName(input.partnerName));
  }

  const response = await fetch(CARDLINK_PAYOUT_API, {
    method: "POST",
    headers: authHeaders(env),
    body: form.toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const success = payload.success === true || payload.success === "true";
  if (!response.ok || !success) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : Array.isArray(payload.errors)
          ? String((payload.errors as Array<Record<string, unknown>>)[0]?.message || "")
          : `Cardlink payout HTTP ${response.status}`;
    throw new Error(message || "Cardlink payout failed");
  }

  const rows = (payload.data as Array<Record<string, unknown>>) || [];
  const row = rows[0];
  if (!row?.id) throw new Error("Cardlink payout: пустой ответ");
  return {
    payoutId: String(row.id),
    status: String(row.status || "MODERATING"),
    amount: Number(row.amount || input.amount),
    commission: Number(row.commission || 0),
  };
}

export function cardlinkBalanceCovers(amount: number, balance: CardlinkBalance | null): boolean {
  if (!balance) return false;
  return balance.available >= amount;
}
