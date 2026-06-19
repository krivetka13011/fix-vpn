import type { BotEnv } from "./env";
import { isTesterAccount } from "./env";
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
  countUsedDeviceSlots,
  canConnectNewDevice,
  fetchPanelDeviceIps,
  subscriptionDeviceLimit,
  syncPanelDeviceLimit,
  telegramIdFromClientEmail,
} from "./device-limit";
import { deviceSlotDisplayName } from "./panel-client-label";
import {
  getSubscription,
  getUserById,
  getUserByTelegramId,
  listVpnDeviceBindings,
  markTrialFirstConnectAt,
  patchSubscription,
  upsertTelegramUser,
  upsertVpnDeviceBinding,
} from "./repository";
import type { TelegramUser } from "./telegram";
import type { UserBundle } from "./types";
import { XuiApi } from "./xui";
import { DeviceResetCooldownError, deviceResetNotice, resetPanelClient } from "./device-reset";

export type MiniappPlatform = "android" | "ios" | "windows" | "mac";
export type MiniappClient = "happ" | "v2raytun" | "hiddify";

function mapPlatform(platform: string): string {
  if (platform === "mac") return "macos";
  return platform;
}

function miniappClientLabel(client: MiniappClient): string {
  if (client === "v2raytun") return "V2RayTun";
  if (client === "hiddify") return "Hiddify";
  return "Happ";
}

function deviceBindingLabel(platform: MiniappPlatform, client: MiniappClient): string {
  const osNames: Record<string, string> = {
    ios: "iPhone / iPad",
    android: "Android",
    windows: "Windows ПК",
    macos: "Mac",
  };
  const os = mapPlatform(platform);
  return `${osNames[os] || os} · ${miniappClientLabel(client)}`;
}

async function recordMiniappDeviceConnect(
  env: BotEnv,
  userId: string,
  tg: TelegramUser,
  platform: MiniappPlatform,
  client: MiniappClient
): Promise<void> {
  const os = mapPlatform(platform);
  const vpnClient = mapClient(client);
  await upsertVpnDeviceBinding(
    env,
    userId,
    os,
    vpnClient,
    deviceBindingLabel(platform, client)
  );
  await syncPanelDeviceLimit(env, userId);
  const sub = await getSubscription(env, userId);
  if (sub?.is_trial) {
    await markTrialFirstConnectAt(env, tg.id);
  }
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
  tg: TelegramUser,
  options?: { force?: boolean }
): Promise<string | null> {
  const user = await upsertTelegramUser(env, tg);
  await ensureSubscriptionPeriod(env, user.id);
  const sub = await getSubscription(env, user.id);
  return syncPanelSubIdForUser(
    env,
    user.id,
    tg.id,
    user.username,
    user.display_name,
    sub,
    options
  );
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
  limitDisplay: number | null;
  panelOnline: boolean;
  devices: MiniappDeviceRow[];
  hasClient: boolean;
  canAddDevices: boolean;
}> {
  const sub = await getSubscription(env, userId);
  const user = await getUserById(env, userId);
  const limit = subscriptionDeviceLimit(sub);
  const telegramId =
    telegramIdFromClientEmail(sub?.client_email) ?? user?.telegram_id ?? 0;
  const rawUsed =
    Number.isFinite(telegramId) && telegramId > 0
      ? await countUsedDeviceSlots(env, telegramId, userId)
      : 0;
  const used =
    limit === 0 ? rawUsed : Math.min(rawUsed, limit > 0 ? limit : rawUsed);

  const bindings = await listVpnDeviceBindings(env, userId);
  let devices: MiniappDeviceRow[] = bindings.map((row) => ({
    id: row.id,
    label: row.label,
    os: row.os,
    client: row.vpn_client,
    lastSeenAt: row.last_seen_at,
    online: true,
  }));

  if (devices.length === 0 && telegramId > 0) {
    const panelIps = await fetchPanelDeviceIps(env, telegramId);
    devices = panelIps.map((row, index) => ({
      id: row.ip,
      label: deviceSlotDisplayName(user?.username, telegramId, index + 1),
      os: "",
      client: "",
      lastSeenAt: row.seenAt || new Date().toISOString(),
      online: true,
    }));
  }

  let panelOnline = false;
  if (telegramId > 0) {
    try {
      const xui = new XuiApi(env);
      const panelEmail = await xui.resolvePanelEmail(telegramId);
      if (panelEmail) {
        const onlineEmails = await xui.getOnlineClientEmails();
        panelOnline = onlineEmails.includes(panelEmail);
      }
    } catch {
      // panel unreachable
    }
  }

  const canAddDevices = Boolean(
    sub?.status === "active" &&
      sub.plan_type === "basic" &&
      !sub.is_trial &&
      sub.extra_devices < 10
  );

  return {
    used,
    limit,
    limitDisplay: limit === 0 ? null : limit,
    panelOnline,
    devices,
    hasClient: Boolean(sub?.client_email?.trim()),
    canAddDevices,
  };
}

export async function buildMiniappConnectUrl(
  env: BotEnv,
  tg: TelegramUser,
  platform: MiniappPlatform,
  client: MiniappClient
): Promise<{ connectUrl: string; subUrl: string; subId: string; redirectUrl: string }> {
  const user = await upsertTelegramUser(env, tg);
  const sub = await getSubscription(env, user.id);
  if (sub?.status !== "active") {
    throw new Error("Сначала активируйте подписку или пробный период");
  }

  const gate = await canConnectNewDevice(env, user.id, tg.id);
  if (!gate.ok) {
    throw new Error(gate.message.replace(/<[^>]+>/g, ""));
  }

  const subId = await resolvePanelSubIdForUser(env, tg, { force: !sub?.xray_sub_id?.trim() });
  if (!subId) {
    throw new Error("Подписка ещё синхронизируется. Повторите через минуту.");
  }

  const mappedClient = mapClient(client);
  await syncPanelDeviceLimit(env, user.id);
  await recordMiniappDeviceConnect(env, user.id, tg, platform, client);

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
    isTester: isTesterAccount(env, tg.id, user.is_tester),
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

export async function buildMiniappUserProfile(
  env: BotEnv,
  bundle: UserBundle,
  options?: { skipPanel?: boolean }
) {
  const sub = bundle.subscription;
  const base = bundleToApiUser(bundle);
  const limit = subscriptionDeviceLimit(sub);

  const deviceInfo =
    sub.status !== "active" || options?.skipPanel
      ? {
          used: 0,
          limit,
          limitDisplay: limit === 0 ? null : limit,
          panelOnline: false,
          devices: [] as MiniappDeviceRow[],
          hasClient: Boolean(sub.client_email?.trim()),
          canAddDevices: false,
        }
      : await fetchMiniappDevices(env, bundle.user.id);

  let canConnect = false;
  let connectBlockReason: string | null = null;
  if (canConnectSubscription(sub)) {
    if (limit === 0 || deviceInfo.used < limit) {
      canConnect = true;
    } else {
      connectBlockReason =
        `Все ${deviceInfo.used} устройств заняты (${deviceInfo.used}/${limit}).\n\n` +
        `Сбросьте подключение в профиле (раз в 24 ч) или докупите устройства.`;
    }
  } else if (sub.status !== "active") {
    connectBlockReason =
      "Сначала активируйте пробный период или оформите подписку.";
  } else {
    connectBlockReason = "Подписка синхронизируется. Подождите минуту и повторите.";
  }

  return {
    ...base,
    subscription: {
      ...base.subscription,
      isTrial: Boolean(sub.is_trial),
      canConnect,
      connectBlockReason,
      periodText: subscriptionPeriodText(sub),
      devicesUsed: deviceInfo.used,
      devicesMax: deviceInfo.limitDisplay,
      panelOnline: deviceInfo.panelOnline,
      devices: deviceInfo.devices,
      canAddDevices: deviceInfo.canAddDevices,
      hasClient: deviceInfo.hasClient,
    },
  };
}
