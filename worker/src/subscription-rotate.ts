import type { BotEnv } from "./env";
import { buildProtectedSubscriptionUrl } from "./connect-links";
import { patchSubscription } from "./repository";
import type { DbSubscription } from "./types";
import { XuiApi } from "./xui";

export function randomSubId(length = 16): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function isSubRotatePending(
  sub: Pick<DbSubscription, "panel_sub_rotate_requested_at"> | null | undefined,
  maxAgeMs = 15 * 60 * 1000
): boolean {
  const raw = sub?.panel_sub_rotate_requested_at;
  if (!raw) return false;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < maxAgeMs;
}

/** New subId invalidates copied Happ links; old profiles stop refreshing. */
export async function rotateSubscriptionAccess(
  env: BotEnv,
  userId: string,
  sub: DbSubscription
): Promise<{ subId: string; pending: boolean }> {
  const currentSubId = sub.xray_sub_id?.trim() || "";
  if (!sub.client_email?.trim() || !sub.xray_uuid?.trim()) {
    return { subId: currentSubId, pending: false };
  }

  const newSubId = randomSubId();
  const subscriptionUrl = buildProtectedSubscriptionUrl(env, newSubId);
  const telegramId = Number(sub.client_email) || 0;

  try {
    const xui = new XuiApi(env);
    await xui.rotateClientSubId(
      sub.client_email,
      sub.xray_uuid,
      newSubId,
      telegramId
    );
    await patchSubscription(env, userId, {
      xray_sub_id: newSubId,
      subscription_url: subscriptionUrl,
      subscription_payload_cache: null,
      pending_xray_sub_id: null,
      panel_sub_rotate_requested_at: null,
      panel_ip_clear_requested_at: null,
    });
    return { subId: newSubId, pending: false };
  } catch (error) {
    console.error("rotateSubscriptionAccess:", error);
    await patchSubscription(env, userId, {
      pending_xray_sub_id: newSubId,
      panel_sub_rotate_requested_at: new Date().toISOString(),
      subscription_payload_cache: null,
    });
    return { subId: currentSubId, pending: true };
  }
}
