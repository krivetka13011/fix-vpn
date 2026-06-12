import type { BotEnv } from "../env";

export type BillingMonths = 1 | 3 | 6 | 12;

export function baseMonthly(env: BotEnv): number {
  return Number(env.BASE_PRICE_RUB_PER_MONTH || "199");
}

export function discountPercent(env: BotEnv, months: BillingMonths): number {
  if (months === 3) return Number(env.DISCOUNT_3_MONTHS_PERCENT || "10");
  if (months === 6) return Number(env.DISCOUNT_6_MONTHS_PERCENT || "15");
  if (months === 12) return Number(env.DISCOUNT_12_MONTHS_PERCENT || "20");
  return 0;
}

export function calcPrice(
  env: BotEnv,
  months: BillingMonths,
  promoDiscount = 0
): number {
  const monthly = baseMonthly(env);
  const gross = monthly * months;
  const periodDiscount = Math.round((gross * discountPercent(env, months)) / 100);
  const afterPeriod = gross - periodDiscount;
  const promo = Math.round((afterPeriod * promoDiscount) / 100);
  return Math.max(0, afterPeriod - promo);
}

export function periodLabel(months: BillingMonths): string {
  const map: Record<BillingMonths, string> = {
    1: "1 месяц",
    3: "3 месяца",
    6: "6 месяцев",
    12: "1 год",
  };
  return map[months];
}

export const BILLING_OPTIONS: BillingMonths[] = [1, 3, 6, 12];
