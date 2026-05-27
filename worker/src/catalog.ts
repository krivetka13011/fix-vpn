export type PlanType = "basic" | "personal";
export type BillingMonths = 1 | 3 | 6 | 12;

export const EXTRA_DEVICE_PRICE_PER_MONTH = 99;
export const SUPPORT_TELEGRAM_ID = 8312175683;

export const TARIFFS: Record<
  PlanType,
  {
    id: PlanType;
    name: string;
    subtitle: string;
    includedDevices: number | null;
    periods: Record<BillingMonths, number>;
  }
> = {
  basic: {
    id: "basic",
    name: "Базовый",
    subtitle: "1 устройство в тарифе",
    includedDevices: 1,
    periods: { 1: 199, 3: 499, 6: 899, 12: 1499 },
  },
  personal: {
    id: "personal",
    name: "Персональный сервер",
    subtitle: "Высокая скорость · безлимит устройств",
    includedDevices: null,
    periods: { 1: 499, 3: 1299, 6: 2299, 12: 3999 },
  },
};

export function periodLabel(months: BillingMonths): string {
  const map: Record<BillingMonths, string> = {
    1: "1 месяц",
    3: "3 месяца",
    6: "6 месяцев",
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
