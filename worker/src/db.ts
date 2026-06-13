import {
  TARIFFS,
  calcTotalRub,
  periodLabel,
  EXTRA_DEVICE_PRICE_PER_MONTH,
  type BillingMonths,
  type PlanType,
} from "./catalog";
import { sbJson, sbRequest, type SupabaseEnv } from "./supabase";
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
  if (sub.status !== "active" || !sub.ends_at) return sub;
  const end = new Date(`${sub.ends_at}T23:59:59`);
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
  env: SupabaseEnv,
  telegramId: number
): Promise<UserBundle | null> {
  const users = await sbJson<DbUser[]>(
    await sbRequest(
      env,
      `users?telegram_id=eq.${telegramId}&select=*&limit=1`
    )
  );
  if (!users.length) return null;
  const user = users[0];
  const subs = await sbJson<DbSubscription[]>(
    await sbRequest(
      env,
      `subscriptions?user_id=eq.${user.id}&select=*&limit=1`
    )
  );
  const addons = await sbJson<DbAddon[]>(
    await sbRequest(
      env,
      `addon_purchases?user_id=eq.${user.id}&select=*&order=purchased_at.desc`
    )
  );
  const subscription = applyExpiry(
    subs[0] ?? emptySubscription(user.id)
  );
  if (subscription.status === "expired" && subs[0]) {
    await sbRequest(
      env,
      `subscriptions?user_id=eq.${user.id}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "expired", updated_at: new Date().toISOString() }),
      }
    );
  }
  return { user, subscription, addons };
}

export async function ensureUser(
  env: SupabaseEnv,
  tg: TelegramUser
): Promise<UserBundle> {
  const existing = await getBundle(env, tg.id);
  if (existing) {
    const patch = await sbRequest(env, `users?id=eq.${existing.user.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        display_name: displayName(tg),
        username: tg.username ?? null,
        photo_url: tg.photo_url ?? existing.user.photo_url,
        updated_at: new Date().toISOString(),
      }),
    });
    const updated = await sbJson<DbUser[]>(patch);
    return {
      ...existing,
      user: updated[0] ?? existing.user,
      subscription: applyExpiry(existing.subscription),
    };
  }

  const created = await sbJson<DbUser[]>(
    await sbRequest(env, "users", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        telegram_id: tg.id,
        username: tg.username ?? null,
        display_name: displayName(tg),
        photo_url: tg.photo_url ?? null,
      }),
    })
  );
  const user = created[0];
  const subRow = await sbJson<DbSubscription[]>(
    await sbRequest(env, "subscriptions", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: user.id,
        plan_type: "basic",
        status: "none",
        extra_devices: 0,
        plan_label: null,
      }),
    })
  );
  return {
    user,
    subscription: subRow[0] ?? emptySubscription(user.id),
    addons: [],
  };
}

export async function purchaseSubscription(
  env: SupabaseEnv,
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
  const patchBody = {
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
    updated_at: now.toISOString(),
  };
  await sbRequest(env, `subscriptions?user_id=eq.${bundle.user.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patchBody),
  });
  const total = calcTotalRub(planType, months, extra);
  if (extra > 0) {
    await sbRequest(env, "addon_purchases", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: bundle.user.id,
        addon_type: "extra_devices",
        label: `Доп. устройства: +${extra}`,
        quantity: extra,
        price_rub: extra * EXTRA_DEVICE_PRICE_PER_MONTH * months,
      }),
    });
  }
  const fresh = await getBundle(env, tg.id);
  return fresh!;
}

export async function purchaseExtraDevices(
  env: SupabaseEnv,
  tg: TelegramUser,
  addDevices: number
): Promise<UserBundle> {
  const bundle = await ensureUser(env, tg);
  const sub = bundle.subscription;
  if (sub.status !== "active" || sub.plan_type !== "basic") {
    throw new Error("Докупка доступна при активном базовом тарифе");
  }
  const add = Math.max(1, Math.min(10, addDevices));
  const months = (sub.billing_months ?? 1) as BillingMonths;
  const newExtra = sub.extra_devices + add;
  const price = add * EXTRA_DEVICE_PRICE_PER_MONTH * months;
  await sbRequest(env, `subscriptions?user_id=eq.${bundle.user.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      extra_devices: newExtra,
      updated_at: new Date().toISOString(),
    }),
  });
  await sbRequest(env, "addon_purchases", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: bundle.user.id,
      addon_type: "extra_devices",
      label: `Доп. устройства: +${add}`,
      quantity: add,
      price_rub: price,
    }),
  });
  const fresh = await getBundle(env, tg.id);
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
