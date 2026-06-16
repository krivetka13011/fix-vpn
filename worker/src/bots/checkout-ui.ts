import type { BotEnv } from "../env";
import {
  EXTRA_DEVICE_PRICE_PER_MONTH,
  TARIFFS,
  type BillingMonths,
} from "../catalog";
import { BILLING_OPTIONS, calcPrice, periodLabel, type BillingMonths as PricingMonths } from "./pricing";

const PERIOD_EMOJI: Record<PricingMonths, string> = {
  1: "📅",
  3: "📆",
  6: "🗓",
  12: "⭐",
};

export const DEVICE_OPTIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function defaultCheckoutDevices(): number {
  return Math.max(2, includedDevices());
}

export function includedDevices(): number {
  return TARIFFS.basic.includedDevices ?? 1;
}

export function extraDevicesForTotal(totalDevices: number): number {
  return Math.max(0, totalDevices - includedDevices());
}

export function calcCheckoutPrice(
  env: BotEnv,
  months: BillingMonths,
  totalDevices: number,
  promoDiscount = 0
): number {
  const extra = extraDevicesForTotal(totalDevices);
  const base = calcPrice(env, months);
  const addon = extra * EXTRA_DEVICE_PRICE_PER_MONTH * months;
  let total = base + addon;
  if (promoDiscount > 0) {
    total = Math.round((total * (100 - promoDiscount)) / 100);
  }
  return Math.max(0, total);
}

export function deviceLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} устройство`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} устройства`;
  }
  return `${count} устройств`;
}

export function periodsKeyboard(env: BotEnv) {
  const baseDevices = defaultCheckoutDevices();
  return {
    inline_keyboard: BILLING_OPTIONS.map((months) => {
      const price = calcCheckoutPrice(env, months, baseDevices);
      return [
        {
          text: `${PERIOD_EMOJI[months]} ${periodLabel(months)} · ${price} ₽`,
          callback_data: `c:period:${months}`,
        },
      ];
    }).concat([[{ text: "◀️ Назад", callback_data: "c:menu" }]]),
  };
}

export function tariffConfigText(
  env: BotEnv,
  months: BillingMonths,
  totalDevices: number,
  promo = 0
): string {
  const price = calcCheckoutPrice(env, months, totalDevices, promo);
  return (
    `📌 <b>Настройка тарифа</b>\n\n` +
    `Базово:\n` +
    `• ${deviceLabel(defaultCheckoutDevices())}\n\n` +
    `Сейчас:\n` +
    `• ${deviceLabel(totalDevices)}\n` +
    `💰 К оплате: <b>${price} ₽</b>\n\n` +
    `При необходимости измените параметры ниже и подтвердите оплату.`
  );
}

export function tariffConfigKeyboard(
  env: BotEnv,
  months: BillingMonths,
  selectedDevices: number,
  promo = 0
) {
  const price = calcCheckoutPrice(env, months, selectedDevices, promo);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < DEVICE_OPTIONS.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    for (let j = 0; j < 2 && i + j < DEVICE_OPTIONS.length; j += 1) {
      const count = DEVICE_OPTIONS[i + j];
      const mark = count === selectedDevices ? " ✅" : "";
      row.push({
        text: `📱 ${deviceLabel(count)}${mark}`,
        callback_data: `c:dev:${months}:${count}:${promo}`,
      });
    }
    rows.push(row);
  }

  rows.push([
    {
      text: `💳 Оплатить ${price} ₽`,
      callback_data: `c:checkout:${months}:${selectedDevices}:${promo}`,
    },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "c:buy" }]);

  return { inline_keyboard: rows };
}

export function paymentMethodsKeyboard(
  months: number,
  totalDevices: number,
  promo = 0
) {
  return {
    inline_keyboard: [
      [{ text: "📱 СБП", callback_data: `c:pay:sbp:${months}:${promo}:${totalDevices}` }],
      [{ text: "💳 Карта", callback_data: `c:pay:card:${months}:${promo}:${totalDevices}` }],
      [{ text: "💎 USDT", callback_data: `c:pay:crypto_usdt:${months}:${promo}:${totalDevices}` }],
      [{ text: "🎟 Ввести промокод", callback_data: `c:promo:${months}:${totalDevices}` }],
      [{ text: "◀️ Назад", callback_data: `c:period:${months}` }],
    ],
  };
}
