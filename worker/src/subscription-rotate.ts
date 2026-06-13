import type { BotEnv } from "./env";
import { patchSubscription } from "./repository";

/** Clear stuck subId rotation flags only — never touch pending panel IP clear. */
export async function clearStuckRotationFlags(
  env: BotEnv,
  userId: string
): Promise<void> {
  await patchSubscription(env, userId, {
    pending_xray_sub_id: null,
    panel_sub_rotate_requested_at: null,
  });
}

/** @deprecated Use clearStuckRotationFlags — kept for callers that finish an IP clear. */
export async function clearDeviceSwapState(
  env: BotEnv,
  userId: string
): Promise<void> {
  await clearStuckRotationFlags(env, userId);
}

export async function completePanelIpClear(
  env: BotEnv,
  userId: string
): Promise<void> {
  await patchSubscription(env, userId, {
    panel_ip_clear_requested_at: null,
  });
}
