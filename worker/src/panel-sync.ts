import type { BotEnv } from "./env";
import {
  buildPanelSubscriptionUrlForUser,
  fetchPanelSubscriptionBody,
  subscriptionBodyForClients,
} from "./connect-links";
import { debugSessionLog } from "./debug-session-log";
import { panelLimitIpForSubscription } from "./device-limit";
import {
  kvClearSubscriptionPayloadCache,
  kvGetSubscriptionPayloadCache,
  kvSetSubscriptionPayloadCache,
  patchSubscription,
} from "./repository";
import type { DbSubscription } from "./types";
import { XuiApi } from "./xui";

export type PanelSyncOptions = {
  /** Принудительно сверить с панелью, даже если в D1 уже есть xray_sub_id */
  force?: boolean;
};

export async function syncPanelSubIdForUser(
  env: BotEnv,
  userId: string,
  telegramId: number,
  username: string | null,
  displayName: string | null,
  sub: DbSubscription | null,
  options?: PanelSyncOptions
): Promise<string | null> {
  const lockedSubId = sub?.xray_sub_id?.trim() || "";
  const lockedUuid = sub?.xray_uuid?.trim() || "";

  if (!options?.force && lockedSubId && lockedUuid) {
    try {
      const xui = new XuiApi(env);
      const onInbound = await xui.findClientByTelegramId(telegramId);
      if (onInbound?.subId?.trim() === lockedSubId) {
        if (
          onInbound.primaryUuid &&
          lockedUuid &&
          onInbound.primaryUuid !== lockedUuid
        ) {
          await patchSubscription(env, userId, {
            xray_uuid: onInbound.primaryUuid,
            client_email: onInbound.email,
          });
        }
        return lockedSubId;
      }
    } catch (error) {
      console.error("syncPanelSubId panel verify:", error);
    }
  }

  let panel: { email: string; subId: string; primaryUuid: string } | null = null;
  let provisioned = false;

  try {
    const xui = new XuiApi(env);
    panel = await xui.resolvePanelClientForTelegram(telegramId, sub, username);

    if (panel) {
      const onInbound = await xui.findClientByTelegramId(telegramId);
      if (!onInbound) {
        await xui.syncPanelClientDisplayName(
          panel,
          telegramId,
          username,
          displayName,
          panelLimitIpForSubscription(sub)
        );
      }
    }

    if (!panel) {
      const provision = await xui.ensureClientPrepared(env, {
        userId,
        username,
        displayName,
        telegramId,
        limitIp: panelLimitIpForSubscription(sub),
        enableClient: sub?.status === "active",
        dbSubscription: sub,
      });
      panel = {
        email: provision.email,
        subId: provision.subId,
        primaryUuid: provision.primaryUuid,
      };
      provisioned = true;
    }
  } catch (error) {
    console.error("syncPanelSubId xui:", error);
    // #region agent log
    debugSessionLog(
      "panel-sync.ts:syncPanelSubIdForUser",
      "panel sync failed",
      {
        telegramId,
        force: Boolean(options?.force),
        error: error instanceof Error ? error.message : "unknown",
      },
      "R"
    );
    // #endregion
    return lockedSubId || null;
  }

  const subId =
    lockedSubId && lockedSubId === panel.subId.trim()
      ? lockedSubId
      : panel.subId.trim();
  const panelUrl = buildPanelSubscriptionUrlForUser(env, subId);
  const patch: Record<string, unknown> = {
    client_email: panel.email,
    xray_sub_id: subId,
    xray_uuid: panel.primaryUuid,
    subscription_url: panelUrl,
  };

  if (
    (lockedSubId && lockedSubId !== subId) ||
    (lockedUuid && lockedUuid !== panel.primaryUuid)
  ) {
    await kvClearSubscriptionPayloadCache(env, userId);
  }

  const subIdChanged = lockedSubId !== subId;
  if (sub?.status === "active" && (provisioned || subIdChanged)) {
    try {
      const cached = (await kvGetSubscriptionPayloadCache(env, userId))?.trim();
      if (!cached || cached.length < 80) {
        const live = await fetchPanelSubscriptionBody(env, subId);
        if (live?.body) {
          await kvSetSubscriptionPayloadCache(
            env,
            userId,
            subscriptionBodyForClients(live.body)
          );
        }
      }
    } catch (error) {
      console.error("syncPanelSubId cache refresh:", error);
    }
  }

  await patchSubscription(env, userId, patch);
  return subId;
}
