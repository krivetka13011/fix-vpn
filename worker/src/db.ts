import {
  TARIFFS,
  calcTotalRub,
  periodLabel,
  EXTRA_DEVICE_PRICE_PER_MONTH,
  type BillingMonths,
  type PlanType,
} from "./catalog";
import { syncPanelDeviceLimit } from "./device-limit";
import { d1All, d1First, d1Patch, d1Run, mapSubscriptionRow, mapUserRow, newId, nowIso } from "./d1-db";
import {
  getSubscription,
  getUserByTelegramId,
  patchSubscription,
  patchUser,
  upsertTelegramUser,
} from "./repository";
import type { StorageEnv } from "./storage-env";
import type { DbAddon, DbSubscription, DbUser, UserBundle } from "./types";
import type { TelegramUser } from "./telegram";
import { displayName } from "./telegram";

function emptySubscription(userId: string): DbSubscription {
  return {
    id: "",
    user_id: userId,
    plan_type: "basic",
    status: "none",
    plan_label: null,
    billing_months: null,
    starts_at: null,
    ends_at: null,
    vpn_key: null,
    extra_devices: 0,
    purchased_at: null,
    updated_at: new Date().toISOString(),
  };
}

function applyExpiry(sub: DbSubscription): DbSubscription {
  if (sub.status !== "active") return sub;
  if (sub.expires_at) {
    const end = new Date(sub.expires_at).getTime();
    if (Number.isFinite(end) && end < Date.now()) {
      return { ...sub, status: "expired" };
    }
    return sub;
  }
  if (!sub.ends_at) return sub;
  const end = new Date(`${sub.ends_at}T23:59:59+03:00`);
  if (end < new Date()) return { ...sub, status: "expired" };
  return sub;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export async function getBundle(
  env: StorageEnv,
  telegramId: number
): Promise<UserBundle | null> {
  const user = await getUserByTelegramId(env, telegramId);
  if (!user) return null;

  const subRow = await d1First(
    env.DB,
    "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
    user.id
  );
  const addons = await d1All<Record<string, unknown>>(
    env.DB,
    "SELECT * FROM addon_purchases WHERE user_id = ? ORDER BY purchased_at DESC",
    user.id
  );

  const subscription = applyExpiry(
    subRow ? mapSubscriptionRow(subRow) : emptySubscription(user.id)
  );
  let currentUser = user;
  if (subscription.status === "expired" && subRow) {
    await patchSubscription(env, user.id, { status: "expired" });
    if (subscription.is_trial && !user.has_used_trial) {
      await patchUser(env, user.id, { has_used_trial: true });
      currentUser = { ...user, has_used_trial: true };
    }
  }

  return {
    user: currentUser,
    subscription,
    addons: addons.map((row) => ({
      id: String(row.id),
      user_id: String(row.user_id),
      addon_type: String(row.addon_type),
      label: String(row.label),
      quantity: Number(row.quantity),
      price_rub: Number(row.price_rub),
      purchased_at: String(row.purchased_at),
    })),
  };
}

export async function ensureUser(
  env: StorageEnv,
  tg: TelegramUser
): Promise<UserBundle> {
  const existing = await getBundle(env, tg.id);
  if (existing) {
    await d1Patch(
      env.DB,
      "users",
      {
        display_name: displayName(tg),
        username: tg.username ?? null,
        photo_url: tg.photo_url ?? existing.user.photo_url,
        updated_at: nowIso(),
      },
      "id = ?",
      existing.user.id
    );
    const user = (await getUserByTelegramId(env, tg.id)) ?? existing.user;
    return {
      ...existing,
      user,
      subscription: applyExpiry(existing.subscription),
    };
  }

  const user = await upsertTelegramUser(env, tg);
  const sub = await getSubscription(env, user.id);
  return {
    user,
    subscription: sub ?? emptySubscription(user.id),
    addons: [],
  };
}

export async function purchaseSubscription(
  env: StorageEnv,
  tg: TelegramUser,
  planType: PlanType,
  months: BillingMonths,
  extraDevices: number
): Promise<UserBundle> {
  const bundle = await ensureUser(env, tg);
  const tariff = TARIFFS[planType];
  const extra =
    planType === "personal" ? 0 : Math.max(0, Math.min(10, extraDevices));
  const now = new Date();
  const prev = bundle.subscription;
  const extendFrom =
    prev.status === "active" && prev.ends_at
      ? new Date(`${prev.ends_at}T12:00:00`) > now
        ? new Date(`${prev.ends_at}T12:00:00`)
        : now
      : now;
  const label = `${tariff.name} · ${periodLabel(months)}`;
  const vpnKey =
    prev.vpn_key ?? `FIX-${tg.id}-${planType}-${months}M`;

  await patchSubscription(env, bundle.user.id, {
    plan_type: planType,
    status: "active",
    plan_label: label,
    billing_months: months,
    starts_at:
      prev.status === "active" && prev.starts_at
        ? prev.starts_at
        : formatDate(now),
    ends_at: formatDate(addMonths(extendFrom, months)),
    vpn_key: vpnKey,
    extra_devices: extra,
    purchased_at: now.toISOString(),
  });

  const total = calcTotalRub(planType, months, extra);
  if (extra > 0) {
    await d1Run(
      env.DB,
      `INSERT INTO addon_purchases (id, user_id, addon_type, label, quantity, price_rub, purchased_at)
       VALUES (?, ?, 'extra_devices', ?, ?, ?, ?)`,
      newId(),
      bundle.user.id,
      `Доп. устройства: +${extra}`,
      extra,
      extra * EXTRA_DEVICE_PRICE_PER_MONTH * months,
      nowIso()
    );
  }
  const fresh = await getBundle(env, tg.id);
  await syncPanelDeviceLimit(env, fresh!.user.id);
  return fresh!;
}

export async function purchaseExtraDevices(
  env: StorageEnv,
  tg: TelegramUser,
  addDevices: number
): Promise<UserBundle> {
  const bundle = await ensureUser(env, tg);
  const sub = bundle.subscription;
  if (sub.status !== "active" || sub.plan_type !== "basic") {
    throw new Error("Докупка доступна при активном базовом тарифе");
  }
  const add = Math.max(1, Math.min(10, addDevices));
  if (sub.extra_devices + add > 10) {
    throw new Error("Максимум 10 дополнительных устройств (11 слотов всего)");
  }
  const months = (sub.billing_months ?? 1) as BillingMonths;
  const newExtra = sub.extra_devices + add;
  const price = add * EXTRA_DEVICE_PRICE_PER_MONTH * months;

  await patchSubscription(env, bundle.user.id, {
    extra_devices: newExtra,
  });
  await d1Run(
    env.DB,
    `INSERT INTO addon_purchases (id, user_id, addon_type, label, quantity, price_rub, purchased_at)
     VALUES (?, ?, 'extra_devices', ?, ?, ?, ?)`,
    newId(),
    bundle.user.id,
    `Доп. устройства: +${add}`,
    add,
    price,
    nowIso()
  );
  const fresh = await getBundle(env, tg.id);
  await syncPanelDeviceLimit(env, fresh!.user.id);
  return fresh!;
}

export function bundleToApiUser(bundle: UserBundle) {
  const { user, subscription, addons } = bundle;
  const sub = applyExpiry(subscription);
  const deviceTotal =
    sub.plan_type === "personal"
      ? null
      : (TARIFFS.basic.includedDevices ?? 1) + sub.extra_devices;
  return {
    id: user.telegram_id,
    displayName: user.display_name,
    username: user.username,
    photoUrl: user.photo_url,
    subscription: {
      status: sub.status,
      planType: sub.plan_type === "none" ? null : sub.plan_type,
      planLabel: sub.plan_label,
      billingMonths: sub.billing_months,
      startsAt: sub.starts_at,
      endsAt: sub.ends_at,
      purchasedAt: sub.purchased_at,
      extraDevices: sub.extra_devices,
      deviceTotal,
    },
    addons: addons.map((a) => ({
      id: a.id,
      type: a.addon_type,
      label: a.label,
      quantity: a.quantity,
      priceRub: a.price_rub,
      purchasedAt: a.purchased_at,
    })),
  };
}
