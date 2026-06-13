import type { BotEnv } from "./env";
import {
  buildPanelSubscriptionUrlForUser,
  buildProtectedSubscriptionUrl,
  panelSubscriptionIsLive,
} from "./connect-links";
import { patchSubscription } from "./repository";
import type { DbSubscription } from "./types";
import { XuiApi } from "./xui";

export async function syncPanelSubIdForUser(
  env: BotEnv,
  userId: string,
  telegramId: number,
  username: string | null,
  sub: DbSubscription | null
): Promise<string | null> {
  const xui = new XuiApi(env);
  let panel = await xui.resolvePanelClientForTelegram(telegramId, sub, username);

  if (!panel) {
    try {
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
    } catch (error) {
      console.error("syncPanelSubId ensureClientPrepared:", error);
      return sub?.xray_sub_id?.trim() || null;
    }
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
