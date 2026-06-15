import type { BotEnv } from "./env";
import { TARIFFS } from "./catalog";
import { bundleToApiUser } from "./db";
import {
  buildClientButtonUrl,
  buildClientConnectUrl,
  buildHappDeepLink,
  buildPublicSubscriptionUrl,
  buildProtectedSubscriptionUrl,
  type VpnClientId,
} from "./connect-links";
import { syncPanelSubIdForUser } from "./panel-sync";
import {
  getSubscription,
  getUserByTelegramId,
  patchSubscription,
  upsertTelegramUser,
} from "./repository";
import type { TelegramUser } from "./telegram";
import type { UserBundle } from "./types";
import { XuiApi } from "./xui";
import {
  fetchPanelDeviceIps,
  subscriptionDeviceLimit,
  syncPanelDeviceLimit,
} from "./device-limit";
import { DeviceResetCooldownError, deviceResetNotice, resetPanelClient } from "./device-reset";

export type MiniappPlatform = "android" | "ios" | "windows" | "mac";
export type MiniappClient = "happ" | "v2raytun" | "hiddify";

function mapPlatform(platform: string): string {
  if (platform === "mac") return "macos";
  return platform;
}

function mapClient(client: string): VpnClientId {
  if (client === "v2raytun") return "v2rayng";
  if (client === "happ" || client === "hiddify" || client === "shadowrocket") {
    return client;
  }
  return "happ";
}


function formatPeriod(startsAt: string | null, endsAt: string | null): string | null {
  if (!startsAt && !endsAt) return null;
  const fmt = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  if (startsAt && endsAt) return `${fmt(startsAt)} — ${fmt(endsAt)}`;
  if (endsAt) return `до ${fmt(endsAt)}`;
  return startsAt ? `с ${fmt(startsAt)}` : null;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function ensureSubscriptionPeriod(env: BotEnv, userId: string): Promise<void> {
  const sub = await getSubscription(env, userId);
  if (!sub || sub.status !== "active") return;
  if (sub.starts_at && sub.ends_at) return;

  const now = new Date();
  let startsAt = sub.starts_at ?? formatDateOnly(now);
  let endsAt = sub.ends_at;

  if (!endsAt && sub.is_trial) {
    const trialDays = Number(env.TRIAL_DAYS || env.XUI_TRIAL_DAYS || "3");
    const end = new Date(now.getTime() + trialDays * 86400000);
    endsAt = formatDateOnly(end);
  }

  if (!endsAt && sub.billing_months) {
    const end = new Date(now);
    end.setMonth(end.getMonth() + Number(sub.billing_months));
    endsAt = formatDateOnly(end);
  }

  if (!endsAt) return;

  await patchSubscription(env, userId, {
    starts_at: startsAt,
    ends_at: endsAt,
  });
}

export async function resolvePanelSubIdForUser(
  env: BotEnv,
  tg: TelegramUser
): Promise<string | null> {
  const user = await upsertTelegramUser(env, tg);
  await ensureSubscriptionPeriod(env, user.id);
  const sub = await getSubscription(env, user.id);
  return syncPanelSubIdForUser(env, user.id, tg.id, user.username, sub);
}

export interface MiniappDeviceRow {
  id: string;
  label: string;
  os: string;
  client: string;
  lastSeenAt: string;
  online: boolean;
}

export async function fetchMiniappDevices(
  env: BotEnv,
  userId: string
): Promise<{
  used: number;
  limit: number;
  panelOnline: boolean;
  devices: MiniappDeviceRow[];
}> {
  const sub = await getSubscription(env, userId);
  const limit = subscriptionDeviceLimit(sub);
  const panelIps = await fetchPanelDeviceIps(env, sub?.client_email);
  let panelOnline = false;

  if (sub?.client_email) {
    try {
      const xui = new XuiApi(env);
      const onlineEmails = await xui.getOnlineClientEmails();
      panelOnline = onlineEmails.includes(sub.client_email);
    } catch {
      // panel unreachable from worker
    }
  }

  const devices: MiniappDeviceRow[] = panelIps.map((row) => ({
    id: row.ip,
    label: row.seenAt ? `IP ${row.ip} (${row.seenAt})` : `IP ${row.ip}`,
    os: "",
    client: "",
    lastSeenAt: row.seenAt || new Date().toISOString(),
    online: panelOnline,
  }));

  const used = limit === 0 ? panelIps.length : Math.min(limit, panelIps.length);

  return {
    used,
    limit,
    panelOnline,
    devices,
  };
}

export async function buildMiniappConnectUrl(
  env: BotEnv,
  tg: TelegramUser,
  platform: MiniappPlatform,
  client: MiniappClient
): Promise<{ connectUrl: string; subUrl: string; subId: string; redirectUrl: string }> {
  const sub = await getSubscription(env, (await upsertTelegramUser(env, tg)).id);
  if (sub?.status !== "active") {
    throw new Error("Сначала активируйте подписку или пробный период");
  }

  const subId = await resolvePanelSubIdForUser(env, tg);
  if (!subId) {
    throw new Error("Подписка ещё синхронизируется. Повторите через минуту.");
  }

  const mappedClient = mapClient(client);
  const user = await getUserByTelegramId(env, tg.id);
  if (user) {
    await syncPanelDeviceLimit(env, user.id);
  }

  const subUrl = buildPublicSubscriptionUrl(env, subId);
  const connectUrl = buildClientConnectUrl(env, mappedClient, subId);

  return {
    subId,
    subUrl,
    connectUrl,
    redirectUrl: connectUrl,
  };
}

export async function resetMiniappDevices(env: BotEnv, tg: TelegramUser): Promise<string> {
  const user = await getUserByTelegramId(env, tg.id);
  if (!user) throw new Error("Пользователь не найден");
  await resetPanelClient(env, user.id, {
    telegramId: tg.id,
    isTester: user.is_tester,
  });
  return deviceResetNotice();
}

export function subscriptionPeriodText(sub: {
  starts_at?: string | null;
  ends_at?: string | null;
  billing_months?: number | null;
  is_trial?: boolean | null;
  plan_label?: string | null;
}): string | null {
  const period = formatPeriod(sub.starts_at ?? null, sub.ends_at ?? null);
  if (period) return period;
  if (sub.is_trial && sub.plan_label) return sub.plan_label;
  return null;
}

export function canConnectSubscription(sub: {
  status: string;
  xray_sub_id?: string | null;
}): boolean {
  return sub.status === "active" && Boolean(sub.xray_sub_id?.trim());
}

export function deviceTotalForPlan(sub: {
  plan_type: string;
  extra_devices: number;
}): number | null {
  if (sub.plan_type === "personal") return null;
  return (TARIFFS.basic.includedDevices ?? 1) + sub.extra_devices;
}

export async function buildMiniappUserProfile(env: BotEnv, bundle: UserBundle) {
  const deviceInfo = await fetchMiniappDevices(env, bundle.user.id);
  const sub = bundle.subscription;
  const base = bundleToApiUser(bundle);
  return {
    ...base,
    subscription: {
      ...base.subscription,
      isTrial: Boolean(sub.is_trial),
      canConnect: canConnectSubscription(sub),
      periodText: subscriptionPeriodText(sub),
      devicesUsed: deviceInfo.used,
      devicesMax: deviceInfo.limit,
      panelOnline: deviceInfo.panelOnline,
      devices: deviceInfo.devices,
    },
  };
}
