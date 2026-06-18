import type { BotEnv } from "./env";
import {
  isTestMode,
  paidSubscriptionDurationMs,
  testCheckoutPriceRub,
  trialDurationMs,
} from "./test-mode";

export type PlanType = "basic" | "personal";
export type BillingMonths = 1 | 2 | 3 | 6 | 12;

export const EXTRA_DEVICE_PRICE_PER_MONTH = 75;
export const SUPPORT_TELEGRAM_USERNAME = "Fixvpnmng";
export const TELEGRAM_CHANNEL_URL = "https://t.me/FIXVPNfast";

export const PRIVACY_POLICY_URL =
  "https://telegra.ph/Politika-konfidencialnosti-04-01-26";
export const TERMS_OF_SERVICE_URL =
  "https://telegra.ph/Polzovatelskoe-soglashenie-04-01-19";

export const TARIFFS: Record<
  PlanType,
  {
    id: PlanType;
    name: string;
    subtitle: string;
    includedDevices: number | null;
    speedMbps: number | null;
    features: string[];
    periods: Record<BillingMonths, number>;
  }
> = {
  basic: {
    id: "basic",
    name: "Базовый",
    subtitle: "199 ₽ / мес",
    includedDevices: 1,
    speedMbps: null,
    features: [
      "Безлимитный трафик",
      "Выбор нескольких стран",
      "1 устройство в тарифе",
      "Доп. устройства +75 ₽ / мес",
    ],
    periods: { 1: 199, 2: 378, 3: 529, 6: 999, 12: 1799 },
  },
  personal: {
    id: "personal",
    name: "Про",
    subtitle: "999 ₽ / мес · личный сервер",
    includedDevices: null,
    speedMbps: 1000,
    features: [
      "Личный сервер",
      "Безграничное количество устройств",
      "Скорость до 1000 Мб/с",
      "Безлимитный трафик",
    ],
    periods: { 1: 999, 2: 1898, 3: 2679, 6: 4799, 12: 8999 },
  },
};

export const BILLING_MONTHS: BillingMonths[] = [1, 2, 3, 6, 12];

export function periodLabel(months: BillingMonths): string {
  const map: Record<BillingMonths, string> = {
    1: "1 месяц",
    2: "2 месяца",
    3: "3 месяца",
    6: "6 месяцев",
    12: "12 месяцев",
  };
  return map[months];
}

export function periodChipLabel(months: BillingMonths): string {
  const map: Record<BillingMonths, string> = {
    1: "1 мес",
    2: "2 мес",
    3: "3 мес",
    6: "6 мес",
    12: "1 год",
  };
  return map[months];
}

export function calcTotalRub(
  planType: PlanType,
  months: BillingMonths,
  extraDevices: number
): number {
  const base = TARIFFS[planType].periods[months];
  if (planType === "personal") return base;
  return base + extraDevices * EXTRA_DEVICE_PRICE_PER_MONTH * months;
}

/** Каталог для Mini App с учётом test mode (1 ₽ за любой период). */
export function catalogForEnv(env: BotEnv) {
  const testPrice = testCheckoutPriceRub(env);
  const testMode = isTestMode(env);
  const tariffs = Object.values(TARIFFS).map((tariff) => {
    if (testPrice === null) return tariff;
    const periods = { ...tariff.periods };
    for (const m of BILLING_MONTHS) {
      periods[m] = testPrice;
    }
    return {
      ...tariff,
      subtitle: `${testPrice} ₽ (тест)`,
      periods,
    };
  });
  return {
    tariffs,
    testMode,
    testCheckoutPriceRub: testPrice,
    testSubscriptionMinutes: testMode
      ? Math.round(paidSubscriptionDurationMs(env, 1) / 60000)
      : null,
    trialDurationMinutes: testMode
      ? Math.round(trialDurationMs(env) / 60000)
      : null,
  };
}
