import type { BotEnv } from "../env";
import {
  calcTotalRub,
  periodLabel as catalogPeriodLabel,
  type BillingMonths,
  type PlanType,
} from "../catalog";

export type { BillingMonths, PlanType };

export const BILLING_OPTIONS: BillingMonths[] = [1, 2, 3, 6, 12];

export function periodLabel(months: BillingMonths): string {
  return catalogPeriodLabel(months);
}

export function periodButtonLabel(months: BillingMonths): string {
  const star = months === 12 ? "⭐️ " : "";
  return `${star}${catalogPeriodLabel(months)}`;
}

export function calcCheckoutPrice(
  plan: PlanType,
  months: BillingMonths,
  extraDevices = 0,
  promoDiscount = 0
): number {
  let total = calcTotalRub(plan, months, extraDevices);
  if (promoDiscount > 0) {
    total = Math.round((total * (100 - promoDiscount)) / 100);
  }
  return Math.max(0, total);
}

/** @deprecated use calcCheckoutPrice(plan, months, extra, promo) */
export function calcPrice(
  env: BotEnv,
  months: BillingMonths,
  promoDiscount = 0
): number {
  void env;
  return calcCheckoutPrice("basic", months, 0, promoDiscount);
}

export function baseMonthly(env: BotEnv): number {
  return Number(env.BASE_PRICE_RUB_PER_MONTH || "199");
}
