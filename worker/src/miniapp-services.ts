import type { BotEnv } from "./env";
import { TARIFFS } from "./catalog";
import { buildProtectedSubscriptionUrl, buildRedirectUrl, type VpnClientId } from "./connect-links";
import { syncPanelSubIdForUser } from "./panel-sync";
import {
  clearVpnDeviceBindings,
  getSubscription,
  getUserByTelegramId,
  listVpnDeviceBindings,
  patchSubscription,
  upsertTelegramUser,
  upsertVpnDeviceBinding,
} from "./repository";
import type { TelegramUser } from "./telegram";
import { XuiApi, type PanelDeviceIp } from "./xui";

const OS_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  windows: "Windows",
  macos: "macOS",
  mac: "macOS",
};

const CLIENT_LABELS: Record<string, string> = {
  happ: "Happ",
  v2rayng: "V2rayNG",
  v2raytun: "v2rayTun",
  hiddify: "Hiddify",
  shadowrocket: "Shadowrocket",
};

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

function deviceLimitTotal(sub: { extra_devices?: number; plan_type?: string | null } | null): number {
  if (sub?.plan_type === "personal") return 999;
  return 1 + Number(sub?.extra_devices || 0);
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

export type DeviceBindingRow = {
  os: string;
  vpn_client: string;
  label: string;
};

export type DeviceSlotStatus = {
  limit: number;
  panelIps: PanelDeviceIp[];
  bindings: DeviceBindingRow[];
  slotTaken: boolean;
};

export async function fetchDeviceSlotStatus(
  env: BotEnv,
  userId: string,
  sub: Awaited<ReturnType<typeof getSubscription>>
): Promise<DeviceSlotStatus> {
  const limit = deviceLimitTotal(sub);
  const bindings = await listVpnDeviceBindings(env, userId);
  let panelIps: PanelDeviceIp[] = [];

  if (sub?.client_email) {
    try {
      panelIps = await new XuiApi(env).getClientIps(sub.client_email);
    } catch {
      // panel unreachable from worker
    }
  }

  const slotTaken =
    panelIps.length >= limit || bindings.length >= limit;

  return {
    limit,
    panelIps,
    bindings: bindings.map((row) => ({
      os: row.os,
      vpn_client: row.vpn_client,
      label: row.label,
    })),
    slotTaken,
  };
}

export function isDifferentDeviceAttempt(
  status: DeviceSlotStatus,
  targetOs: string
): boolean {
  if (!status.slotTaken) return false;
  if (status.bindings.length > 0) {
    return !status.bindings.some((row) => row.os === targetOs);
  }
  return status.panelIps.length > 0;
}

export function deviceOccupiedMessage(
  status: DeviceSlotStatus,
  targetOs?: string
): string {
  const occupiedLines: string[] = [];
  for (const row of status.bindings.slice(0, 2)) {
    occupiedLines.push(`• ${row.label}`);
  }
  for (const row of status.panelIps.slice(0, 2)) {
    const seen = row.seenAt ? ` (${row.seenAt})` : "";
    occupiedLines.push(`• IP ${row.ip}${seen}`);
  }
  const occupied =
    occupiedLines.length > 0 ? occupiedLines.join("\n") : "• другое устройство";

  const replaceNote =
    targetOs && isDifferentDeviceAttempt(status, targetOs)
      ? "\n\nВы подключаете другое устройство — сначала отвяжите текущее."
      : "";

  return (
    `На этом аккаунте уже привязано устройство. Одновременно работает только ${status.limit} (по IP в панели).\n\n` +
    `Сейчас занято:\n${occupied}${replaceNote}\n\n` +
    `Чтобы заменить: «Мой профиль» → «Мои устройства» → «Сбросить привязки», затем подключитесь снова.`
  );
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
  const bindings = await listVpnDeviceBindings(env, userId);
  const limit = deviceLimitTotal(sub);
  const slot = await fetchDeviceSlotStatus(env, userId, sub);
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

  const devices: MiniappDeviceRow[] = bindings.map((row) => ({
    id: row.id,
    label: row.label,
    os: row.os,
    client: row.vpn_client,
    lastSeenAt: row.last_seen_at,
    online: false,
  }));

  return {
    used: Math.max(bindings.length, slot.panelIps.length),
    limit: limit >= 999 ? Math.max(bindings.length, slot.panelIps.length, 1) : limit,
    panelOnline,
    devices,
  };
}

export async function buildMiniappConnectUrl(
  env: BotEnv,
  tg: TelegramUser,
  platform: MiniappPlatform,
  client: MiniappClient
): Promise<{ redirectUrl: string; subId: string }> {
  const sub = await getSubscription(env, (await upsertTelegramUser(env, tg)).id);
  if (sub?.status !== "active") {
    throw new Error("Сначала активируйте подписку или пробный период");
  }

  const subId = await resolvePanelSubIdForUser(env, tg);
  if (!subId) {
    throw new Error("Подписка ещё синхронизируется. Повторите через минуту.");
  }

  const mappedOs = mapPlatform(platform);
  const mappedClient = mapClient(client);
  const user = await getUserByTelegramId(env, tg.id);
  if (user) {
    const slot = await fetchDeviceSlotStatus(env, user.id, sub);
    if (isDifferentDeviceAttempt(slot, mappedOs)) {
      throw new Error(deviceOccupiedMessage(slot, mappedOs));
    }
    const label = `${OS_LABELS[mappedOs] || mappedOs} · ${CLIENT_LABELS[client] || client}`;
    await upsertVpnDeviceBinding(env, user.id, mappedOs, mappedClient, label);
  }

  return {
    subId,
    redirectUrl: buildRedirectUrl(env, mappedClient, subId),
  };
}

export async function resetMiniappDevices(env: BotEnv, tg: TelegramUser): Promise<void> {
  const user = await getUserByTelegramId(env, tg.id);
  if (!user) throw new Error("Пользователь не найден");
  const sub = await getSubscription(env, user.id);
  if (!sub?.client_email) throw new Error("Нет активного клиента в панели");

  const xui = new XuiApi(env);
  await xui.clearClientIps(sub.client_email);
  await clearVpnDeviceBindings(env, user.id);
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
