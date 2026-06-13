import type { BotEnv } from "./env";
import {
  buildPanelSubscriptionUrlForUser,
  panelSubscriptionIsLive,
} from "./connect-links";
import { patchSubscription } from "./repository";
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

  const live = await panelSubscriptionIsLive(env, subId);
  if (!live) return null;

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
  sub: DbSubscription | null
): Promise<string | null> {
  let panel: { email: string; subId: string; primaryUuid: string } | null = null;

  try {
    const xui = new XuiApi(env);
    panel = await xui.resolvePanelClientForTelegram(telegramId, sub, username);

    if (!panel) {
      const provision = await xui.ensureClientPrepared(env, {
        userId,
        username,
        telegramId,
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
  let subId = panel.subId.trim();
  if (lockedSubId) {
    const lockedLive = await panelSubscriptionIsLive(env, lockedSubId);
    if (lockedLive) {
      subId = lockedSubId;
    }
  }

  const live = await panelSubscriptionIsLive(env, subId);
  if (!live) {
    const panelLive = await panelSubscriptionIsLive(env, panel.subId);
    if (!panelLive) {
      const fromDb = await syncFromDbBinding(env, userId, telegramId, sub);
      if (fromDb) return fromDb;
      console.error("syncPanelSubId: panel subscription dead", panel.subId);
      return null;
    }
    subId = panel.subId;
  }

  const panelUrl = buildPanelSubscriptionUrlForUser(env, subId);
  await patchSubscription(env, userId, {
    client_email: String(telegramId),
    xray_sub_id: subId,
    xray_uuid: panel.primaryUuid,
    subscription_url: panelUrl,
  });

  return subId;
}
