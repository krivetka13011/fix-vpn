import type { BotEnv } from "../env";
import {
  EXTRA_DEVICE_PRICE_PER_MONTH,
  TARIFFS,
  type BillingMonths,
  type PlanType,
} from "../catalog";
import { calcCheckoutPrice, periodButtonLabel, periodLabel } from "./pricing";

export const DEVICE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function includedDevices(): number {
  return TARIFFS.basic.includedDevices ?? 1;
}

export function extraDevicesForTotal(totalDevices: number): number {
  return Math.max(0, totalDevices - includedDevices());
}

export function deviceLabel(count: number): string {
  return String(count);
}

export function tariffsText(): string {
  return (
    `💳 <b>Тарифы</b>\n\n` +
    `✅ <b>Базовый:</b>\n` +
    `● Безлимитный трафик\n` +
    `● 1 устройство в тарифе\n` +
    `● Быстрое подключение\n` +
    `● Стабильность\n` +
    `Подойдёт для одного человека\n\n` +
    `⭐️ <b>Про:</b>\n` +
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
        return [
          {
            text: `${periodButtonLabel(months)} - ${price} рублей`,
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
    `Выберите количество устройств\n\n` +
    `Выбрано устройств: <b>${totalDevices}</b>\n` +
    `Сумма: <b>${price} ₽</b>\n\n` +
    `Доп. устройство: +${EXTRA_DEVICE_PRICE_PER_MONTH} ₽ / мес`
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

  for (let i = 0; i < DEVICE_OPTIONS.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    for (let j = 0; j < 2 && i + j < DEVICE_OPTIONS.length; j += 1) {
      const count = DEVICE_OPTIONS[i + j];
      const mark = count === selected ? " ✅" : "";
      row.push({
        text: `${count}${mark}`,
        callback_data: `c:dev:${plan}:${months}:${count}:${promo}`,
      });
    }
    rows.push(row);
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
  const devicesLine =
    plan === "personal" ? "Безлимит" : String(totalDevices);
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
      ? `c:period:${plan}:${months}`
      : `c:period:${plan}:${months}`;
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
  return {
    method: parts[2],
    plan: parts[3] as PlanType,
    months: Number(parts[4]) as BillingMonths,
    promo: Number(parts[5] || "0"),
    totalDevices: Number(parts[6] || includedDevices()),
  };
}
