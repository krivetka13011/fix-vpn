import {
  buildPanelSubscriptionUrlForUser,
  fetchPanelJsonSubscription,
  fetchPanelSubscriptionBody,
  subscriptionBodyForClients,
} from "./connect-links";
import { panelLimitIpForSubscription } from "./device-limit";
import type { BotEnv } from "./env";
import { withTimeout } from "./async-timeout";
import { syncPanelSubIdForUser } from "./panel-sync";
import {
  getSubscription,
  getUserById,
  kvClearSubscriptionPayloadCache,
  kvGetSubscriptionPayloadCache,
  kvSetSubscriptionPayloadCache,
  markTrialConsumed,
  patchSubscription,
  saveXuiInboundClients,
} from "./repository";
import type { DbSubscription } from "./types";
import { XuiApi, type ProvisionResult } from "./xui";
export async function persistPanelProvision(
  env: BotEnv,
  userId: string,
  provision: ProvisionResult,
  subscription: Record<string, unknown>
): Promise<string> {
  const current = await getSubscription(env, userId);
  const lockedSubId = current?.xray_sub_id?.trim();
  const subId = lockedSubId || provision.subId;
  const subscriptionUrl = buildPanelSubscriptionUrlForUser(env, subId);

  if (provision.inbounds.length > 0) {
    await saveXuiInboundClients(
      env,
      userId,
      provision.inbounds.map((row) => ({
        inboundId: row.inboundId,
        clientUuid: row.clientUuid,
        clientEmail: provision.email,
      }))
    );
  }

  if (lockedSubId && lockedSubId !== subId) {
    await kvClearSubscriptionPayloadCache(env, userId);
  }

  await patchSubscription(env, userId, {
    xray_uuid: provision.primaryUuid,
    xray_sub_id: subId,
    subscription_url: subscriptionUrl,
    client_email: provision.email,
    ...subscription,
  });

  return subId;
}

export async function refreshSubscriptionCache(
  env: BotEnv,
  userId: string,
  subId: string
): Promise<void> {
  try {
    const cached = (await kvGetSubscriptionPayloadCache(env, userId))?.trim();
    if (cached && cached.length >= 80) return;
    const live = await fetchPanelSubscriptionBody(env, subId);
    if (live?.body) {
      await kvSetSubscriptionPayloadCache(
        env,
        userId,
        subscriptionBodyForClients(live.body)
      );
    }
  } catch (error) {
    console.error("refreshSubscriptionCache:", error);
  }
}

export type ActivateTrialParams = {
  userId: string;
  telegramId: number;
  username: string | null;
  displayName: string | null;
  expiryMs: number;
  dbSubscription: DbSubscription | null;
  subscriptionFields: Record<string, unknown>;
};

/** Пробный период: панель + D1 binding; KV-кэш подгружается при подключении. */
export async function activateTrialSubscription(
  env: BotEnv,
  params: ActivateTrialParams
): Promise<string> {
  const xui = new XuiApi(env);
  const provision = await withTimeout(
    xui.provisionTrial(env, {
      userId: params.userId,
      username: params.username,
      displayName: params.displayName,
      telegramId: params.telegramId,
      expiryMs: params.expiryMs,
      limitIp: 1,
      dbSubscription: params.dbSubscription,
    }),
    25000,
    "Панель не ответила вовремя при активации пробного периода"
  );

  const subId = await persistPanelProvision(
    env,
    params.userId,
    provision,
    params.subscriptionFields
  );
  await markTrialConsumed(env, params.telegramId);
  return subId;
}

export type ActivatePaidParams = {
  userId: string;
  telegramId: number;
  username: string | null;
  displayName: string | null;
  expiryMs: number;
  dbSubscription: DbSubscription | null;
  limitIp: number;
  subscriptionFields: Record<string, unknown>;
};

/** Платная подписка: панель + D1 binding + KV-кэш. */
export async function activatePaidSubscription(
  env: BotEnv,
  params: ActivatePaidParams
): Promise<string> {
  const xui = new XuiApi(env);
  const provision = await xui.provisionTrial(env, {
    userId: params.userId,
    username: params.username,
    displayName: params.displayName,
    telegramId: params.telegramId,
    expiryMs: params.expiryMs,
    limitIp: params.limitIp,
    dbSubscription: params.dbSubscription,
  });

  const subId = await persistPanelProvision(
    env,
    params.userId,
    provision,
    params.subscriptionFields
  );
  void refreshSubscriptionCache(env, params.userId, subId).catch((error) =>
    console.error("refreshSubscriptionCache:", error)
  );
  return subId;
}

/** Резервный клиент на панели без включения тумблера (для /start). */
export async function ensurePanelClientRecord(
  env: BotEnv,
  params: {
    userId: string;
    telegramId: number;
    username: string | null;
    displayName: string | null;
    dbSubscription: DbSubscription | null;
    enableClient: boolean;
  }
): Promise<string | null> {
  const sub = params.dbSubscription;
  const lockedSubId = sub?.xray_sub_id?.trim();
  const lockedUuid = sub?.xray_uuid?.trim();
  if (lockedSubId && lockedUuid) {
    const xui = new XuiApi(env);
    const onInbound = await xui.findClientByTelegramId(params.telegramId);
    if (onInbound?.subId?.trim()) {
      const live = await fetchPanelSubscriptionBody(env, lockedSubId);
      if (live?.body) return lockedSubId;
    }
  }

  const xui = new XuiApi(env);
  const provision = await xui.ensureClientPrepared(env, {
    userId: params.userId,
    username: params.username,
    displayName: params.displayName,
    telegramId: params.telegramId,
    limitIp: panelLimitIpForSubscription(sub),
    enableClient: false,
    dbSubscription: sub,
  });

  const subId = await persistPanelProvision(env, params.userId, provision, {
    status: sub?.status || "none",
    plan_type: sub?.plan_type || "basic",
    plan_label: sub?.plan_label ?? null,
    billing_months: sub?.billing_months ?? null,
    starts_at: sub?.starts_at ?? null,
    ends_at: sub?.ends_at ?? null,
    is_trial: sub?.is_trial ?? false,
  });

  if (params.enableClient) {
    try {
      await xui.forceEnableClient(params.telegramId, provision.email);
    } catch (error) {
      console.error("ensurePanelClientRecord enable:", error);
    }
  }

  return subId;
}

/** Восстанавливает клиента в панели для активной подписки (после сброса устройства и т.п.). */
export async function ensureActiveSubscriptionPanel(
  env: BotEnv,
  dbSub: DbSubscription
): Promise<boolean> {
  if (dbSub.status !== "active") return false;

  const user = await getUserById(env, dbSub.user_id);
  if (!user) return false;

  const subId = dbSub.xray_sub_id?.trim();
  if (subId) {
    const xui = new XuiApi(env);
    const onInbound = await xui.findClientByTelegramId(user.telegram_id);
    if (onInbound) {
      const [live, json] = await Promise.all([
        fetchPanelSubscriptionBody(env, subId),
        fetchPanelJsonSubscription(env, subId),
      ]);
      if (live?.body) return true;
      void json;
    }
  }

  try {
    const recreatedSubId = await syncPanelSubIdForUser(
      env,
      user.id,
      user.telegram_id,
      user.username,
      user.display_name,
      dbSub,
      { force: true }
    );
    if (!recreatedSubId) return false;

    await kvClearSubscriptionPayloadCache(env, user.id);
    await refreshSubscriptionCache(env, user.id, recreatedSubId);
    const xui = new XuiApi(env);
    const onInbound = await xui.findClientByTelegramId(user.telegram_id);
    const live = await fetchPanelSubscriptionBody(env, recreatedSubId);
    return Boolean(onInbound && live?.body);
  } catch (error) {
    console.error("ensureActiveSubscriptionPanel:", error);
    return false;
  }
}
