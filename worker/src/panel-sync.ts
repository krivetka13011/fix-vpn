import type { BotEnv } from "./env";
import {
  buildPanelSubscriptionUrlForUser,
  fetchPanelSubscriptionBody,
  subscriptionBodyForClients,
} from "./connect-links";
import { panelLimitIpForSubscription } from "./device-limit";
import {
  kvClearSubscriptionPayloadCache,
  kvSetSubscriptionPayloadCache,
  patchSubscription,
} from "./repository";
import type { DbSubscription } from "./types";
import { XuiApi } from "./xui";

async function syncFromDbBinding(
  env: BotEnv,
  userId: string,
  telegramId: number,
  sub: DbSubscription | null
): Promise<string | null> {
  const subId = sub?.xray_sub_id?.trim();
  const uuid = sub?.xray_uuid?.trim();
  if (!subId || !uuid) return null;

  const panelUrl = buildPanelSubscriptionUrlForUser(env, subId);
  await patchSubscription(env, userId, {
    client_email: String(telegramId),
    xray_sub_id: subId,
    xray_uuid: uuid,
    subscription_url: panelUrl,
  });
  return subId;
}

export async function syncPanelSubIdForUser(
  env: BotEnv,
  userId: string,
  telegramId: number,
  username: string | null,
  displayName: string | null,
  sub: DbSubscription | null
): Promise<string | null> {
  let panel: { email: string; subId: string; primaryUuid: string } | null = null;

  try {
    const xui = new XuiApi(env);
    await xui.ensureClientEnabledByTelegramId(telegramId);
    panel = await xui.resolvePanelClientForTelegram(telegramId, sub, username);

    if (!panel) {
      const provision = await xui.ensureClientPrepared(env, {
        userId,
        username,
        displayName,
        telegramId,
        limitIp: panelLimitIpForSubscription(sub),
        dbSubscription: sub,
      });
      panel = {
        email: provision.email,
        subId: provision.subId,
        primaryUuid: provision.primaryUuid,
      };
    }
  } catch (error) {
    console.error("syncPanelSubId xui:", error);
    const fromDb = await syncFromDbBinding(env, userId, telegramId, sub);
    if (fromDb) return fromDb;
    return sub?.xray_sub_id?.trim() || null;
  }

  const lockedSubId = sub?.xray_sub_id?.trim() || "";
  const subId =
    lockedSubId && lockedSubId === panel.subId.trim()
      ? lockedSubId
      : panel.subId.trim();
  const panelUrl = buildPanelSubscriptionUrlForUser(env, subId);
  const patch: Record<string, unknown> = {
    client_email: String(telegramId),
    xray_sub_id: subId,
    xray_uuid: panel.primaryUuid,
    subscription_url: panelUrl,
  };

  if (lockedSubId && lockedSubId !== subId) {
    await kvClearSubscriptionPayloadCache(env, userId);
  }

  try {
    const live = await fetchPanelSubscriptionBody(env, subId);
    if (live?.body) {
      await kvSetSubscriptionPayloadCache(
        env,
        userId,
        subscriptionBodyForClients(live.body)
      );
    }
  } catch (error) {
    console.error("syncPanelSubId cache refresh:", error);
  }

  await patchSubscription(env, userId, patch);

  try {
    await new XuiApi(env).ensureClientEnabledByTelegramId(telegramId);
  } catch (error) {
    console.error("syncPanelSubId enable:", error);
  }

  return subId;
}
