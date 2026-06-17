import type { BillingMonths, PlanType } from "../catalog";
import { calcCheckoutPrice, periodLabel } from "./pricing";

export { calcCheckoutPrice };

export const DEVICE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function includedDevices(): number {
  return 1;
}

export function extraDevicesForTotal(totalDevices: number): number {
  return Math.max(0, totalDevices - includedDevices());
}

export function tariffsText(): string {
  return (
    `💳 Тарифы\n\n` +
    `✅ Базовый:\n` +
    `● Безлимитный трафик\n` +
    `● 1 устройство в тарифе\n` +
    `● Быстрое подключение\n` +
    `● Стабильность\n` +
    `Подойдёт для одного человека\n\n` +
    `⭐️ Про:\n` +
    `● Личный сервер\n` +
    `● Безлимитные количество устройств\n` +
    `● Безлимитный трафик\n` +
    `● Скорость до 1000 Мб/с\n` +
    `Подойдёт для семьи/компании/активных пользователей`
  );
}

export function tariffsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Базовый от 199/мес", callback_data: "c:plan:basic" }],
      [{ text: "⭐️ Про от 999/мес", callback_data: "c:plan:personal" }],
      [{ text: "◀️ Назад", callback_data: "c:menu" }],
    ],
  };
}

export function periodsKeyboard(plan: PlanType) {
  const monthsList: BillingMonths[] = [1, 2, 3, 6, 12];
  return {
    inline_keyboard: monthsList
      .map((months) => {
        const price = calcCheckoutPrice(plan, months);
        const star = months === 12 ? "⭐️ " : "";
        return [
          {
            text: `${star}${periodLabel(months)} - ${price} рублей`,
            callback_data: `c:period:${plan}:${months}`,
          },
        ];
      })
      .concat([[{ text: "◀️ Назад", callback_data: "c:buy" }]]),
  };
}

export function devicesText(
  plan: PlanType,
  months: BillingMonths,
  totalDevices: number,
  promo = 0
): string {
  const price = calcCheckoutPrice(plan, months, extraDevicesForTotal(totalDevices), promo);
  return (
    `Выберите количество устройств\n` +
    `Выбрано устройств: <b>${totalDevices}</b>\n` +
    `Сумма: <b>${price} ₽</b>`
  );
}

export function devicesKeyboard(
  plan: PlanType,
  months: BillingMonths,
  selected: number,
  promo = 0
) {
  const price = calcCheckoutPrice(plan, months, extraDevicesForTotal(selected), promo);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < DEVICE_OPTIONS.length; i += 5) {
    rows.push(
      DEVICE_OPTIONS.slice(i, i + 5).map((count) => ({
        text: String(count),
        callback_data: `c:dev:${plan}:${months}:${count}:${promo}`,
      }))
    );
  }

  rows.push([
    {
      text: `💳 Оплатить ${price} ₽`,
      callback_data: `c:checkout:${plan}:${months}:${selected}:${promo}`,
    },
  ]);
  rows.push([{ text: "◀️ Назад", callback_data: `c:plan:${plan}` }]);

  return { inline_keyboard: rows };
}

export function paymentSummaryText(
  plan: PlanType,
  months: BillingMonths,
  totalDevices: number,
  promo = 0
): string {
  const price = calcCheckoutPrice(plan, months, extraDevicesForTotal(totalDevices), promo);
  const devicesLine = plan === "personal" ? "Безлимит" : String(totalDevices);
  return (
    `Период: <b>${periodLabel(months)}</b>\n` +
    `Устройств: <b>${devicesLine}</b>\n` +
    `Сумма: <b>${price} ₽</b>\n\n` +
    `Выберите способ оплаты:`
  );
}

export function paymentMethodsKeyboard(
  plan: PlanType,
  months: BillingMonths,
  totalDevices: number,
  promo = 0
) {
  const back =
    plan === "basic"
      ? `c:dev:${plan}:${months}:${totalDevices}:${promo}`
      : `c:plan:${plan}`;
  return {
    inline_keyboard: [
      [{ text: "📱 СБП", callback_data: `c:pay:sbp:${plan}:${months}:${promo}:${totalDevices}` }],
      [{ text: "💳 Карта", callback_data: `c:pay:card:${plan}:${months}:${promo}:${totalDevices}` }],
      [{ text: "💎 USDT", callback_data: `c:pay:crypto_usdt:${plan}:${months}:${promo}:${totalDevices}` }],
      [{ text: "🎟 Ввести промокод", callback_data: `c:promo:${plan}:${months}:${totalDevices}` }],
      [{ text: "◀️ Назад", callback_data: back }],
    ],
  };
}

export function parseCheckoutPayData(data: string): {
  method: string;
  plan: PlanType;
  months: BillingMonths;
  promo: number;
  totalDevices: number;
} | null {
  const parts = data.split(":");
  if (parts[0] !== "c" || parts[1] !== "pay" || parts.length < 7) return null;
  const totalRaw = parts[6];
  return {
    method: parts[2],
    plan: parts[3] as PlanType,
    months: Number(parts[4]) as BillingMonths,
    promo: Number(parts[5] || "0"),
    totalDevices:
      totalRaw !== undefined && totalRaw !== ""
        ? Number(totalRaw)
        : includedDevices(),
  };
}
