import {
  buildPanelSubscriptionUrlForUser,
  fetchPanelSubscriptionBody,
  subscriptionBodyForClients,
} from "./connect-links";
import { panelLimitIpForSubscription } from "./device-limit";
import type { BotEnv } from "./env";
import {
  getSubscription,
  kvClearSubscriptionPayloadCache,
  kvGetSubscriptionPayloadCache,
  kvSetSubscriptionPayloadCache,
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

/** Пробный период: панель + D1 binding + KV-кэш. */
export async function activateTrialSubscription(
  env: BotEnv,
  params: ActivateTrialParams
): Promise<string> {
  const xui = new XuiApi(env);
  const provision = await xui.provisionTrial(env, {
    userId: params.userId,
    username: params.username,
    displayName: params.displayName,
    telegramId: params.telegramId,
    expiryMs: params.expiryMs,
    limitIp: 1,
    dbSubscription: params.dbSubscription,
  });

  const subId = await persistPanelProvision(
    env,
    params.userId,
    provision,
    params.subscriptionFields
  );
  await refreshSubscriptionCache(env, params.userId, subId);
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
  const provision = await xui.provisionUser(env, {
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
  await refreshSubscriptionCache(env, params.userId, subId);
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
  if (sub?.xray_sub_id?.trim() && sub?.xray_uuid?.trim()) {
    return sub.xray_sub_id.trim();
  }

  const xui = new XuiApi(env);
  const provision = await xui.ensureClientPrepared(env, {
    userId: params.userId,
    username: params.username,
    displayName: params.displayName,
    telegramId: params.telegramId,
    limitIp: panelLimitIpForSubscription(sub),
    enableClient: params.enableClient,
    dbSubscription: sub,
  });

  return persistPanelProvision(env, params.userId, provision, {
    status: sub?.status || "none",
    plan_type: sub?.plan_type || "basic",
    plan_label: sub?.plan_label ?? null,
    billing_months: sub?.billing_months ?? null,
    starts_at: sub?.starts_at ?? null,
    ends_at: sub?.ends_at ?? null,
    is_trial: sub?.is_trial ?? false,
  });
}
